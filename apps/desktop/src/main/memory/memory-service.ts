import { randomUUID } from 'node:crypto'

import type { WebContents } from 'electron'

import { logScope } from '@/main/logger'
import { getSettings, getUserMemories, setUserMemories } from '@/main/store'
import {
  EVENTS,
  MAX_MEMORY_CONTENT_CHARS,
  MAX_MEMORY_ENTRIES,
  MAX_MEMORY_PROMPT_CHARS,
  type AppSettings,
  type MemoryEntry,
  type MemoryExtractionDelta,
  type UserMemoriesState,
  type UserMemoriesSyncPayload
} from '@/shared/ipc'

const memLog = logScope('memory')

let syncWebContents: WebContents | null = null

export function bindMemorySync(wc: WebContents): void {
  syncWebContents = wc
}

function broadcastMemorySync(
  state: UserMemoriesState,
  lastExtractionDelta?: MemoryExtractionDelta
): void {
  if (!syncWebContents || syncWebContents.isDestroyed()) return
  const payload: UserMemoriesSyncPayload = {
    ...state,
    ...(lastExtractionDelta ? { lastExtractionDelta } : {})
  }
  syncWebContents.send(EVENTS.MEMORY_SYNC, payload)
}

export function listMemories(): UserMemoriesState {
  return getUserMemories()
}

export function addMemory(
  content: string,
  opts?: { source?: MemoryEntry['source']; sourceSessionId?: string }
): UserMemoriesState {
  const entry = normalizeNewEntry(content, opts)
  if (!entry) return getUserMemories()
  const prev = getUserMemories()
  const next = setUserMemories({ items: [entry, ...prev.items] })
  broadcastMemorySync(next)
  return next
}

export function updateMemory(id: string, content: string): UserMemoriesState {
  const trimmed = content.trim().slice(0, MAX_MEMORY_CONTENT_CHARS)
  if (!trimmed) return getUserMemories()
  const prev = getUserMemories()
  const now = Date.now()
  let found = false
  const items = prev.items.map((row) => {
    if (row.id !== id) return row
    found = true
    return { ...row, content: trimmed, updatedAt: now }
  })
  if (!found) return prev
  const next = setUserMemories({ items })
  broadcastMemorySync(next)
  return next
}

export function deleteMemory(id: string): UserMemoriesState {
  const prev = getUserMemories()
  const items = prev.items.filter((row) => row.id !== id)
  if (items.length === prev.items.length) return prev
  const next = setUserMemories({ items })
  broadcastMemorySync(next)
  return next
}

export function clearMemories(): UserMemoriesState {
  const next = setUserMemories({ items: [] })
  broadcastMemorySync(next)
  return next
}

function normalizeNewEntry(
  content: string,
  opts?: { source?: MemoryEntry['source']; sourceSessionId?: string }
): MemoryEntry | null {
  const trimmed = content.trim().slice(0, MAX_MEMORY_CONTENT_CHARS)
  if (!trimmed) return null
  const now = Date.now()
  const entry: MemoryEntry = {
    id: `mem-${randomUUID()}`,
    content: trimmed,
    source: opts?.source === 'auto' ? 'auto' : 'manual',
    createdAt: now,
    updatedAt: now
  }
  if (opts?.sourceSessionId?.trim()) {
    entry.sourceSessionId = opts.sourceSessionId.trim()
  }
  return entry
}

export type MemoryExtractionAction = {
  op: 'add' | 'update' | 'delete'
  id?: string
  content?: string
}

export function applyMemoryExtractionActions(
  actions: MemoryExtractionAction[],
  opts?: { sourceSessionId?: string }
): { state: UserMemoriesState; delta: MemoryExtractionDelta } {
  const delta: MemoryExtractionDelta = { added: 0, updated: 0, deleted: 0 }
  if (!actions.length) {
    return { state: getUserMemories(), delta }
  }

  let items = [...getUserMemories().items]
  const now = Date.now()

  for (const action of actions) {
    if (action.op === 'delete') {
      const id = action.id?.trim()
      if (!id) continue
      const before = items.length
      items = items.filter((row) => row.id !== id)
      if (items.length < before) delta.deleted += 1
      continue
    }

    if (action.op === 'update') {
      const id = action.id?.trim()
      const content = action.content?.trim().slice(0, MAX_MEMORY_CONTENT_CHARS)
      if (!id || !content) continue
      let hit = false
      items = items.map((row) => {
        if (row.id !== id) return row
        hit = true
        return { ...row, content, updatedAt: now, source: 'auto' as const }
      })
      if (hit) delta.updated += 1
      continue
    }

    if (action.op === 'add') {
      const content = action.content?.trim().slice(0, MAX_MEMORY_CONTENT_CHARS)
      if (!content) continue
      if (items.length >= MAX_MEMORY_ENTRIES) {
        memLog.warn('[applyMemoryExtractionActions] at capacity, skipping add')
        continue
      }
      const entry: MemoryEntry = {
        id: `mem-${randomUUID()}`,
        content,
        source: 'auto',
        createdAt: now,
        updatedAt: now
      }
      if (opts?.sourceSessionId?.trim()) {
        entry.sourceSessionId = opts.sourceSessionId.trim()
      }
      items.unshift(entry)
      delta.added += 1
    }
  }

  items.sort((a, b) => b.updatedAt - a.updatedAt)
  const state = setUserMemories({ items: items.slice(0, MAX_MEMORY_ENTRIES) })
  if (delta.added + delta.updated + delta.deleted > 0) {
    broadcastMemorySync(state, delta)
  }
  return { state, delta }
}

export function buildMemoryPromptBlock(settings?: AppSettings): string {
  const s = settings ?? getSettings()
  if (s.memoryEnabled === false) return ''

  const items = getUserMemories().items
  if (!items.length) return ''

  const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt)
  const lines: string[] = []
  let usedChars = 0
  const header =
    '## User memories (global, persistent)\n' +
    'The following facts about the user were saved in the app (not workspace files). Use when relevant; do not contradict unless the user corrects you. Do not mention this section unless asked.\n' +
    'To remember or forget facts when the user asks, use tools user_memory_add / user_memory_update / user_memory_delete — never write .claude-memory.json or similar files in the workspace.'

  for (const row of sorted) {
    const line = `- [${row.id}] ${row.content}`
    if (usedChars + line.length + 1 > MAX_MEMORY_PROMPT_CHARS) break
    lines.push(line)
    usedChars += line.length + 1
  }

  if (!lines.length) return ''
  return `${header}\n${lines.join('\n')}`
}
