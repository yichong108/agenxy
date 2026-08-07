import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { app } from 'electron'
import Store from 'electron-store'

import { hasAccessToken } from '@/main/auth-token'
import { mainLog } from '@/main/logger'
import { fetchSettingsFromApi, logSettingsApiError, putSettingsToApi } from '@/main/settings-api'
import {
  apiCreateWorkspace,
  apiDeleteWorkspace,
  apiListWorkspaces,
  apiPatchWorkspace,
  apiReorderWorkspaces,
  logWorkspaceSessionApiError
} from '@/main/workspace-session-api'
import {
  type AppSettings,
  type ChatMessage,
  defaultRendererUiState,
  defaultSettings,
  defaultWorkspaceUiState,
  HOME_WORKSPACE_ID,
  normalizeSettings,
  type RendererUiState,
  type SessionInfo,
  type WorkspaceInfo,
  type WorkspaceUiState
} from '@/shared/ipc'
import { getElectronAppDir, getElectronMcpConfigPath } from './path'

/**
 * electron-store 仅保留 settings / uiState；
 * 旧版 workspace/session 字段仅供一次性迁移读取。
 */
type StoreSchema = {
  settings: AppSettings
  uiState: RendererUiState
  /** @deprecated 迁移后清除 */
  workspaces?: WorkspaceInfo[]
  /** @deprecated */
  activeWorkspaceId?: string | null
  /** @deprecated */
  workspaceBootstrapDone?: boolean
  /** @deprecated */
  suppressHomeWorkspaceAutoEnsure?: boolean
  /** @deprecated */
  sessionsMetaByWorkspace?: Record<string, SessionInfo[]>
  /** @deprecated */
  sessionsMessagesByWorkspace?: Record<string, Record<string, ChatMessage[]>>
  /** @deprecated */
  workspace?: string
  /** @deprecated */
  sessionsMeta?: SessionInfo[]
  /** @deprecated */
  sessionsMessages?: Record<string, ChatMessage[]>
  /** 本地→API 迁移是否已完成（按机器） */
  workspaceSessionMigratedToApi?: boolean
}

const store = new Store<StoreSchema>({
  name: 'openworker',
  defaults: {
    settings: { ...defaultSettings },
    uiState: { ...defaultRendererUiState }
  }
})

/** 工作区内存缓存（API 权威） */
let workspaceCache: WorkspaceInfo[] = []

/**
 * 规范化本机工作区绝对路径
 *
 * @param dir - 目录路径
 */
export function normalizeWorkspacePath(dir: string): string {
  return path.resolve(dir).replace(/[\\/]+$/, '')
}

/**
 * 写入本地 settings 缓存（不访问网络）
 *
 * @param next - 完整 AppSettings
 */
function writeLocalSettingsCache(next: AppSettings): void {
  const normalized = normalizeSettings(next)
  store.set('settings', normalized)
  syncMcpConfigFile(normalized)
}

/**
 * MCP 配置文件路径（~/.openworker/mcp.json）
 *
 * @returns 绝对路径
 */
export function getMcpConfigPath(): string {
  return getElectronMcpConfigPath()
}

/**
 * 将 settings.mcpServers 同步写入 mcp.json
 *
 * @param settings - 当前应用设置
 */
function syncMcpConfigFile(settings: AppSettings): void {
  try {
    mkdirSync(getElectronAppDir(), { recursive: true })
    const payload = { mcpServers: settings.mcpServers ?? [] }
    writeFileSync(getMcpConfigPath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch (e) {
    console.warn('[store] Failed to sync mcp.json:', e instanceof Error ? e.message : e)
  }
}

/**
 * 读取本地缓存的 AppSettings（同步）
 *
 * @returns 规范化后的 AppSettings
 */
export function getSettings(): AppSettings {
  return normalizeSettings(store.get('settings'))
}

/**
 * 从 API 拉取 settings 并刷新本地缓存；失败时回落本地缓存
 *
 * @returns 最终使用的 AppSettings
 */
export async function loadSettingsFromApi(): Promise<AppSettings> {
  const local = getSettings()
  try {
    const remote = await fetchSettingsFromApi()
    const remoteIsPristine =
      !remote.tavilyApiKey &&
      !remote.providerProfiles.deepseek.apiKey &&
      remote.mcpServers.length === 0
    const localHasUserData =
      Boolean(local.tavilyApiKey) ||
      Boolean(local.providerProfiles.deepseek.apiKey) ||
      local.mcpServers.length > 0

    if (remoteIsPristine && localHasUserData) {
      const seeded = await putSettingsToApi(local)
      writeLocalSettingsCache(seeded)
      return seeded
    }

    writeLocalSettingsCache(remote)
    return remote
  } catch (error) {
    logSettingsApiError('loadSettingsFromApi', error)
    return local
  }
}

/**
 * 合并 patch，优先写入 API，成功后同步本地缓存；API 失败时仍写本地
 *
 * @param patch - 要合并的 settings 字段
 * @returns 保存后的完整 AppSettings
 */
export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = normalizeSettings({ ...getSettings(), ...patch })
  try {
    const saved = await putSettingsToApi(next)
    writeLocalSettingsCache(saved)
    return saved
  } catch (error) {
    logSettingsApiError('setSettings', error)
    writeLocalSettingsCache(next)
    return next
  }
}

function normalizeUiState(input: Partial<RendererUiState>): RendererUiState {
  const byWorkspaceRaw = input.byWorkspace || {}
  const byWorkspace: Record<string, WorkspaceUiState> = {}
  for (const [workspaceId, value] of Object.entries(byWorkspaceRaw)) {
    const hiddenRaw = value?.sidebarHiddenSessionIds
    const sidebarHiddenSessionIds = Array.isArray(hiddenRaw)
      ? hiddenRaw.filter((x): x is string => typeof x === 'string')
      : []
    byWorkspace[workspaceId] = {
      activeSessionId: value?.activeSessionId ?? null,
      inputDraft: value?.inputDraft ?? '',
      sidebarHiddenSessionIds
    }
  }
  return {
    activeWorkspaceId: input.activeWorkspaceId ?? null,
    byWorkspace
  }
}

/**
 * 读取 UI 状态（本地 electron-store）
 */
export function getUiState(): RendererUiState {
  return normalizeUiState(store.get('uiState'))
}

/**
 * 合并写入 UI 状态
 *
 * @param patch - 部分 UI 状态
 */
export function setUiState(patch: Partial<RendererUiState>): RendererUiState {
  const prev = getUiState()
  const next = normalizeUiState({
    ...prev,
    ...patch,
    byWorkspace: {
      ...prev.byWorkspace,
      ...(patch.byWorkspace || {})
    }
  })
  store.set('uiState', next)
  return next
}

/**
 * 读取某工作区 UI 状态
 *
 * @param workspaceId - 工作区 id
 */
export function getWorkspaceUiState(workspaceId: string): WorkspaceUiState {
  return getUiState().byWorkspace[workspaceId] || { ...defaultWorkspaceUiState }
}

/**
 * 合并写入某工作区 UI 状态
 *
 * @param workspaceId - 工作区 id
 * @param patch - 部分状态
 */
export function setWorkspaceUiState(
  workspaceId: string,
  patch: Partial<WorkspaceUiState>
): RendererUiState {
  const current = getUiState()
  const prev = current.byWorkspace[workspaceId] || { ...defaultWorkspaceUiState }
  return setUiState({
    byWorkspace: {
      ...current.byWorkspace,
      [workspaceId]: {
        activeSessionId: patch.activeSessionId ?? prev.activeSessionId,
        inputDraft: patch.inputDraft ?? prev.inputDraft,
        sidebarHiddenSessionIds: patch.sidebarHiddenSessionIds ?? prev.sidebarHiddenSessionIds ?? []
      }
    }
  })
}

/**
 * 同步读取工作区内存缓存
 */
export function listWorkspaces(): WorkspaceInfo[] {
  return [...workspaceCache]
}

/**
 * 按 id 查工作区缓存
 *
 * @param workspaceId - 工作区 id
 */
export function getWorkspaceById(workspaceId: string): WorkspaceInfo | null {
  return workspaceCache.find((x) => x.id === workspaceId) || null
}

/**
 * 当前活动工作区 id（优先 UI 状态，回落列表首项）
 */
export function getActiveWorkspaceId(): string | null {
  const list = listWorkspaces()
  if (list.length === 0) return null
  const uiActive = getUiState().activeWorkspaceId
  if (uiActive && list.some((x) => x.id === uiActive)) return uiActive
  return list[0]!.id
}

/**
 * 当前活动工作区
 */
export function getActiveWorkspace(): WorkspaceInfo | null {
  const activeId = getActiveWorkspaceId()
  if (!activeId) return null
  return getWorkspaceById(activeId)
}

/**
 * 活动工作区 path（兼容旧 getWorkspace）
 */
export function getWorkspace(): string {
  return getActiveWorkspace()?.path || ''
}

/**
 * 设置活动工作区（仅本地 UI；不访问 API）
 *
 * @param workspaceId - 工作区 id
 */
export function setActiveWorkspace(workspaceId: string): WorkspaceInfo | null {
  const target = getWorkspaceById(workspaceId)
  if (!target) return null
  const uiState = getUiState()
  if (uiState.activeWorkspaceId !== target.id) {
    setUiState({ activeWorkspaceId: target.id })
  }
  return target
}

/**
 * 清空工作区内存缓存（登出时）
 */
export function clearWorkspaceCache(): void {
  workspaceCache = []
}

/**
 * 确保 Home 工作区 path 为本机主目录；必要时 PATCH API
 *
 * @param list - 当前工作区列表
 */
async function ensureHomePathLocal(list: WorkspaceInfo[]): Promise<WorkspaceInfo[]> {
  const homePath = normalizeWorkspacePath(app.getPath('home'))
  const home = list.find((x) => x.id === HOME_WORKSPACE_ID)
  if (!home) return list
  if (home.path === homePath) return list
  try {
    const updated = await apiPatchWorkspace(HOME_WORKSPACE_ID, { path: homePath })
    return list.map((w) => (w.id === HOME_WORKSPACE_ID ? updated : w))
  } catch (error) {
    logWorkspaceSessionApiError('ensureHomePathLocal', error)
    return list.map((w) =>
      w.id === HOME_WORKSPACE_ID ? { ...w, path: homePath, updatedAt: Date.now() } : w
    )
  }
}

/**
 * 从 API 拉取工作区并刷新内存缓存；顺带校正 Home path
 *
 * @returns 工作区列表
 */
export async function hydrateWorkspacesFromApi(): Promise<WorkspaceInfo[]> {
  if (!hasAccessToken()) {
    workspaceCache = []
    return []
  }
  try {
    let list = await apiListWorkspaces()
    list = await ensureHomePathLocal(list)
    workspaceCache = list
    const active = getActiveWorkspaceId()
    if (active) setUiState({ activeWorkspaceId: active })
    return listWorkspaces()
  } catch (error) {
    logWorkspaceSessionApiError('hydrateWorkspacesFromApi', error)
    throw error
  }
}

/**
 * 按路径添加或返回已有工作区，并写入 API
 *
 * @param dir - 本机目录
 */
export async function upsertWorkspaceByPath(dir: string): Promise<WorkspaceInfo> {
  const normalizedPath = normalizeWorkspacePath(dir)
  const existed = workspaceCache.find((x) => x.path === normalizedPath)
  if (existed) return existed

  const created = await apiCreateWorkspace({
    name: path.basename(normalizedPath) || normalizedPath,
    path: normalizedPath
  })
  workspaceCache = [...workspaceCache, created]
  return created
}

/**
 * 重命名工作区
 *
 * @param workspaceId - 工作区 id
 * @param name - 新名称
 */
export async function renameWorkspace(
  workspaceId: string,
  name: string
): Promise<WorkspaceInfo | null> {
  const nextName = name.trim()
  if (!nextName) return null
  if (!getWorkspaceById(workspaceId)) return null
  try {
    const updated = await apiPatchWorkspace(workspaceId, { name: nextName })
    workspaceCache = workspaceCache.map((w) => (w.id === workspaceId ? updated : w))
    return updated
  } catch (error) {
    logWorkspaceSessionApiError('renameWorkspace', error)
    throw error
  }
}

/**
 * 重排工作区
 *
 * @param orderIds - 有序 id 列表
 */
export async function reorderWorkspaces(orderIds: string[]): Promise<WorkspaceInfo[]> {
  if (!Array.isArray(orderIds) || orderIds.length === 0) return listWorkspaces()
  try {
    const list = await apiReorderWorkspaces(orderIds)
    workspaceCache = list
    return listWorkspaces()
  } catch (error) {
    logWorkspaceSessionApiError('reorderWorkspaces', error)
    throw error
  }
}

/**
 * 软删工作区（API）并更新缓存与 UI
 *
 * @param workspaceId - 工作区 id
 */
export async function removeWorkspace(workspaceId: string): Promise<boolean> {
  if (!getWorkspaceById(workspaceId)) return false
  try {
    await apiDeleteWorkspace(workspaceId)
  } catch (error) {
    logWorkspaceSessionApiError('removeWorkspace', error)
    throw error
  }

  workspaceCache = workspaceCache.filter((x) => x.id !== workspaceId)

  const active = getUiState().activeWorkspaceId
  if (active === workspaceId || !workspaceCache.some((x) => x.id === active)) {
    const fallback = workspaceCache[0]?.id ?? null
    setUiState({ activeWorkspaceId: fallback })
  }

  const uiState = getUiState()
  if (uiState.byWorkspace[workspaceId]) {
    const copied = { ...uiState.byWorkspace }
    delete copied[workspaceId]
    setUiState({ byWorkspace: copied })
  }
  return true
}

/**
 * 顶栏恢复 Home：若远端无 Home（已软删），重新创建固定 id
 */
export async function restoreHomeWorkspaceInList(): Promise<WorkspaceInfo | null> {
  const existing = getWorkspaceById(HOME_WORKSPACE_ID)
  if (existing) return existing

  const homePath = normalizeWorkspacePath(app.getPath('home'))
  try {
    const created = await apiCreateWorkspace({
      id: HOME_WORKSPACE_ID,
      name: '主目录',
      path: homePath,
      isDefault: true,
      sortOrder: 0
    })
    workspaceCache = [created, ...workspaceCache.filter((w) => w.id !== HOME_WORKSPACE_ID)]
    return created
  } catch (error) {
    // 可能 id 冲突（软删行仍占主键）：尝试 hydrate 后返回
    logWorkspaceSessionApiError('restoreHomeWorkspaceInList', error)
    await hydrateWorkspacesFromApi()
    return getWorkspaceById(HOME_WORKSPACE_ID)
  }
}

/**
 * 兼容旧 API：选择目录并设为活动工作区
 *
 * @param dir - 目录
 */
export async function setWorkspace(dir: string): Promise<void> {
  const workspace = await upsertWorkspaceByPath(dir)
  setActiveWorkspace(workspace.id)
}

/**
 * 是否已做过本地→API 迁移标记
 */
export function isWorkspaceSessionMigratedToApi(): boolean {
  return store.get('workspaceSessionMigratedToApi') === true
}

/**
 * 标记本地→API 迁移完成
 */
export function markWorkspaceSessionMigratedToApi(): void {
  store.set('workspaceSessionMigratedToApi', true)
}

/**
 * 读取旧版本地 workspace/session 数据（供一次性迁移）
 */
export function readLegacyLocalWorkspaceSessionData(): {
  workspaces: WorkspaceInfo[]
  sessionsMetaByWorkspace: Record<string, SessionInfo[]>
  sessionsMessagesByWorkspace: Record<string, Record<string, ChatMessage[]>>
} {
  const workspaces = Array.isArray(store.get('workspaces')) ? store.get('workspaces')! : []
  const sessionsMetaByWorkspace = store.get('sessionsMetaByWorkspace') || {}
  const sessionsMessagesByWorkspace = store.get('sessionsMessagesByWorkspace') || {}
  return { workspaces, sessionsMetaByWorkspace, sessionsMessagesByWorkspace }
}

/**
 * 清除 electron-store 中的旧 workspace/session 键
 */
export function clearLegacyLocalWorkspaceSessionKeys(): void {
  const keys = [
    'workspaces',
    'activeWorkspaceId',
    'workspaceBootstrapDone',
    'suppressHomeWorkspaceAutoEnsure',
    'sessionsMetaByWorkspace',
    'sessionsMessagesByWorkspace',
    'workspace',
    'sessionsMeta',
    'sessionsMessages'
  ] as const
  for (const key of keys) {
    try {
      store.delete(key)
    } catch {
      /* ignore */
    }
  }
  mainLog.info('[store] cleared legacy workspace/session keys from electron-store')
}

// 模块加载时同步一次 mcp.json
try {
  syncMcpConfigFile(normalizeSettings(store.get('settings')))
} catch {
  /* ignore */
}
