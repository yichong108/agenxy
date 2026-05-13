import { create } from 'zustand'

import { defaultWorkspaceUiState, type WorkspaceUiState } from '@/shared/ipc'

type UiStoreState = {
  activeWorkspaceId: string | null
  activeSessionId: string | null
  inputDraft: string
  /** 递增以触发主区域对话输入框聚焦（如新会话） */
  composerFocusNonce: number
  byWorkspace: Record<string, WorkspaceUiState>
  hydrated: boolean
  hydrateFromMain: () => Promise<void>
  setActiveWorkspaceId: (workspaceId: string | null) => void
  setActiveSessionId: (id: string | null) => void
  setInputDraft: (text: string) => void
  requestComposerFocus: () => void
}

let draftTimer: ReturnType<typeof setTimeout> | null = null

function persistPatch(
  patch: Partial<{
    activeWorkspaceId: string | null
    byWorkspace: Record<string, WorkspaceUiState>
  }>
): void {
  if (typeof window === 'undefined' || typeof window.bridge === 'undefined') return
  void window.bridge.setUiState(patch)
}

function resolveWorkspaceUiState(
  workspaceId: string | null,
  byWorkspace: Record<string, WorkspaceUiState>
): WorkspaceUiState {
  if (!workspaceId) return { ...defaultWorkspaceUiState }
  return byWorkspace[workspaceId] || { ...defaultWorkspaceUiState }
}

export const useUiStore = create<UiStoreState>((set, get) => ({
  activeWorkspaceId: null,
  activeSessionId: null,
  inputDraft: '',
  composerFocusNonce: 0,
  byWorkspace: {},
  hydrated: false,
  hydrateFromMain: async () => {
    if (typeof window === 'undefined' || typeof window.bridge === 'undefined') {
      set({ hydrated: true })
      return
    }
    const persisted = await window.bridge.getUiState()
    const activeWorkspaceId = persisted.activeWorkspaceId ?? null
    const byWorkspace = persisted.byWorkspace || {}
    const workspaceUiState = resolveWorkspaceUiState(activeWorkspaceId, byWorkspace)
    set({
      activeWorkspaceId,
      activeSessionId: workspaceUiState.activeSessionId,
      inputDraft: workspaceUiState.inputDraft,
      byWorkspace,
      hydrated: true
    })
  },
  setActiveWorkspaceId: (workspaceId) => {
    if (workspaceId === get().activeWorkspaceId) return
    const currentByWorkspace = get().byWorkspace
    const nextWorkspaceState = resolveWorkspaceUiState(workspaceId, currentByWorkspace)
    set({
      activeWorkspaceId: workspaceId,
      activeSessionId: nextWorkspaceState.activeSessionId,
      inputDraft: nextWorkspaceState.inputDraft
    })
    persistPatch({ activeWorkspaceId: workspaceId })
  },
  setActiveSessionId: (id) => {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId || id === get().activeSessionId) return
    const currentByWorkspace = get().byWorkspace
    const prev = resolveWorkspaceUiState(workspaceId, currentByWorkspace)
    const byWorkspace = {
      ...currentByWorkspace,
      [workspaceId]: { ...prev, activeSessionId: id }
    }
    set({ activeSessionId: id, byWorkspace })
    persistPatch({ byWorkspace: { [workspaceId]: byWorkspace[workspaceId]! } })
  },
  setInputDraft: (text) => {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) {
      set({ inputDraft: text })
      return
    }
    const currentByWorkspace = get().byWorkspace
    const prev = resolveWorkspaceUiState(workspaceId, currentByWorkspace)
    const byWorkspace = {
      ...currentByWorkspace,
      [workspaceId]: { ...prev, inputDraft: text }
    }
    set({ inputDraft: text, byWorkspace })
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(() => {
      persistPatch({ byWorkspace: { [workspaceId]: byWorkspace[workspaceId]! } })
      draftTimer = null
    }, 150)
  },
  requestComposerFocus: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1 }))
}))
