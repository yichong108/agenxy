import { type AgentComposerMode, type AppSettings } from '@agenxy/shared'

import { AGENXY_USER_DISPLAY_KW } from './constants.js'
import type { NamedTool, ToolExecutorContext } from './define-tool.js'
import { classifyIntent, type UserIntent } from './intent-classifier.js'
import { agentLog } from './logger.js'
import {
  type AgentMessage,
  contentToText,
  findLastAiMessage,
  humanMessage
} from './messages.js'
import { runReactLoop } from './react-loop.js'
import { isAbortError } from './run-utils.js'
import { createPlanAfterToolCoordinator } from './graph/plan-after-tool.js'
import type { AgenxyGraphRunContext } from './graph/run-context.js'
import type { AgenxyGraphStateType, AgenxyRunMeta, PreparedTooling } from './graph/state.js'

export type InitRunCallbacks = {
  persistMessages: (messages: AgentMessage[]) => void
}

export type RunWorkflowInput = {
  composerMode: AgentComposerMode
  runMeta: AgenxyRunMeta
  messages: AgentMessage[]
  runContext: AgenxyGraphRunContext
  initRunCallbacks: InitRunCallbacks
  signal?: AbortSignal
}

export type RunWorkflowResult = {
  messages: AgentMessage[]
  toolEvents: AgenxyGraphStateType['toolEvents']
}

/** @deprecated 使用 RunWorkflowInput */
export type RunAgenxyPipelineInput = RunWorkflowInput

/** @deprecated 使用 RunWorkflowResult */
export type RunAgenxyPipelineResult = RunWorkflowResult

export type ReactObservationContext = {
  sessionId: string
  tags: string[]
  traceMetadata: Record<string, string>
  traceId: string
  traceName: string
  input: string
}

/**
 * 宿主注入的工作流依赖（工具组装、Langfuse、记忆提取等）。
 */
export type WorkflowDeps = {
  prepareTooling: (args: {
    composerMode: AgentComposerMode
    sessionId: string
    root: string
    settings: AppSettings
    runCtx: ToolExecutorContext
    filterIntents?: UserIntent[]
  }) => Promise<PreparedTooling>

  wrapReactRun?: <T>(
    ctx: ReactObservationContext,
    fn: () => Promise<T>,
    opts?: { formatOutput?: (messages: AgentMessage[]) => string }
  ) => Promise<T>

  extractMemory?: (args: {
    sessionId: string
    userText: string
    assistantText: string
  }) => Promise<void>
}

/**
 * 追加本轮用户消息并持久化。
 *
 * @param state - 当前流水线状态
 * @param callbacks - 初始化回调（如消息持久化）
 * @returns 更新后的 messages 片段
 */
function appendUserMessagePhase(
  state: AgenxyGraphStateType,
  callbacks: InitRunCallbacks
): Partial<AgenxyGraphStateType> {
  const { runMeta } = state
  const msg = humanMessage(
    runMeta.agentUserText,
    runMeta.planContext ? runMeta.userDisplayText : undefined
  )
  const messages = [...state.messages, msg]
  callbacks.persistMessages(messages)
  return { messages }
}

/**
 * 分类用户意图，供 Build 模式筛选工具。
 *
 * @param state - 当前流水线状态
 * @param runContext - 运行上下文
 * @param signal - 可选取消信号
 * @returns 检测到的意图列表
 */
async function classifyIntentPhase(
  state: AgenxyGraphStateType,
  runContext: AgenxyGraphRunContext,
  signal?: AbortSignal
): Promise<Partial<AgenxyGraphStateType>> {
  const { runMeta } = state
  const { settings, emit } = runContext
  let detectedIntents: AgenxyGraphStateType['detectedIntents'] = []

  try {
    const classification = await classifyIntent(
      runMeta.userDisplayText || runMeta.agentUserText,
      settings,
      signal
    )
    if (classification.intent !== 'general' && classification.confidence > 0.6) {
      detectedIntents = [classification.intent]
    }
    agentLog.info(
      `[classifyIntentPhase] intent=${classification.intent} confidence=${classification.confidence.toFixed(2)}`
    )
  } catch (e) {
    if (isAbortError(e)) throw e
    agentLog.warn('[classifyIntentPhase] failed:', e)
    const message = e instanceof Error ? e.message : String(e)
    emit({
      type: 'intent-classified',
      sessionId: runMeta.sessionId,
      runId: runMeta.runId,
      traceId: runMeta.traceId,
      intent: 'general',
      skillNames: [],
      error: message
    })
  }

  agentLog.info(`[classifyIntentPhase] detectedIntents=${JSON.stringify(detectedIntents)}`)
  return { detectedIntents }
}

/**
 * 挂载工具结束后的 plan 协调器（afterToolEnd）。
 *
 * @param state - 当前流水线状态
 * @param runContext - 运行上下文（写入 afterToolEnd）
 * @param signal - 可选取消信号
 */
function setupPlanAfterToolPhase(
  state: AgenxyGraphStateType,
  runContext: AgenxyGraphRunContext,
  signal?: AbortSignal
): void {
  const { runMeta, composerMode } = state
  const coordinator = createPlanAfterToolCoordinator({
    composerMode,
    sessionId: runMeta.sessionId,
    runId: runMeta.runId,
    traceId: runMeta.traceId,
    userText: runMeta.userDisplayText || runMeta.agentUserText,
    settings: runContext.settings,
    signal: signal ?? runContext.signal,
    emit: runContext.emit,
    runToolEvents: runContext.runToolEvents
  })
  runContext.afterToolEnd = coordinator.afterToolEnd
}

/**
 * 按模式与意图组装本轮可用工具与 system prompt。
 *
 * @param state - 当前流水线状态
 * @param runContext - 运行上下文
 * @param deps - 宿主注入依赖
 * @returns tooling 产物
 */
async function prepareToolingPhase(
  state: AgenxyGraphStateType,
  runContext: AgenxyGraphRunContext,
  deps: WorkflowDeps
): Promise<Partial<AgenxyGraphStateType>> {
  const { composerMode, runMeta, detectedIntents } = state
  const { settings, onTool, afterToolEnd } = runContext
  const { sessionId, root, runId, traceId } = runMeta

  const toolingBundle = await deps.prepareTooling({
    composerMode,
    sessionId,
    root,
    settings,
    runCtx: { runId, traceId, onTool, afterToolEnd },
    filterIntents: composerMode === 'build' ? detectedIntents : undefined
  })

  agentLog.info(`[prepareToolingPhase] mode=${composerMode} tools=${toolingBundle.tools.length}`)

  return { tooling: toolingBundle }
}

/**
 * 运行 Agent Loop 阶段（流式生成、工具调用与 HITL）。
 *
 * @param state - 当前状态
 * @param runContext - 运行上下文
 * @param deps - 宿主注入依赖
 * @returns 运行结束后的 messages 与 toolEvents
 */
async function runAgentLoopPhase(
  state: AgenxyGraphStateType,
  runContext: AgenxyGraphRunContext,
  deps: WorkflowDeps
): Promise<{ messages: AgentMessage[]; toolEvents: AgenxyGraphStateType['toolEvents'] }> {
  const bridge = runContext.reactBridge
  const prepared = state.tooling
  if (!prepared) {
    throw new Error('[runAgentLoopPhase] tooling not prepared')
  }

  const { composerMode, runMeta } = state
  const { settings, runToolEvents } = runContext
  const { tools, runPrompt } = prepared
  const { sessionId, runId, traceId, threadId, workspaceId, userDisplayText, agentUserText } =
    runMeta

  agentLog.info(
    `[runAgentLoopPhase] mode=${composerMode} runPrompt: ${JSON.stringify(runPrompt, null, 2)}`
  )

  const hitlEnabled = composerMode === 'build' && settings.toolApprovalInBuild !== false

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
          traceId,
          threadId
        },
        hitl: {
          enabled: hitlEnabled,
          onPending: (hitlId, toolCalls) => {
            bridge.setPendingHitl(hitlId, threadId, toolCalls)
          },
          emitRequired: (hitlId, toolCalls) => {
            bridge.resetStream()
            bridge.emitHitlRequired(hitlId, toolCalls)
          },
          onRejected: (toolCalls) => {
            bridge.resetStream()
            bridge.emitToolsRejected(toolCalls)
          }
        }
      }
    )

  const observationCtx: ReactObservationContext = {
    sessionId,
    tags: ['agenxy', 'pipeline', 'react', composerMode],
    traceMetadata: {
      run_id: runId,
      trace_id: traceId,
      workspace_id: workspaceId,
      step: 'react'
    },
    traceId,
    traceName: 'agenxy-graph',
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
 * 从本轮对话中提取记忆（若设置开启）。
 *
 * @param state - 当前流水线状态
 * @param runContext - 运行上下文
 * @param deps - 宿主注入依赖
 */
async function extractMemoryPhase(
  state: AgenxyGraphStateType,
  runContext: AgenxyGraphRunContext,
  deps: WorkflowDeps
): Promise<void> {
  const { settings } = runContext
  if (!settings.memoryEnabled || !settings.autoExtractMemory || !deps.extractMemory) return

  const { runMeta, messages } = state
  const lastAi = findLastAiMessage(messages)
  const assistantText = lastAi ? contentToText(lastAi.content) : ''
  const userText = runMeta.userDisplayText || runMeta.agentUserText

  try {
    await deps.extractMemory({
      sessionId: runMeta.sessionId,
      userText,
      assistantText
    })
  } catch (err) {
    agentLog.warn('[extractMemoryPhase] failed:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * 执行完整 agent 工作流（按阶段编排：消息、意图、工具、Agent Loop、记忆）。
 *
 * @param input - 初始状态与 runContext
 * @param deps - 宿主注入依赖
 * @returns 运行结束后的 messages 与 toolEvents
 */
export async function runWorkflow(
  input: RunWorkflowInput,
  deps: WorkflowDeps
): Promise<RunWorkflowResult> {
  const state: AgenxyGraphStateType = {
    messages: input.messages,
    composerMode: input.composerMode,
    runMeta: input.runMeta,
    detectedIntents: [],
    tooling: null,
    toolEvents: []
  }

  const { runContext, initRunCallbacks, signal } = input

  Object.assign(state, appendUserMessagePhase(state, initRunCallbacks))

  if (state.composerMode === 'build') {
    Object.assign(state, await classifyIntentPhase(state, runContext, signal))
  }

  setupPlanAfterToolPhase(state, runContext, signal)

  Object.assign(state, await prepareToolingPhase(state, runContext, deps))

  const agentLoopResult = await runAgentLoopPhase(state, runContext, deps)
  state.messages = agentLoopResult.messages
  state.toolEvents = [...state.toolEvents, ...agentLoopResult.toolEvents]

  if (runContext.settings.memoryEnabled && runContext.settings.autoExtractMemory) {
    await extractMemoryPhase(state, runContext, deps)
  }

  return {
    messages: state.messages,
    toolEvents: state.toolEvents
  }
}

/** @deprecated 使用 runWorkflow */
export const runAgenxyPipeline = runWorkflow

/** @deprecated 使用 runWorkflow */
export const runAgenxyGraph = runWorkflow

/** @deprecated 使用 WorkflowDeps */
export type PipelineDeps = WorkflowDeps

export { AGENXY_USER_DISPLAY_KW }
