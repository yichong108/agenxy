import type { AuthUser, LoginResult } from '@agenwork/shared'

import { getRequestErrorMessage, request } from '@/renderer/src/api/request'

/**
 * 调用后端账号密码登录接口
 *
 * 经 renderer 的统一 `request` 直连 API，不经过 main / IPC。
 *
 * @param username - 登录账号
 * @param password - 明文密码
 * @returns 登录结果（accessToken + user）
 * @throws 当网络失败或业务失败时抛出 Error（message 尽量来自服务端）
 */
export async function loginWithPasswordApi(
  username: string,
  password: string
): Promise<LoginResult> {
  const result = await request<LoginResult>({
    url: '/auth/login',
    method: 'POST',
    data: { username, password }
  })

  if (!result.ok) {
    throw new Error(getRequestErrorMessage(result))
  }

  if (!result.data?.accessToken || !result.data.user) {
    throw new Error('登录响应无效')
  }

  return result.data
}

/**
 * 用已有 token 拉取当前用户（用于会话恢复校验）
 *
 * @param accessToken - JWT access token
 * @returns 用户信息；token 失效或请求失败时返回 null
 */
export async function fetchAuthMeApi(accessToken: string): Promise<AuthUser | null> {
  const result = await request<{ user: AuthUser }>({
    url: '/auth/me',
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  })

  if (!result.ok) return null

  const user = result.data?.user
  if (!user || typeof user.id !== 'string' || typeof user.username !== 'string') return null
  return user
}
