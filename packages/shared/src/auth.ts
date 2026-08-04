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
 * 用户列表项 — 在 AuthUser 基础上附带创建时间
 */
export type AuthUserListItem = AuthUser & {
  /** ISO 8601 创建时间 */
  createdAt: string
}

/**
 * 登录成功响应中的 data 字段
 */
export type LoginResult = {
  accessToken: string
  user: AuthUser
}

/**
 * 用户列表接口响应中的 data 字段
 */
export type UserListResult = {
  users: AuthUserListItem[]
}
