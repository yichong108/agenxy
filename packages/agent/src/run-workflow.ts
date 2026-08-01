import { type AgentComposerMode, type AppSettings, type StreamEvent } from '@agenwork/shared'
import type { CoreMessage, LanguageModel } from 'ai'

import type { ToolExecutorContext } from './define-tool.js'
import { resolveChatModel } from './llm.js'
import { agentLog } from './logger.js'
import { userMessage } from './messages.js'
import { runReactLoop } from './react-loop.js'
import type {
  PreparedTooling,
  RunMeta,
  WorkflowRunContext,
  WorkflowState
} from './run-types.js'

export type InitRunCallbacks = {
  persistMessages: (messages: CoreMessage[]) => void
}

export type RunWorkflowInput = {
  composerMode: AgentComposerMode
  runMeta: RunMeta
  messages: CoreMessage[]
  runContext: WorkflowRunContext
  initRunCallbacks: InitRunCallbacks
  signal?: AbortSignal
}

export type RunWorkflowResult = {
  messages: CoreMessage[]
}

/** @deprecated 使用 RunWorkflowInput */
export type RunAgenworkPipelineInput = RunWorkflowInput

/** @deprecated 使用 RunWorkflowResult */
export type RunAgenworkPipelineResult = RunWorkflowResult

/**
 * 工作流依赖（工具组装等）。
 *
 * agent 核心调用 prepareTooling 后进入 ReAct 循环；
 * prepareTooling 由 createAgent 的默认 tooling 注入。
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

  /** createAgent 注入的模型；未设则各阶段从 settings 解析 */
  provider?: LanguageModel
}

/**
 * 追加本轮用户消息并持久化。
 *
 * 模型侧使用 agentUserText；UI 展示文案由宿主凭 RunMeta.userDisplayText 处理。
 *
 * @param state - 当前流水线状态
 * @param callbacks - 初始化回调（如消息持久化）
 * @returns 更新后的 messages 片段
 */
function appendUserMessagePhase(
  state: WorkflowState,
  callbacks: InitRunCallbacks
): Partial<WorkflowState> {
  const { runMeta } = state
  const messages = [...state.messages, userMessage(runMeta.agentUserText)]
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
  state: WorkflowState,
  runContext: WorkflowRunContext,
  deps: WorkflowDeps,
  signal?: AbortSignal
): Promise<Partial<WorkflowState>> {
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

  const toolCount = Object.keys(toolingBundle.tools).length
  agentLog.info(`[prepareToolingPhase] mode=${composerMode} tools=${toolCount}`)

  return { tooling: toolingBundle }
}

/**
 * 运行 Agent Loop 阶段（流式生成与工具调用）。
 *
 * @param state - 当前状态
 * @param runContext - 运行上下文
 * @param deps - 宿主注入依赖
 * @returns 运行结束后的 messages
 */
async function runAgentLoopPhase(
  state: WorkflowState,
  runContext: WorkflowRunContext,
  deps: WorkflowDeps
): Promise<{ messages: CoreMessage[] }> {
  const bridge = runContext.reactBridge
  const prepared = state.tooling
  if (!prepared) {
    throw new Error('[runAgentLoopPhase] tooling not prepared')
  }

  const { settings } = runContext
  const { tools, runPrompt } = prepared

  const model = resolveChatModel(settings, deps.provider ?? runContext.provider)
  if (!model) {
    throw new Error('请先在设置中配置 API Key，或向 createAgent 传入 provider')
  }

  const onStreamToken = (token: string) => {
    bridge.streamedCharsRef.current += token.length
    bridge.pushStreamToken(token)
  }

  const runMessages = await runReactLoop(
    model,
    runPrompt,
    state.messages,
    tools,
    bridge.abortController,
    onStreamToken,
    bridge.maxSteps,
    bridge.invokeTimeoutMs
  )

  return {
    messages: runMessages.length > 0 ? runMessages : state.messages
  }
}

/**
 * 执行完整 agent 工作流（按阶段编排：消息、工具、Agent Loop）。
 *
 * @param input - 初始状态与 runContext
 * @param deps - 宿主注入依赖
 * @returns 运行结束后的 messages
 */
export async function runWorkflow(
  input: RunWorkflowInput,
  deps: WorkflowDeps
): Promise<RunWorkflowResult> {
  const state: WorkflowState = {
    messages: input.messages,
    composerMode: input.composerMode,
    runMeta: input.runMeta,
    tooling: null
  }

  const { runContext, initRunCallbacks, signal } = input

  Object.assign(state, appendUserMessagePhase(state, initRunCallbacks))
  Object.assign(state, await prepareToolingPhase(state, runContext, deps, signal))

  const agentLoopResult = await runAgentLoopPhase(state, runContext, deps)
  state.messages = agentLoopResult.messages

  return {
    messages: state.messages
  }
}

/** @deprecated 使用 runWorkflow */
export const runAgenworkPipeline = runWorkflow

/** @deprecated 使用 runWorkflow */
export const runAgenworkGraph = runWorkflow

/** @deprecated 使用 WorkflowDeps */
export type PipelineDeps = WorkflowDeps
