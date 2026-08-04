import { Router } from 'express'
import { pingMysql } from '../db/mysql.js'
import { pingRedis } from '../db/redis.js'

/**
 * 健康检查路由
 *
 * 聚合进程状态以及 MySQL / Redis 连通性，供负载均衡与监控探活使用。
 */
export const healthRouter = Router()

healthRouter.get('/health', async (_req, res) => {
  const [mysqlOk, redisOk] = await Promise.all([pingMysql(), pingRedis()])
  const ok = mysqlOk && redisOk

  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks: {
      mysql: mysqlOk ? 'up' : 'down',
      redis: redisOk ? 'up' : 'down'
    }
  })
})
