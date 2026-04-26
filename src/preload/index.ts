import { contextBridge, ipcRenderer } from 'electron'

import {
  EVENTS,
  IPC,
  type AppSettings,
  type ChatMessage,
  type RendererUiState,
  type SessionInfo,
  type StreamEvent
} from '../shared/ipc.js'

const api = {
  selectWorkspace: () => ipcRenderer.invoke(IPC.WORKSPACE_SELECT) as Promise<{ path: string }>,
  getWorkspace: () => ipcRenderer.invoke(IPC.WORKSPACE_GET) as Promise<string>,
  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET) as Promise<AppSettings>,
  setSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.invoke(IPC.SETTINGS_SET, patch) as Promise<AppSettings>,
  getUiState: () => ipcRenderer.invoke(IPC.UI_STATE_GET) as Promise<RendererUiState>,
  setUiState: (patch: Partial<RendererUiState>) =>
    ipcRenderer.invoke(IPC.UI_STATE_SET, patch) as Promise<RendererUiState>,
  listSessions: () => ipcRenderer.invoke(IPC.SESSIONS_LIST) as Promise<SessionInfo[]>,
  getSessionMessages: (sessionId: string) =>
    ipcRenderer.invoke(IPC.SESSIONS_GET_MESSAGES, sessionId) as Promise<ChatMessage[]>,
  createSession: (name?: string) =>
    ipcRenderer.invoke(IPC.SESSIONS_CREATE, name) as Promise<SessionInfo>,
  renameSession: (id: string, name: string) =>
    ipcRenderer.invoke(IPC.SESSIONS_RENAME, id, name) as Promise<SessionInfo | null>,
  deleteSession: (id: string) =>
    ipcRenderer.invoke(IPC.SESSIONS_DELETE, id) as Promise<{ ok: true }>,
  sendAgentMessage: (sessionId: string, text: string) =>
    ipcRenderer.invoke(IPC.AGENT_SEND, sessionId, text) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  cancelAgent: (sessionId: string) =>
    ipcRenderer.invoke(IPC.AGENT_CANCEL, sessionId) as Promise<{ ok: true }>,
  toggleDevtools: () => ipcRenderer.invoke(IPC.DEVTOOLS_TOGGLE) as Promise<{ open: boolean }>,
  openExternal: (url: string) =>
    ipcRenderer.invoke(IPC.EXTERNAL_OPEN, url) as Promise<{ ok: boolean }>,
  onStream: (cb: (e: StreamEvent) => void) => {
    const h = (_: Electron.IpcRendererEvent, p: StreamEvent) => cb(p)
    ipcRenderer.on(EVENTS.AGENT_STREAM, h)
    return () => {
      ipcRenderer.removeListener(EVENTS.AGENT_STREAM, h)
    }
  },
  onSessionsSync: (cb: (s: SessionInfo[]) => void) => {
    const h = (_: Electron.IpcRendererEvent, s: SessionInfo[]) => cb(s)
    ipcRenderer.on(EVENTS.SESSIONS_SYNC, h)
    return () => {
      ipcRenderer.removeListener(EVENTS.SESSIONS_SYNC, h)
    }
  },
  onWorkspaceChange: (cb: (p: { path: string }) => void) => {
    const h = (_: Electron.IpcRendererEvent, p: { path: string }) => cb(p)
    ipcRenderer.on(EVENTS.WORKSPACE_CHANGED, h)
    return () => {
      ipcRenderer.removeListener(EVENTS.WORKSPACE_CHANGED, h)
    }
  },
  onSettingsSync: (cb: (s: AppSettings) => void) => {
    const h = (_: Electron.IpcRendererEvent, s: AppSettings) => cb(s)
    ipcRenderer.on(EVENTS.SETTINGS_SYNC, h)
    return () => {
      ipcRenderer.removeListener(EVENTS.SETTINGS_SYNC, h)
    }
  }
}

contextBridge.exposeInMainWorld('bridge', api)

export type AgentWeaveApi = typeof api
