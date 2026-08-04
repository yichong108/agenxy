import mysql from 'mysql2/promise'
import { env } from '../config/env.js'

/**
 * MySQL 连接池
 *
 * 使用连接池复用连接，降低每次请求建立 TCP 握手的开销。
 * 连接参数来自集中配置，便于开发/生产环境切换。
 */
export const mysqlPool = mysql.createPool({
  host: env.mysql.host,
  port: env.mysql.port,
  user: env.mysql.user,
  password: env.mysql.password,
  database: env.mysql.database,
  waitForConnections: true,
  connectionLimit: 10,
  enableKeepAlive: true
})

/**
 * 探测 MySQL 是否可连通
 *
 * 通过执行轻量 `SELECT 1` 验证连接池是否可用。
 * 健康检查接口调用此方法，避免在探活路径上执行业务查询。
 *
 * @returns 连通时返回 true；失败时返回 false 且不抛出异常
 */
export async function pingMysql(): Promise<boolean> {
  try {
    const connection = await mysqlPool.getConnection()
    try {
      await connection.query('SELECT 1')
      return true
    } finally {
      connection.release()
    }
  } catch {
    return false
  }
}
