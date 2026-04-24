import path from 'node:path'
import { app } from 'electron'
import Store from 'electron-store'
import { defaultSettings, type AppSettings, type SessionInfo } from '../shared/ipc.js'

type StoreSchema = {
  workspace: string
  settings: AppSettings
  /** 轻量持久化：会话 id+标题；消息仍以内存为主，避免超大 JSON */
  sessionsMeta: SessionInfo[]
}

const store = new Store<StoreSchema>({
  name: 'agent-weave',
  defaults: {
    workspace: '',
    settings: { ...defaultSettings },
    sessionsMeta: []
  }
})

export function getWorkspace(): string {
  return store.get('workspace') || ''
}

export function setWorkspace(dir: string): void {
  store.set('workspace', path.resolve(dir))
}

export function getSettings(): AppSettings {
  return { ...defaultSettings, ...store.get('settings') }
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch }
  store.set('settings', next)
  return next
}

export function getSessionsMeta(): SessionInfo[] {
  return store.get('sessionsMeta') || []
}

export function setSessionsMeta(list: SessionInfo[]): void {
  store.set('sessionsMeta', list)
}

export function userDataPath(): string {
  return app.getPath('userData')
}
