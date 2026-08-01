/**
 * @file messages.ts
 * @description 基于 AI SDK CoreMessage 的会话消息辅助函数
 */
import type { CoreAssistantMessage, CoreMessage, CoreUserMessage } from 'ai'

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
 * 创建用户消息（AI SDK CoreUserMessage）。
 *
 * @param content - 发给模型的文本
 * @returns user 消息
 */
export function userMessage(content: string): CoreUserMessage {
  return { role: 'user', content }
}

/**
 * 创建助手文本消息（无 tool-call）。
 *
 * @param content - 助手文本
 * @returns assistant 消息
 */
export function assistantMessage(content: string): CoreAssistantMessage {
  return { role: 'assistant', content }
}

/**
 * 从 messages 末尾查找最后一条 assistant 消息。
 *
 * @param messages - AI SDK CoreMessage 列表
 * @returns 最后一条 assistant 消息，若无则 undefined
 */
export function findLastAssistantMessage(
  messages: CoreMessage[]
): CoreAssistantMessage | undefined {
  return [...messages].reverse().find((m): m is CoreAssistantMessage => m.role === 'assistant')
}

/** @deprecated 使用 findLastAssistantMessage */
export const findLastAiMessage = findLastAssistantMessage

export type { CoreMessage, CoreAssistantMessage, CoreUserMessage }
