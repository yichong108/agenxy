/// <reference types="vite/client" />

import type {
  AboutAppInfo,
  AgentSendOptions,
  AppSettings,
  ChatMessage,
  McpProbeResult,
  McpServerEntry,
  McpWarmupReport,
  McpWarmupStatus,
  RendererUiState,
  SessionInfo,
  StreamEvent,
  TerminalCompleteResult,
  TerminalOutputEvent,
  TerminalRunResult,
  WebEditAction,
  WindowChromeAction,
  WorkspaceFileContentResult,
  WorkspaceFileTreePayload,
  WorkspaceInfo,
  WorkspacesPayload
} from '@/shared/ipc'

/** 扩展 Vite 环境变量类型（渲染进程直连 API） */
declare global {
  interface ImportMetaEnv {
    readonly VITE_API_URL?: string
    readonly VITE_OPENWORKERER_API_BASE_URL?: string
  }
}

type Api = {
  platform: NodeJS.Platform
  windowAction: (action: WindowChromeAction) => Promise<void>
  /** true：允许系统最小化/最大化/关闭；false：禁用（弹窗打开时） */
  setCaptionControlsVisible: (visible: boolean) => void
  webEdit: (action: WebEditAction) => Promise<void>
  showAbout: () => Promise<AboutAppInfo>
  selectWorkspace: () => Promise<{ path: string }>
  getWorkspace: () => Promise<string>
  listWorkspaces: () => Promise<WorkspacesPayload>
  addWorkspace: (dir: string) => Promise<WorkspaceInfo | null>
  activateWorkspace: (workspaceId: string) => Promise<WorkspaceInfo | null>
  reorderWorkspaces: (orderIds: string[]) => Promise<WorkspacesPayload>
  renameWorkspace: (workspaceId: string, name: string) => Promise<WorkspaceInfo | null>
  removeWorkspace: (workspaceId: string) => Promise<{ ok: boolean }>
  getWorkspaceFileTree: () => Promise<WorkspaceFileTreePayload>
  readWorkspaceFile: (relPath: string) => Promise<WorkspaceFileContentResult>
  runTerminalCommand: (workspaceId: string, command: string) => Promise<TerminalRunResult>
  cancelTerminalCommand: (workspaceId: string) => Promise<{ ok: true }>
  onTerminalOutput: (cb: (e: TerminalOutputEvent) => void) => () => void
  completeTerminalCommand: (
    workspaceId: string,
    commandLine: string
  ) => Promise<TerminalCompleteResult>
  getSettings: () => Promise<AppSettings>
  setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  getUiState: () => Promise<RendererUiState>
  setUiState: (patch: Partial<RendererUiState>) => Promise<RendererUiState>
  listSessions: () => Promise<SessionInfo[]>
  listSessionsByWorkspace: (workspaceId: string) => Promise<SessionInfo[]>
  getSessionMessages: (sessionId: string) => Promise<ChatMessage[]>
  createSession: (name?: string) => Promise<SessionInfo | null>
  renameSession: (id: string, name: string) => Promise<SessionInfo | null>
  deleteSession: (id: string) => Promise<{ ok: true }>
  sendAgentMessage: (
    sessionId: string,
    text: string,
    opts?: AgentSendOptions
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  cancelAgent: (sessionId: string) => Promise<{ ok: true }>
  toggleDevtools: () => Promise<{ open: boolean }>
  openExternal: (url: string) => Promise<{ ok: boolean }>
  mcpProbeServer: (entry: McpServerEntry) => Promise<McpProbeResult>
  getMcpWarmupStatus: () => Promise<McpWarmupStatus>
  mcpRunWarmup: () => Promise<McpWarmupReport>
  onMcpWarmup: (cb: (r: McpWarmupReport) => void) => () => void
  onStream: (cb: (e: StreamEvent) => void) => () => void
  onSessionsSync: (cb: (s: SessionInfo[]) => void) => () => void
  onWorkspaceChange: (cb: (p: { path: string }) => void) => () => void
  onWorkspacesSync: (cb: (p: WorkspacesPayload) => void) => () => void
  onSettingsSync: (cb: (s: AppSettings) => void) => () => void
}

declare global {
  interface Window {
    bridge: Api
  }
}

export {}
