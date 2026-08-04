import type { UserListResult } from '@agenwork/shared'

import { getRequestErrorMessage, request } from './request'

/**
 * 拉取后台用户列表
 *
 * @returns 用户公开信息列表
 * @throws 当网络失败或业务失败时抛出 Error
 */
export async function fetchUsers(): Promise<UserListResult['users']> {
  const result = await request<UserListResult>({
    url: '/users',
    method: 'GET'
  })

  if (!result.ok) {
    throw new Error(getRequestErrorMessage(result))
  }

  return result.data?.users ?? []
}
