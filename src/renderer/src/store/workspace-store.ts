import { create } from 'zustand'

import type { SessionInfo, WorkspaceInfo } from '@/shared/ipc'

type WorkspaceStoreState = {
  workspaces: WorkspaceInfo[]
  sessionsByWorkspace: Record<string, SessionInfo[]>
  expandedWorkspaceIds: Set<string>
  setWorkspaces: (list: WorkspaceInfo[]) => void
  setSessionsByWorkspace: (map: Record<string, SessionInfo[]>) => void
  updateSessionsForWorkspace: (workspaceId: string, list: SessionInfo[]) => void
  mergeSessionsPatch: (patch: Record<string, SessionInfo[]>) => void
  setExpandedWorkspaceIds: (next: Set<string>) => void
  toggleExpandedWorkspaceId: (workspaceId: string) => void
  addExpandedWorkspaceId: (workspaceId: string) => void
}

export const useWorkspaceStore = create<WorkspaceStoreState>((set) => ({
  workspaces: [],
  sessionsByWorkspace: {},
  expandedWorkspaceIds: new Set(),
  setWorkspaces: (list) => set({ workspaces: list }),
  setSessionsByWorkspace: (map) => set({ sessionsByWorkspace: map }),
  updateSessionsForWorkspace: (workspaceId, list) =>
    set((s) => ({
      sessionsByWorkspace: { ...s.sessionsByWorkspace, [workspaceId]: list }
    })),
  mergeSessionsPatch: (patch) =>
    set((s) => ({
      sessionsByWorkspace: { ...s.sessionsByWorkspace, ...patch }
    })),
  setExpandedWorkspaceIds: (next) => set({ expandedWorkspaceIds: next }),
  toggleExpandedWorkspaceId: (workspaceId) =>
    set((s) => {
      const next = new Set(s.expandedWorkspaceIds)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      return { expandedWorkspaceIds: next }
    }),
  addExpandedWorkspaceId: (workspaceId) =>
    set((s) => {
      const next = new Set(s.expandedWorkspaceIds)
      next.add(workspaceId)
      return { expandedWorkspaceIds: next }
    })
}))
