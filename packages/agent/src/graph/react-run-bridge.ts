import type { PendingToolCall } from '../hitl.js'

/**
 * ReAct 阶段与宿主 IPC 之间的桥接对象。
 *
 * 由 createAgent 在每次 run 内构造，宿主通过 callbacks 接收流式与 HITL 事件。
 */
export type ReactRunBridge = {
  abortController: AbortController
  recursionLimit: number
  invokeTimeoutMs: number
  streamedCharsRef: { current: number }
  pushStreamToken: (token: string) => void
  resetStream: () => void
  setPendingHitl: (hitlId: string, toolCalls: PendingToolCall[]) => void
  emitHitlRequired: (hitlId: string, toolCalls: PendingToolCall[]) => void
  emitToolsRejected: (toolCalls: PendingToolCall[]) => void
}
