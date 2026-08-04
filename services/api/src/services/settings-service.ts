import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { defaultSettings, normalizeSettings, type AppSettings } from '@openwork/shared'

import { mysqlPool } from '../db/mysql.js'
import { redis } from '../db/redis.js'

/** 全局单例 settings 行主键（多用户 auth 落地前使用） */
export const DEFAULT_SETTINGS_ID = 'default'

const CACHE_KEY = `app_settings:${DEFAULT_SETTINGS_ID}`
/** Redis 缓存 TTL（秒） */
const CACHE_TTL_SEC = 60

type SettingsRow = RowDataPacket & {
  payload: AppSettings | string
}

/**
 * 从 MySQL 行的 JSON 列解析并规范化 AppSettings
 *
 * @param payload - mysql2 可能返回对象或 JSON 字符串
 * @returns 规范化后的 AppSettings
 */
function parsePayload(payload: AppSettings | string | null | undefined): AppSettings {
  if (payload == null) return normalizeSettings({})
  if (typeof payload === 'string') {
    try {
      return normalizeSettings(JSON.parse(payload) as Partial<AppSettings>)
    } catch {
      return normalizeSettings({})
    }
  }
  return normalizeSettings(payload)
}

/**
 * 尝试从 Redis 读取缓存的 settings
 *
 * @returns 命中时返回 AppSettings；未命中或 Redis 不可用时返回 null
 */
async function readCache(): Promise<AppSettings | null> {
  try {
    if (redis.status === 'wait' || redis.status === 'end') {
      await redis.connect()
    }
    const raw = await redis.get(CACHE_KEY)
    if (!raw) return null
    return normalizeSettings(JSON.parse(raw) as Partial<AppSettings>)
  } catch {
    return null
  }
}

/**
 * 将 settings 写入 Redis 缓存；失败时静默忽略（不影响主路径）
 *
 * @param settings - 要缓存的完整 settings
 */
async function writeCache(settings: AppSettings): Promise<void> {
  try {
    if (redis.status === 'wait' || redis.status === 'end') {
      await redis.connect()
    }
    await redis.set(CACHE_KEY, JSON.stringify(settings), 'EX', CACHE_TTL_SEC)
  } catch {
    // ignore cache write failures
  }
}

/**
 * 使 settings 缓存失效；失败时静默忽略
 */
async function invalidateCache(): Promise<void> {
  try {
    if (redis.status === 'wait' || redis.status === 'end') {
      await redis.connect()
    }
    await redis.del(CACHE_KEY)
  } catch {
    // ignore
  }
}

/**
 * 读取全局应用 settings
 *
 * 优先读 Redis 缓存，未命中再查 MySQL；无行时返回默认值并落库种子。
 *
 * @returns 规范化后的 AppSettings
 */
export async function getAppSettings(): Promise<AppSettings> {
  const cached = await readCache()
  if (cached) return cached

  const [rows] = await mysqlPool.query<SettingsRow[]>(
    'SELECT payload FROM app_settings WHERE id = ? LIMIT 1',
    [DEFAULT_SETTINGS_ID]
  )

  const row = rows[0]
  if (!row) {
    const seed = normalizeSettings({ ...defaultSettings })
    await saveAppSettings(seed)
    return seed
  }

  const settings = parsePayload(row.payload)
  await writeCache(settings)
  return settings
}

/**
 * 用完整 AppSettings 覆盖写入全局 settings
 *
 * @param settings - 已规范化的完整 settings
 * @returns 写入后的 AppSettings
 */
export async function saveAppSettings(settings: AppSettings): Promise<AppSettings> {
  const next = normalizeSettings(settings)
  await mysqlPool.query<ResultSetHeader>(
    `INSERT INTO app_settings (id, payload)
     VALUES (?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE payload = VALUES(payload)`,
    [DEFAULT_SETTINGS_ID, JSON.stringify(next)]
  )
  await invalidateCache()
  await writeCache(next)
  return next
}

/**
 * 合并 patch 后保存全局 settings
 *
 * @param patch - 部分 AppSettings 字段
 * @returns 合并并规范化后的完整 AppSettings
 */
export async function patchAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getAppSettings()
  return saveAppSettings({ ...current, ...patch })
}
