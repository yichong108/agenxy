/**
 * Agent 单次 run / 工作流相关类型。
 *
 * 供 createAgent 与 runWorkflow 共用；不依赖宿主实现。
 */

import type { AgentComposerMode } from '@agenwork/shared'
import type { CoreMessage, ToolSet } from 'ai'

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
  /** UI 展示用用户文案（可与 agentUserText 不同）；用户消息本身由宿主写入 messages */
  userDisplayText: string
  /** 本轮用户文案（供 tooling 等使用；messages 须已由宿主追加对应用户消息） */
  agentUserText: string
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
