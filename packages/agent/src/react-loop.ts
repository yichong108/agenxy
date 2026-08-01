/**
 * @file react-loop.ts
 * @description ReAct 循环实现（基于 AI SDK CoreMessage + ToolSet）
 */
import { defaultSettings, MAX_AGENT_LOOP_STEPS } from '@agenwork/shared'
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
 * 构造单条 tool 结果消息。
 * 
 * 如果把完整 tools（含 execute）直接传给 streamText，SDK 在模型返回 tool_calls 后会自动执行（即使默认 maxSteps: 1）。
 *
 * @param tc - 对应的工具调用
 * @param result - 执行结果文本
 * @param isError - 是否为错误结果
 * @returns AI SDK tool 消息
 */
function toolResultMessage(tc: ToolCallPart, result: string, isError?: boolean): CoreToolMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        result,
        ...(isError ? { isError: true } : {})
      }
    ]
  }
}

/**
 * 依次执行工具调用，收集 tool 结果消息。
 *
 * @param toolCalls - streamText 返回的工具调用
 * @param tools - AI SDK ToolSet
 * @param messages - 当前会话（传给 ToolExecutionOptions）
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
      out.push(toolResultMessage(tc, `Tool not found: ${tc.toolName}`, true))
      continue
    }
    try {
      const result = await impl.execute(tc.args, {
        toolCallId: tc.toolCallId,
        messages,
        abortSignal: signal
      })
      const content = typeof result === 'string' ? result : JSON.stringify(result)
      out.push(toolResultMessage(tc, content))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      out.push(toolResultMessage(tc, message, true))
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
 * @param maxSteps - 最大工具调用轮次；缺省时使用 MAX_AGENT_LOOP_STEPS
 * @param timeoutMs - 循环超时（毫秒）；缺省时使用 defaultSettings.agentRunTimeoutMs
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
  timeoutMs?: number
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

    working.push(buildAssistantMessage(text, toolCalls))

    if (toolCalls.length === 0) break
    steps += 1

    working.push(...(await executeToolCalls(toolCalls, tools, working, ac.signal)))
  }

  return working
}
