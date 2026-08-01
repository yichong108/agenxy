/**
 * Agent 单次 run 相关类型。
 *
 * 供 createAgent 使用；不依赖宿主实现。
 */

import type { ToolSet } from 'ai'

/**
 * 工具准备阶段产物：ReAct 可用工具与 system prompt。
 */
export type PreparedTooling = {
  tools: ToolSet
  runPrompt: string
}

/**
 * 单次 run 的元数据，由宿主注入。
 *
 * 工作区路径不在此结构中；由 send 的 workspacePath（或 createAgent local.cwd）提供。
 */
export type RunMeta = {
  sessionId: string
  runId: string
  traceId: string
  workspaceId: string
  /** 本轮用户文案（供 tooling 等使用；messages 须已由宿主追加对应用户消息） */
  agentUserText: string
}
