import {
  addMemory,
  deleteMemory,
  listMemories,
  updateMemory
} from '@/main/memory/memory-service'
import { getSettings } from '@/main/store'
import { MAX_MEMORY_CONTENT_CHARS } from '@/shared/ipc'

function memoryDisabledMessage(): string {
  return 'User memory is disabled in app settings. Ask the user to enable it under 用户记忆 or Settings.'
}

export function userMemoryList(): string {
  const settings = getSettings()
  if (settings.memoryEnabled === false) return memoryDisabledMessage()
  const { items } = listMemories()
  if (!items.length) return 'No saved user memories.'
  return items.map((m) => `[${m.id}] (${m.source}) ${m.content}`).join('\n')
}

export function userMemoryAdd(content: string, sessionId?: string): string {
  const settings = getSettings()
  if (settings.memoryEnabled === false) return memoryDisabledMessage()
  const trimmed = content.trim()
  if (!trimmed) return 'Error: content must not be empty.'
  if (trimmed.length > MAX_MEMORY_CONTENT_CHARS) {
    return `Error: content exceeds ${MAX_MEMORY_CONTENT_CHARS} characters.`
  }
  const state = addMemory(trimmed, { source: 'manual', sourceSessionId: sessionId })
  const added = state.items[0]
  return added ? `Added memory [${added.id}]: ${added.content}` : 'Failed to add memory.'
}

export function userMemoryUpdate(id: string, content: string): string {
  const settings = getSettings()
  if (settings.memoryEnabled === false) return memoryDisabledMessage()
  const trimmed = content.trim()
  if (!id.trim()) return 'Error: id is required.'
  if (!trimmed) return 'Error: content must not be empty.'
  const prev = listMemories()
  if (!prev.items.some((m) => m.id === id.trim())) {
    return `Error: no memory with id ${id.trim()}.`
  }
  const state = updateMemory(id.trim(), trimmed)
  const row = state.items.find((m) => m.id === id.trim())
  return row ? `Updated memory [${row.id}]: ${row.content}` : 'Failed to update memory.'
}

export function userMemoryDelete(id: string): string {
  const settings = getSettings()
  if (settings.memoryEnabled === false) return memoryDisabledMessage()
  if (!id.trim()) return 'Error: id is required.'
  const prev = listMemories()
  if (!prev.items.some((m) => m.id === id.trim())) {
    return `Error: no memory with id ${id.trim()}.`
  }
  deleteMemory(id.trim())
  return `Deleted memory [${id.trim()}].`
}
