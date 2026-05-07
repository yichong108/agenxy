import { App as AntdApp } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, MouseEvent as ReactMouseEvent } from 'react'
import { flushSync } from 'react-dom'

import { useUiStore } from '@/renderer/src/store/ui-store'
import { useWorkspaceStore } from '@/renderer/src/store/workspace-store'
import {
  defaultWorkspaceUiState,
  HOME_WORKSPACE_ID,
  type SessionInfo,
  type WorkspaceInfo,
  type WorkspaceUiState
} from '@/shared/ipc'

function filterSessionsForSidebar(
  list: SessionInfo[] | undefined,
  hiddenIds: string[] | undefined
): SessionInfo[] {
  const hidden = new Set(hiddenIds ?? [])
  return (list ?? []).filter((s) => !hidden.has(s.id))
}

type WorkspaceDropMarker = {
  workspaceId: string
  placement: 'before' | 'after'
}

const legacyWorkspaceId = 'legacy-single-workspace'

export type UseWorkspaceLeftPaneOptions = {
  /** 从侧栏移除当前会话后，强制为主区域加载消息 */
  ensureSessionMessages?: (sessionId: string, force?: boolean) => void
}

export function useWorkspaceLeftPane({ ensureSessionMessages }: UseWorkspaceLeftPaneOptions) {
  const { message: msgApi, modal: modalApi } = AntdApp.useApp()
  const preloadOk = typeof window !== 'undefined' && typeof window.bridge !== 'undefined'
  const bridge = window.bridge
  const bridgeCompat = bridge as typeof bridge & {
    listWorkspaces?: () => Promise<{ list: WorkspaceInfo[]; activeWorkspaceId: string | null }>
    listSessionsByWorkspace?: (workspaceId: string) => Promise<SessionInfo[]>
    reorderWorkspaces?: (
      orderIds: string[]
    ) => Promise<{ list: WorkspaceInfo[]; activeWorkspaceId: string | null }>
    onWorkspacesSync?: (
      cb: (payload: { list: WorkspaceInfo[]; activeWorkspaceId: string | null }) => void
    ) => () => void
    activateWorkspace?: (workspaceId: string) => Promise<WorkspaceInfo | null>
  }
  const supportsMultiWorkspaceApi =
    typeof bridgeCompat.listWorkspaces === 'function' &&
    typeof bridgeCompat.onWorkspacesSync === 'function' &&
    typeof bridgeCompat.activateWorkspace === 'function'

  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces)
  const sessionsByWorkspace = useWorkspaceStore((s) => s.sessionsByWorkspace)
  const mergeSessionsPatch = useWorkspaceStore((s) => s.mergeSessionsPatch)
  const expandedWorkspaceIds = useWorkspaceStore((s) => s.expandedWorkspaceIds)
  const setExpandedWorkspaceIds = useWorkspaceStore((s) => s.setExpandedWorkspaceIds)
  const toggleExpandedWorkspaceId = useWorkspaceStore((s) => s.toggleExpandedWorkspaceId)
  const addExpandedWorkspaceId = useWorkspaceStore((s) => s.addExpandedWorkspaceId)

  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId)
  const setActiveWorkspaceId = useUiStore((s) => s.setActiveWorkspaceId)
  const activeSessionId = useUiStore((s) => s.activeSessionId)
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId)
  const setInputDraft = useUiStore((s) => s.setInputDraft)
  const byWorkspaceUi = useUiStore((s) => s.byWorkspace)

  const sessionsByWorkspaceForSidebar = useMemo(() => {
    const out: Record<string, SessionInfo[]> = {}
    for (const [wid, list] of Object.entries(sessionsByWorkspace)) {
      out[wid] = filterSessionsForSidebar(list, byWorkspaceUi[wid]?.sidebarHiddenSessionIds)
    }
    return out
  }, [sessionsByWorkspace, byWorkspaceUi])

  const workspacesForSidebar = useMemo(() => {
    const homeHasSessions = (sessionsByWorkspaceForSidebar[HOME_WORKSPACE_ID] ?? []).length > 0
    if (homeHasSessions) return workspaces
    return workspaces.filter((w) => w.id !== HOME_WORKSPACE_ID)
  }, [workspaces, sessionsByWorkspaceForSidebar])

  const workspaceTreeEmptyMessage = useMemo(() => {
    if (workspacesForSidebar.length > 0) return ''
    if (workspaces.length === 0) {
      return '暂无工作区。请点击下方「添加并切换工作区」选择项目文件夹。'
    }
    return '请添加项目文件夹作为工作区；用户目录（Home）仅在已有会话记录时显示在侧栏。'
  }, [workspaces.length, workspacesForSidebar.length])

  const workspacesWithComposerHomeStub = useMemo(() => {
    if (workspaces.some((w) => w.id === HOME_WORKSPACE_ID)) return workspaces
    const stub: WorkspaceInfo = {
      id: HOME_WORKSPACE_ID,
      name: 'Home',
      path: null,
      createdAt: 0,
      updatedAt: 0
    }
    return [stub, ...workspaces]
  }, [workspaces])

  const composerSelectedWorkspaceId = useMemo(
    () => activeWorkspaceId ?? HOME_WORKSPACE_ID,
    [activeWorkspaceId]
  )

  const SIDEBAR_MIN_WIDTH = 240
  const SIDEBAR_MAX_WIDTH = 560
  const SIDEBAR_DEFAULT_WIDTH = 300

  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)
  const [isSidebarResizing, setIsSidebarResizing] = useState(false)
  const sidebarResizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const sidebarExpandedWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH)

  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null)
  const [workspaceDropMarker, setWorkspaceDropMarker] = useState<WorkspaceDropMarker | null>(null)

  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')

  const [settingsOpen, setSettingsOpen] = useState(false)

  const [mcpOpen, setMcpOpen] = useState(false)

  const [skillsOpen, setSkillsOpen] = useState(false)

  useEffect(() => {
    if (!preloadOk) return
    const unSub = [
      supportsMultiWorkspaceApi
        ? bridgeCompat.onWorkspacesSync!((payload) => {
            flushSync(() => {
              setWorkspaces(payload.list)
              setExpandedWorkspaceIds(new Set(payload.list.map((workspace) => workspace.id)))
            })
            setActiveWorkspaceId(payload.activeWorkspaceId)
            const listByWorkspace = bridgeCompat.listSessionsByWorkspace
            if (!listByWorkspace) return
            void Promise.all(
              payload.list.map(async (workspace) => {
                const list = await listByWorkspace(workspace.id)
                return [workspace.id, list] as const
              })
            ).then((entries) => {
              mergeSessionsPatch(Object.fromEntries(entries))
            })
          })
        : bridge.onWorkspaceChange((p) => {
            const legacyWorkspace: WorkspaceInfo = {
              id: legacyWorkspaceId,
              name: p.path ? '当前工作区' : '默认工作区',
              path: p.path || null,
              createdAt: Date.now(),
              updatedAt: Date.now()
            }
            setWorkspaces([legacyWorkspace])
            setActiveWorkspaceId(legacyWorkspace.id)
            setExpandedWorkspaceIds(new Set([legacyWorkspace.id]))
          })
    ]
    return () => unSub.forEach((f) => f())
  }, [
    bridge,
    bridgeCompat,
    mergeSessionsPatch,
    preloadOk,
    setActiveWorkspaceId,
    setExpandedWorkspaceIds,
    setWorkspaces,
    supportsMultiWorkspaceApi
  ])

  useEffect(() => {
    addExpandedWorkspaceId(composerSelectedWorkspaceId)
  }, [addExpandedWorkspaceId, composerSelectedWorkspaceId])

  const pickWorkspace = useCallback(async () => {
    const r = await bridge.selectWorkspace()
    if (r.path) {
      msgApi.success('已选择工作区')
    }
  }, [bridge, msgApi])

  const openSettings = useCallback(() => {
    setSettingsOpen(true)
  }, [])

  const openMcpHub = useCallback(() => {
    setMcpOpen(true)
  }, [])

  const openSkillsHub = useCallback(() => {
    setSkillsOpen(true)
  }, [])

  const handleWorkspaceToggle = useCallback(
    (workspaceId: string) => {
      toggleExpandedWorkspaceId(workspaceId)
    },
    [toggleExpandedWorkspaceId]
  )

  const handleSidebarResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isSidebarCollapsed) return
      if (event.button !== 0) return
      event.preventDefault()
      sidebarResizeStartRef.current = {
        startX: event.clientX,
        startWidth: sidebarWidth
      }
      setIsSidebarResizing(true)
    },
    [isSidebarCollapsed, sidebarWidth]
  )

  const handleSidebarCollapseToggle = useCallback(() => {
    setIsSidebarCollapsed((prev) => {
      if (prev) {
        setSidebarWidth(sidebarExpandedWidthRef.current)
        return false
      }
      sidebarExpandedWidthRef.current = sidebarWidth
      setSidebarWidth(56)
      return true
    })
  }, [sidebarWidth])

  useEffect(() => {
    if (!isSidebarResizing) return
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMouseMove = (event: MouseEvent) => {
      const dragState = sidebarResizeStartRef.current
      if (!dragState) return
      const delta = event.clientX - dragState.startX
      const nextWidth = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, dragState.startWidth + delta)
      )
      setSidebarWidth(nextWidth)
      sidebarExpandedWidthRef.current = nextWidth
    }

    const handleMouseUp = () => {
      sidebarResizeStartRef.current = null
      setIsSidebarResizing(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('blur', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('blur', handleMouseUp)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, isSidebarResizing])

  const handleSessionClick = useCallback(
    async (workspaceId: string, sessionId: string) => {
      if (workspaceId !== activeWorkspaceId && supportsMultiWorkspaceApi) {
        const workspace = await bridgeCompat.activateWorkspace!(workspaceId)
        if (!workspace) {
          msgApi.error('切换工作区失败')
          return
        }
      }
      setActiveSessionId(sessionId)
    },
    [activeWorkspaceId, bridgeCompat, msgApi, setActiveSessionId, supportsMultiWorkspaceApi]
  )

  const openBlankConversationInWorkspace = useCallback(
    async (workspaceId: string) => {
      if (!workspaceId) return
      const ws = workspacesWithComposerHomeStub.find((w) => w.id === workspaceId)
      let resolvedId = workspaceId
      if (!ws?.path) {
        const hasHome = workspacesWithComposerHomeStub.some((w) => w.id === HOME_WORKSPACE_ID)
        if (!hasHome) {
          msgApi.warning('请先添加工作区')
          return
        }
        resolvedId = HOME_WORKSPACE_ID
      }
      if (resolvedId !== activeWorkspaceId && supportsMultiWorkspaceApi) {
        const workspace = await bridgeCompat.activateWorkspace!(resolvedId)
        if (!workspace) {
          msgApi.error('切换工作区失败')
          return
        }
      }
      addExpandedWorkspaceId(resolvedId)
      setActiveSessionId(null)
      setInputDraft('')
    },
    [
      activeWorkspaceId,
      addExpandedWorkspaceId,
      bridgeCompat,
      msgApi,
      setActiveSessionId,
      setInputDraft,
      supportsMultiWorkspaceApi,
      workspacesWithComposerHomeStub
    ]
  )

  const openBlankConversationForActiveWorkspace = useCallback(() => {
    void (async () => {
      const cid = composerSelectedWorkspaceId
      const ws = workspacesWithComposerHomeStub.find((w) => w.id === cid)
      const targetId =
        ws?.path && cid !== HOME_WORKSPACE_ID
          ? cid
          : workspacesWithComposerHomeStub.some((w) => w.id === HOME_WORKSPACE_ID)
            ? HOME_WORKSPACE_ID
            : null
      if (!targetId) {
        msgApi.warning('请先添加工作区')
        return
      }
      await openBlankConversationInWorkspace(targetId)
    })()
  }, [
    composerSelectedWorkspaceId,
    msgApi,
    openBlankConversationInWorkspace,
    workspacesWithComposerHomeStub
  ])

  const handleSessionRenameRequest = useCallback((session: SessionInfo) => {
    setRenameId(session.id)
    setRenameName(session.name)
  }, [])

  const handleSessionDeleteRequest = useCallback(
    (session: SessionInfo) => {
      modalApi.confirm({
        title: '删除此会话？',
        centered: true,
        onOk: () => {
          void bridge.deleteSession(session.id).then(() => msgApi.success('已删除'))
        }
      })
    },
    [bridge, modalApi, msgApi]
  )

  const handleRemoveWorkspaceFromSidebar = useCallback(
    (workspace: WorkspaceInfo) => {
      const isDefault = Boolean(workspace.isDefault)
      const isHome = workspace.id === HOME_WORKSPACE_ID
      modalApi.confirm({
        title: '从侧边栏移除此工作区？',
        content: isHome
          ? 'Home（用户目录）工作区下的全部会话将从本机永久删除，不会并入其他工作区。移除后不会再自动显示 Home；若需该路径仍可通过「添加并切换工作区」选择用户目录。'
          : isDefault
            ? '默认工作区下的全部会话将从本机永久删除，不会并入其他工作区。移除后侧栏可为空，可通过下方按钮重新添加工作区。'
            : '该工作区下的全部会话将从本机永久删除，不会并入其他工作区。之后可通过「添加并切换工作区」重新选择该文件夹。',
        centered: true,
        okText: '移除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          const { ok } = await bridge.removeWorkspace(workspace.id)
          if (ok) {
            msgApi.success('已从侧边栏移除')
          } else {
            msgApi.error('移除失败')
          }
        }
      })
    },
    [bridge, modalApi, msgApi]
  )

  const handleRemoveSessionFromSidebar = useCallback(
    (workspaceId: string, session: SessionInfo) => {
      const { byWorkspace, activeSessionId } = useUiStore.getState()
      const prev: WorkspaceUiState = byWorkspace[workspaceId] ?? { ...defaultWorkspaceUiState }
      const prevHidden = prev.sidebarHiddenSessionIds ?? []
      if (prevHidden.includes(session.id)) return
      const sidebarHiddenSessionIds = [...prevHidden, session.id]
      const nextWs: WorkspaceUiState = { ...prev, sidebarHiddenSessionIds }
      const nextByWorkspace = { ...byWorkspace, [workspaceId]: nextWs }
      useUiStore.setState({ byWorkspace: nextByWorkspace })
      void window.bridge.setUiState({ byWorkspace: { [workspaceId]: nextWs } })

      const list = sessionsByWorkspace[workspaceId] ?? []
      const hiddenSet = new Set(sidebarHiddenSessionIds)
      const visible = list.filter((s) => !hiddenSet.has(s.id))
      if (activeSessionId === session.id) {
        const nextId = visible[0]?.id ?? null
        setActiveSessionId(nextId)
        if (nextId) ensureSessionMessages?.(nextId, true)
      }
      msgApi.success('已从侧边栏移除')
    },
    [ensureSessionMessages, msgApi, sessionsByWorkspace, setActiveSessionId]
  )

  const handleWorkspaceDragStart = useCallback(
    (event: DragEvent<HTMLDivElement>, workspaceId: string) => {
      setDraggingWorkspaceId(workspaceId)
      setWorkspaceDropMarker(null)
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', workspaceId)
    },
    []
  )

  const handleWorkspaceDragEnd = useCallback(() => {
    setDraggingWorkspaceId(null)
    setWorkspaceDropMarker(null)
  }, [])

  const handleWorkspaceDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>, workspaceId: string) => {
      if (!draggingWorkspaceId || draggingWorkspaceId === workspaceId) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const rect = event.currentTarget.getBoundingClientRect()
      const midpoint = rect.top + rect.height / 2
      const placement: WorkspaceDropMarker['placement'] =
        event.clientY < midpoint ? 'before' : 'after'
      setWorkspaceDropMarker((prev) => {
        if (prev?.workspaceId === workspaceId && prev.placement === placement) return prev
        return { workspaceId, placement }
      })
    },
    [draggingWorkspaceId]
  )

  const handleWorkspaceDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>, targetWorkspaceId: string) => {
      event.preventDefault()
      const sourceWorkspaceId =
        draggingWorkspaceId || event.dataTransfer.getData('text/plain') || null

      const placement: WorkspaceDropMarker['placement'] =
        workspaceDropMarker?.workspaceId === targetWorkspaceId
          ? workspaceDropMarker.placement
          : 'before'

      setWorkspaceDropMarker(null)
      setDraggingWorkspaceId(null)

      if (!sourceWorkspaceId || sourceWorkspaceId === targetWorkspaceId) return
      const sourceIndex = workspaces.findIndex((x) => x.id === sourceWorkspaceId)
      const targetIndex = workspaces.findIndex((x) => x.id === targetWorkspaceId)
      if (sourceIndex < 0 || targetIndex < 0) return

      const next = [...workspaces]
      const [dragged] = next.splice(sourceIndex, 1)
      if (!dragged) return
      const normalizedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
      const insertIndex = placement === 'after' ? normalizedTargetIndex + 1 : normalizedTargetIndex
      next.splice(insertIndex, 0, dragged)
      const nextIds = next.map((x) => x.id)

      setWorkspaces(next)
      if (typeof bridgeCompat.reorderWorkspaces === 'function') {
        const payload = await bridgeCompat.reorderWorkspaces(nextIds)
        setWorkspaces(payload.list)
      }
    },
    [bridgeCompat, draggingWorkspaceId, setWorkspaces, workspaceDropMarker, workspaces]
  )

  const renameModal = {
    renameId,
    renameName,
    setRenameName,
    closeRename: () => setRenameId(null),
    confirmRename: () => {
      const v = renameName.trim()
      if (renameId && v) {
        void bridge.renameSession(renameId, v).then(() => {
          msgApi.success('已重命名')
          setRenameId(null)
        })
      }
    }
  }

  return {
    preloadOk,
    supportsMultiWorkspaceApi,
    sidebarWidth,
    isSidebarCollapsed,
    isSidebarResizing,
    activeWorkspaceId,
    activeSessionId,
    workspacesForSidebar,
    workspaceTreeEmptyMessage,
    sessionsByWorkspaceForSidebar,
    expandedWorkspaceIds,
    draggingWorkspaceId,
    workspaceDropMarker,
    pickWorkspace,
    handleSidebarResizeStart,
    handleSidebarCollapseToggle,
    openMcpHub,
    openSkillsHub,
    openSettings,
    openBlankConversationForActiveWorkspace,
    handleWorkspaceToggle,
    handleWorkspaceDragStart,
    handleWorkspaceDragOver,
    handleWorkspaceDrop,
    handleWorkspaceDragEnd,
    openBlankConversationInWorkspace,
    handleSessionClick,
    handleSessionRenameRequest,
    handleSessionDeleteRequest,
    handleRemoveSessionFromSidebar,
    handleRemoveWorkspaceFromSidebar: supportsMultiWorkspaceApi
      ? handleRemoveWorkspaceFromSidebar
      : undefined,
    mcpOpen,
    closeMcpHub: () => setMcpOpen(false),
    settingsOpen,
    closeSettings: () => setSettingsOpen(false),
    skillsOpen,
    closeSkillsHub: () => setSkillsOpen(false),
    renameModal
  }
}
