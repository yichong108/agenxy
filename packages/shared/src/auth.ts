/**
 * 登录请求体 — 账号密码登录（暂不提供注册）
 */
export type LoginRequest = {
  username: string
  password: string
}

/**
 * 已认证用户的公开信息（不含密码）
 */
export type AuthUser = {
  id: string
  username: string
  role: string
}

/**
 * 登录成功响应中的 data 字段
 */
export type LoginResult = {
  accessToken: string
  user: AuthUser
}
