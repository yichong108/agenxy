import { contextBridge, ipcRenderer } from 'electron'
import { EVENTS, IPC, type AppSettings, type SessionInfo, type StreamEvent } from '../shared/ipc.js'

const api = {
  selectWorkspace: () => ipcRenderer.invoke(IPC.WORKSPACE_SELECT) as Promise<{ path: string }>,
  getWorkspace: () => ipcRenderer.invoke(IPC.WORKSPACE_GET) as Promise<string>,
  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET) as Promise<AppSettings>,
  setSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.SETTINGS_SET, patch) as Promise<AppSettings>,
  listSessions: () => ipcRenderer.invoke(IPC.SESSIONS_LIST) as Promise<SessionInfo[]>,
  createSession: (name?: string) => ipcRenderer.invoke(IPC.SESSIONS_CREATE, name) as Promise<SessionInfo>,
  renameSession: (id: string, name: string) => ipcRenderer.invoke(IPC.SESSIONS_RENAME, id, name) as Promise<SessionInfo | null>,
  deleteSession: (id: string) => ipcRenderer.invoke(IPC.SESSIONS_DELETE, id) as Promise<{ ok: true }>,
  sendAgentMessage: (sessionId: string, text: string) =>
    ipcRenderer.invoke(IPC.AGENT_SEND, sessionId, text) as Promise<{ ok: true } | { ok: false; error: string }>,
  cancelAgent: (sessionId: string) => ipcRenderer.invoke(IPC.AGENT_CANCEL, sessionId) as Promise<{ ok: true }>,
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

contextBridge.exposeInMainWorld('agentWeave', api)

export type AgentWeaveApi = typeof api
