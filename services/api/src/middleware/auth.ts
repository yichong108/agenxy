import type { AuthUser } from '@openworker/shared'
import type { NextFunction, Request, Response } from 'express'

import { getUserFromAccessToken } from '../services/auth-service.js'

/** 挂载在 req 上的已认证用户 */
export type AuthedRequest = Request & {
  user: AuthUser
}

/**
 * 从已鉴权请求取出用户（requireAuth 之后调用）
 *
 * @param req - Express 请求
 */
export function getAuthedUser(req: Request): AuthUser {
  return (req as unknown as AuthedRequest).user
}

/**
 * 从 Authorization 头解析 Bearer token
 *
 * @param header - Authorization 头原始值
 * @returns token 字符串；非法时返回 null
 */
function extractBearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token || null
}

/**
 * JWT 鉴权中间件 — 校验 Bearer token 并将用户挂到 `req.user`
 *
 * 失败时返回 HTTP 401 + `{ code, message, data: null }`（与 auth 路由 envelope 对齐）。
 *
 * @param req - Express 请求
 * @param res - Express 响应
 * @param next - 下一中间件
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractBearerToken(req.headers.authorization)
    if (!token) {
      res.status(401).json({
        code: 40102,
        message: 'Missing or invalid Authorization header',
        data: null
      })
      return
    }

    const user = await getUserFromAccessToken(token)
    if (!user) {
      res.status(401).json({
        code: 40102,
        message: 'Invalid or expired token',
        data: null
      })
      return
    }

    ;(req as AuthedRequest).user = user
    next()
  } catch (error) {
    console.error('[api] requireAuth failed', error)
    res.status(500).json({
      code: 50003,
      message: error instanceof Error ? error.message : String(error),
      data: null
    })
  }
}
