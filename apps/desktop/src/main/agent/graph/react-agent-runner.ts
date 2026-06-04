import { type BaseMessage, ToolMessage } from '@langchain/core/messages'
import { Command, INTERRUPT, isInterrupted } from '@langchain/langgraph'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import type { CallbackHandler } from '@langfuse/langchain'

import { agentLog } from '@/main/agent/agent-log'
import type { NamedTool } from '@/main/agent/agent-tooling'
import {
  buildRejectionStateMessages,
  createHitlResumeCommand,
  extractPendingToolCalls,
  type HitlUserDecision,
  isPausedBeforeTools,
  makeHitlId,
  partitionPendingToolCalls,
  type PendingToolCall,
  waitForHitlDecision
} from '@/main/agent/hitl'

export type ReactAgentRunContext = {
  sessionId: string
  runId: string
  traceId: string
  threadId: string
  hitlEnabled: boolean
  toolsByName: Map<string, NamedTool>
  onPendingHitl: (hitlId: string, toolCalls: PendingToolCall[]) => void
  emitHitlRequired: (hitlId: string, toolCalls: PendingToolCall[]) => void
  onToolsRejected?: (toolCalls: PendingToolCall[]) => void
}

type ReactAgentInvokeInput =
  | { messages: BaseMessage[] }
  | Command<HitlUserDecision, Record<string, unknown>>

/**
 * 在 interruptBefore tools 暂停时，执行无需审批的只读工具并写入 ToolMessage。
 */
async function executePendingToolCalls(
  pending: PendingToolCall[],
  toolsByName: Map<string, NamedTool>
): Promise<ToolMessage[]> {
  const out: ToolMessage[] = []
  for (const tc of pending) {
    const impl = toolsByName.get(tc.name)
    if (!impl) {
      out.push(
        new ToolMessage({
          content: `Tool not found: ${tc.name}`,
          tool_call_id: tc.id,
          name: tc.name,
          status: 'error'
        })
      )
      continue
    }
    try {
      const result = await impl.invoke(tc.args)
      const content = typeof result === 'string' ? result : JSON.stringify(result)
      out.push(
        new ToolMessage({
          content,
          tool_call_id: tc.id,
          name: tc.name
        })
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      out.push(
        new ToolMessage({
          content: message,
          tool_call_id: tc.id,
          name: tc.name,
          status: 'error'
        })
      )
    }
  }
  return out
}

function isHitlInterrupt(
  result: unknown,
  next: string[] | undefined,
  hitlEnabled: boolean
): boolean {
  if (!hitlEnabled) return false
  if (isPausedBeforeTools(next)) return true
  return isInterrupted(result)
}

/**
 * 运行 ReAct 子图：超时保护 + interruptBefore tools HITL，通过 Command.resume 恢复。
 *
 * @param agent - createReactAgent 编译图
 * @param messages - 初始 messages
 * @param ac - 取消信号
 * @param onToken - 流式 token 回调
 * @param options - recursionLimit、timeout、Langfuse handler
 * @param runCtx - HITL 与 thread 上下文
 * @returns 运行结束后的 messages
 */
export async function runReactAgentWithGuard(
  agent: ReturnType<typeof createReactAgent>,
  messages: BaseMessage[],
  ac: AbortController,
  onToken: (token: string) => void,
  options: {
    recursionLimit: number
    timeoutMs: number
    langfuseHandler?: CallbackHandler | null
  },
  runCtx: ReactAgentRunContext
): Promise<BaseMessage[]> {
  const { recursionLimit, timeoutMs, langfuseHandler } = options
  const graphConfig = {
    configurable: { thread_id: runCtx.threadId },
    signal: ac.signal,
    recursionLimit,
    callbacks: [
      {
        handleLLMNewToken(token: string) {
          onToken(token)
        }
      },
      ...(langfuseHandler ? [langfuseHandler] : [])
    ]
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort()
      reject(new Error(`Model-tool loop timeout (>${timeoutMs}ms), run aborted`))
    }, timeoutMs)
  })

  let input: ReactAgentInvokeInput = { messages }
  let hitlRound = 0
  const graphStateConfig = { configurable: { thread_id: runCtx.threadId } }

  try {
    agentLog.info(
      `[runReactAgentWithGuard] thread=${runCtx.threadId} hitl=${runCtx.hitlEnabled} recursionLimit=${recursionLimit}`
    )

    while (true) {
      const result = await Promise.race([agent.invoke(input, graphConfig), timeoutPromise])
      const state = await agent.getState(graphStateConfig)
      const stateMessages = (state.values?.messages ?? []) as BaseMessage[]

      if (!isHitlInterrupt(result, state.next, runCtx.hitlEnabled)) {
        if (stateMessages.length > 0) return stateMessages
        const fallback = (result as { messages?: BaseMessage[] })?.messages
        return Array.isArray(fallback) && fallback.length > 0 ? fallback : stateMessages
      }

      if (isInterrupted(result)) {
        const interrupts = (result as { [INTERRUPT]: { value?: unknown }[] })[INTERRUPT]
        agentLog.info(
          `[runReactAgentWithGuard] graph interrupt payloads=${JSON.stringify(interrupts?.map((i) => i.value))}`
        )
      }

      const pending = extractPendingToolCalls(stateMessages)
      if (pending.length === 0) {
        agentLog.warn('[runReactAgentWithGuard] interrupt before tools but no tool_calls in state')
        return stateMessages
      }

      const { approvalRequired, autoExecute } = partitionPendingToolCalls(pending)
      if (approvalRequired.length === 0) {
        agentLog.info(
          `[runReactAgentWithGuard] read-only tools only (${autoExecute.map((t) => t.name).join(', ')}), skip HITL`
        )
        input = createHitlResumeCommand('accept')
        continue
      }

      const hitlId = makeHitlId(runCtx.runId, hitlRound++)
      runCtx.onPendingHitl(hitlId, approvalRequired)
      runCtx.emitHitlRequired(hitlId, approvalRequired)

      const decision = await waitForHitlDecision(hitlId, ac.signal)
      agentLog.info(`[runReactAgentWithGuard] hitl decision=${decision} hitlId=${hitlId}`)

      if (decision === 'reject') {
        const autoResults =
          autoExecute.length > 0
            ? await executePendingToolCalls(autoExecute, runCtx.toolsByName)
            : []
        await agent.updateState(graphStateConfig, {
          messages: [...autoResults, ...buildRejectionStateMessages(approvalRequired)]
        })
        runCtx.onToolsRejected?.(approvalRequired)
      }

      input = createHitlResumeCommand(decision)
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
