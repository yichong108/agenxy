import { randomUUID } from 'node:crypto'

import { clearSessionState, initSessionState } from '@/main/agent/agent-service'
import {
  getActiveWorkspaceId,
  deleteSessionMessages,
  getAllSessionsMetaByWorkspace,
  getSessionsMeta,
  listWorkspaces,
  moveWorkspaceSessionData,
  setSessionsMeta
} from '@/main/store'
import type { SessionInfo } from '@/shared/ipc'

const listByWorkspace = new Map<string, SessionInfo[]>()
const nameCounterByWorkspace = new Map<string, number>()
const sessionWorkspaceMap = new Map<string, string>()

function persist(workspaceId: string): void {
  const list = listByWorkspace.get(workspaceId) || []
  setSessionsMeta(workspaceId, [...list])
}

function touchWorkspaceCounter(workspaceId: string): void {
  if (!nameCounterByWorkspace.has(workspaceId)) {
    const base = (listByWorkspace.get(workspaceId)?.length || 0) + 1
    nameCounterByWorkspace.set(workspaceId, base)
  }
}

function ensureWorkspaceBucket(workspaceId: string): SessionInfo[] {
  let list = listByWorkspace.get(workspaceId)
  if (!list) {
    list = getSessionsMeta(workspaceId)
    listByWorkspace.set(workspaceId, list)
  }
  touchWorkspaceCounter(workspaceId)
  return list
}

function registerSessionWorkspace(workspaceId: string, list: SessionInfo[]): void {
  for (const session of list) {
    sessionWorkspaceMap.set(session.id, workspaceId)
    initSessionState(workspaceId, session.id)
  }
}

export function loadSessionList(): SessionInfo[] {
  listByWorkspace.clear()
  nameCounterByWorkspace.clear()
  sessionWorkspaceMap.clear()
  const allMeta = getAllSessionsMetaByWorkspace()
  for (const workspace of listWorkspaces()) {
    const list = allMeta[workspace.id] || []
    listByWorkspace.set(workspace.id, list)
    registerSessionWorkspace(workspace.id, list)
  }
  return getSessionsForActiveWorkspace()
}

export function getSessions(workspaceId: string): SessionInfo[] {
  return [...ensureWorkspaceBucket(workspaceId)]
}

export function getSessionsForActiveWorkspace(): SessionInfo[] {
  const activeWorkspaceId = getActiveWorkspaceId()
  if (!activeWorkspaceId) return []
  return getSessions(activeWorkspaceId)
}

export function getSessionById(id: string): SessionInfo | undefined {
  const workspaceId = sessionWorkspaceMap.get(id)
  if (!workspaceId) return undefined
  return (listByWorkspace.get(workspaceId) || []).find((s) => s.id === id)
}

export function getSessionWorkspaceId(sessionId: string): string | null {
  return sessionWorkspaceMap.get(sessionId) || null
}

export function touchSession(workspaceId: string, id: string): void {
  const list = ensureWorkspaceBucket(workspaceId)
  const s = list.find((x) => x.id === id)
  if (!s) return
  s.updatedAt = Date.now()
  persist(workspaceId)
}

export function createSession(workspaceId: string, name?: string, persistMeta = true): SessionInfo {
  const list = ensureWorkspaceBucket(workspaceId)
  if (!name) {
    const count = nameCounterByWorkspace.get(workspaceId) || 1
    name = `新会话 ${count}`
    nameCounterByWorkspace.set(workspaceId, count + 1)
  }
  const s: SessionInfo = {
    id: randomUUID(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  list.push(s)
  sessionWorkspaceMap.set(s.id, workspaceId)
  initSessionState(workspaceId, s.id)
  if (persistMeta) persist(workspaceId)
  return s
}

export function renameSession(workspaceId: string, id: string, name: string): SessionInfo | null {
  const list = ensureWorkspaceBucket(workspaceId)
  const s = list.find((x) => x.id === id)
  if (!s) return null
  s.name = name
  s.updatedAt = Date.now()
  persist(workspaceId)
  return s
}

export function deleteSession(workspaceId: string, id: string): boolean {
  const list = ensureWorkspaceBucket(workspaceId)
  const i = list.findIndex((x) => x.id === id)
  if (i < 0) return false
  list.splice(i, 1)
  sessionWorkspaceMap.delete(id)
  clearSessionState(id)
  deleteSessionMessages(workspaceId, id)
  persist(workspaceId)
  return true
}

export function removeWorkspaceSessions(fromWorkspaceId: string, toWorkspaceId: string): void {
  if (fromWorkspaceId === toWorkspaceId) return
  const fromList = ensureWorkspaceBucket(fromWorkspaceId)
  const toList = ensureWorkspaceBucket(toWorkspaceId)
  for (const session of fromList) {
    sessionWorkspaceMap.set(session.id, toWorkspaceId)
    initSessionState(toWorkspaceId, session.id)
  }
  const merged = [...toList, ...fromList]
  listByWorkspace.set(toWorkspaceId, merged)
  listByWorkspace.set(fromWorkspaceId, [])
  moveWorkspaceSessionData(fromWorkspaceId, toWorkspaceId)
  setSessionsMeta(toWorkspaceId, merged)
  setSessionsMeta(fromWorkspaceId, [])
}

/** 删除某工作区下全部会话及消息（用于从侧栏移除默认工作区且不并入其他工作区） */
export function purgeWorkspaceSessions(workspaceId: string): void {
  const snapshot = [...ensureWorkspaceBucket(workspaceId)]
  for (const s of snapshot) {
    deleteSession(workspaceId, s.id)
  }
  listByWorkspace.set(workspaceId, [])
  nameCounterByWorkspace.delete(workspaceId)
  setSessionsMeta(workspaceId, [])
}
