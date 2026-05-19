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
  UserMemoriesState,
  UserMemoriesSyncPayload,
  SkillsInstallResult,
  SkillsMarketCatalogItem,
  SkillsRuntimeState,
  SkillsUninstallPayload,
  SkillsUninstallResult,
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
  listMemories: () => Promise<UserMemoriesState>
  addMemory: (content: string) => Promise<UserMemoriesState>
  updateMemory: (id: string, content: string) => Promise<UserMemoriesState>
  deleteMemory: (id: string) => Promise<UserMemoriesState>
  clearMemories: () => Promise<UserMemoriesState>
  onMemorySync: (cb: (payload: UserMemoriesSyncPayload) => void) => () => void
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
  resumeAgentHitl: (
    sessionId: string,
    hitlId: string,
    decision: 'accept' | 'reject'
  ) => Promise<{ ok: true } | { ok: false; error: string }>
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
