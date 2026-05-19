import {
  addMemory,
  deleteMemory,
  listMemories,
  updateMemory
} from '@/main/memory/memory-service'
import { getSettings } from '@/main/store'
import { MAX_MEMORY_CONTENT_CHARS } from '@/shared/ipc'

function memoryDisabledMessage(): string {
  return '应用设置中已关闭用户记忆。请在「用户记忆」或设置中开启。'
}

export function userMemoryList(): string {
  const settings = getSettings()
  if (settings.memoryEnabled === false) return memoryDisabledMessage()
  const { items } = listMemories()
  if (!items.length) return '暂无已保存的用户记忆。'
  return items.map((m) => `[${m.id}] (${m.source}) ${m.content}`).join('\n')
}

export function userMemoryAdd(content: string, sessionId?: string): string {
  const settings = getSettings()
  if (settings.memoryEnabled === false) return memoryDisabledMessage()
  const trimmed = content.trim()
  if (!trimmed) return '错误：内容不能为空。'
  if (trimmed.length > MAX_MEMORY_CONTENT_CHARS) {
    return `错误：内容超过 ${MAX_MEMORY_CONTENT_CHARS} 个字符。`
  }
  const state = addMemory(trimmed, { source: 'manual', sourceSessionId: sessionId })
  const added = state.items[0]
  return added ? `已添加记忆 [${added.id}]：${added.content}` : '添加记忆失败。'
}

export function userMemoryUpdate(id: string, content: string): string {
  const settings = getSettings()
  if (settings.memoryEnabled === false) return memoryDisabledMessage()
  const trimmed = content.trim()
  if (!id.trim()) return '错误：必须提供 id。'
  if (!trimmed) return '错误：内容不能为空。'
  const prev = listMemories()
  if (!prev.items.some((m) => m.id === id.trim())) {
    return `错误：不存在 id 为 ${id.trim()} 的记忆。`
  }
  const state = updateMemory(id.trim(), trimmed)
  const row = state.items.find((m) => m.id === id.trim())
  return row ? `已更新记忆 [${row.id}]：${row.content}` : '更新记忆失败。'
}

export function userMemoryDelete(id: string): string {
  const settings = getSettings()
  if (settings.memoryEnabled === false) return memoryDisabledMessage()
  if (!id.trim()) return '错误：必须提供 id。'
  const prev = listMemories()
  if (!prev.items.some((m) => m.id === id.trim())) {
    return `错误：不存在 id 为 ${id.trim()} 的记忆。`
  }
  deleteMemory(id.trim())
  return `已删除记忆 [${id.trim()}]。`
}
