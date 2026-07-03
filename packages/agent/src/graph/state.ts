import type { NamedTool } from '../define-tool.js'
import type { UserIntent } from '../intent-classifier.js'
import type { AgentMessage } from '../messages.js'
import type { AgentComposerMode, ToolTimelineEvent } from '@agenxy/shared'

export type PreparedTooling = {
  tools: NamedTool[]
  runPrompt: string
}

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

export type AgenxyReactPhaseResult = {
  messages: AgentMessage[]
  toolEvents: ToolTimelineEvent[]
}

export type AgenxyGraphState = {
  messages: AgentMessage[]
  composerMode: AgentComposerMode
  runMeta: AgenxyRunMeta
  detectedIntents: UserIntent[]
  toolEvents: ToolTimelineEvent[]
}

export type AgenxyGraphStateType = AgenxyGraphState & {
  tooling: PreparedTooling | null
}
