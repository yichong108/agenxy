import type { AuthUser } from '@openworker/shared'
import { create } from 'zustand'

import { fetchAuthMeApi, loginWithPasswordApi } from '@/renderer/src/api/auth-api'

/** localStorage 中持久化登录会话的 key */
const AUTH_STORAGE_KEY = 'openworker.auth.session'

type PersistedAuthSession = {
  accessToken: string
  user: AuthUser
}

type AuthStoreState = {
  accessToken: string | null
  user: AuthUser | null
  /** 是否已完成从 localStorage /me 的恢复尝试 */
  hydrated: boolean
  /** 主进程工作区/会话是否已 hydrate */
  dataHydrated: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  hydrate: () => Promise<void>
}

/**
 * 从 localStorage 读取持久化的登录会话
 *
 * @returns 合法会话或 null
 */
function readPersistedSession(): PersistedAuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedAuthSession>
    if (
      typeof parsed.accessToken !== 'string' ||
      !parsed.accessToken ||
      !parsed.user ||
      typeof parsed.user.id !== 'string' ||
      typeof parsed.user.username !== 'string'
    ) {
      return null
    }
    return {
      accessToken: parsed.accessToken,
      user: {
        id: parsed.user.id,
        username: parsed.user.username,
        role: typeof parsed.user.role === 'string' ? parsed.user.role : 'user'
      }
    }
  } catch {
    return null
  }
}

/**
 * 将登录会话写入 localStorage；传入 null 则清除
 *
 * @param session - 要持久化的会话，或 null 表示登出
 */
function writePersistedSession(session: PersistedAuthSession | null): void {
  if (!session) {
    localStorage.removeItem(AUTH_STORAGE_KEY)
    return
  }
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session))
}

/**
 * 同步 JWT 到主进程并拉取工作区/会话
 *
 * @param accessToken - JWT
 */
async function syncTokenAndHydrateMain(accessToken: string): Promise<void> {
  const bridge = typeof window !== 'undefined' ? window.bridge : undefined
  if (!bridge?.setAuthToken || !bridge.hydrateAuthData) return
  await bridge.setAuthToken(accessToken)
  await bridge.hydrateAuthData()
}

/**
 * 清除主进程 JWT 与业务内存
 */
async function clearMainAuth(): Promise<void> {
  const bridge = typeof window !== 'undefined' ? window.bridge : undefined
  if (!bridge?.clearAuthToken) return
  await bridge.clearAuthToken()
}

/**
 * 渲染进程认证状态（zustand）
 *
 * token 存 localStorage；登录经 renderer 直连后端 `/auth/login`；
 * 成功后把 JWT 交给 main，由 main 拉取 workspace/session。
 */
export const useAuthStore = create<AuthStoreState>((set, get) => ({
  accessToken: null,
  user: null,
  hydrated: false,
  dataHydrated: false,
  login: async (username, password) => {
    const result = await loginWithPasswordApi(username, password)
    const session: PersistedAuthSession = {
      accessToken: result.accessToken,
      user: result.user
    }
    writePersistedSession(session)
    set({
      accessToken: session.accessToken,
      user: session.user,
      hydrated: true,
      dataHydrated: false
    })
    try {
      await syncTokenAndHydrateMain(session.accessToken)
    } finally {
      set({ dataHydrated: true })
    }
  },
  logout: () => {
    writePersistedSession(null)
    set({ accessToken: null, user: null, dataHydrated: false })
    void clearMainAuth()
  },
  hydrate: async () => {
    if (get().hydrated) return
    const persisted = readPersistedSession()
    if (!persisted) {
      set({ accessToken: null, user: null, hydrated: true, dataHydrated: false })
      return
    }

    // 先乐观恢复本地会话，再后台校验；校验失败则清除
    set({
      accessToken: persisted.accessToken,
      user: persisted.user,
      hydrated: true,
      dataHydrated: false
    })

    const me = await fetchAuthMeApi(persisted.accessToken)
    if (!me) {
      writePersistedSession(null)
      set({ accessToken: null, user: null, dataHydrated: false })
      void clearMainAuth()
      return
    }

    const next: PersistedAuthSession = {
      accessToken: persisted.accessToken,
      user: me
    }
    writePersistedSession(next)
    set({ accessToken: next.accessToken, user: next.user })
    try {
      await syncTokenAndHydrateMain(next.accessToken)
    } finally {
      set({ dataHydrated: true })
    }
  }
}))
