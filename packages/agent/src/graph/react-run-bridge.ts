import type { PendingToolCall } from '../hitl.js'

/**
 * execute_react 与宿主 agent-service 之间的 IPC/HITL/流式桥接。
 */
export type ReactRunBridge = {
  abortController: AbortController
  recursionLimit: number
  invokeTimeoutMs: number
  streamedCharsRef: { current: number }
  pushStreamToken: (token: string) => void
  resetStream: () => void
  setPendingHitl: (hitlId: string, threadId: string, toolCalls: PendingToolCall[]) => void
  emitHitlRequired: (hitlId: string, toolCalls: PendingToolCall[]) => void
  emitToolsRejected: (toolCalls: PendingToolCall[]) => void
}
