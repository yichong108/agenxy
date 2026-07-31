/**
 * Agent 单次 run / 工作流相关类型。
 *
 * 供 createAgent 与 runWorkflow 共用；不依赖宿主实现。
 */

import type { AgentComposerMode, AppSettings, StreamEvent, ToolTimelineEvent } from '@agenwork/shared'
import type { LanguageModel } from 'ai'

import type { NamedTool } from './define-tool.js'
import type { AgentMessage } from './messages.js'

/**
 * 工具准备阶段产物：ReAct 可用工具与 system prompt。
 */
export type PreparedTooling = {
  tools: NamedTool[]
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
  userDisplayText: string
  agentUserText: string
}

/**
 * ReAct 阶段与宿主 IPC 之间的桥接对象。
 *
 * 由 createAgent 在每次 run 内构造，宿主通过 callbacks 接收流式事件。
 */
export type ReactRunBridge = {
  abortController: AbortController
  recursionLimit: number
  invokeTimeoutMs: number
  streamedCharsRef: { current: number }
  pushStreamToken: (token: string) => void
}

/**
 * 单次 agent 工作流运行时的可变上下文。
 *
 * 贯穿工具准备与 ReAct 各阶段；宿主可在 prepareTooling 中使用 emit / signal。
 */
export type WorkflowRunContext = {
  settings: AppSettings
  signal: AbortSignal
  onTool: (e: ToolTimelineEvent) => void
  emit: (event: StreamEvent) => void
  runToolEvents: ToolTimelineEvent[]
  reactBridge: ReactRunBridge
  /** createAgent 注入的模型；未设则各阶段从 settings 解析 */
  provider?: LanguageModel
}

/**
 * Agent 工作流阶段间传递的状态。
 */
export type WorkflowState = {
  messages: AgentMessage[]
  composerMode: AgentComposerMode
  runMeta: RunMeta
  tooling: PreparedTooling | null
  toolEvents: ToolTimelineEvent[]
}
