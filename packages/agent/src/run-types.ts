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
