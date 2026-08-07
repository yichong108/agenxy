import type {
  CreateSessionRequest,
  CreateWorkspaceRequest,
  PatchSessionRequest,
  PatchWorkspaceRequest,
  SessionDto,
  SessionMessagesPayload,
  WorkspaceDto
} from '@openworker/shared'

import { getAccessToken } from '@/main/auth-token'
import { mainLog } from '@/main/logger'
import { getApiBaseUrl } from '@/main/settings-api'
import type { SessionInfo, WorkspaceInfo } from '@/shared/ipc'

/** API envelope */
type ApiEnvelope<T> = {
  code: number
  message: string
  data: T | null
}

/**
 * Workspace/Session API 调用失败
 */
export class WorkspaceSessionApiError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'WorkspaceSessionApiError'
    this.code = code
  }
}

/**
 * 将 API WorkspaceDto 转为 Desktop WorkspaceInfo
 *
 * @param dto - API DTO
 */
export function workspaceDtoToInfo(dto: WorkspaceDto): WorkspaceInfo {
  return {
    id: dto.id,
    name: dto.name,
    path: dto.path,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    isDefault: dto.isDefault
  }
}

/**
 * 将 API SessionDto 转为 Desktop SessionInfo
 *
 * @param dto - API DTO
 */
export function sessionDtoToInfo(dto: SessionDto): SessionInfo {
  return {
    id: dto.id,
    name: dto.name,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt
  }
}

/**
 * 带 JWT 调用 workspace/session API
 *
 * @param method - HTTP 方法
 * @param path - 以 / 开头的路径
 * @param body - 可选 JSON body
 */
async function apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getAccessToken()
  if (!token) {
    throw new WorkspaceSessionApiError(40102, 'Not authenticated')
  }

  const url = `${getApiBaseUrl()}${path}`
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })

  let envelope: ApiEnvelope<T> | null = null
  try {
    envelope = (await res.json()) as ApiEnvelope<T>
  } catch {
    throw new WorkspaceSessionApiError(
      res.status,
      `${method} ${path}: invalid JSON (${res.status})`
    )
  }

  if (!envelope || typeof envelope !== 'object') {
    throw new WorkspaceSessionApiError(res.status, `${method} ${path}: empty response`)
  }

  if (envelope.code !== 0 || envelope.data == null) {
    throw new WorkspaceSessionApiError(
      envelope.code || res.status,
      envelope.message || `${method} ${path} failed`
    )
  }

  return envelope.data
}

/**
 * 记录 API 错误（不抛出）
 *
 * @param action - 操作名
 * @param error - 错误
 */
export function logWorkspaceSessionApiError(action: string, error: unknown): void {
  mainLog.warn(
    `[workspace-session-api] ${action} failed:`,
    error instanceof Error ? error.message : error
  )
}

/** GET /workspaces */
export async function apiListWorkspaces(): Promise<WorkspaceInfo[]> {
  const data = await apiRequest<{ list: WorkspaceDto[] }>('GET', '/workspaces')
  return (data.list || []).map(workspaceDtoToInfo)
}

/** POST /workspaces */
export async function apiCreateWorkspace(body: CreateWorkspaceRequest): Promise<WorkspaceInfo> {
  const data = await apiRequest<{ workspace: WorkspaceDto }>('POST', '/workspaces', body)
  return workspaceDtoToInfo(data.workspace)
}

/** PATCH /workspaces/:id */
export async function apiPatchWorkspace(
  id: string,
  body: PatchWorkspaceRequest
): Promise<WorkspaceInfo> {
  const data = await apiRequest<{ workspace: WorkspaceDto }>(
    'PATCH',
    `/workspaces/${encodeURIComponent(id)}`,
    body
  )
  return workspaceDtoToInfo(data.workspace)
}

/** DELETE /workspaces/:id */
export async function apiDeleteWorkspace(id: string): Promise<void> {
  await apiRequest<{ ok: boolean }>('DELETE', `/workspaces/${encodeURIComponent(id)}`)
}

/** PUT /workspaces/reorder */
export async function apiReorderWorkspaces(orderedIds: string[]): Promise<WorkspaceInfo[]> {
  const data = await apiRequest<{ list: WorkspaceDto[] }>('PUT', '/workspaces/reorder', {
    orderedIds
  })
  return (data.list || []).map(workspaceDtoToInfo)
}

/** GET /workspaces/:id/sessions */
export async function apiListSessions(workspaceId: string): Promise<SessionInfo[]> {
  const data = await apiRequest<{ list: SessionDto[] }>(
    'GET',
    `/workspaces/${encodeURIComponent(workspaceId)}/sessions`
  )
  return (data.list || []).map(sessionDtoToInfo)
}

/** POST /workspaces/:id/sessions */
export async function apiCreateSession(
  workspaceId: string,
  body: CreateSessionRequest = {}
): Promise<SessionInfo> {
  const data = await apiRequest<{ session: SessionDto }>(
    'POST',
    `/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
    body
  )
  return sessionDtoToInfo(data.session)
}

/** PATCH /sessions/:id */
export async function apiPatchSession(id: string, body: PatchSessionRequest): Promise<SessionInfo> {
  const data = await apiRequest<{ session: SessionDto }>(
    'PATCH',
    `/sessions/${encodeURIComponent(id)}`,
    body
  )
  return sessionDtoToInfo(data.session)
}

/** DELETE /sessions/:id */
export async function apiDeleteSession(id: string): Promise<void> {
  await apiRequest<{ ok: boolean }>('DELETE', `/sessions/${encodeURIComponent(id)}`)
}

/** GET /sessions/:id/messages */
export async function apiGetSessionMessages(sessionId: string): Promise<unknown[]> {
  const data = await apiRequest<SessionMessagesPayload>(
    'GET',
    `/sessions/${encodeURIComponent(sessionId)}/messages`
  )
  return Array.isArray(data.messages) ? data.messages : []
}

/** PUT /sessions/:id/messages */
export async function apiPutSessionMessages(
  sessionId: string,
  messages: unknown[]
): Promise<unknown[]> {
  const data = await apiRequest<SessionMessagesPayload>(
    'PUT',
    `/sessions/${encodeURIComponent(sessionId)}/messages`,
    { messages } satisfies SessionMessagesPayload
  )
  return Array.isArray(data.messages) ? data.messages : []
}
