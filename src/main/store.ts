import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { app } from 'electron'
import Store from 'electron-store'

import {
  defaultProviderProfiles,
  defaultRendererUiState,
  defaultWorkspaceUiState,
  defaultSettings,
  type AppSettings,
  type ModelProviderId,
  type ProviderProfile,
  type ChatMessage,
  type RendererUiState,
  type SessionInfo,
  type WorkspaceInfo,
  type WorkspaceUiState
} from '../shared/ipc.js'

type StoreSchema = {
  workspaces: WorkspaceInfo[]
  activeWorkspaceId: string | null
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
  name: 'agent-weave',
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

function ensureDefaultWorkspace(list: WorkspaceInfo[]): WorkspaceInfo[] {
  if (list.some((item) => item.id === DEFAULT_WORKSPACE_ID)) {
    return list
  }
  return [createDefaultWorkspace(), ...list]
}

function normalizeWorkspaces(input: WorkspaceInfo[]): WorkspaceInfo[] {
  const list = ensureDefaultWorkspace(input)
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
    return
  }

  const now = Date.now()
  const legacyWorkspace = (store.get('workspace') || '').trim()
  const legacySessionsMeta = store.get('sessionsMeta') || []
  const legacySessionsMessages = store.get('sessionsMessages') || {}
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
    typeof legacyUiStateRaw?.activeSessionId === 'string' ? legacyUiStateRaw.activeSessionId : null
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
}

migrateFromLegacyIfNeeded()

type LegacyFlatSettings = {
  apiKey?: string
  baseUrl?: string
  model?: string
}

function normalizeSettings(input: Partial<AppSettings> & LegacyFlatSettings): AppSettings {
  const defaults = defaultSettings
  const baseProfiles = defaultProviderProfiles()
  const { baseUrl: legacyBaseUrl, model: legacyModel, apiKey: legacyApiKey, ...inputRest } = input
  const legacy: LegacyFlatSettings = {
    baseUrl: legacyBaseUrl,
    model: legacyModel,
    apiKey: legacyApiKey
  }
  const fromProfiles = inputRest.providerProfiles

  let providerProfiles: Record<ModelProviderId, ProviderProfile> = {
    deepseek: { ...baseProfiles.deepseek, ...fromProfiles?.deepseek },
    ollama: { ...baseProfiles.ollama, ...fromProfiles?.ollama }
  }

  const hadLegacyTopLevel =
    typeof legacy.baseUrl === 'string' ||
    typeof legacy.model === 'string' ||
    typeof legacy.apiKey === 'string'

  const looksNewProfileShape =
    fromProfiles != null &&
    typeof fromProfiles === 'object' &&
    (fromProfiles.deepseek != null || fromProfiles.ollama != null)

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

  const finalizeProfile = (p: ProviderProfile, id: ModelProviderId): ProviderProfile => ({
    ...p,
    enableTools:
      typeof p.enableTools === 'boolean' ? p.enableTools : id === 'ollama' ? false : true
  })
  providerProfiles = {
    deepseek: finalizeProfile(providerProfiles.deepseek, 'deepseek'),
    ollama: finalizeProfile(providerProfiles.ollama, 'ollama')
  }

  const provider: ModelProviderId = inputRest.provider === 'ollama' ? 'ollama' : 'deepseek'

  const merged: AppSettings = {
    ...defaults,
    ...inputRest,
    provider,
    providerProfiles,
    maxConcurrentStreams: inputRest.maxConcurrentStreams ?? defaults.maxConcurrentStreams,
    streamFlushMs: inputRest.streamFlushMs ?? defaults.streamFlushMs,
    streamFlushChars: inputRest.streamFlushChars ?? defaults.streamFlushChars,
    maxTerminalOutputChars: inputRest.maxTerminalOutputChars ?? defaults.maxTerminalOutputChars,
    maxAgentLoopSteps: inputRest.maxAgentLoopSteps ?? defaults.maxAgentLoopSteps,
    agentRunTimeoutMs: inputRest.agentRunTimeoutMs ?? defaults.agentRunTimeoutMs,
    tavilyApiKey:
      typeof inputRest.tavilyApiKey === 'string' ? inputRest.tavilyApiKey : defaults.tavilyApiKey
  }

  return {
    ...merged,
    maxTerminalOutputChars: Math.min(1000, Math.max(1, merged.maxTerminalOutputChars)),
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
    byWorkspace[workspaceId] = {
      activeSessionId: value?.activeSessionId ?? null,
      inputDraft: value?.inputDraft ?? ''
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
        inputDraft: patch.inputDraft ?? prev.inputDraft
      }
    }
  })
}

export function listWorkspaces(): WorkspaceInfo[] {
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
  const workspace = createWorkspaceFromPath(normalizedPath)
  const next = [...list, workspace]
  store.set('workspaces', next)
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

export function removeWorkspace(workspaceId: string): boolean {
  if (workspaceId === DEFAULT_WORKSPACE_ID) return false
  const list = listWorkspaces()
  const next = list.filter((x) => x.id !== workspaceId)
  if (next.length === list.length) return false
  store.set('workspaces', ensureDefaultWorkspace(next))
  const activeId = getActiveWorkspaceId()
  if (activeId === workspaceId) {
    setActiveWorkspace(DEFAULT_WORKSPACE_ID)
  }
  const uiState = getUiState()
  if (uiState.byWorkspace[workspaceId]) {
    const copied = { ...uiState.byWorkspace }
    delete copied[workspaceId]
    setUiState({ byWorkspace: copied })
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
