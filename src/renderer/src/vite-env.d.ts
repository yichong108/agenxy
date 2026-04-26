/// <reference types="vite/client" />

import type {
  AppSettings,
  ChatMessage,
  RendererUiState,
  SessionInfo,
  StreamEvent
} from '@shared/ipc'

type Api = {
  selectWorkspace: () => Promise<{ path: string }>
  getWorkspace: () => Promise<string>
  getSettings: () => Promise<AppSettings>
  setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  getUiState: () => Promise<RendererUiState>
  setUiState: (patch: Partial<RendererUiState>) => Promise<RendererUiState>
  listSessions: () => Promise<SessionInfo[]>
  getSessionMessages: (sessionId: string) => Promise<ChatMessage[]>
  createSession: (name?: string) => Promise<SessionInfo>
  renameSession: (id: string, name: string) => Promise<SessionInfo | null>
  deleteSession: (id: string) => Promise<{ ok: true }>
  sendAgentMessage: (
    sessionId: string,
    text: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  cancelAgent: (sessionId: string) => Promise<{ ok: true }>
  toggleDevtools: () => Promise<{ open: boolean }>
  onStream: (cb: (e: StreamEvent) => void) => () => void
  onSessionsSync: (cb: (s: SessionInfo[]) => void) => () => void
  onWorkspaceChange: (cb: (p: { path: string }) => void) => () => void
  onSettingsSync: (cb: (s: AppSettings) => void) => () => void
}

declare global {
  interface Window {
    bridge: Api
  }
}

export {}
