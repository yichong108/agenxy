/** 与桌面端 / auth 路由对齐的统一响应 envelope */
export type ApiEnvelope<T> = {
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
export function ok<T>(data: T, message = 'ok'): ApiEnvelope<T> {
  return { code: 0, message, data }
}

/**
 * 构造业务失败响应
 *
 * @param code - 业务错误码
 * @param message - 错误说明
 */
export function fail(code: number, message: string): ApiEnvelope<null> {
  return { code, message, data: null }
}

/** 资源不存在或已软删 */
export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message)
    this.name = 'NotFoundError'
  }
}

/** 请求体不合法 */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}
