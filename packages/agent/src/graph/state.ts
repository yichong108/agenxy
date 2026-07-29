import type { AgentComposerMode, ToolTimelineEvent } from '@agenxy/shared'

import type { NamedTool } from '../define-tool.js'
import type { UserIntent } from '../intent-classifier.js'
import type { AgentMessage } from '../messages.js'

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
export type AgenxyRunMeta = {
  sessionId: string
  runId: string
  traceId: string
  workspaceId: string
  root: string
  userDisplayText: string
  agentUserText: string
  planContext?: string
}

/**
 * Agent 流水线图状态（顺序阶段间传递）。
 */
export type AgenxyGraphStateType = {
  messages: AgentMessage[]
  composerMode: AgentComposerMode
  runMeta: AgenxyRunMeta
  detectedIntents: UserIntent[]
  tooling: PreparedTooling | null
  toolEvents: ToolTimelineEvent[]
}

/** @deprecated 使用 AgenxyGraphStateType */
export type AgenxyGraphState = AgenxyGraphStateType

/** @deprecated 流水线不再使用 LangGraph phase result */
export type AgenxyReactPhaseResult = {
  messages: AgentMessage[]
  toolEvents: ToolTimelineEvent[]
}
