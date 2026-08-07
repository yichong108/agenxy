import {
  HOME_WORKSPACE_ID,
  type CreateWorkspaceRequest,
  type PatchWorkspaceRequest,
  type WorkspaceDto
} from '@openworker/shared'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'

import { BadRequestError, NotFoundError } from '../http/envelope.js'
import { mysqlPool } from '../db/mysql.js'

type WorkspaceRow = RowDataPacket & {
  id: string
  user_id: string
  name: string
  path: string | null
  sort_order: number
  is_default: number
  created_at: Date
  updated_at: Date
}

/**
 * 将 MySQL 行映射为 WorkspaceDto（epoch ms）
 *
 * @param row - workspaces 表行
 */
function toDto(row: WorkspaceRow): WorkspaceDto {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    sortOrder: row.sort_order,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    isDefault: row.is_default === 1 ? true : undefined
  }
}

/**
 * 确保当前用户存在未删除的 Home 工作区；没有则创建
 *
 * @param userId - 用户 id
 * @param conn - 可选事务连接
 * @returns Home 工作区 DTO
 */
export async function ensureHomeWorkspace(
  userId: string,
  conn?: PoolConnection
): Promise<WorkspaceDto> {
  const db = conn ?? mysqlPool
  const [rows] = await db.query<(WorkspaceRow & { deleted_at: Date | null })[]>(
    `SELECT id, user_id, name, path, sort_order, is_default, created_at, updated_at, deleted_at
     FROM workspaces
     WHERE user_id = ? AND id = ?
     LIMIT 1`,
    [userId, HOME_WORKSPACE_ID]
  )
  const row = rows[0]
  if (row && row.deleted_at == null) return toDto(row)

  const now = new Date()
  // path 由 Desktop 本机写入，API 不猜测服务端 homedir
  if (row) {
    await db.query<ResultSetHeader>(
      `UPDATE workspaces
       SET name = ?, sort_order = 0, is_default = 1, deleted_at = NULL, updated_at = ?
       WHERE user_id = ? AND id = ?`,
      ['Home', now, userId, HOME_WORKSPACE_ID]
    )
    return {
      id: HOME_WORKSPACE_ID,
      name: 'Home',
      path: row.path,
      sortOrder: 0,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: now.getTime(),
      isDefault: true
    }
  }

  await db.query<ResultSetHeader>(
    `INSERT INTO workspaces (user_id, id, name, path, sort_order, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, HOME_WORKSPACE_ID, 'Home', null, 0, 1, now, now]
  )
  return {
    id: HOME_WORKSPACE_ID,
    name: 'Home',
    path: null,
    sortOrder: 0,
    createdAt: now.getTime(),
    updatedAt: now.getTime(),
    isDefault: true
  }
}

/**
 * 列出当前用户未删除的工作区（按 sort_order、创建时间）
 *
 * 若列表为空则自动确保 Home 存在。
 *
 * @param userId - 用户 id
 */
export async function listWorkspaces(userId: string): Promise<WorkspaceDto[]> {
  const [rows] = await mysqlPool.query<WorkspaceRow[]>(
    `SELECT id, user_id, name, path, sort_order, is_default, created_at, updated_at
     FROM workspaces
     WHERE user_id = ? AND deleted_at IS NULL
     ORDER BY sort_order ASC, created_at ASC`,
    [userId]
  )
  if (rows.length === 0) {
    const home = await ensureHomeWorkspace(userId)
    return [home]
  }
  return rows.map(toDto)
}

/**
 * 按 id 获取未删除工作区
 *
 * @param userId - 用户 id
 * @param workspaceId - 工作区 id
 * @throws {NotFoundError} 不存在或已软删
 */
export async function getWorkspace(userId: string, workspaceId: string): Promise<WorkspaceDto> {
  const [rows] = await mysqlPool.query<WorkspaceRow[]>(
    `SELECT id, user_id, name, path, sort_order, is_default, created_at, updated_at
     FROM workspaces
     WHERE user_id = ? AND id = ? AND deleted_at IS NULL
     LIMIT 1`,
    [userId, workspaceId]
  )
  const row = rows[0]
  if (!row) throw new NotFoundError('Workspace not found')
  return toDto(row)
}

/**
 * 创建工作区
 *
 * @param userId - 用户 id
 * @param body - 创建请求
 */
export async function createWorkspace(
  userId: string,
  body: CreateWorkspaceRequest
): Promise<WorkspaceDto> {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) throw new BadRequestError('name is required')

  const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : randomUUID()
  const path =
    body.path === undefined || body.path === null
      ? null
      : typeof body.path === 'string'
        ? body.path
        : null

  const [maxRows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT COALESCE(MAX(sort_order), -1) AS max_sort
     FROM workspaces WHERE user_id = ? AND deleted_at IS NULL`,
    [userId]
  )
  const sortOrder =
    typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder)
      ? Math.floor(body.sortOrder)
      : Number(maxRows[0]?.max_sort ?? -1) + 1

  const now = new Date()
  const isDefault = body.isDefault === true ? 1 : 0

  // 若同 id 已软删，则恢复该行（复合主键不允许再 INSERT）
  const [existingRows] = await mysqlPool.query<WorkspaceRow[]>(
    `SELECT id, user_id, name, path, sort_order, is_default, created_at, updated_at, deleted_at
     FROM workspaces WHERE user_id = ? AND id = ? LIMIT 1`,
    [userId, id]
  )
  const existing = existingRows[0] as (WorkspaceRow & { deleted_at: Date | null }) | undefined
  if (existing && existing.deleted_at == null) {
    throw new BadRequestError('Workspace id already exists')
  }

  if (existing) {
    await mysqlPool.query<ResultSetHeader>(
      `UPDATE workspaces
       SET name = ?, path = ?, sort_order = ?, is_default = ?, deleted_at = NULL, updated_at = ?
       WHERE user_id = ? AND id = ?`,
      [name, path, sortOrder, isDefault, now, userId, id]
    )
  } else {
    await mysqlPool.query<ResultSetHeader>(
      `INSERT INTO workspaces (user_id, id, name, path, sort_order, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, id, name, path, sortOrder, isDefault, now, now]
    )
  }

  return {
    id,
    name,
    path,
    sortOrder,
    createdAt: existing ? new Date(existing.created_at).getTime() : now.getTime(),
    updatedAt: now.getTime(),
    isDefault: isDefault === 1 ? true : undefined
  }
}

/**
 * 部分更新工作区
 *
 * @param userId - 用户 id
 * @param workspaceId - 工作区 id
 * @param body - 补丁
 */
export async function patchWorkspace(
  userId: string,
  workspaceId: string,
  body: PatchWorkspaceRequest
): Promise<WorkspaceDto> {
  await getWorkspace(userId, workspaceId)

  const sets: string[] = []
  const params: unknown[] = []

  if (typeof body.name === 'string') {
    const name = body.name.trim()
    if (!name) throw new BadRequestError('name cannot be empty')
    sets.push('name = ?')
    params.push(name)
  }
  if (body.path !== undefined) {
    sets.push('path = ?')
    params.push(body.path === null ? null : String(body.path))
  }
  if (typeof body.isDefault === 'boolean') {
    sets.push('is_default = ?')
    params.push(body.isDefault ? 1 : 0)
  }

  if (sets.length === 0) {
    return getWorkspace(userId, workspaceId)
  }

  params.push(userId, workspaceId)
  await mysqlPool.query<ResultSetHeader>(
    `UPDATE workspaces SET ${sets.join(', ')}
     WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
    params
  )
  return getWorkspace(userId, workspaceId)
}

/**
 * 按有序 id 列表重排未删除工作区
 *
 * @param userId - 用户 id
 * @param orderedIds - 完整有序 id 列表
 */
export async function reorderWorkspaces(
  userId: string,
  orderedIds: string[]
): Promise<WorkspaceDto[]> {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw new BadRequestError('orderedIds must be a non-empty array')
  }

  const current = await listWorkspaces(userId)
  const currentIds = new Set(current.map((w) => w.id))
  if (orderedIds.length !== currentIds.size || orderedIds.some((id) => !currentIds.has(id))) {
    throw new BadRequestError('orderedIds must match the full set of active workspaces')
  }

  const conn = await mysqlPool.getConnection()
  try {
    await conn.beginTransaction()
    for (let i = 0; i < orderedIds.length; i += 1) {
      await conn.query<ResultSetHeader>(
        `UPDATE workspaces SET sort_order = ?
         WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
        [i, userId, orderedIds[i]]
      )
    }
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }

  return listWorkspaces(userId)
}

/**
 * 软删工作区，并级联软删其下未删除会话
 *
 * @param userId - 用户 id
 * @param workspaceId - 工作区 id
 */
export async function softDeleteWorkspace(userId: string, workspaceId: string): Promise<void> {
  await getWorkspace(userId, workspaceId)

  const conn = await mysqlPool.getConnection()
  try {
    await conn.beginTransaction()
    const now = new Date()
    await conn.query<ResultSetHeader>(
      `UPDATE sessions SET deleted_at = ?
       WHERE user_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [now, userId, workspaceId]
    )
    const [result] = await conn.query<ResultSetHeader>(
      `UPDATE workspaces SET deleted_at = ?
       WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
      [now, userId, workspaceId]
    )
    if (result.affectedRows === 0) {
      throw new NotFoundError('Workspace not found')
    }
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

/**
 * 统计用户未删除工作区数量（不含自动创建副作用）
 *
 * @param userId - 用户 id
 */
export async function countActiveWorkspaces(userId: string): Promise<number> {
  const [rows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM workspaces
     WHERE user_id = ? AND deleted_at IS NULL`,
    [userId]
  )
  return Number(rows[0]?.cnt ?? 0)
}
