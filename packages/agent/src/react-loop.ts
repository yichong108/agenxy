/**
 * @file react-loop.ts
 * @description ReAct 循环实现
 */
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

/**
 * ReAct 运行元信息。
 *
 * 将本次运行的标识信息集中管理，避免与 HITL 桥接能力混在同一层级。
 *
 * @property sessionId - 当前会话 ID
 * @property runId - 当前运行 ID
 * @property traceId - 当前链路追踪 ID
 */
export type ReactRunMeta = {
  sessionId: string
  runId: string
  traceId: string
}

/**
 * ReAct 与宿主之间的 HITL 桥接能力。
 *
 * 将审批开关与相关事件回调聚合到单独对象，减少运行上下文的职责混杂。
 *
 * @property enabled - 是否启用 HITL
 * @property onPending - 记录待审批工具调用
 * @property emitRequired - 向宿主发出需要审批的事件
 * @property onRejected - 审批被拒绝后的宿主回调
 */
export type ReactHitlBridge = {
  enabled: boolean
  onPending: (hitlId: string, toolCalls: PendingToolCall[]) => void
  emitRequired: (hitlId: string, toolCalls: PendingToolCall[]) => void
  onRejected?: (toolCalls: PendingToolCall[]) => void
}

/**
 * ReAct 循环运行上下文。
 *
 * 将纯元信息与 HITL 桥接能力分层组织，避免把运行期内部状态塞入上下文对象。
 *
 * @property meta - 本次运行的标识信息
 * @property hitl - 人工审批桥接配置
 */
export type ReactAgentRunContext = {
  meta: ReactRunMeta
  hitl: ReactHitlBridge
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

async function handleHitlRound(args: {
  pending: PendingToolCall[]
  toolsByName: Map<string, NamedTool>
  runCtx: ReactAgentRunContext
  hitlRound: number
  signal?: AbortSignal
}): Promise<AgentMessage[]> {
  const { pending, toolsByName, runCtx, hitlRound, signal } = args
  const { approvalRequired, autoExecute } = partitionPendingToolCalls(pending)

  if (approvalRequired.length === 0) {
    agentLog.info(
      `[runReactLoop] read-only tools only (${autoExecute.map((t) => t.name).join(', ')}), skip HITL`
    )
    return executePendingToolCalls(pending, toolsByName, signal)
  }

  const hitlId = makeHitlId(runCtx.meta.runId, hitlRound)
  runCtx.hitl.onPending(hitlId, approvalRequired)
  runCtx.hitl.emitRequired(hitlId, approvalRequired)

  const decision: HitlUserDecision = await waitForHitlDecision(hitlId, signal)
  agentLog.info(`[runReactLoop] hitl decision=${decision} hitlId=${hitlId}`)

  if (decision === 'reject') {
    const autoResults =
      autoExecute.length > 0 ? await executePendingToolCalls(autoExecute, toolsByName, signal) : []
    runCtx.hitl.onRejected?.(approvalRequired)
    return [...autoResults, ...buildRejectionStateMessages(approvalRequired)]
  }

  return executePendingToolCalls(pending, toolsByName, signal)
}

/**
 * 运行 ReAct 循环：流式生成 + 手动工具执行 + Build 模式 HITL。
 * 
 * 实现ReAct循环核心原理。
 *
 * @param settings - 应用设置
 * @param systemPrompt - system 提示
 * @param messages - 初始会话消息
 * @param tools - 可用工具
 * @param ac - 取消控制器
 * @param onToken - 流式 token 回调
 * @param options - recursionLimit、timeout
 * @param runCtx - ReAct 运行上下文
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

  const toolSet = buildToolDeclarations(tools)
  const working = [...messages]
  let steps = 0
  let hitlRound = 0

  const deadline = Date.now() + timeoutMs

  agentLog.info(
    `[runReactLoop] runId=${runCtx.meta.runId} hitl=${runCtx.hitl.enabled} recursionLimit=${recursionLimit}`
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
        if (chunk.textDelta) onToken(chunk.textDelta)
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

    // 提取待执行的工具调用
    const pending = extractPendingToolCalls(working)
    if (pending.length === 0) break

    if (runCtx.hitl.enabled) {
      const hitlMessages = await handleHitlRound({
        pending,
        toolsByName,
        runCtx,
        hitlRound: hitlRound++,
        signal: ac.signal
      })
      working.push(...hitlMessages)
      continue
    }

    const results = await executePendingToolCalls(pending, toolsByName, ac.signal)
    working.push(...results)
  }

  return working
}
