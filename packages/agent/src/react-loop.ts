/**
 * @file react-loop.ts
 * @description ReAct 循环实现
 */
import { type AppSettings } from '@agenwork/shared'
import { streamText, tool, type LanguageModel, type ToolSet } from 'ai'

import type { NamedTool } from './define-tool.js'
import { resolveChatModel } from './llm.js'
import { agentLog } from './logger.js'
import {
  type AgentMessage,
  type AgentToolCall,
  aiMessage,
  toModelMessages,
  toolMessage
} from './messages.js'

/**
 * ReAct 运行元信息。
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
 * ReAct 循环运行上下文。
 *
 * @property meta - 本次运行的标识信息
 */
export type ReactAgentRunContext = {
  meta: ReactRunMeta
}

/** 待执行的工具调用（从 AI 消息的 toolCalls 提取） */
type PendingToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
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

/**
 * 从 messages 末尾 AI 消息提取待执行 tool_calls。
 *
 * @param messages - 会话消息
 * @returns 待处理工具调用列表
 */
function extractPendingToolCalls(messages: AgentMessage[]): PendingToolCall[] {
  const lastAi = [...messages].reverse().find((m) => m.type === 'ai')
  if (!lastAi?.toolCalls?.length) return []
  return lastAi.toolCalls.map((tc: AgentToolCall, idx: number) => ({
    id: tc.id ?? `${tc.name}-${idx}`,
    name: tc.name,
    args: tc.args
  }))
}

/**
 * 依次执行待处理工具调用，收集 tool 结果消息。
 *
 * @param pending - 待执行工具调用
 * @param toolsByName - 工具名到实现的映射
 * @param signal - 可选取消信号
 * @returns tool 结果消息列表
 */
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
 * 运行 ReAct 循环：流式生成 + 手动工具执行。
 *
 * 实现 ReAct 循环核心原理。
 *
 * @param settings - 应用设置
 * @param systemPrompt - system 提示
 * @param messages - 初始会话消息
 * @param tools - 可用工具
 * @param ac - 取消控制器
 * @param onToken - 流式 token 回调
 * @param options - recursionLimit、timeout
 * @param runCtx - ReAct 运行上下文
 * @param provider - createAgent 可选注入的模型；未传则从 settings 解析
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
  runCtx: ReactAgentRunContext,
  provider?: LanguageModel | null
): Promise<AgentMessage[]> {
  const { recursionLimit, timeoutMs } = options
  const model = resolveChatModel(settings, provider)
  if (!model) {
    throw new Error('请先在设置中配置 API Key，或向 createAgent 传入 provider')
  }
  const toolsByName = new Map(tools.map((t) => [t.name, t]))

  const toolSet = buildToolDeclarations(tools)
  const working = [...messages]
  let steps = 0

  const deadline = Date.now() + timeoutMs

  agentLog.info(`[runReactLoop] runId=${runCtx.meta.runId} recursionLimit=${recursionLimit}`)

  while (steps < recursionLimit) {
    if (ac.signal.aborted) throw new Error('Aborted')
    if (Date.now() > deadline) {
      ac.abort()
      throw new Error(`Model-tool loop timeout (>${timeoutMs}ms), run aborted`)
    }

    const result = streamText({
      model,
      system: systemPrompt,
      messages: toModelMessages(working),
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

    const pending = extractPendingToolCalls(working)
    if (pending.length === 0) break

    const results = await executePendingToolCalls(pending, toolsByName, ac.signal)
    working.push(...results)
  }

  return working
}
