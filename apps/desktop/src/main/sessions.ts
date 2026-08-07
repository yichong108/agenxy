import { clearSessionState, initSessionState } from '@/main/agent/agent-service'
import { hasAccessToken } from '@/main/auth-token'
import { getActiveWorkspaceId, listWorkspaces } from '@/main/store'
import {
  apiCreateSession,
  apiDeleteSession,
  apiGetSessionMessages,
  apiListSessions,
  apiPatchSession,
  apiPutSessionMessages,
  logWorkspaceSessionApiError
} from '@/main/workspace-session-api'
import type { SessionInfo } from '@/shared/ipc'
import type { Message } from '@ag-ui/client'

const listByWorkspace = new Map<string, SessionInfo[]>()
const nameCounterByWorkspace = new Map<string, number>()
const sessionWorkspaceMap = new Map<string, string>()
/** 完整 AG-UI Message[] 内存缓存 */
const messagesBySession = new Map<string, Message[]>()
const messagesHydrated = new Set<string>()

function touchWorkspaceCounter(workspaceId: string): void {
  if (!nameCounterByWorkspace.has(workspaceId)) {
    const base = (listByWorkspace.get(workspaceId)?.length || 0) + 1
    nameCounterByWorkspace.set(workspaceId, base)
  }
}

function ensureWorkspaceBucket(workspaceId: string): SessionInfo[] {
  let list = listByWorkspace.get(workspaceId)
  if (!list) {
    list = []
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

/**
 * 清空会话内存（登出）
 */
export function clearSessionsMemory(): void {
  listByWorkspace.clear()
  nameCounterByWorkspace.clear()
  sessionWorkspaceMap.clear()
  messagesBySession.clear()
  messagesHydrated.clear()
}

/**
 * 从 API 拉取所有工作区的会话元数据并填充内存
 *
 * @returns 当前活动工作区的会话列表
 */
export async function loadSessionList(): Promise<SessionInfo[]> {
  listByWorkspace.clear()
  nameCounterByWorkspace.clear()
  sessionWorkspaceMap.clear()
  // 保留已 hydrate 的 messages 缓存，避免切换时重复拉取；登出时 clearSessionsMemory

  if (!hasAccessToken()) {
    return []
  }

  for (const workspace of listWorkspaces()) {
    try {
      const list = await apiListSessions(workspace.id)
      listByWorkspace.set(workspace.id, list)
      registerSessionWorkspace(workspace.id, list)
    } catch (error) {
      logWorkspaceSessionApiError(`loadSessionList:${workspace.id}`, error)
      listByWorkspace.set(workspace.id, [])
    }
  }
  return getSessionsForActiveWorkspace()
}

/**
 * 读取某工作区会话列表（内存）
 *
 * @param workspaceId - 工作区 id
 */
export function getSessions(workspaceId: string): SessionInfo[] {
  return [...ensureWorkspaceBucket(workspaceId)]
}

/**
 * 当前活动工作区会话列表
 */
export function getSessionsForActiveWorkspace(): SessionInfo[] {
  const activeWorkspaceId = getActiveWorkspaceId()
  if (!activeWorkspaceId) return []
  return getSessions(activeWorkspaceId)
}

/**
 * 按会话 id 查元数据
 *
 * @param id - 会话 id
 */
export function getSessionById(id: string): SessionInfo | undefined {
  const workspaceId = sessionWorkspaceMap.get(id)
  if (!workspaceId) return undefined
  return (listByWorkspace.get(workspaceId) || []).find((s) => s.id === id)
}

/**
 * 会话所属工作区
 *
 * @param sessionId - 会话 id
 */
export function getSessionWorkspaceId(sessionId: string): string | null {
  return sessionWorkspaceMap.get(sessionId) || null
}

/**
 * touch 会话 updatedAt（API + 内存）
 *
 * @param workspaceId - 工作区 id
 * @param id - 会话 id
 */
export async function touchSession(workspaceId: string, id: string): Promise<void> {
  const list = ensureWorkspaceBucket(workspaceId)
  const s = list.find((x) => x.id === id)
  if (!s) return
  try {
    const updated = await apiPatchSession(id, { touch: true })
    s.updatedAt = updated.updatedAt
  } catch (error) {
    logWorkspaceSessionApiError('touchSession', error)
    s.updatedAt = Date.now()
  }
}

/**
 * 创建会话并写入 API
 *
 * @param workspaceId - 工作区 id
 * @param name - 可选名称
 */
export async function createSession(workspaceId: string, name?: string): Promise<SessionInfo> {
  const list = ensureWorkspaceBucket(workspaceId)
  let sessionName = name
  if (!sessionName) {
    const count = nameCounterByWorkspace.get(workspaceId) || 1
    sessionName = `新会话 ${count}`
    nameCounterByWorkspace.set(workspaceId, count + 1)
  }

  const s = await apiCreateSession(workspaceId, { name: sessionName })
  list.push(s)
  sessionWorkspaceMap.set(s.id, workspaceId)
  messagesBySession.set(s.id, [])
  messagesHydrated.add(s.id)
  initSessionState(workspaceId, s.id)
  return s
}

/**
 * 重命名会话
 *
 * @param workspaceId - 工作区 id
 * @param id - 会话 id
 * @param name - 新名称
 */
export async function renameSession(
  workspaceId: string,
  id: string,
  name: string
): Promise<SessionInfo | null> {
  const list = ensureWorkspaceBucket(workspaceId)
  const s = list.find((x) => x.id === id)
  if (!s) return null
  const updated = await apiPatchSession(id, { name })
  s.name = updated.name
  s.updatedAt = updated.updatedAt
  return s
}

/**
 * 软删会话
 *
 * @param workspaceId - 工作区 id
 * @param id - 会话 id
 */
export async function deleteSession(workspaceId: string, id: string): Promise<boolean> {
  const list = ensureWorkspaceBucket(workspaceId)
  const i = list.findIndex((x) => x.id === id)
  if (i < 0) return false
  await apiDeleteSession(id)
  list.splice(i, 1)
  sessionWorkspaceMap.delete(id)
  messagesBySession.delete(id)
  messagesHydrated.delete(id)
  clearSessionState(id)
  return true
}

/**
 * 删除工作区时清空本地会话桶（API 已级联软删）
 *
 * @param workspaceId - 工作区 id
 */
export function purgeWorkspaceSessionsLocal(workspaceId: string): void {
  const snapshot = [...ensureWorkspaceBucket(workspaceId)]
  for (const s of snapshot) {
    sessionWorkspaceMap.delete(s.id)
    messagesBySession.delete(s.id)
    messagesHydrated.delete(s.id)
    clearSessionState(s.id)
  }
  listByWorkspace.set(workspaceId, [])
  nameCounterByWorkspace.delete(workspaceId)
}

/**
 * 将 AG-UI Message[] 写入 API 并更新内存缓存
 *
 * @param sessionId - 会话 id
 * @param messages - 完整 Message[]
 */
export async function persistSessionAguiMessages(
  sessionId: string,
  messages: Message[]
): Promise<void> {
  messagesBySession.set(sessionId, messages)
  messagesHydrated.add(sessionId)
  await apiPutSessionMessages(sessionId, messages)
  const workspaceId = sessionWorkspaceMap.get(sessionId)
  if (workspaceId) {
    void touchSession(workspaceId, sessionId)
  }
}

/**
 * 确保会话 Message[] 已从 API 加载到内存
 *
 * @param sessionId - 会话 id
 * @returns Message[]
 */
export async function ensureSessionMessagesLoaded(sessionId: string): Promise<Message[]> {
  if (messagesHydrated.has(sessionId)) {
    return messagesBySession.get(sessionId) || []
  }
  try {
    const raw = await apiGetSessionMessages(sessionId)
    const messages = raw as Message[]
    messagesBySession.set(sessionId, messages)
    messagesHydrated.add(sessionId)
    return messages
  } catch (error) {
    logWorkspaceSessionApiError('ensureSessionMessagesLoaded', error)
    messagesBySession.set(sessionId, [])
    messagesHydrated.add(sessionId)
    return []
  }
}

/**
 * 同步读取已缓存的 Message[]（可能未 hydrate）
 *
 * @param sessionId - 会话 id
 */
export function getCachedSessionMessages(sessionId: string): Message[] {
  return messagesBySession.get(sessionId) || []
}

/**
 * 迁移时直接灌入内存消息缓存
 *
 * @param sessionId - 会话 id
 * @param messages - Message[]
 */
export function seedSessionMessagesCache(sessionId: string, messages: Message[]): void {
  messagesBySession.set(sessionId, messages)
  messagesHydrated.add(sessionId)
}

/**
 * 迁移时注册会话到内存桶（不调 API）
 *
 * @param workspaceId - 工作区 id
 * @param sessions - 会话列表
 */
export function seedSessionsForWorkspace(workspaceId: string, sessions: SessionInfo[]): void {
  listByWorkspace.set(workspaceId, [...sessions])
  registerSessionWorkspace(workspaceId, sessions)
}
