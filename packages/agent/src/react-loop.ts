/**
 * @file react-loop.ts
 * @description ReAct 循环实现（基于 AI SDK CoreMessage + ToolSet）
 */
import {
  streamText,
  type CoreAssistantMessage,
  type CoreMessage,
  type CoreToolMessage,
  type LanguageModel,
  type Tool,
  type ToolCallPart,
  type ToolSet
} from 'ai'

/** 待执行的工具调用（从 assistant 消息的 tool-call parts 提取） */
type PendingToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
}

/**
 * 构建仅用于模型声明的 ToolSet（去掉 execute，避免 streamText 自动执行）。
 *
 * ReAct 循环手动调用 Tool.execute，以便控制 timeline、错误与取消语义。
 *
 * @param tools - 完整 ToolSet（含 execute）
 * @returns 仅含 parameters/description 的声明用 ToolSet
 */
function buildToolDeclarations(tools: ToolSet): ToolSet {
  const set: ToolSet = {}
  for (const [name, t] of Object.entries(tools)) {
    set[name] = {
      description: t.description,
      parameters: t.parameters
    } as Tool
  }
  return set
}

/**
 * 从 messages 末尾 assistant 消息提取待执行 tool_calls。
 *
 * @param messages - AI SDK CoreMessage 列表
 * @returns 待处理工具调用列表
 */
function extractPendingToolCalls(messages: CoreMessage[]): PendingToolCall[] {
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  if (!lastAssistant) return []
  const content = lastAssistant.content
  if (typeof content === 'string') return []
  return content
    .filter((part): part is ToolCallPart => part.type === 'tool-call')
    .map((tc, idx) => ({
      id: tc.toolCallId || `${tc.toolName}-${idx}`,
      name: tc.toolName,
      args: (tc.args ?? {}) as Record<string, unknown>
    }))
}

/**
 * 依次执行待处理工具调用，收集 tool 结果消息。
 *
 * @param pending - 待执行工具调用
 * @param tools - AI SDK ToolSet
 * @param messages - 当前会话（传给 ToolExecutionOptions）
 * @param signal - 可选取消信号
 * @returns AI SDK tool 结果消息列表
 */
async function executePendingToolCalls(
  pending: PendingToolCall[],
  tools: ToolSet,
  messages: CoreMessage[],
  signal?: AbortSignal
): Promise<CoreToolMessage[]> {
  const out: CoreToolMessage[] = []
  for (const tc of pending) {
    const impl = tools[tc.name]
    if (!impl?.execute) {
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: tc.id,
            toolName: tc.name,
            result: `Tool not found: ${tc.name}`,
            isError: true
          }
        ]
      })
      continue
    }
    try {
      const result = await impl.execute(tc.args, {
        toolCallId: tc.id,
        messages,
        abortSignal: signal
      })
      const content = typeof result === 'string' ? result : JSON.stringify(result)
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: tc.id,
            toolName: tc.name,
            result: content
          }
        ]
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: tc.id,
            toolName: tc.name,
            result: message,
            isError: true
          }
        ]
      })
    }
  }
  return out
}

/**
 * 根据 streamText 结果构造 assistant CoreMessage。
 *
 * @param text - 助手文本
 * @param toolCalls - AI SDK 返回的工具调用
 * @returns assistant 消息
 */
function buildAssistantMessage(
  text: string,
  toolCalls: Array<{
    toolCallId: string
    toolName: string
    args?: unknown
    input?: unknown
  }>
): CoreAssistantMessage {
  if (!toolCalls.length) {
    return { role: 'assistant', content: text }
  }

  const content: Array<{ type: 'text'; text: string } | ToolCallPart> = []
  if (text) {
    content.push({ type: 'text', text })
  }
  for (const tc of toolCalls) {
    content.push({
      type: 'tool-call',
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: (tc.args ?? tc.input ?? {}) as Record<string, unknown>
    })
  }
  return { role: 'assistant', content }
}

/**
 * 运行 ReAct 循环：流式生成 + 手动工具执行。
 *
 * 入参与返回均为 AI SDK `CoreMessage` / `ToolSet`，可直接对接 streamText。
 *
 * @param model - 已解析的 AI SDK LanguageModel
 * @param systemPrompt - system 提示
 * @param messages - 初始会话消息（AI SDK CoreMessage）
 * @param tools - 可用工具（AI SDK ToolSet）
 * @param ac - 取消控制器
 * @param onToken - 流式 token 回调
 * @param recursionLimit - 最大工具调用轮次
 * @param timeoutMs - 循环超时（毫秒）
 * @returns 运行结束后的 CoreMessage 列表（含输入消息与本轮新增）
 */
export async function runReactLoop(
  model: LanguageModel,
  systemPrompt: string,
  messages: CoreMessage[],
  tools: ToolSet,
  ac: AbortController,
  onToken: (token: string) => void,
  recursionLimit: number,
  timeoutMs: number
): Promise<CoreMessage[]> {
  const declarations = buildToolDeclarations(tools)
  const working = [...messages]
  let steps = 0

  const deadline = Date.now() + timeoutMs

  while (steps < recursionLimit) {
    if (ac.signal.aborted) throw new Error('Aborted')
    if (Date.now() > deadline) {
      ac.abort()
      throw new Error(`Model-tool loop timeout (>${timeoutMs}ms), run aborted`)
    }

    const result = streamText({
      model,
      system: systemPrompt,
      messages: working,
      tools: declarations,
      abortSignal: ac.signal
    })

    for await (const chunk of result.fullStream) {
      if (chunk.type === 'text-delta') {
        if (chunk.textDelta) onToken(chunk.textDelta)
      }
    }

    const text = await result.text
    const toolCalls = await result.toolCalls

    working.push(buildAssistantMessage(text, toolCalls ?? []))

    if (!toolCalls?.length) break
    steps += 1

    const pending = extractPendingToolCalls(working)
    if (pending.length === 0) break

    const results = await executePendingToolCalls(pending, tools, working, ac.signal)
    working.push(...results)
  }

  return working
}
