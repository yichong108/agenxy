import type { NamedTool } from '@/main/agent/define-tool'
import type { UserIntent } from '@/main/agent/intent-classifier'
import type { AgentMessage } from '@/main/agent/messages'
import type { AgentComposerMode, ToolTimelineEvent } from '@/shared/ipc'

/**
 * prepare_tooling 阶段写入的工具与 prompt 快照。
 */
export type PreparedTooling = {
  tools: NamedTool[]
  runPrompt: string
}

/**
 * 单次 agent 运行的元数据，供 pipeline 节点与 IPC 桥接共享。
 */
export type AgenxyRunMeta = {
  sessionId: string
  runId: string
  traceId: string
  threadId: string
  workspaceId: string
  root: string
  userDisplayText: string
  agentUserText: string
  planContext?: string
}

/**
 * execute_react 阶段完成后写回的状态片段。
 */
export type AgenxyReactPhaseResult = {
  messages: AgentMessage[]
  toolEvents: ToolTimelineEvent[]
}

/**
 * init_run 之后、execute_react 执行前的 pipeline 状态快照。
 */
export type AgenxyGraphState = {
  messages: AgentMessage[]
  composerMode: AgentComposerMode
  runMeta: AgenxyRunMeta
  detectedIntents: UserIntent[]
  toolEvents: ToolTimelineEvent[]
}

/**
 * Pipeline 运行时状态（含 tooling 中间态）。
 */
export type AgenxyGraphStateType = AgenxyGraphState & {
  tooling: PreparedTooling | null
}
