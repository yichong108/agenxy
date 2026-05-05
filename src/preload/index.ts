import { contextBridge, ipcRenderer } from 'electron'

import { installElectronLogBridge } from '@/preload/electron-log-bridge'
import {
  EVENTS,
  IPC,
  type AppSettings,
  type ChatMessage,
  type McpProbeResult,
  type McpServerEntry,
  type McpWarmupReport,
  type McpWarmupStatus,
  type RendererUiState,
  type SessionInfo,
  type SkillsInstallResult,
  type SkillsMarketCatalogItem,
  type SkillsRuntimeState,
  type SkillsUninstallPayload,
  type SkillsUninstallResult,
  type StreamEvent,
  type WebEditAction,
  type WindowChromeAction,
  type WorkspaceInfo,
  type WorkspacesPayload
} from '@/shared/ipc'

installElectronLogBridge()

const api = {
  /** 渲染进程用于判断是否启用 Windows 自定义标题栏菜单 */
  platform: process.platform,
  windowAction: (action: WindowChromeAction) =>
    ipcRenderer.invoke(IPC.WINDOW_ACTION, action) as Promise<void>,
  webEdit: (action: WebEditAction) => ipcRenderer.invoke(IPC.WEB_EDIT, action) as Promise<void>,
  showAbout: () => ipcRenderer.invoke(IPC.APP_ABOUT) as Promise<void>,
  selectWorkspace: () => ipcRenderer.invoke(IPC.WORKSPACE_SELECT) as Promise<{ path: string }>,
  getWorkspace: () => ipcRenderer.invoke(IPC.WORKSPACE_GET) as Promise<string>,
  listWorkspaces: () => ipcRenderer.invoke(IPC.WORKSPACE_LIST) as Promise<WorkspacesPayload>,
  addWorkspace: (dir: string) =>
    ipcRenderer.invoke(IPC.WORKSPACE_ADD, dir) as Promise<WorkspaceInfo | null>,
  activateWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(IPC.WORKSPACE_ACTIVATE, workspaceId) as Promise<WorkspaceInfo | null>,
  reorderWorkspaces: (orderIds: string[]) =>
    ipcRenderer.invoke(IPC.WORKSPACE_REORDER, orderIds) as Promise<WorkspacesPayload>,
  renameWorkspace: (workspaceId: string, name: string) =>
    ipcRenderer.invoke(IPC.WORKSPACE_RENAME, workspaceId, name) as Promise<WorkspaceInfo | null>,
  removeWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(IPC.WORKSPACE_REMOVE, workspaceId) as Promise<{ ok: boolean }>,
  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET) as Promise<AppSettings>,
  setSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.invoke(IPC.SETTINGS_SET, patch) as Promise<AppSettings>,
  getUiState: () => ipcRenderer.invoke(IPC.UI_STATE_GET) as Promise<RendererUiState>,
  setUiState: (patch: Partial<RendererUiState>) =>
    ipcRenderer.invoke(IPC.UI_STATE_SET, patch) as Promise<RendererUiState>,
  listSessions: () => ipcRenderer.invoke(IPC.SESSIONS_LIST) as Promise<SessionInfo[]>,
  listSessionsByWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(IPC.SESSIONS_LIST_BY_WORKSPACE, workspaceId) as Promise<SessionInfo[]>,
  getSessionMessages: (sessionId: string) =>
    ipcRenderer.invoke(IPC.SESSIONS_GET_MESSAGES, sessionId) as Promise<ChatMessage[]>,
  createSession: (name?: string) =>
    ipcRenderer.invoke(IPC.SESSIONS_CREATE, name) as Promise<SessionInfo | null>,
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
  mcpProbeServer: (entry: McpServerEntry) =>
    ipcRenderer.invoke(IPC.MCP_PROBE, entry) as Promise<McpProbeResult>,
  getMcpWarmupStatus: () => ipcRenderer.invoke(IPC.MCP_WARMUP_GET) as Promise<McpWarmupStatus>,
  mcpRunWarmup: () => ipcRenderer.invoke(IPC.MCP_WARMUP_RUN) as Promise<McpWarmupReport>,
  onMcpWarmup: (cb: (r: McpWarmupReport) => void) => {
    const h = (_: Electron.IpcRendererEvent, r: McpWarmupReport) => cb(r)
    ipcRenderer.on(EVENTS.MCP_WARMUP, h)
    return () => {
      ipcRenderer.removeListener(EVENTS.MCP_WARMUP, h)
    }
  },
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
  onWorkspacesSync: (cb: (p: WorkspacesPayload) => void) => {
    const h = (_: Electron.IpcRendererEvent, p: WorkspacesPayload) => cb(p)
    ipcRenderer.on(EVENTS.WORKSPACES_SYNC, h)
    return () => {
      ipcRenderer.removeListener(EVENTS.WORKSPACES_SYNC, h)
    }
  },
  onSettingsSync: (cb: (s: AppSettings) => void) => {
    const h = (_: Electron.IpcRendererEvent, s: AppSettings) => cb(s)
    ipcRenderer.on(EVENTS.SETTINGS_SYNC, h)
    return () => {
      ipcRenderer.removeListener(EVENTS.SETTINGS_SYNC, h)
    }
  },
  getSkillsState: () => ipcRenderer.invoke(IPC.SKILLS_STATE) as Promise<SkillsRuntimeState>,
  installSkillFromMarket: (item: SkillsMarketCatalogItem) =>
    ipcRenderer.invoke(IPC.SKILLS_INSTALL, item) as Promise<SkillsInstallResult>,
  uninstallSkill: (payload: SkillsUninstallPayload) =>
    ipcRenderer.invoke(IPC.SKILLS_UNINSTALL, payload) as Promise<SkillsUninstallResult>
}

contextBridge.exposeInMainWorld('bridge', api)

export type AgentWeaveApi = typeof api
