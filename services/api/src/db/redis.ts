import { Redis } from 'ioredis'
import { env } from '../config/env.js'

/**
 * Redis 客户端单例
 *
 * lazyConnect 为 true，避免进程启动时因 Redis 未就绪而直接崩溃；
 * 由健康检查与业务代码在实际使用时触发连接。
 */
export const redis = new Redis({
  host: env.redis.host,
  port: env.redis.port,
  password: env.redis.password,
  db: env.redis.db,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false
})

/**
 * 探测 Redis 是否可连通
 *
 * 先确保客户端已连接，再执行 PING。
 * 健康检查接口调用此方法，失败时返回 false 而不向上抛错，便于聚合探活结果。
 *
 * @returns 连通时返回 true；失败时返回 false
 */
export async function pingRedis(): Promise<boolean> {
  try {
    if (redis.status === 'wait' || redis.status === 'end') {
      await redis.connect()
    }
    const result = await redis.ping()
    return result === 'PONG'
  } catch {
    return false
  }
}
