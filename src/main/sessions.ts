import { randomUUID } from 'node:crypto'
import { clearSessionState, initSessionState } from './agent/agent-service.js'
import { getSessionsMeta, setSessionsMeta } from './store.js'
import type { SessionInfo } from '../shared/ipc.js'

let list: SessionInfo[] = []
let nameCounter = 1

function persist(): void {
  setSessionsMeta([...list])
}

export function loadSessionList(): SessionInfo[] {
  list = getSessionsMeta()
  if (list.length === 0) {
    createSession('新会话 1', false)
    persist()
  }
  for (const s of list) {
    initSessionState(s.id)
  }
  return list
}

export function getSessions(): SessionInfo[] {
  return [...list]
}

export function getSessionById(id: string): SessionInfo | undefined {
  return list.find((s) => s.id === id)
}

export function touchSession(id: string): void {
  const s = list.find((x) => x.id === id)
  if (!s) return
  s.updatedAt = Date.now()
  persist()
}

export function createSession(name?: string, persistMeta = true): SessionInfo {
  if (!name) {
    name = `新会话 ${nameCounter++}`
  }
  const s: SessionInfo = {
    id: randomUUID(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  list.push(s)
  initSessionState(s.id)
  if (persistMeta) persist()
  return s
}

export function renameSession(id: string, name: string): SessionInfo | null {
  const s = list.find((x) => x.id === id)
  if (!s) return null
  s.name = name
  s.updatedAt = Date.now()
  persist()
  return s
}

export function deleteSession(id: string): boolean {
  const i = list.findIndex((x) => x.id === id)
  if (i < 0) return false
  list.splice(i, 1)
  clearSessionState(id)
  if (list.length === 0) {
    createSession(undefined, false)
  }
  persist()
  return true
}
