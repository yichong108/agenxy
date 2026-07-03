export type MemoryEntry = {
  id: string
  content: string
  source: 'manual' | 'auto'
  createdAt: number
  updatedAt: number
  sourceSessionId?: string
}

export type UserMemoriesState = {
  items: MemoryEntry[]
}

export type MemoryExtractionDelta = {
  added: number
  updated: number
  deleted: number
}

export type UserMemoriesSyncPayload = UserMemoriesState & {
  lastExtractionDelta?: MemoryExtractionDelta
}

export const MAX_MEMORY_ENTRIES = 64
export const MAX_MEMORY_CONTENT_CHARS = 400
export const MAX_MEMORY_PROMPT_CHARS = 3200
