import { type AgentComposerMode, type AppSettings, type StreamEvent } from '@agenwork/shared'
import type { CoreMessage, LanguageModel } from 'ai'

import type { ToolExecutorContext, ToolObservation } from './define-tool.js'
import { agentLog } from './logger.js'
import { runReactLoop } from './react-loop.js'
import type { PreparedTooling, RunMeta, WorkflowState } from './run-types.js'

/**
 * 按模式组装本轮可用工具与 system prompt 的依赖函数。
 */
export type PrepareToolingFn = (args: {
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

/**
 * 工作流依赖（工具组装等）。
 *
 * @deprecated 使用 PrepareToolingFn 与 runWorkflow 位置参数
 */
export type WorkflowDeps = {
  prepareTooling: PrepareToolingFn
  /** createAgent 注入的模型；未设则各阶段从 settings 解析 */
  provider?: LanguageModel
}

export type RunWorkflowResult = {
  messages: CoreMessage[]
}

/** @deprecated 工作流已改为位置参数，不再使用对象入参 */
export type RunWorkflowInput = {
  composerMode: AgentComposerMode
  runMeta: RunMeta
  messages: CoreMessage[]
  settings: AppSettings
  onTool: (e: ToolObservation) => void
  emit: (event: StreamEvent) => void
  abortController: AbortController
  pushStreamToken: (token: string) => void
  prepareTooling: PrepareToolingFn
  /** 本轮聊天模型；同时供 tooling 与 Agent Loop 使用 */
  provider: LanguageModel
  maxSteps?: number
  invokeTimeoutMs?: number
}

/** @deprecated 使用 RunWorkflowInput */
export type RunAgenworkPipelineInput = RunWorkflowInput

/** @deprecated 使用 RunWorkflowResult */
export type RunAgenworkPipelineResult = RunWorkflowResult

/**
 * 按模式组装本轮可用工具与 system prompt。
 *
 * @param state - 当前流水线状态
 * @param settings - 应用设置
 * @param onTool - 工具观察回调
 * @param emit - 流式事件回调
 * @param prepareTooling - 工具组装函数
 * @param provider - 可选模型（供 tooling 使用）
 * @param signal - 可选取消信号
 * @returns tooling 产物
 */
async function prepareToolingPhase(
  state: WorkflowState,
  settings: AppSettings,
  onTool: (e: ToolObservation) => void,
  emit: (event: StreamEvent) => void,
  prepareTooling: PrepareToolingFn,
  provider?: LanguageModel,
  signal?: AbortSignal
): Promise<Partial<WorkflowState>> {
  const { composerMode, runMeta } = state
  const { sessionId, root, runId, traceId, userDisplayText, agentUserText } = runMeta

  const toolingBundle = await prepareTooling({
    composerMode,
    sessionId,
    root,
    settings,
    runCtx: { runId, traceId, onTool },
    userText: userDisplayText || agentUserText,
    signal,
    emit,
    provider
  })

  const toolCount = Object.keys(toolingBundle.tools).length
  agentLog.info(`[prepareToolingPhase] mode=${composerMode} tools=${toolCount}`)

  return { tooling: toolingBundle }
}

/**
 * 执行完整 agent 工作流（按阶段编排：工具准备、Agent Loop）。
 *
 * 调用方须已将本轮用户消息写入 messages；消息持久化由宿主负责。
 *
 * @param composerMode - 编排模式（ask / build 等）
 * @param runMeta - 本轮 run 元数据
 * @param messages - 会话消息（须已含本轮用户消息）
 * @param settings - 应用设置
 * @param onTool - 工具观察回调
 * @param emit - 流式事件回调
 * @param abortController - 取消控制器
 * @param pushStreamToken - 流式 token 回调
 * @param prepareTooling - 工具组装函数
 * @param provider - 本轮已解析的聊天模型（供 tooling 与 Agent Loop 使用）
 * @param maxSteps - 最大工具调用轮次
 * @param invokeTimeoutMs - 循环超时（毫秒）
 * @returns 运行结束后的 messages
 */
export async function runWorkflow(
  composerMode: AgentComposerMode,
  runMeta: RunMeta,
  messages: CoreMessage[],
  settings: AppSettings,
  onTool: (e: ToolObservation) => void,
  emit: (event: StreamEvent) => void,
  abortController: AbortController,
  pushStreamToken: (token: string) => void,
  prepareTooling: PrepareToolingFn,
  provider: LanguageModel,
  maxSteps?: number,
  invokeTimeoutMs?: number
): Promise<RunWorkflowResult> {
  const state: WorkflowState = {
    messages,
    composerMode,
    runMeta,
    tooling: null
  }

  Object.assign(
    state,
    await prepareToolingPhase(
      state,
      settings,
      onTool,
      emit,
      prepareTooling,
      provider,
      abortController.signal
    )
  )

  const prepared = state.tooling
  if (!prepared) {
    throw new Error('[runWorkflow] tooling not prepared')
  }

  const { tools, runPrompt } = prepared

  const runMessages = await runReactLoop(
    provider,
    runPrompt,
    state.messages,
    tools,
    abortController,
    pushStreamToken,
    maxSteps,
    invokeTimeoutMs
  )

  return {
    messages: runMessages.length > 0 ? runMessages : state.messages
  }
}

/** @deprecated 使用 runWorkflow */
export const runAgenworkPipeline = runWorkflow

/** @deprecated 使用 runWorkflow */
export const runAgenworkGraph = runWorkflow

/** @deprecated 使用 WorkflowDeps */
export type PipelineDeps = WorkflowDeps
