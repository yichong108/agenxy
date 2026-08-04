import bcrypt from 'bcryptjs'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'

import { mysqlPool } from './mysql.js'

/** 默认管理员账号（仅在 users 表无该用户时写入） */
const DEFAULT_ADMIN_USERNAME = 'admin'
/** 默认管理员明文密码；生产环境应尽快修改 */
const DEFAULT_ADMIN_PASSWORD = 'admin'
/** bcrypt 计算成本 */
const BCRYPT_ROUNDS = 10

/**
 * 确保业务所需的 MySQL 表存在，并写入默认管理员账号
 *
 * 在进程启动时调用一次；使用 IF NOT EXISTS / 按用户名查重，可重复执行。
 */
export async function ensureSchema(): Promise<void> {
  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id VARCHAR(64) NOT NULL,
      payload JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) NOT NULL,
      username VARCHAR(64) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'user',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_users_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await seedDefaultAdmin()
}

/**
 * 若不存在 admin 用户，则插入默认管理员（账号/密码均为 admin）
 *
 * 使用查重后再插入，避免重复启动时覆盖已修改的密码。
 */
async function seedDefaultAdmin(): Promise<void> {
  const [rows] = await mysqlPool.query<RowDataPacket[]>(
    'SELECT id FROM users WHERE username = ? LIMIT 1',
    [DEFAULT_ADMIN_USERNAME]
  )
  if (rows.length > 0) return

  const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, BCRYPT_ROUNDS)
  await mysqlPool.query<ResultSetHeader>(
    `INSERT INTO users (id, username, password_hash, role)
     VALUES (?, ?, ?, ?)`,
    [randomUUID(), DEFAULT_ADMIN_USERNAME, passwordHash, 'admin']
  )
  console.log(
    `[api] seeded default admin user: ${DEFAULT_ADMIN_USERNAME} / ${DEFAULT_ADMIN_PASSWORD}`
  )
}
