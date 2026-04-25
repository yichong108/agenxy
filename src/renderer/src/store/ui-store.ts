import { create } from 'zustand'

type UiStoreState = {
  activeSessionId: string | null
  inputDraft: string
  hydrated: boolean
  hydrateFromMain: () => Promise<void>
  setActiveSessionId: (id: string | null) => void
  setInputDraft: (text: string) => void
}

let draftTimer: ReturnType<typeof setTimeout> | null = null

function persistPatch(patch: { activeSessionId?: string | null; inputDraft?: string }): void {
  if (typeof window === 'undefined' || typeof window.bridge === 'undefined') return
  void window.bridge.setUiState(patch)
}

export const useUiStore = create<UiStoreState>((set, get) => ({
  activeSessionId: null,
  inputDraft: '',
  hydrated: false,
  hydrateFromMain: async () => {
    if (typeof window === 'undefined' || typeof window.bridge === 'undefined') {
      set({ hydrated: true })
      return
    }
    const persisted = await window.bridge.getUiState()
    set({
      activeSessionId: persisted.activeSessionId,
      inputDraft: persisted.inputDraft,
      hydrated: true
    })
  },
  setActiveSessionId: (id) => {
    if (id === get().activeSessionId) return
    set({ activeSessionId: id })
    persistPatch({ activeSessionId: id })
  },
  setInputDraft: (text) => {
    set({ inputDraft: text })
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(() => {
      persistPatch({ inputDraft: text })
      draftTimer = null
    }, 150)
  }
}))
