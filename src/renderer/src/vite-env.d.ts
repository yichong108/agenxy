/// <reference types="vite/client" />

import type {
  AgentSendOptions,
  AppSettings,
  ChatMessage,
  McpProbeResult,
  McpServerEntry,
  McpWarmupReport,
  McpWarmupStatus,
  RendererUiState,
  SessionInfo,
  SkillsInstallResult,
  SkillsMarketCatalogItem,
  SkillsRuntimeState,
  SkillsUninstallPayload,
  SkillsUninstallResult,
  StreamEvent,
  TerminalCompleteResult,
  TerminalRunResult,
  WebEditAction,
  WindowChromeAction,
  WorkspaceFileContentResult,
  WorkspaceFileTreePayload,
  WorkspaceInfo,
  WorkspacesPayload
} from '@/shared/ipc'

type Api = {
  platform: NodeJS.Platform
  windowAction: (action: WindowChromeAction) => Promise<void>
  webEdit: (action: WebEditAction) => Promise<void>
  showAbout: () => Promise<void>
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
  getSkillsState: () => Promise<SkillsRuntimeState>
  installSkillFromMarket: (item: SkillsMarketCatalogItem) => Promise<SkillsInstallResult>
  uninstallSkill: (payload: SkillsUninstallPayload) => Promise<SkillsUninstallResult>
}

declare global {
  interface Window {
    bridge: Api
  }
}

export {}
