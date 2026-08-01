/**
 * Agent 单次 run / 工作流相关类型。
 *
 * 供 createAgent 与 runWorkflow 共用；不依赖宿主实现。
 */

import type { AgentComposerMode, AppSettings, StreamEvent } from '@agenwork/shared'
import type { CoreMessage, LanguageModel, ToolSet } from 'ai'

import type { ToolObservation } from './define-tool.js'

/**
 * 工具准备阶段产物：ReAct 可用工具与 system prompt。
 */
export type PreparedTooling = {
  tools: ToolSet
  runPrompt: string
}

/**
 * 单次 run 的元数据，由宿主注入。
 */
export type RunMeta = {
  sessionId: string
  runId: string
  traceId: string
  workspaceId: string
  root: string
  /** UI 展示用用户文案（可与 agentUserText 不同） */
  userDisplayText: string
  /** 发给模型的用户文案 */
  agentUserText: string
}

/**
 * ReAct 阶段与宿主 IPC 之间的桥接对象。
 *
 * 由 createAgent 在每次 run 内构造，宿主通过 callbacks 接收流式事件。
 */
export type ReactRunBridge = {
  abortController: AbortController
  /** 最大工具调用轮次；缺省时由 runReactLoop 回落到 MAX_AGENT_LOOP_STEPS */
  maxSteps?: number
  /** 循环超时（毫秒）；缺省时由 runReactLoop 回落到 defaultSettings.agentRunTimeoutMs */
  invokeTimeoutMs?: number
  streamedCharsRef: { current: number }
  pushStreamToken: (token: string) => void
}

/**
 * 单次 agent 工作流运行时的可变上下文。
 *
 * 贯穿工具准备与 ReAct 各阶段；tooling 可通过 emit / signal 与宿主协作。
 * 工具观察仅回调宿主，时间线收集由宿主负责。
 */
export type WorkflowRunContext = {
  settings: AppSettings
  signal: AbortSignal
  onTool: (e: ToolObservation) => void
  emit: (event: StreamEvent) => void
  reactBridge: ReactRunBridge
  /** createAgent 注入的模型；未设则各阶段从 settings 解析 */
  provider?: LanguageModel
}

/**
 * Agent 工作流阶段间传递的状态。
 */
export type WorkflowState = {
  messages: CoreMessage[]
  composerMode: AgentComposerMode
  runMeta: RunMeta
  tooling: PreparedTooling | null
}
