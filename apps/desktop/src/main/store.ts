import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { getOpenworkDir, getOpenworkMcpConfigPath } from '@openwork/agent'
import { app } from 'electron'
import Store from 'electron-store'

import { removeWorkspaceSessions } from '@/main/sessions'
import { fetchSettingsFromApi, logSettingsApiError, putSettingsToApi } from '@/main/settings-api'
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

type StoreSchema = {
  workspaces: WorkspaceInfo[]
  activeWorkspaceId: string | null
  /** 已完成工作区初始化；空列表时不自动塞回默认项（区别于首次安装种子） */
  workspaceBootstrapDone?: boolean
  /** 用户已移除 Home（workspace-home），读取列表时不再自动插入该项 */
  suppressHomeWorkspaceAutoEnsure?: boolean
  settings: AppSettings
  uiState: RendererUiState
  /** 会话元数据持久化：按 workspaceId 分桶 */
  sessionsMetaByWorkspace: Record<string, SessionInfo[]>
  /** 会话问答持久化：按 workspaceId + sessionId 存储 */
  sessionsMessagesByWorkspace: Record<string, Record<string, ChatMessage[]>>
  /** 兼容旧版字段（仅用于迁移） */
  workspace?: string
  sessionsMeta?: SessionInfo[]
  sessionsMessages?: Record<string, ChatMessage[]>
}

const DEFAULT_WORKSPACE_ID = 'workspace-default'

const store = new Store<StoreSchema>({
  name: 'openwork',
  defaults: {
    workspaces: [],
    activeWorkspaceId: null,
    settings: { ...defaultSettings },
    uiState: { ...defaultRendererUiState },
    sessionsMetaByWorkspace: {},
    sessionsMessagesByWorkspace: {}
  }
})

function createDefaultWorkspace(timestamp = Date.now()): WorkspaceInfo {
  return {
    id: DEFAULT_WORKSPACE_ID,
    name: '默认工作区',
    path: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    isDefault: true
  }
}

function createWorkspaceFromPath(workspacePath: string, timestamp = Date.now()): WorkspaceInfo {
  return {
    id: randomUUID(),
    name: path.basename(workspacePath) || workspacePath,
    path: workspacePath,
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

function normalizeWorkspacePath(dir: string): string {
  return path.resolve(dir).replace(/[\\/]+$/, '')
}

function normalizeWorkspaces(input: WorkspaceInfo[]): WorkspaceInfo[] {
  const raw = Array.isArray(input) ? input : []
  /** 持久化空数组表示侧栏已清空，不在读取时自动注入默认工作区 */
  if (raw.length === 0) {
    return []
  }
  const list = raw
  const dedupById = new Map<string, WorkspaceInfo>()
  const dedupByPath = new Map<string, string>()
  for (const item of list) {
    const id = item.id || randomUUID()
    const normalizedPath = item.path ? normalizeWorkspacePath(item.path) : null
    if (normalizedPath && dedupByPath.has(normalizedPath)) {
      continue
    }
    if (normalizedPath) dedupByPath.set(normalizedPath, id)
    dedupById.set(id, {
      ...item,
      id,
      path: normalizedPath,
      name: item.name || (normalizedPath ? path.basename(normalizedPath) : '默认工作区'),
      isDefault: id === DEFAULT_WORKSPACE_ID ? true : item.isDefault,
      updatedAt: item.updatedAt || Date.now(),
      createdAt: item.createdAt || Date.now()
    })
  }
  return [...dedupById.values()]
}

function migrateFromLegacyIfNeeded(): void {
  const currentWorkspaces = store.get('workspaces')
  if (Array.isArray(currentWorkspaces) && currentWorkspaces.length > 0) {
    const normalized = normalizeWorkspaces(currentWorkspaces)
    store.set('workspaces', normalized)
    const activeWorkspaceId = store.get('activeWorkspaceId')
    if (!activeWorkspaceId || !normalized.some((x) => x.id === activeWorkspaceId)) {
      store.set('activeWorkspaceId', normalized[0]?.id ?? null)
    }
    store.set('workspaceBootstrapDone', true)
    return
  }

  const legacyWorkspace = (store.get('workspace') || '').trim()
  const legacySessionsMeta = store.get('sessionsMeta') || []
  const legacySessionsMessages = store.get('sessionsMessages') || {}
  const hasLegacyData =
    Boolean(legacyWorkspace) ||
    (Array.isArray(legacySessionsMeta) && legacySessionsMeta.length > 0) ||
    (legacySessionsMessages &&
      typeof legacySessionsMessages === 'object' &&
      Object.keys(legacySessionsMessages).length > 0)

  if (hasLegacyData) {
    const now = Date.now()
    const legacyUiStateRaw = store.get('uiState') as Partial<RendererUiState> &
      Partial<WorkspaceUiState> & {
        activeSessionId?: string | null
        inputDraft?: string
      }

    const defaultWorkspace = createDefaultWorkspace(now)
    const nextWorkspaces: WorkspaceInfo[] = [defaultWorkspace]
    if (legacyWorkspace) {
      nextWorkspaces.push(createWorkspaceFromPath(normalizeWorkspacePath(legacyWorkspace), now))
    }

    const activeSessionId =
      typeof legacyUiStateRaw?.activeSessionId === 'string'
        ? legacyUiStateRaw.activeSessionId
        : null
    const inputDraft =
      typeof legacyUiStateRaw?.inputDraft === 'string' ? legacyUiStateRaw.inputDraft : ''

    store.set('workspaces', nextWorkspaces)
    store.set('activeWorkspaceId', defaultWorkspace.id)
    store.set('sessionsMetaByWorkspace', { [defaultWorkspace.id]: legacySessionsMeta })
    store.set('sessionsMessagesByWorkspace', { [defaultWorkspace.id]: legacySessionsMessages })
    store.set('uiState', {
      activeWorkspaceId: defaultWorkspace.id,
      byWorkspace: {
        [defaultWorkspace.id]: {
          activeSessionId,
          inputDraft
        }
      }
    })
    store.set('workspaceBootstrapDone', true)
    return
  }

  if (!store.get('workspaceBootstrapDone')) {
    const now = Date.now()
    const homePath = normalizeWorkspacePath(app.getPath('home'))
    const homeWs: WorkspaceInfo = {
      id: HOME_WORKSPACE_ID,
      name: '主目录',
      path: homePath,
      createdAt: now,
      updatedAt: now
    }
    store.set('workspaces', [homeWs])
    store.set('activeWorkspaceId', homeWs.id)
    store.set('sessionsMetaByWorkspace', { [homeWs.id]: [] })
    store.set('uiState', {
      activeWorkspaceId: homeWs.id,
      byWorkspace: {
        [homeWs.id]: {
          activeSessionId: null,
          inputDraft: ''
        }
      }
    })
    store.set('workspaceBootstrapDone', true)
  }
}

migrateFromLegacyIfNeeded()

/** 保证存在主目录工作区；若已有同路径工作区则合并会话后改为固定 Home ID（除非用户已移除 Home） */
export function ensureHomeWorkspaceInList(): void {
  const homePath = normalizeWorkspacePath(app.getPath('home'))
  let list = normalizeWorkspaces(store.get('workspaces') || [])

  if (list.some((x) => x.id === HOME_WORKSPACE_ID)) {
    const idx = list.findIndex((x) => x.id === HOME_WORKSPACE_ID)
    if (idx >= 0 && list[idx]!.path !== homePath) {
      const next = [...list]
      next[idx] = { ...next[idx]!, path: homePath, updatedAt: Date.now() }
      store.set('workspaces', next)
    }
    return
  }

  if (store.get('suppressHomeWorkspaceAutoEnsure')) {
    return
  }

  const dup = list.find((x) => x.path === homePath)
  if (dup && dup.id !== HOME_WORKSPACE_ID) {
    moveWorkspaceSessionData(dup.id, HOME_WORKSPACE_ID)
    list = list.filter((x) => x.id !== dup.id)
  }

  const now = Date.now()
  const homeWs: WorkspaceInfo = {
    id: HOME_WORKSPACE_ID,
    name: '主目录',
    path: homePath,
    createdAt: dup?.createdAt ?? now,
    updatedAt: now
  }
  store.set('workspaces', [homeWs, ...list])
}

ensureHomeWorkspaceInList()

/** 顶栏选择 Home 时：取消移除抑制并写回列表（与 ensureHomeWorkspaceInList 配合） */
export function restoreHomeWorkspaceInList(): void {
  store.set('suppressHomeWorkspaceAutoEnsure', false)
  ensureHomeWorkspaceInList()
}

export function getWorkspace(): string {
  return getActiveWorkspace()?.path || ''
}

export function setWorkspace(dir: string): void {
  const workspace = upsertWorkspaceByPath(dir)
  setActiveWorkspace(workspace.id)
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
 * MCP 配置文件路径（~/.openwork/mcp.json），与 createAgent.send 约定一致。
 *
 * @returns 绝对路径
 */
export function getMcpConfigPath(): string {
  return getOpenworkMcpConfigPath()
}

/**
 * 将 settings.mcpServers 同步写入 mcp.json，供 agent 包读取。
 *
 * @param settings - 当前应用设置
 */
function syncMcpConfigFile(settings: AppSettings): void {
  try {
    mkdirSync(getOpenworkDir(), { recursive: true })
    const payload = { mcpServers: settings.mcpServers ?? [] }
    writeFileSync(getMcpConfigPath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch (e) {
    console.warn('[store] Failed to sync mcp.json:', e instanceof Error ? e.message : e)
  }
}

/**
 * 读取本地缓存的 AppSettings（同步）
 *
 * Agent 运行路径使用此方法，避免每次工具调用都打 API。
 * 缓存由 `loadSettingsFromApi` / `setSettings` 与远端对齐。
 *
 * @returns 规范化后的 AppSettings
 */
export function getSettings(): AppSettings {
  return normalizeSettings(store.get('settings'))
}

/**
 * 从 API 拉取 settings 并刷新本地缓存；失败时回落本地缓存
 *
 * 首次远端为默认空配置且本地已有用户配置时，会把本地配置推到 API（一次性迁移）。
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
 * 合并 patch，优先写入 API，成功后同步本地缓存；API 失败时仍写本地并返回本地结果
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

export function getUiState(): RendererUiState {
  return normalizeUiState(store.get('uiState'))
}

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

export function getWorkspaceUiState(workspaceId: string): WorkspaceUiState {
  return getUiState().byWorkspace[workspaceId] || { ...defaultWorkspaceUiState }
}

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

export function listWorkspaces(): WorkspaceInfo[] {
  ensureHomeWorkspaceInList()
  return normalizeWorkspaces(store.get('workspaces') || [])
}

export function getWorkspaceById(workspaceId: string): WorkspaceInfo | null {
  return listWorkspaces().find((x) => x.id === workspaceId) || null
}

export function getActiveWorkspaceId(): string | null {
  const list = listWorkspaces()
  if (list.length === 0) return null
  const active = store.get('activeWorkspaceId')
  if (active && list.some((x) => x.id === active)) {
    return active
  }
  const fallback = list[0]!.id
  store.set('activeWorkspaceId', fallback)
  return fallback
}

export function getActiveWorkspace(): WorkspaceInfo | null {
  const activeId = getActiveWorkspaceId()
  if (!activeId) return null
  return getWorkspaceById(activeId)
}

export function setActiveWorkspace(workspaceId: string): WorkspaceInfo | null {
  const target = getWorkspaceById(workspaceId)
  if (!target) return null
  store.set('activeWorkspaceId', target.id)
  const uiState = getUiState()
  if (uiState.activeWorkspaceId !== target.id) {
    setUiState({ activeWorkspaceId: target.id })
  }
  return target
}

export function upsertWorkspaceByPath(dir: string): WorkspaceInfo {
  const normalizedPath = normalizeWorkspacePath(dir)
  const list = listWorkspaces()
  const existed = list.find((x) => x.path === normalizedPath)
  if (existed) {
    return existed
  }
  const listWasEmpty = list.length === 0
  const workspace = createWorkspaceFromPath(normalizedPath)
  const next = [...list, workspace]
  store.set('workspaces', next)
  if (listWasEmpty && getSessionsMeta(DEFAULT_WORKSPACE_ID).length > 0) {
    removeWorkspaceSessions(DEFAULT_WORKSPACE_ID, workspace.id)
  }
  return workspace
}

export function renameWorkspace(workspaceId: string, name: string): WorkspaceInfo | null {
  const nextName = name.trim()
  if (!nextName) return null
  const list = listWorkspaces()
  const idx = list.findIndex((x) => x.id === workspaceId)
  if (idx < 0) return null
  const nextItem = {
    ...list[idx]!,
    name: nextName,
    updatedAt: Date.now()
  }
  list[idx] = nextItem
  store.set('workspaces', list)
  return nextItem
}

export function reorderWorkspaces(orderIds: string[]): WorkspaceInfo[] {
  const list = listWorkspaces()
  if (!Array.isArray(orderIds) || orderIds.length === 0) return list

  const byId = new Map(list.map((item) => [item.id, item] as const))
  const orderedIds: string[] = []
  const seen = new Set<string>()
  for (const id of orderIds) {
    if (typeof id !== 'string') continue
    if (!byId.has(id) || seen.has(id)) continue
    seen.add(id)
    orderedIds.push(id)
  }
  if (orderedIds.length === 0) return list

  const next: WorkspaceInfo[] = orderedIds.map((id) => byId.get(id)!).filter(Boolean)
  for (const item of list) {
    if (!seen.has(item.id)) next.push(item)
  }

  store.set('workspaces', next)
  return next
}

export function removeWorkspace(workspaceId: string): boolean {
  const list = listWorkspaces()
  const next = list.filter((x) => x.id !== workspaceId)
  if (next.length === list.length) return false

  const finalList = next
  store.set('workspaces', finalList)

  if (workspaceId === HOME_WORKSPACE_ID) {
    store.set('suppressHomeWorkspaceAutoEnsure', true)
  }

  const active = store.get('activeWorkspaceId')
  if (active === workspaceId || !finalList.some((x) => x.id === active)) {
    const fallback = finalList[0]?.id ?? null
    if (fallback) {
      setActiveWorkspace(fallback)
    } else {
      store.set('activeWorkspaceId', null)
      setUiState({ activeWorkspaceId: null })
    }
  }

  const uiState = getUiState()
  if (uiState.byWorkspace[workspaceId]) {
    const copied = { ...uiState.byWorkspace }
    delete copied[workspaceId]
    setUiState({ byWorkspace: copied })
  }
  if (finalList.length === 0) {
    store.set('workspaceBootstrapDone', true)
  }
  return true
}

export function getDefaultWorkspaceId(): string {
  return DEFAULT_WORKSPACE_ID
}

export function getSessionsMeta(workspaceId: string): SessionInfo[] {
  const all = store.get('sessionsMetaByWorkspace') || {}
  return all[workspaceId] || []
}

export function getAllSessionsMetaByWorkspace(): Record<string, SessionInfo[]> {
  return store.get('sessionsMetaByWorkspace') || {}
}

export function setSessionsMeta(workspaceId: string, list: SessionInfo[]): void {
  const all = store.get('sessionsMetaByWorkspace') || {}
  all[workspaceId] = list
  store.set('sessionsMetaByWorkspace', all)
}

export function getSessionMessages(workspaceId: string, sessionId: string): ChatMessage[] {
  const all = store.get('sessionsMessagesByWorkspace') || {}
  const bucket = all[workspaceId] || {}
  return bucket[sessionId] || []
}

export function setSessionMessages(
  workspaceId: string,
  sessionId: string,
  list: ChatMessage[]
): void {
  const all = store.get('sessionsMessagesByWorkspace') || {}
  const bucket = all[workspaceId] || {}
  bucket[sessionId] = list
  all[workspaceId] = bucket
  store.set('sessionsMessagesByWorkspace', all)
}

export function deleteSessionMessages(workspaceId: string, sessionId: string): void {
  const all = store.get('sessionsMessagesByWorkspace') || {}
  const bucket = all[workspaceId] || {}
  if (!(sessionId in bucket)) return
  delete bucket[sessionId]
  all[workspaceId] = bucket
  store.set('sessionsMessagesByWorkspace', all)
}

export function moveWorkspaceSessionData(fromWorkspaceId: string, toWorkspaceId: string): void {
  if (fromWorkspaceId === toWorkspaceId) return
  const allMeta = store.get('sessionsMetaByWorkspace') || {}
  const allMessages = store.get('sessionsMessagesByWorkspace') || {}
  const fromMeta = allMeta[fromWorkspaceId] || []
  const toMeta = allMeta[toWorkspaceId] || []
  allMeta[toWorkspaceId] = [...toMeta, ...fromMeta]
  delete allMeta[fromWorkspaceId]

  const fromMessages = allMessages[fromWorkspaceId] || {}
  const toMessages = allMessages[toWorkspaceId] || {}
  allMessages[toWorkspaceId] = { ...toMessages, ...fromMessages }
  delete allMessages[fromWorkspaceId]
  store.set('sessionsMetaByWorkspace', allMeta)
  store.set('sessionsMessagesByWorkspace', allMessages)
}

export function userDataPath(): string {
  return app.getPath('userData')
}

// 模块加载时同步一次，保证 createAgent 首次 run 前 mcp.json 已存在
try {
  syncMcpConfigFile(normalizeSettings(store.get('settings')))
} catch {
  /* ignore */
}
