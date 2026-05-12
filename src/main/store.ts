import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { app } from 'electron'
import Store from 'electron-store'

import {
  defaultProviderProfiles,
  defaultRendererUiState,
  defaultWorkspaceUiState,
  defaultSettings,
  HOME_WORKSPACE_ID,
  parseMcpServersFromUnknown,
  type AppSettings,
  type McpServerEntry,
  type ModelProviderId,
  type ProviderProfile,
  type ChatMessage,
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
  name: 'agenxy',
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
      name: 'Home',
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
    name: 'Home',
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

type LegacyFlatSettings = {
  apiKey?: string
  baseUrl?: string
  model?: string
}

function normalizeMcpServers(raw: unknown): McpServerEntry[] {
  return parseMcpServersFromUnknown(raw)
}

function normalizeSettings(
  input: Partial<AppSettings> &
    LegacyFlatSettings & {
      skillsMarketCatalogUrl?: unknown
      skillsMarketCatalogRefreshHours?: unknown
      /** 旧版持久化字段，忽略 */
      maxConcurrentStreams?: unknown
      /** 已改为内置常量，忽略旧持久化 */
      streamFlushMs?: unknown
      streamFlushChars?: unknown
      maxTerminalOutputChars?: unknown
    }
): AppSettings {
  const defaults = defaultSettings
  const baseProfiles = defaultProviderProfiles()
  const {
    baseUrl: legacyBaseUrl,
    model: legacyModel,
    apiKey: legacyApiKey,
    skillsMarketCatalogUrl: legacySkillsMarketCatalogUrl,
    skillsMarketCatalogRefreshHours: legacySkillsMarketCatalogRefreshHours,
    maxConcurrentStreams: _legacyMaxConcurrentStreams,
    streamFlushMs: _legacyStreamFlushMs,
    streamFlushChars: _legacyStreamFlushChars,
    maxTerminalOutputChars: _legacyMaxTerminalOutputChars,
    ...inputRest
  } = input
  void legacySkillsMarketCatalogUrl
  void legacySkillsMarketCatalogRefreshHours
  void _legacyMaxConcurrentStreams
  void _legacyStreamFlushMs
  void _legacyStreamFlushChars
  void _legacyMaxTerminalOutputChars
  const legacy: LegacyFlatSettings = {
    baseUrl: legacyBaseUrl,
    model: legacyModel,
    apiKey: legacyApiKey
  }
  const fromProfiles = inputRest.providerProfiles

  let providerProfiles: Record<ModelProviderId, ProviderProfile> = {
    deepseek: { ...baseProfiles.deepseek, ...fromProfiles?.deepseek }
  }

  const hadLegacyTopLevel =
    typeof legacy.baseUrl === 'string' ||
    typeof legacy.model === 'string' ||
    typeof legacy.apiKey === 'string'

  const looksNewProfileShape =
    fromProfiles != null &&
    typeof fromProfiles === 'object' &&
    fromProfiles.deepseek != null

  if (hadLegacyTopLevel && !looksNewProfileShape) {
    providerProfiles = {
      ...providerProfiles,
      deepseek: {
        ...providerProfiles.deepseek,
        baseUrl: legacy.baseUrl?.trim() || providerProfiles.deepseek.baseUrl,
        model: legacy.model?.trim() || providerProfiles.deepseek.model,
        apiKey: typeof legacy.apiKey === 'string' ? legacy.apiKey : providerProfiles.deepseek.apiKey
      }
    }
  }

  const finalizeProfile = (p: ProviderProfile): ProviderProfile => ({
    baseUrl: p.baseUrl ?? '',
    model: p.model ?? '',
    apiKey: p.apiKey ?? ''
  })
  providerProfiles = {
    deepseek: finalizeProfile(providerProfiles.deepseek)
  }

  const provider: ModelProviderId = 'deepseek'

  const merged: AppSettings = {
    ...defaults,
    ...inputRest,
    provider,
    providerProfiles,
    maxAgentLoopSteps: inputRest.maxAgentLoopSteps ?? defaults.maxAgentLoopSteps,
    agentRunTimeoutMs: inputRest.agentRunTimeoutMs ?? defaults.agentRunTimeoutMs,
    tavilyApiKey:
      typeof inputRest.tavilyApiKey === 'string' ? inputRest.tavilyApiKey : defaults.tavilyApiKey,
    mcpServers: normalizeMcpServers(
      inputRest.mcpServers !== undefined ? inputRest.mcpServers : defaults.mcpServers
    )
  }

  return {
    ...merged,
    maxAgentLoopSteps: Math.min(64, Math.max(4, Math.floor(merged.maxAgentLoopSteps))),
    agentRunTimeoutMs: Math.min(600_000, Math.max(5_000, Math.floor(merged.agentRunTimeoutMs)))
  }
}

export function getWorkspace(): string {
  return getActiveWorkspace()?.path || ''
}

export function setWorkspace(dir: string): void {
  const workspace = upsertWorkspaceByPath(dir)
  setActiveWorkspace(workspace.id)
}

export function getSettings(): AppSettings {
  return normalizeSettings(store.get('settings'))
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const next = normalizeSettings({ ...getSettings(), ...patch })
  store.set('settings', next)
  return next
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
    const { removeWorkspaceSessions } =
      require('@/main/sessions') as typeof import('@/main/sessions')
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
