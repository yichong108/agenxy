import { config as loadEnv } from 'dotenv'

loadEnv()

/**
 * API 服务运行时配置
 *
 * 从环境变量读取端口、JWT、MySQL 与 Redis 连接信息。
 * 使用集中配置便于后续校验与多环境切换，避免在业务代码中直接读 process.env。
 */
export const env = {
  /** HTTP 服务监听端口 */
  port: Number(process.env.PORT ?? 3100),

  /**
   * JWT 签名密钥；生产环境务必通过 JWT_SECRET 覆盖
   */
  jwtSecret: process.env.JWT_SECRET ?? 'openworker-dev-jwt-secret-change-me',

  /** access token 有效期（如 `7d`、`12h`） */
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',

  mysql: {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DATABASE ?? 'openworker'
  },

  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB ?? 0)
  }
} as const
