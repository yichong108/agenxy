import { type AppSettings } from '@agenxy/shared'
import { tool, type CoreMessage, type ToolSet } from 'ai'
import { streamText } from 'ai'

import type { NamedTool } from './define-tool.js'
import {
  buildRejectionStateMessages,
  extractPendingToolCalls,
  type HitlUserDecision,
  makeHitlId,
  partitionPendingToolCalls,
  type PendingToolCall,
  waitForHitlDecision
} from './hitl.js'
import { getChatModel } from './llm.js'
import { agentLog } from './logger.js'
import { type AgentMessage, aiMessage, toModelMessages, toolMessage } from './messages.js'

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

/**
 * 将 NamedTool 列表转为 AI SDK ToolSet（仅声明 schema，不自动执行）。
 *
 * @param namedTools - 工具列表
 * @returns AI SDK tools 映射
 */
export function buildToolDeclarations(namedTools: NamedTool[]): ToolSet {
  const set = {} as ToolSet
  for (const t of namedTools) {
    set[t.name] = tool({
      description: t.description,
      parameters: t.schema,
      execute: async () => {
        throw new Error('Tool execution is handled manually in the ReAct loop')
      }
    }) as ToolSet[string]
  }
  return set
}

async function executePendingToolCalls(
  pending: PendingToolCall[],
  toolsByName: Map<string, NamedTool>,
  signal?: AbortSignal
): Promise<AgentMessage[]> {
  const out: AgentMessage[] = []
  for (const tc of pending) {
    const impl = toolsByName.get(tc.name)
    if (!impl) {
      out.push(toolMessage(tc.id, tc.name, `Tool not found: ${tc.name}`, 'error'))
      continue
    }
    try {
      const result = await impl.invoke(tc.args, { signal })
      const content = typeof result === 'string' ? result : JSON.stringify(result)
      out.push(toolMessage(tc.id, tc.name, content))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      out.push(toolMessage(tc.id, tc.name, message, 'error'))
    }
  }
  return out
}

/**
 * 运行 ReAct 循环：流式生成 + 手动工具执行 + Build 模式 HITL。
 *
 * @param settings - 应用设置
 * @param systemPrompt - system 提示
 * @param messages - 初始会话消息
 * @param tools - 可用工具
 * @param ac - 取消控制器
 * @param onToken - 流式 token 回调
 * @param options - recursionLimit、timeout
 * @param runCtx - HITL 与 thread 上下文
 * @returns 运行结束后的 messages
 */
export async function runReactLoop(
  settings: AppSettings,
  systemPrompt: string,
  messages: AgentMessage[],
  tools: NamedTool[],
  ac: AbortController,
  onToken: (token: string) => void,
  options: {
    recursionLimit: number
    timeoutMs: number
  },
  runCtx: ReactAgentRunContext
): Promise<AgentMessage[]> {
  const { recursionLimit, timeoutMs } = options
  const model = getChatModel(settings)
  if (!model) {
    throw new Error('请先在设置中配置 API Key')
  }
  const toolsByName = new Map(tools.map((t) => [t.name, t]))
  runCtx.toolsByName = toolsByName

  const toolSet = buildToolDeclarations(tools)
  const working = [...messages]
  let steps = 0
  let hitlRound = 0

  const deadline = Date.now() + timeoutMs

  agentLog.info(
    `[runReactLoop] thread=${runCtx.threadId} hitl=${runCtx.hitlEnabled} recursionLimit=${recursionLimit}`
  )

  while (steps < recursionLimit) {
    if (ac.signal.aborted) throw new Error('Aborted')
    if (Date.now() > deadline) {
      ac.abort()
      throw new Error(`Model-tool loop timeout (>${timeoutMs}ms), run aborted`)
    }

    const result = streamText({
      model,
      system: systemPrompt,
      messages: toModelMessages(working) as CoreMessage[],
      tools: toolSet,
      abortSignal: ac.signal
    })

    for await (const chunk of result.fullStream) {
      if (chunk.type === 'text-delta') {
        const token = 'textDelta' in chunk ? chunk.textDelta : (chunk as { text?: string }).text
        if (token) onToken(token)
      }
    }

    const text = await result.text
    const toolCalls = await result.toolCalls

    const assistantMsg = aiMessage(
      text,
      toolCalls?.map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        args: ((tc as { args?: Record<string, unknown> }).args ??
          (tc as { input?: Record<string, unknown> }).input ??
          {}) as Record<string, unknown>
      }))
    )
    working.push(assistantMsg)

    if (!toolCalls?.length) break
    steps += 1

    const pending = extractPendingToolCalls(working)
    if (pending.length === 0) break

    if (runCtx.hitlEnabled) {
      const { approvalRequired, autoExecute } = partitionPendingToolCalls(pending)

      if (approvalRequired.length === 0) {
        agentLog.info(
          `[runReactLoop] read-only tools only (${autoExecute.map((t) => t.name).join(', ')}), skip HITL`
        )
        const results = await executePendingToolCalls(pending, toolsByName, ac.signal)
        working.push(...results)
        continue
      }

      const hitlId = makeHitlId(runCtx.runId, hitlRound++)
      runCtx.onPendingHitl(hitlId, approvalRequired)
      runCtx.emitHitlRequired(hitlId, approvalRequired)

      const decision: HitlUserDecision = await waitForHitlDecision(hitlId, ac.signal)
      agentLog.info(`[runReactLoop] hitl decision=${decision} hitlId=${hitlId}`)

      if (decision === 'reject') {
        const autoResults =
          autoExecute.length > 0
            ? await executePendingToolCalls(autoExecute, toolsByName, ac.signal)
            : []
        working.push(...autoResults, ...buildRejectionStateMessages(approvalRequired))
        runCtx.onToolsRejected?.(approvalRequired)
        continue
      }

      const results = await executePendingToolCalls(pending, toolsByName, ac.signal)
      working.push(...results)
      continue
    }

    const results = await executePendingToolCalls(pending, toolsByName, ac.signal)
    working.push(...results)
  }

  return working
}
