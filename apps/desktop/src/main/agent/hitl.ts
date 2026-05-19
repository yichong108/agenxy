import { AIMessage, SystemMessage, ToolMessage, type BaseMessage, isAIMessage } from '@langchain/core/messages'

/** Marks graph-only messages that must not appear in chat history. */
export const AGENXY_INTERNAL_KW = 'agenxy_internal'
import { MemorySaver } from '@langchain/langgraph'

export const TOOL_REJECTED_RESULT = 'Rejected by user (not executed)'

export function isRejectedToolResult(result?: string): boolean {
  return Boolean(result?.includes('Rejected by user'))
}

/** Shared checkpointer for all agent threads (in-memory; keyed by thread_id). */
export const agentCheckpointer = new MemorySaver()

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
  for (const [id, waiter] of waiters) {
    waiters.delete(id)
    waiter.reject(err)
  }
}

export function cancelHitlWaiter(hitlId: string, reason = 'Cancelled'): void {
  const waiter = waiters.get(hitlId)
  if (!waiter) return
  waiters.delete(hitlId)
  waiter.reject(new Error(reason))
}

export function extractPendingToolCalls(messages: BaseMessage[]): PendingToolCall[] {
  const lastAi = [...messages].reverse().find((m) => isAIMessage(m)) as AIMessage | undefined
  if (!lastAi?.tool_calls?.length) return []
  return lastAi.tool_calls.map((tc, idx) => {
    const rawArgs = tc.args
    const args =
      typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : { input: rawArgs }
    return {
      id: tc.id ?? `${tc.name}-${idx}`,
      name: tc.name,
      args
    }
  })
}

export function isPausedBeforeTools(next: string[] | undefined): boolean {
  return Array.isArray(next) && next.includes('tools')
}

/** Tools that may run without user approval in Build mode HITL. */
export const HITL_EXEMPT_TOOL_NAMES = new Set([
  'read_file',
  'list_dir',
  'glob',
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

/** Synthetic tool results + internal system hint (not persisted / not shown as user text). */
export function buildRejectionStateMessages(pending: PendingToolCall[]): BaseMessage[] {
  const names = pending.map((t) => t.name).join(', ')
  const toolMessages = pending.map(
    (tc) =>
      new ToolMessage({
        content: `用户已拒绝工具 ${tc.name}，本次未执行。本轮不得再次调用 ${tc.name}。`,
        tool_call_id: tc.id,
        name: tc.name,
        status: 'error'
      })
  )
  const systemHint = new SystemMessage({
    content:
      `User rejected tool call(s): ${names}. Do not retry them this turn. ` +
      `Reply in the user's language: briefly acknowledge the rejection and suggest alternatives without those tools.`,
    additional_kwargs: { [AGENXY_INTERNAL_KW]: true }
  })
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
