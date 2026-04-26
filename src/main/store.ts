import path from 'node:path'

import { app } from 'electron'
import Store from 'electron-store'

import {
  defaultRendererUiState,
  defaultSettings,
  type AppSettings,
  type ChatMessage,
  type RendererUiState,
  type SessionInfo
} from '../shared/ipc.js'

type StoreSchema = {
  workspace: string
  settings: AppSettings
  uiState: RendererUiState
  /** 会话元数据持久化：会话 id、标题、时间 */
  sessionsMeta: SessionInfo[]
  /** 会话问答持久化：按 sessionId 存储 */
  sessionsMessages: Record<string, ChatMessage[]>
}

const store = new Store<StoreSchema>({
  name: 'agent-weave',
  defaults: {
    workspace: '',
    settings: { ...defaultSettings },
    uiState: { ...defaultRendererUiState },
    sessionsMeta: [],
    sessionsMessages: {}
  }
})

function normalizeSettings(input: Partial<AppSettings>): AppSettings {
  const merged = { ...defaultSettings, ...input }
  return {
    ...merged,
    maxTerminalOutputChars: Math.min(1000, Math.max(1, merged.maxTerminalOutputChars))
  }
}

export function getWorkspace(): string {
  return store.get('workspace') || ''
}

export function setWorkspace(dir: string): void {
  store.set('workspace', path.resolve(dir))
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
  return {
    activeSessionId: input.activeSessionId ?? null,
    inputDraft: input.inputDraft ?? ''
  }
}

export function getUiState(): RendererUiState {
  return normalizeUiState(store.get('uiState'))
}

export function setUiState(patch: Partial<RendererUiState>): RendererUiState {
  const next = normalizeUiState({ ...getUiState(), ...patch })
  store.set('uiState', next)
  return next
}

export function getSessionsMeta(): SessionInfo[] {
  return store.get('sessionsMeta') || []
}

export function setSessionsMeta(list: SessionInfo[]): void {
  store.set('sessionsMeta', list)
}

export function getSessionMessages(sessionId: string): ChatMessage[] {
  const all = store.get('sessionsMessages') || {}
  return all[sessionId] || []
}

export function setSessionMessages(sessionId: string, list: ChatMessage[]): void {
  const all = store.get('sessionsMessages') || {}
  all[sessionId] = list
  store.set('sessionsMessages', all)
}

export function deleteSessionMessages(sessionId: string): void {
  const all = store.get('sessionsMessages') || {}
  if (!(sessionId in all)) return
  delete all[sessionId]
  store.set('sessionsMessages', all)
}

export function userDataPath(): string {
  return app.getPath('userData')
}
