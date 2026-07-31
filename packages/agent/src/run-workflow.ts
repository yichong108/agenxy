import { type AgentComposerMode, type AppSettings, type StreamEvent } from '@agenwork/shared'
import type { LanguageModel } from 'ai'

import type { ToolExecutorContext } from './define-tool.js'
import { agentLog } from './logger.js'
import {
  type AgentMessage,
  contentToText,
  findLastAiMessage,
  humanMessage
} from './messages.js'
import { runReactLoop } from './react-loop.js'
import type { AgenworkGraphRunContext } from './graph/run-context.js'
import type { AgenworkGraphStateType, AgenworkRunMeta, PreparedTooling } from './graph/state.js'
import { AGENWORK_USER_DISPLAY_KW } from './constants.js'

export type InitRunCallbacks = {
  persistMessages: (messages: AgentMessage[]) => void
}

export type RunWorkflowInput = {
  composerMode: AgentComposerMode
  runMeta: AgenworkRunMeta
  messages: AgentMessage[]
  runContext: AgenworkGraphRunContext
  initRunCallbacks: InitRunCallbacks
  signal?: AbortSignal
}

export type RunWorkflowResult = {
  messages: AgentMessage[]
  toolEvents: AgenworkGraphStateType['toolEvents']
}

/** @deprecated 使用 RunWorkflowInput */
export type RunAgenworkPipelineInput = RunWorkflowInput

/** @deprecated 使用 RunWorkflowResult */
export type RunAgenworkPipelineResult = RunWorkflowResult

export type ReactObservationContext = {
  sessionId: string
  tags: string[]
  traceMetadata: Record<string, string>
  traceId: string
  traceName: string
  input: string
}

/**
 * 宿主注入的工作流依赖（工具组装、Langfuse 等）。
 *
 * agent 核心只负责调用 prepareTooling 并进入 ReAct 循环；
 * 宿主可在 prepareTooling 内完成自定义工具/skills 组装。
 */
export type WorkflowDeps = {
  prepareTooling: (args: {
    composerMode: AgentComposerMode
    sessionId: string
    root: string
    settings: AppSettings
    runCtx: ToolExecutorContext
    /** 本轮用户可见/代理文本，供宿主按需使用 */
    userText: string
    signal?: AbortSignal
    emit: (event: StreamEvent) => void
    provider?: LanguageModel
  }) => Promise<PreparedTooling>

  wrapReactRun?: <T>(
    ctx: ReactObservationContext,
    fn: () => Promise<T>,
    opts?: { formatOutput?: (messages: AgentMessage[]) => string }
  ) => Promise<T>

  /** createAgent 注入的模型；未设则各阶段从 settings 解析 */
  provider?: LanguageModel
}

/**
 * 追加本轮用户消息并持久化。
 *
 * @param state - 当前流水线状态
 * @param callbacks - 初始化回调（如消息持久化）
 * @returns 更新后的 messages 片段
 */
function appendUserMessagePhase(
  state: AgenworkGraphStateType,
  callbacks: InitRunCallbacks
): Partial<AgenworkGraphStateType> {
  const { runMeta } = state
  const displayText =
    runMeta.userDisplayText && runMeta.userDisplayText !== runMeta.agentUserText
      ? runMeta.userDisplayText
      : undefined
  const msg = humanMessage(runMeta.agentUserText, displayText)
  const messages = [...state.messages, msg]
  callbacks.persistMessages(messages)
  return { messages }
}

/**
 * 按模式组装本轮可用工具与 system prompt。
 *
 * @param state - 当前流水线状态
 * @param runContext - 运行上下文
 * @param deps - 宿主注入依赖
 * @param signal - 可选取消信号
 * @returns tooling 产物
 */
async function prepareToolingPhase(
  state: AgenworkGraphStateType,
  runContext: AgenworkGraphRunContext,
  deps: WorkflowDeps,
  signal?: AbortSignal
): Promise<Partial<AgenworkGraphStateType>> {
  const { composerMode, runMeta } = state
  const { settings, onTool, emit, provider } = runContext
  const { sessionId, root, runId, traceId, userDisplayText, agentUserText } = runMeta

  const toolingBundle = await deps.prepareTooling({
    composerMode,
    sessionId,
    root,
    settings,
    runCtx: { runId, traceId, onTool },
    userText: userDisplayText || agentUserText,
    signal,
    emit,
    provider: deps.provider ?? provider
  })

  agentLog.info(`[prepareToolingPhase] mode=${composerMode} tools=${toolingBundle.tools.length}`)

  return { tooling: toolingBundle }
}

/**
 * 运行 Agent Loop 阶段（流式生成与工具调用）。
 *
 * @param state - 当前状态
 * @param runContext - 运行上下文
 * @param deps - 宿主注入依赖
 * @returns 运行结束后的 messages 与 toolEvents
 */
async function runAgentLoopPhase(
  state: AgenworkGraphStateType,
  runContext: AgenworkGraphRunContext,
  deps: WorkflowDeps
): Promise<{ messages: AgentMessage[]; toolEvents: AgenworkGraphStateType['toolEvents'] }> {
  const bridge = runContext.reactBridge
  const prepared = state.tooling
  if (!prepared) {
    throw new Error('[runAgentLoopPhase] tooling not prepared')
  }

  const { composerMode, runMeta } = state
  const { settings, runToolEvents } = runContext
  const { tools, runPrompt } = prepared
  const { sessionId, runId, traceId, workspaceId, userDisplayText, agentUserText } = runMeta

  agentLog.info(
    `[runAgentLoopPhase] mode=${composerMode} runPrompt: ${JSON.stringify(runPrompt, null, 2)}`
  )

  const onStreamToken = (token: string) => {
    bridge.streamedCharsRef.current += token.length
    bridge.pushStreamToken(token)
  }

  const runAgentLoop = async () =>
    runReactLoop(
      settings,
      runPrompt,
      state.messages,
      tools,
      bridge.abortController,
      onStreamToken,
      {
        recursionLimit: bridge.recursionLimit,
        timeoutMs: bridge.invokeTimeoutMs
      },
      {
        meta: {
          sessionId,
          runId,
          traceId
        }
      },
      deps.provider ?? runContext.provider
    )

  const observationCtx: ReactObservationContext = {
    sessionId,
    tags: ['agenwork', 'pipeline', 'react', composerMode],
    traceMetadata: {
      run_id: runId,
      trace_id: traceId,
      workspace_id: workspaceId,
      step: 'react'
    },
    traceId,
    traceName: 'agenwork-graph',
    input: userDisplayText || agentUserText
  }

  const runMessages = deps.wrapReactRun
    ? await deps.wrapReactRun(observationCtx, runAgentLoop, {
        formatOutput: (messages) => {
          const lastAi = findLastAiMessage(messages)
          return lastAi ? contentToText(lastAi.content) : ''
        }
      })
    : await runAgentLoop()

  return {
    messages: runMessages.length > 0 ? runMessages : state.messages,
    toolEvents: runToolEvents
  }
}

/**
 * 执行完整 agent 工作流（按阶段编排：消息、工具、Agent Loop）。
 *
 * @param input - 初始状态与 runContext
 * @param deps - 宿主注入依赖
 * @returns 运行结束后的 messages 与 toolEvents
 */
export async function runWorkflow(
  input: RunWorkflowInput,
  deps: WorkflowDeps
): Promise<RunWorkflowResult> {
  const state: AgenworkGraphStateType = {
    messages: input.messages,
    composerMode: input.composerMode,
    runMeta: input.runMeta,
    tooling: null,
    toolEvents: []
  }

  const { runContext, initRunCallbacks, signal } = input

  Object.assign(state, appendUserMessagePhase(state, initRunCallbacks))
  Object.assign(state, await prepareToolingPhase(state, runContext, deps, signal))

  const agentLoopResult = await runAgentLoopPhase(state, runContext, deps)
  state.messages = agentLoopResult.messages
  state.toolEvents = [...state.toolEvents, ...agentLoopResult.toolEvents]

  return {
    messages: state.messages,
    toolEvents: state.toolEvents
  }
}

/** @deprecated 使用 runWorkflow */
export const runAgenworkPipeline = runWorkflow

/** @deprecated 使用 runWorkflow */
export const runAgenworkGraph = runWorkflow

/** @deprecated 使用 WorkflowDeps */
export type PipelineDeps = WorkflowDeps

export { AGENWORK_USER_DISPLAY_KW }
