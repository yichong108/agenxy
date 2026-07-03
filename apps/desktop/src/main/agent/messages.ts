import { AGENXY_INTERNAL_KW, AGENXY_USER_DISPLAY_KW } from '@/main/agent/constants'

/**
 * 模型发起的工具调用（ReAct 循环中的 assistant tool_calls）。
 */
export type AgentToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
}

/**
 * Agent 会话消息（替代 LangChain BaseMessage）。
 *
 * 使用 `type` 字段区分角色，与历史 `getBaseMessageType` 语义一致。
 */
export type AgentMessage =
  | { type: 'human'; content: string; displayText?: string }
  | { type: 'ai'; content: string; toolCalls?: AgentToolCall[] }
  | { type: 'system'; content: string; internal?: boolean }
  | { type: 'tool'; toolCallId: string; name: string; content: string; status?: 'error' }

/**
 * 读取 Agent 消息的角色类型。
 *
 * @param msg - 会话消息
 * @returns human / ai / system / tool
 */
export function getAgentMessageType(msg: AgentMessage): string {
  return msg.type
}

/**
 * 将 message content 转为纯文本（兼容多模态数组）。
 *
 * @param content - 字符串或结构化 content
 * @returns 纯文本
 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}

/**
 * 从 messages 末尾查找最后一条 AI 消息。
 *
 * @param messages - 会话消息列表
 * @returns 最后一条 ai 消息，若无则 undefined
 */
export function findLastAiMessage(
  messages: AgentMessage[]
): Extract<AgentMessage, { type: 'ai' }> | undefined {
  const msg = [...messages].reverse().find((m) => m.type === 'ai')
  return msg as Extract<AgentMessage, { type: 'ai' }> | undefined
}

/**
 * 判断是否为内部 graph 消息（不持久化、不展示）。
 *
 * @param msg - 会话消息
 * @returns 是否标记为 internal
 */
export function isInternalAgentMessage(msg: AgentMessage): boolean {
  return msg.type === 'system' && msg.internal === true
}

/**
 * 创建用户消息。
 *
 * @param content - 发给模型的文本
 * @param displayText - UI 展示用文本（可选）
 * @returns human 消息
 */
export function humanMessage(content: string, displayText?: string): AgentMessage {
  return displayText ? { type: 'human', content, displayText } : { type: 'human', content }
}

/**
 * 创建助手消息。
 *
 * @param content - 助手文本
 * @param toolCalls - 可选工具调用列表
 * @returns ai 消息
 */
export function aiMessage(content: string, toolCalls?: AgentToolCall[]): AgentMessage {
  return toolCalls?.length ? { type: 'ai', content, toolCalls } : { type: 'ai', content }
}

/**
 * 创建系统消息。
 *
 * @param content - 系统提示
 * @param internal - 是否为内部消息（不持久化）
 * @returns system 消息
 */
export function systemMessage(content: string, internal = false): AgentMessage {
  return { type: 'system', content, internal }
}

/**
 * 创建工具结果消息。
 *
 * @param toolCallId - 关联的 tool_call id
 * @param name - 工具名
 * @param content - 工具输出
 * @param status - 可选错误状态
 * @returns tool 消息
 */
export function toolMessage(
  toolCallId: string,
  name: string,
  content: string,
  status?: 'error'
): AgentMessage {
  return status
    ? { type: 'tool', toolCallId, name, content, status }
    : { type: 'tool', toolCallId, name, content }
}

/**
 * 将 AgentMessage 列表转为 AI SDK ModelMessage 格式。
 *
 * @param messages - 会话消息
 * @returns AI SDK 可用的 model messages
 */
export function toModelMessages(messages: AgentMessage[]): Array<{
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>
  toolCallId?: string
  toolName?: string
}> {
  const out: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool'
    content: string
    toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>
    toolCallId?: string
    toolName?: string
  }> = []

  for (const msg of messages) {
    if (msg.type === 'human') {
      out.push({ role: 'user', content: msg.content })
      continue
    }
    if (msg.type === 'system' && !msg.internal) {
      out.push({ role: 'system', content: msg.content })
      continue
    }
    if (msg.type === 'ai') {
      const row: (typeof out)[number] = { role: 'assistant', content: msg.content }
      if (msg.toolCalls?.length) {
        row.toolCalls = msg.toolCalls.map((tc) => ({
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.args
        }))
      }
      out.push(row)
      continue
    }
    if (msg.type === 'tool') {
      out.push({
        role: 'tool',
        content: msg.content,
        toolCallId: msg.toolCallId,
        toolName: msg.name
      })
    }
  }
  return out
}

/** @deprecated 使用 getAgentMessageType */
export const getBaseMessageType = getAgentMessageType

/** 内部消息 additional_kwargs 键（兼容旧持久化逻辑引用） */
export { AGENXY_INTERNAL_KW, AGENXY_USER_DISPLAY_KW }
