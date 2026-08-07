import type {
  CreateSessionRequest,
  PatchSessionRequest,
  SessionDto,
  SessionMessagesPayload
} from '@openworker/shared'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'

import { BadRequestError, NotFoundError } from '../http/envelope.js'
import { mysqlPool } from '../db/mysql.js'
import { getWorkspace } from './workspace-service.js'

type SessionRow = RowDataPacket & {
  id: string
  user_id: string
  workspace_id: string
  name: string
  messages_json: unknown
  created_at: Date
  updated_at: Date
}

/**
 * 将 MySQL 行映射为 SessionDto（不含 messages）
 *
 * @param row - sessions 表行
 */
function toDto(row: SessionRow): SessionDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime()
  }
}

/**
 * 解析 messages_json 列为 unknown[]
 *
 * @param raw - MySQL JSON 字段
 */
function parseMessagesJson(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

/**
 * 列出工作区下未删除会话（不含 messages_json）
 *
 * @param userId - 用户 id
 * @param workspaceId - 工作区 id
 */
export async function listSessions(userId: string, workspaceId: string): Promise<SessionDto[]> {
  await getWorkspace(userId, workspaceId)
  const [rows] = await mysqlPool.query<SessionRow[]>(
    `SELECT id, user_id, workspace_id, name, created_at, updated_at
     FROM sessions
     WHERE user_id = ? AND workspace_id = ? AND deleted_at IS NULL
     ORDER BY updated_at DESC`,
    [userId, workspaceId]
  )
  return rows.map(toDto)
}

/**
 * 获取未删除会话元数据
 *
 * @param userId - 用户 id
 * @param sessionId - 会话 id
 */
export async function getSession(userId: string, sessionId: string): Promise<SessionDto> {
  const [rows] = await mysqlPool.query<SessionRow[]>(
    `SELECT id, user_id, workspace_id, name, created_at, updated_at
     FROM sessions
     WHERE user_id = ? AND id = ? AND deleted_at IS NULL
     LIMIT 1`,
    [userId, sessionId]
  )
  const row = rows[0]
  if (!row) throw new NotFoundError('Session not found')
  return toDto(row)
}

/**
 * 在指定工作区创建会话
 *
 * @param userId - 用户 id
 * @param workspaceId - 工作区 id
 * @param body - 创建请求
 */
export async function createSession(
  userId: string,
  workspaceId: string,
  body: CreateSessionRequest
): Promise<SessionDto> {
  await getWorkspace(userId, workspaceId)

  const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : randomUUID()
  const name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : `会话 ${new Date().toLocaleString()}`

  const now = new Date()
  try {
    await mysqlPool.query<ResultSetHeader>(
      `INSERT INTO sessions (user_id, id, workspace_id, name, messages_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, ?)`,
      [userId, id, workspaceId, name, JSON.stringify([]), now, now]
    )
  } catch (error) {
    const err = error as { code?: string }
    if (err.code === 'ER_DUP_ENTRY') {
      throw new BadRequestError('Session id already exists')
    }
    throw error
  }

  return {
    id,
    workspaceId,
    name,
    createdAt: now.getTime(),
    updatedAt: now.getTime()
  }
}

/**
 * 部分更新会话（重命名 / touch）
 *
 * @param userId - 用户 id
 * @param sessionId - 会话 id
 * @param body - 补丁
 */
export async function patchSession(
  userId: string,
  sessionId: string,
  body: PatchSessionRequest
): Promise<SessionDto> {
  await getSession(userId, sessionId)

  const sets: string[] = []
  const params: unknown[] = []

  if (typeof body.name === 'string') {
    const name = body.name.trim()
    if (!name) throw new BadRequestError('name cannot be empty')
    sets.push('name = ?')
    params.push(name)
  }
  if (body.touch === true) {
    sets.push('updated_at = CURRENT_TIMESTAMP(3)')
  }

  if (sets.length === 0) {
    return getSession(userId, sessionId)
  }

  params.push(userId, sessionId)
  await mysqlPool.query<ResultSetHeader>(
    `UPDATE sessions SET ${sets.join(', ')}
     WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
    params
  )
  return getSession(userId, sessionId)
}

/**
 * 软删会话
 *
 * @param userId - 用户 id
 * @param sessionId - 会话 id
 */
export async function softDeleteSession(userId: string, sessionId: string): Promise<void> {
  await getSession(userId, sessionId)
  const [result] = await mysqlPool.query<ResultSetHeader>(
    `UPDATE sessions SET deleted_at = CURRENT_TIMESTAMP(3)
     WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
    [userId, sessionId]
  )
  if (result.affectedRows === 0) {
    throw new NotFoundError('Session not found')
  }
}

/**
 * 读取会话完整 Message[]
 *
 * @param userId - 用户 id
 * @param sessionId - 会话 id
 */
export async function getSessionMessages(
  userId: string,
  sessionId: string
): Promise<SessionMessagesPayload> {
  const [rows] = await mysqlPool.query<SessionRow[]>(
    `SELECT id, user_id, workspace_id, name, messages_json, created_at, updated_at
     FROM sessions
     WHERE user_id = ? AND id = ? AND deleted_at IS NULL
     LIMIT 1`,
    [userId, sessionId]
  )
  const row = rows[0]
  if (!row) throw new NotFoundError('Session not found')
  return { messages: parseMessagesJson(row.messages_json) }
}

/**
 * 整包覆盖会话 Message[]，并刷新 updated_at
 *
 * @param userId - 用户 id
 * @param sessionId - 会话 id
 * @param payload - `{ messages: Message[] }`
 */
export async function putSessionMessages(
  userId: string,
  sessionId: string,
  payload: SessionMessagesPayload
): Promise<SessionMessagesPayload> {
  if (!payload || !Array.isArray(payload.messages)) {
    throw new BadRequestError('messages must be an array')
  }

  await getSession(userId, sessionId)

  const json = JSON.stringify(payload.messages)
  const [result] = await mysqlPool.query<ResultSetHeader>(
    `UPDATE sessions
     SET messages_json = CAST(? AS JSON), updated_at = CURRENT_TIMESTAMP(3)
     WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
    [json, userId, sessionId]
  )
  if (result.affectedRows === 0) {
    throw new NotFoundError('Session not found')
  }
  return { messages: payload.messages }
}

/**
 * 统计用户未删除会话数（可选按工作区）
 *
 * @param userId - 用户 id
 * @param workspaceId - 可选工作区过滤
 */
export async function countActiveSessions(userId: string, workspaceId?: string): Promise<number> {
  if (workspaceId) {
    const [rows] = await mysqlPool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM sessions
       WHERE user_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [userId, workspaceId]
    )
    return Number(rows[0]?.cnt ?? 0)
  }
  const [rows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM sessions
     WHERE user_id = ? AND deleted_at IS NULL`,
    [userId]
  )
  return Number(rows[0]?.cnt ?? 0)
}
