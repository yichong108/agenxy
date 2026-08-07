/**
 * 主进程内存中的 JWT access token
 *
 * 由渲染进程登录/恢复/登出时经 IPC 同步；workspace/session API 客户端读取此值。
 */

let accessToken: string | null = null

/**
 * 设置当前用户的 access token
 *
 * @param token - JWT；空字符串视为清除
 */
export function setAccessToken(token: string | null): void {
  const next = typeof token === 'string' ? token.trim() : ''
  accessToken = next || null
}

/**
 * 清除 access token（登出）
 */
export function clearAccessToken(): void {
  accessToken = null
}

/**
 * 读取当前 access token
 *
 * @returns token 或 null
 */
export function getAccessToken(): string | null {
  return accessToken
}

/**
 * 是否已具备可用 token
 */
export function hasAccessToken(): boolean {
  return Boolean(accessToken)
}
