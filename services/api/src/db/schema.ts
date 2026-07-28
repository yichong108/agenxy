import { mysqlPool } from './mysql.js';

/**
 * 确保业务所需的 MySQL 表存在
 *
 * 在进程启动时调用一次；使用 IF NOT EXISTS，可重复执行。
 * 当前仅包含全局应用 settings 表（尚无多用户 auth）。
 */
export async function ensureSchema(): Promise<void> {
  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id VARCHAR(64) NOT NULL,
      payload JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}
