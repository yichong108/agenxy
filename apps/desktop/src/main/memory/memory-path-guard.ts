import path from 'node:path'

/** Basenames agents must not use for ad-hoc memory files in the workspace. */
const RESERVED_MEMORY_FILE_NAMES = new Set([
  '.claude-memory.json',
  '.cursor-memory.json',
  '.agenxy-memory.json',
  'claude-memory.json',
  'cursor-memory.json',
  'agenxy-memory.json',
  'user-memory.json',
  'memories.json'
])

export function isReservedMemoryFilePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const base = path.basename(normalized).toLowerCase()
  return RESERVED_MEMORY_FILE_NAMES.has(base)
}

export const MEMORY_FILE_GUARD_MESSAGE =
  '请勿在工作区文件中存储用户记忆。请使用 user_memory_add / user_memory_update / user_memory_delete（应用全局记忆：设置 → 用户记忆）。'
