import { Router } from 'express'

import { listUsers } from '../services/user-service.js'

/** 与桌面端 / 管理端 `request` 对齐的统一响应 envelope */
type ApiEnvelope<T> = {
  code: number
  message: string
  data: T | null
}

/**
 * 构造成功响应（HTTP 200 + code 0）
 *
 * @param data - 业务数据
 * @param message - 可选提示文案
 */
function ok<T>(data: T, message = 'ok'): ApiEnvelope<T> {
  return { code: 0, message, data }
}

/**
 * 构造业务失败响应（HTTP 200 + 非 0 code）
 *
 * @param code - 业务错误码
 * @param message - 错误说明
 */
function fail(code: number, message: string): ApiEnvelope<null> {
  return { code, message, data: null }
}

/**
 * 用户管理路由
 *
 * - GET /users — 返回全部用户公开信息列表（暂无鉴权，供后台管理使用）
 *
 * 响应统一为 `{ code, message, data }`。
 */
export const usersRouter = Router()

usersRouter.get('/users', async (_req, res) => {
  try {
    const users = await listUsers()
    res.status(200).json(ok({ users }))
  } catch (error) {
    console.error('[api] GET /users failed', error)
    res.status(200).json(fail(50003, error instanceof Error ? error.message : String(error)))
  }
})
