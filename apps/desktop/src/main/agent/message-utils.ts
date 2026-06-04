import { AIMessage, type BaseMessage } from '@langchain/core/messages'

/**
 * 读取 LangChain 消息的 type 字段（兼容 getType / _getType）。
 */
export function getBaseMessageType(msg: BaseMessage): string {
  const maybeGetType = (msg as { getType?: () => string }).getType
  if (typeof maybeGetType === 'function') return maybeGetType.call(msg)
  const maybeInternalType = (msg as { _getType?: () => string })._getType
  if (typeof maybeInternalType === 'function') return maybeInternalType.call(msg)
  return ''
}

/**
 * 将 message content（string 或多模态数组）转为纯文本。
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
 */
export function findLastAiMessage(messages: BaseMessage[]): AIMessage | undefined {
  const msg = [...messages].reverse().find((m) => getBaseMessageType(m) === 'ai')
  return msg as AIMessage | undefined
}
