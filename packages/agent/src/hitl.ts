import { AGENWORK_INTERNAL_KW } from './constants.js'
import type { AgentMessage, AgentToolCall } from './messages.js'
import { systemMessage, toolMessage } from './messages.js'

export { AGENWORK_INTERNAL_KW }

export const TOOL_REJECTED_RESULT = '用户已拒绝执行（未运行）'

export function isRejectedToolResult(result?: string): boolean {
  return Boolean(result?.includes('用户已拒绝') || result?.includes('Rejected by user'))
}

export type PendingToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
}

export type HitlUserDecision = 'accept' | 'reject'

type HitlWaiter = {
  resolve: (decision: HitlUserDecision) => void
  reject: (err: Error) => void
}

const waiters = new Map<string, HitlWaiter>()

export function makeHitlId(runId: string, index: number): string {
  return `hitl-${runId}-${index}`
}

/**
 * 等待用户 HITL 决策（由宿主通过 submitHitlDecision 提交）。
 *
 * @param hitlId - 审批批次 ID
 * @param signal - 可选 AbortSignal
 * @returns accept / reject
 */
export function waitForHitlDecision(
  hitlId: string,
  signal?: AbortSignal
): Promise<HitlUserDecision> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }
    const onAbort = () => {
      waiters.delete(hitlId)
      reject(new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    waiters.set(hitlId, {
      resolve: (responses) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(responses)
      },
      reject: (err) => {
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      }
    })
  })
}

export function submitHitlDecision(hitlId: string, decision: HitlUserDecision): boolean {
  const waiter = waiters.get(hitlId)
  if (!waiter) return false
  waiters.delete(hitlId)
  waiter.resolve(decision)
  return true
}

export function cancelAllHitlWaiters(reason = 'Cancelled'): void {
  const err = new Error(reason)
  for (const [, waiter] of waiters) {
    waiter.reject(err)
  }
  waiters.clear()
}

export function cancelHitlWaiter(hitlId: string, reason = 'Cancelled'): void {
  const waiter = waiters.get(hitlId)
  if (!waiter) return
  waiters.delete(hitlId)
  waiter.reject(new Error(reason))
}

/**
 * 从 messages 末尾 AI 消息提取待执行 tool_calls。
 *
 * @param messages - 会话消息
 * @returns 待处理工具调用列表
 */
export function extractPendingToolCalls(messages: AgentMessage[]): PendingToolCall[] {
  const lastAi = [...messages].reverse().find((m) => m.type === 'ai')
  if (!lastAi?.toolCalls?.length) return []
  return lastAi.toolCalls.map((tc: AgentToolCall, idx: number) => ({
    id: tc.id ?? `${tc.name}-${idx}`,
    name: tc.name,
    args: tc.args
  }))
}

export const HITL_EXEMPT_TOOL_NAMES = new Set([
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'search_workspace',
  'web_search',
  'mcp_list_servers',
  'mcp_inspect_server'
])

export function requiresHitlApproval(toolName: string): boolean {
  return !HITL_EXEMPT_TOOL_NAMES.has(toolName)
}

export function partitionPendingToolCalls(pending: PendingToolCall[]): {
  approvalRequired: PendingToolCall[]
  autoExecute: PendingToolCall[]
} {
  const approvalRequired: PendingToolCall[] = []
  const autoExecute: PendingToolCall[] = []
  for (const tc of pending) {
    if (requiresHitlApproval(tc.name)) approvalRequired.push(tc)
    else autoExecute.push(tc)
  }
  return { approvalRequired, autoExecute }
}

/**
 * 构造工具拒绝后的 synthetic tool 结果与内部 system 提示。
 *
 * @param pending - 被拒绝的工具调用
 * @returns tool + internal system 消息
 */
export function buildRejectionStateMessages(pending: PendingToolCall[]): AgentMessage[] {
  const names = pending.map((t) => t.name).join(', ')
  const toolMessages = pending.map((tc) =>
    toolMessage(
      tc.id,
      tc.name,
      `用户已拒绝工具 ${tc.name}，本次未执行。本轮不得再次调用 ${tc.name}。`,
      'error'
    )
  )
  const systemHint = systemMessage(
    `用户拒绝了工具调用：${names}。本轮不要重试。` +
      `用中文简要确认拒绝，并在不依赖这些工具的前提下给出替代方案。`,
    true
  )
  return [...toolMessages, systemHint]
}

export function formatToolArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args)
    return s.length > 400 ? `${s.slice(0, 400)}…` : s
  } catch {
    return String(args)
  }
}
