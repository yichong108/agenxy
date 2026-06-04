import type { PendingToolCall } from '@/main/agent/hitl'

/**
 * execute_react 节点与 agent-service 之间的 IPC/HITL/流式桥接。
 *
 * 由 runUserMessage 每 run 构造并注入 runContext.reactBridge。
 */
export type ReactRunBridge = {
  abortController: AbortController
  recursionLimit: number
  invokeTimeoutMs: number
  /** 已流式输出字符数（HITL 触发时会重置） */
  streamedCharsRef: { current: number }
  pushStreamToken: (token: string) => void
  resetStream: () => void
  setPendingHitl: (hitlId: string, threadId: string, toolCalls: PendingToolCall[]) => void
  emitHitlRequired: (hitlId: string, toolCalls: PendingToolCall[]) => void
  emitToolsRejected: (toolCalls: PendingToolCall[]) => void
}
