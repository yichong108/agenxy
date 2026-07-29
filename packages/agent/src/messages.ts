import type { CoreMessage, ToolCallPart } from 'ai'

import { AGENWORK_INTERNAL_KW, AGENWORK_USER_DISPLAY_KW } from './constants.js'

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
 * 将 AgentMessage 列表转为 AI SDK CoreMessage 格式。
 *
 * assistant 的 toolCalls 必须写入 content 数组（type: 'tool-call'），
 * tool 结果必须是 content 数组（type: 'tool-result'）。
 * 顶层 `toolCalls` / 字符串 content 的 tool 消息无法通过 AI SDK 校验。
 *
 * @param messages - 会话消息
 * @returns AI SDK CoreMessage 列表，可直接传给 streamText / generateText
 */
export function toModelMessages(messages: AgentMessage[]): CoreMessage[] {
  const out: CoreMessage[] = []

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
      if (msg.toolCalls?.length) {
        const content: Array<{ type: 'text'; text: string } | ToolCallPart> = []
        if (msg.content) {
          content.push({ type: 'text', text: msg.content })
        }
        for (const tc of msg.toolCalls) {
          content.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.name,
            args: tc.args
          })
        }
        out.push({ role: 'assistant', content })
      } else {
        out.push({ role: 'assistant', content: msg.content })
      }
      continue
    }
    if (msg.type === 'tool') {
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: msg.toolCallId,
            toolName: msg.name,
            result: msg.content,
            ...(msg.status === 'error' ? { isError: true } : {})
          }
        ]
      })
    }
  }
  return out
}

/** @deprecated 使用 getAgentMessageType */
export const getBaseMessageType = getAgentMessageType

export { AGENWORK_INTERNAL_KW, AGENWORK_USER_DISPLAY_KW }
