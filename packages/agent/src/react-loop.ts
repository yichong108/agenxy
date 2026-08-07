/**
 * @file react-loop.ts
 * @description ReAct 循环实现（基于 AI SDK CoreMessage + ToolSet）
 */
import { defaultSettings, MAX_AGENT_LOOP_STEPS } from '@openworker/shared'
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

/**
 * 构建仅用于模型声明的 ToolSet（去掉 execute，避免 streamText 自动执行）。
 *
 * ReAct 循环手动调用 Tool.execute，以便控制工具观察上报、错误与取消语义。
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
 * 构造单条 tool 结果消息。
 *
 * 如果把完整 tools（含 execute）直接传给 streamText，SDK 在模型返回 tool_calls 后会自动执行（即使默认 maxSteps: 1）。
 *
 * @param tc - 对应的工具调用
 * @param result - 执行结果（保留结构化对象；provider 发送前再序列化）
 * @returns AI SDK tool 消息
 */
function toolResultMessage(tc: ToolCallPart, result: unknown): CoreToolMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        result
      }
    ]
  }
}

/**
 * 依次执行工具调用，收集 tool 结果消息。
 *
 * @param toolCalls - streamText 返回的工具调用
 * @param tools - AI SDK ToolSet
 * @param messages - 传给 ToolExecutionOptions.messages：发起本轮 tool call 前的会话快照
 *   （不含顶层 system，也不含本轮带 tool-call 的 assistant，与 AI SDK 约定一致）
 * @param signal - 可选取消信号
 * @returns AI SDK tool 结果消息列表
 */
async function executeToolCalls(
  toolCalls: ToolCallPart[],
  tools: ToolSet,
  messages: CoreMessage[],
  signal?: AbortSignal
): Promise<CoreToolMessage[]> {
  const out: CoreToolMessage[] = []
  for (const tc of toolCalls) {
    const impl = tools[tc.toolName]
    if (!impl?.execute) {
      // 失败时仍把错误信息写进 result，靠文案让模型感知失败
      out.push(toolResultMessage(tc, `Tool not found: ${tc.toolName}`))
      continue
    }
    try {
      const result = await impl.execute(tc.args, {
        toolCallId: tc.toolCallId,
        messages,
        abortSignal: signal
      })
      out.push(toolResultMessage(tc, result))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      out.push(toolResultMessage(tc, message))
    }
  }
  return out
}

/**
 * 根据流式结果构造 assistant CoreMessage。
 *
 * @param text - 助手文本
 * @param toolCalls - streamText 返回的工具调用
 * @returns assistant 消息
 */
function buildAssistantMessage(text: string, toolCalls: ToolCallPart[]): CoreAssistantMessage {
  if (!toolCalls.length) {
    return { role: 'assistant', content: text }
  }

  const content: Array<{ type: 'text'; text: string } | ToolCallPart> = []
  if (text) {
    content.push({ type: 'text', text })
  }
  content.push(...toolCalls)
  return { role: 'assistant', content }
}

/**
 * ReAct 循环
 *
 * 入参与返回均为 AI SDK `CoreMessage` / `ToolSet`，可直接对接 streamText。
 *
 * 每步文本先经 `onToken` 增量流出（打字机效果）；步结束时再分流：
 * - 本步有 tool calls → `onTextRevoke`（撤回已流出的 Result）+ `onThinking`（进入 Worked → Thought）
 * - 本步无 tool calls → 保留已流出的 delta 作为最终 Result（不再整段重发）
 *
 * @param model - 已解析的 AI SDK LanguageModel
 * @param systemPrompt - system 提示
 * @param messages - 初始会话消息（AI SDK CoreMessage）
 * @param tools - 可用工具（AI SDK ToolSet）
 * @param ac - 取消控制器
 * @param onToken - 文本增量回调（流式；收尾步保留，工具步随后 revoke）
 * @param maxSteps - 最大工具调用轮次；缺省时使用 MAX_AGENT_LOOP_STEPS
 * @param timeoutMs - 循环超时（毫秒）；缺省时使用 defaultSettings.agentRunTimeoutMs
 * @param onThinking - 过程思考回调（有工具的中间步文本）
 * @param onTextRevoke - 撤回本步已通过 onToken 流出的 Result 文本（工具步在 onThinking 前调用）
 * @returns 运行结束后的 CoreMessage 列表（含输入消息与本轮新增）
 */
export async function runReactLoop(
  model: LanguageModel,
  systemPrompt: string,
  messages: CoreMessage[],
  tools: ToolSet,
  ac: AbortController,
  onToken: (token: string) => void,
  maxSteps?: number,
  timeoutMs?: number,
  onThinking?: (text: string, durationMs?: number) => void,
  onTextRevoke?: () => void
): Promise<CoreMessage[]> {
  const resolvedMaxSteps = maxSteps ?? MAX_AGENT_LOOP_STEPS
  const resolvedTimeoutMs = timeoutMs ?? defaultSettings.agentRunTimeoutMs

  const declarations = buildToolDeclarations(tools)
  const working = [...messages]
  let steps = 0

  const deadline = Date.now() + resolvedTimeoutMs

  while (steps < resolvedMaxSteps) {
    if (ac.signal.aborted) throw new Error('Aborted')
    if (Date.now() > deadline) {
      ac.abort()
      throw new Error(`Model-tool loop timeout (>${resolvedTimeoutMs}ms), run aborted`)
    }

    const stepStartedAt = Date.now()

    // messages 里不要塞 role: 'system'，避免和顶层 system 重复
    const result = streamText({
      model,
      system: systemPrompt,
      messages: working,
      tools: declarations,
      abortSignal: ac.signal
    })

    // 增量流出以保留打字机效果；若本步最终伴有 tool calls，再 revoke + 转入 Thought
    let stepText = ''
    let streamedLen = 0
    for await (const chunk of result.fullStream) {
      if (chunk.type === 'text-delta') {
        if (chunk.textDelta) {
          stepText += chunk.textDelta
          onToken(chunk.textDelta)
          streamedLen += chunk.textDelta.length
        }
      }
    }

    const text = (await result.text) || stepText
    const toolCalls = await result.toolCalls
    const stepDurationMs = Date.now() - stepStartedAt

    if (toolCalls.length > 0) {
      if (streamedLen > 0) onTextRevoke?.()
      if (text.trim()) onThinking?.(text, stepDurationMs)
    } else if (streamedLen === 0 && text.trim()) {
      // 无 delta 仅整段 text 的兜底（部分 provider / 模拟实现）
      onToken(text)
    }

    // ToolExecutionOptions.messages：不含 system，也不含本轮带 tool-call 的 assistant
    const messagesForTool = working.slice()

    working.push(buildAssistantMessage(text, toolCalls))

    // 有 tool calls → 继续「执行工具 → 再调用模型」
    // 没有 tool calls → 任务收尾，返回完整 working
    if (toolCalls.length === 0) break
    steps += 1

    working.push(...(await executeToolCalls(toolCalls, tools, messagesForTool, ac.signal)))
  }

  return working
}
