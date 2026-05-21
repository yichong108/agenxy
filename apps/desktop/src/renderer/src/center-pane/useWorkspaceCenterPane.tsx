import {
  appendAssistantText,
  buildMessageTurns,
  filterSessionsForSidebar,
  PRELOAD_MISSING_ERROR,
  randomId,
  type RunStats
} from './center-pane-utils'
import {
  CheckOutlined,
  DownOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  SendOutlined,
  StopOutlined
} from '@ant-design/icons'
import { Alert, App as AntdApp, Button, Dropdown, Input, MenuProps, Space, Typography } from 'antd'
import type { InputRef } from 'antd/es/input'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type SimpleBarCore from 'simplebar-core'

import { useUiStore } from '@/renderer/src/store/ui-store'
import { useWorkspaceStore } from '@/renderer/src/store/workspace-store'
import {
  type AgentComposerMode,
  type AgentSendOptions,
  type ChatMessage,
  type HitlToolCallPayload,
  HOME_WORKSPACE_ID,
  type SessionInfo,
  type StreamEvent,
  type ToolTimelineEvent,
  type WorkspaceInfo
} from '@/shared/ipc'

const { Text } = Typography
const { TextArea } = Input

const legacyWorkspaceId = 'legacy-single-workspace'

export type UseWorkspaceCenterPaneOptions = {
  isWinCustomChrome: boolean
  isRightPaneCollapsed: boolean
  onRightPaneExpand: () => void
  onLeftTogglePortalHostChange: (el: HTMLDivElement | null) => void
}

export function useWorkspaceCenterPane({
  isWinCustomChrome,
  isRightPaneCollapsed,
  onRightPaneExpand,
  onLeftTogglePortalHostChange
}: UseWorkspaceCenterPaneOptions) {
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
  const setSessionsByWorkspace = useWorkspaceStore((s) => s.setSessionsByWorkspace)
  const updateSessionsForWorkspace = useWorkspaceStore((s) => s.updateSessionsForWorkspace)
  const setExpandedWorkspaceIds = useWorkspaceStore((s) => s.setExpandedWorkspaceIds)
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId)
  const setActiveWorkspaceId = useUiStore((s) => s.setActiveWorkspaceId)
  const activeId = useUiStore((s) => s.activeSessionId)
  const setActiveId = useUiStore((s) => s.setActiveSessionId)
  const input = useUiStore((s) => s.inputDraft)
  const setInput = useUiStore((s) => s.setInputDraft)
  const composerFocusNonce = useUiStore((s) => s.composerFocusNonce)
  const hydrateUiStore = useUiStore((s) => s.hydrateFromMain)

  const composerInputRef = useRef<InputRef>(null)

  useLayoutEffect(() => {
    if (!composerFocusNonce) return
    composerInputRef.current?.focus({ preventScroll: true })
  }, [composerFocusNonce])

  /** Composer 模式：Build / Ask / Plan（对齐 Cursor） */
  const [composerMode, setComposerMode] = useState<AgentComposerMode>('build')
  /** 由 Plan 模式生成的 assistant 消息 id，用于展示计划清单 */
  const [planAssistantIds, setPlanAssistantIds] = useState<Set<string>>(() => new Set())
  /** 点击「执行计划」后挂到会话上的计划正文（不写入输入框） */
  const [pendingPlanBySession, setPendingPlanBySession] = useState<Record<string, string>>({})
  const lastSendComposerModeRef = useRef<AgentComposerMode>('build')

  /** 顶栏工作区下拉始终含 Home；侧栏移除 Home 后主进程同步列表可能不含该项 */
  const workspacesWithComposerHomeStub = useMemo(() => {
    if (workspaces.some((w) => w.id === HOME_WORKSPACE_ID)) return workspaces
    const stub: WorkspaceInfo = {
      id: HOME_WORKSPACE_ID,
      name: '主目录',
      path: null,
      createdAt: 0,
      updatedAt: 0
    }
    return [stub, ...workspaces]
  }, [workspaces])

  /** 顶栏当前工作区：与主进程一致；仅 null 时视为 Home（避免列表尚未合并时误当作无效选中） */
  const composerSelectedWorkspaceId = useMemo(
    () => activeWorkspaceId ?? HOME_WORKSPACE_ID,
    [activeWorkspaceId]
  )

  /** 避免首屏 load 完成前把「无选中」误判为需要强制回到 Home */
  const didInitialWorkspaceLoadRef = useRef(false)
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({})
  const [timeline, setTimeline] = useState<Record<string, ToolTimelineEvent[]>>({})
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [queued, setQueued] = useState<Record<string, number | undefined>>({})
  const [runStats, setRunStats] = useState<Record<string, RunStats | undefined>>({})
  /** 工具时间线手风琴：key 为 assistant message id，未设置时由 isRun 推导默认展开/收起 */
  const [timelineOpenOverride, setTimelineOpenOverride] = useState<Record<string, boolean>>({})
  /** LangGraph interruptBefore tools：待用户批准的工具批次 */
  const [hitlPending, setHitlPending] = useState<
    Record<string, { hitlId: string; toolCalls: HitlToolCallPayload[] }>
  >({})
  const streamBuf = useRef<Record<string, string>>({})
  const intentBuf = useRef<Record<string, string>>({})
  const assistantMsgId = useRef<Record<string, string | null>>({})
  const hydratedMessageSessions = useRef<Set<string>>(new Set())
  const messagesSimpleBarRef = useRef<SimpleBarCore | null>(null)
  const messagesBottomRef = useRef<HTMLDivElement | null>(null)
  const autoScrollRef = useRef(true)
  /** 指针在消息区 `.simplebar-content-wrapper` 内时为 true，用于仅在该区域悬停时显示滚动条 */
  const [messagesScrollSurfaceHot, setMessagesScrollSurfaceHot] = useState(false)

  const isNearBottom = useCallback((el: HTMLDivElement) => {
    const threshold = 48
    return el.scrollTop + el.clientHeight >= el.scrollHeight - threshold
  }, [])

  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const bottomEl = messagesBottomRef.current
    if (bottomEl) {
      bottomEl.scrollIntoView({ block: 'end', behavior })
      return
    }
    const el = messagesSimpleBarRef.current?.getScrollElement()
    if (el) el.scrollTo({ top: el.scrollHeight, behavior })
  }, [])

  const handleMessagesShellMouseLeave = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const next = e.relatedTarget
    if (next instanceof Node && e.currentTarget.contains(next)) return
    setMessagesScrollSurfaceHot(false)
  }, [])

  const ensureSessionMessages = useCallback(
    async (sessionId: string, force = false) => {
      if (!sessionId) return
      if (!force && hydratedMessageSessions.current.has(sessionId)) return
      const list = await bridge.getSessionMessages(sessionId)
      setMessages((m) => ({ ...m, [sessionId]: list }))
      hydratedMessageSessions.current.add(sessionId)
    },
    [bridge]
  )

  const clearAssistantStreamDraft = useCallback((sessionId: string) => {
    streamBuf.current[sessionId] = ''
    const amId = assistantMsgId.current[sessionId]
    if (!amId) return
    setMessages((m) => {
      const cur = [...(m[sessionId] ?? [])]
      const idx = cur.findIndex((c) => c.id === amId)
      if (idx < 0) return m
      cur[idx] = { ...cur[idx]!, content: '' }
      return { ...m, [sessionId]: cur }
    })
  }, [])

  const load = useCallback(async () => {
    if (supportsMultiWorkspaceApi) {
      const workspacePayload = await bridgeCompat.listWorkspaces!()
      const workspaceList = workspacePayload.list
      flushSync(() => {
        setWorkspaces(workspaceList)
        setExpandedWorkspaceIds(new Set(workspaceList.map((workspace) => workspace.id)))
      })
      setActiveWorkspaceId(workspacePayload.activeWorkspaceId)

      const sessionsMap: Record<string, SessionInfo[]> = {}
      const listByWorkspace = bridgeCompat.listSessionsByWorkspace
      if (listByWorkspace) {
        const entries = await Promise.all(
          workspaceList.map(async (workspace) => {
            const list = await listByWorkspace(workspace.id)
            return [workspace.id, list] as const
          })
        )
        for (const [workspaceId, list] of entries) {
          sessionsMap[workspaceId] = list
        }
      } else {
        const activeId = workspacePayload.activeWorkspaceId
        sessionsMap[activeId ?? ''] = await bridge.listSessions()
      }
      setSessionsByWorkspace(sessionsMap)
      const activeWsId = workspacePayload.activeWorkspaceId ?? ''
      const hidden = useUiStore.getState().byWorkspace[activeWsId]?.sidebarHiddenSessionIds ?? []
      const activeListRaw = sessionsMap[activeWsId] ?? []
      const activeList = filterSessionsForSidebar(activeListRaw, hidden)
      const currentActiveId = useUiStore.getState().activeSessionId
      const nextActiveId =
        currentActiveId && activeList.some((x) => x.id === currentActiveId)
          ? currentActiveId
          : (activeList[0]?.id ?? null)
      setActiveId(nextActiveId)
      if (nextActiveId) {
        await ensureSessionMessages(nextActiveId, true)
      }
      didInitialWorkspaceLoadRef.current = true
      return
    }

    const [legacyPath, legacySessions] = await Promise.all([
      bridge.getWorkspace(),
      bridge.listSessions()
    ])
    const legacyWorkspace: WorkspaceInfo = {
      id: legacyWorkspaceId,
      name: legacyPath ? '当前工作区' : '默认工作区',
      path: legacyPath || null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    setWorkspaces([legacyWorkspace])
    setActiveWorkspaceId(legacyWorkspace.id)
    setExpandedWorkspaceIds(new Set([legacyWorkspace.id]))
    setSessionsByWorkspace({ [legacyWorkspace.id]: legacySessions })
    const legacyHidden =
      useUiStore.getState().byWorkspace[legacyWorkspace.id]?.sidebarHiddenSessionIds ?? []
    const legacyVisible = filterSessionsForSidebar(legacySessions, legacyHidden)
    const currentActiveId = useUiStore.getState().activeSessionId
    const nextActiveId =
      currentActiveId && legacyVisible.some((x) => x.id === currentActiveId)
        ? currentActiveId
        : (legacyVisible[0]?.id ?? null)
    setActiveId(nextActiveId)
    if (nextActiveId) {
      await ensureSessionMessages(nextActiveId, true)
    }
    didInitialWorkspaceLoadRef.current = true
  }, [
    bridge,
    bridgeCompat,
    ensureSessionMessages,
    setActiveId,
    setActiveWorkspaceId,
    setExpandedWorkspaceIds,
    setSessionsByWorkspace,
    setWorkspaces,
    supportsMultiWorkspaceApi
  ])

  const handleStream = useCallback(
    (e: StreamEvent) => {
      if (e.type === 'run-start') {
        const startedAt = e.timestampMs ?? Date.now()
        setRunning((r) => ({ ...r, [e.sessionId]: true }))
        setQueued((q) => ({ ...q, [e.sessionId]: undefined }))
        setRunStats((s) => ({
          ...s,
          [e.sessionId]: {
            runId: e.runId,
            traceId: e.traceId,
            startedAt,
            durationMs: 0,
            toolCalls: 0,
            toolErrors: 0,
            status: 'running'
          }
        }))
        streamBuf.current[e.sessionId] = ''
        intentBuf.current[e.sessionId] = ''
        const aid = randomId()
        assistantMsgId.current[e.sessionId] = aid
        if (lastSendComposerModeRef.current === 'plan') {
          setPlanAssistantIds((prev) => {
            const next = new Set(prev)
            next.add(aid)
            return next
          })
        }
        setMessages((m) => {
          const cur = m[e.sessionId] ?? []
          return {
            ...m,
            [e.sessionId]: [...cur, { id: aid, role: 'assistant' as const, content: '' }]
          }
        })
        setTimeline((t) => ({ ...t, [e.sessionId]: [] }))
        return
      }
      if (e.type === 'queued') {
        setQueued((q) => ({ ...q, [e.sessionId]: e.position }))
        return
      }
      if (e.type === 'intent-delta') {
        intentBuf.current[e.sessionId] = (intentBuf.current[e.sessionId] ?? '') + e.text
        const buf = intentBuf.current[e.sessionId]!
        const amId = assistantMsgId.current[e.sessionId]
        if (!amId) return
        setMessages((m) => {
          const cur = [...(m[e.sessionId] ?? [])]
          const idx = cur.findIndex((c) => c.id === amId)
          if (idx < 0) return m
          const next = { ...cur[idx]!, intentThinking: buf }
          cur[idx] = next
          return { ...m, [e.sessionId]: cur }
        })
        return
      }
      if (e.type === 'intent-end') {
        return
      }
      if (e.type === 'plan-step-start') {
        setTimeline((t) => {
          const list = [...(t[e.sessionId] ?? [])]
          list.push({
            kind: 'plan',
            id: e.stepId,
            afterToolId: e.afterToolId,
            toolName: e.toolName,
            status: 'streaming',
            text: '',
            runId: e.runId,
            traceId: e.traceId,
            timestampMs: Date.now()
          })
          return { ...t, [e.sessionId]: list }
        })
        return
      }
      if (e.type === 'plan-delta') {
        setTimeline((t) => {
          const list = [...(t[e.sessionId] ?? [])]
          const idx = list.findIndex((x) => x.kind === 'plan' && x.id === e.stepId)
          if (idx < 0) return t
          const row = list[idx]
          if (row?.kind !== 'plan') return t
          const next = [...list]
          next[idx] = { ...row, text: row.text + e.text }
          return { ...t, [e.sessionId]: next }
        })
        return
      }
      if (e.type === 'plan-step-end') {
        setTimeline((t) => {
          const list = [...(t[e.sessionId] ?? [])]
          const idx = list.findIndex((x) => x.kind === 'plan' && x.id === e.stepId)
          if (idx < 0) return t
          const row = list[idx]
          if (row?.kind !== 'plan') return t
          const next = [...list]
          next[idx] = { ...row, status: 'end' }
          return { ...t, [e.sessionId]: next }
        })
        return
      }
      if (e.type === 'stream-reset') {
        clearAssistantStreamDraft(e.sessionId)
        return
      }
      if (e.type === 'hitl-required') {
        clearAssistantStreamDraft(e.sessionId)
        setHitlPending((h) => ({
          ...h,
          [e.sessionId]: { hitlId: e.hitlId, toolCalls: e.toolCalls }
        }))
        return
      }
      if (e.type === 'text-delta') {
        streamBuf.current[e.sessionId] = (streamBuf.current[e.sessionId] ?? '') + e.text
        const buf = streamBuf.current[e.sessionId]!
        const amId = assistantMsgId.current[e.sessionId]
        if (!amId) return
        setMessages((m) => {
          const cur = [...(m[e.sessionId] ?? [])]
          const idx = cur.findIndex((c) => c.id === amId)
          if (idx < 0) return m
          const next = { ...cur[idx]!, content: buf }
          cur[idx] = next
          return { ...m, [e.sessionId]: cur }
        })
        return
      }
      if (e.type === 'tool') {
        const te = e.event
        setRunStats((s) => {
          const cur = s[e.sessionId]
          if (!cur) return s
          const isToolStart = te.kind === 'tool' && te.status === 'start'
          const isToolError = te.kind === 'error'
          return {
            ...s,
            [e.sessionId]: {
              ...cur,
              toolCalls: cur.toolCalls + (isToolStart ? 1 : 0),
              toolErrors: cur.toolErrors + (isToolError ? 1 : 0)
            }
          }
        })
        setTimeline((t) => {
          const list = [...(t[e.sessionId] ?? [])]
          if (te.kind === 'tool') {
            const same = list.find(
              (x): x is Extract<ToolTimelineEvent, { kind: 'tool' }> =>
                x.kind === 'tool' && x.id === te.id
            )
            if (same && te.status === 'end') {
              const next: Extract<ToolTimelineEvent, { kind: 'tool' }> = { ...te }
              return {
                ...t,
                [e.sessionId]: list.map((x) => (x.kind === 'tool' && x.id === te.id ? next : x))
              }
            }
          }
          list.push(te)
          return { ...t, [e.sessionId]: list }
        })
        return
      }
      if (e.type === 'error') {
        setHitlPending((h) => {
          const next = { ...h }
          delete next[e.sessionId]
          return next
        })
        msgApi.error(e.message)
        setMessages((m) => {
          const cur = m[e.sessionId] ?? []
          return {
            ...m,
            [e.sessionId]: appendAssistantText(cur, `执行失败：${e.message}`)
          }
        })
        setRunning((r) => ({ ...r, [e.sessionId]: false }))
        setRunStats((s) => {
          const cur = s[e.sessionId]
          if (!cur) return s
          const durationMs =
            e.durationMs ?? (cur.startedAt ? Math.max(0, Date.now() - cur.startedAt) : undefined)
          return {
            ...s,
            [e.sessionId]: { ...cur, durationMs, status: 'error' }
          }
        })
        return
      }
      if (e.type === 'done') {
        setHitlPending((h) => {
          const next = { ...h }
          delete next[e.sessionId]
          return next
        })
        setRunning((r) => ({ ...r, [e.sessionId]: false }))
        setQueued((q) => ({ ...q, [e.sessionId]: undefined }))
        setRunStats((s) => {
          const cur = s[e.sessionId]
          if (!cur) return s
          const durationMs =
            e.durationMs ?? (cur.startedAt ? Math.max(0, Date.now() - cur.startedAt) : undefined)
          return {
            ...s,
            [e.sessionId]: { ...cur, durationMs, status: 'done' }
          }
        })
        streamBuf.current[e.sessionId] = ''
        intentBuf.current[e.sessionId] = ''
        assistantMsgId.current[e.sessionId] = null
        void ensureSessionMessages(e.sessionId, true)
      }
    },
    [clearAssistantStreamDraft, ensureSessionMessages, msgApi]
  )

  useEffect(() => {
    if (!preloadOk) {
      msgApi.error(PRELOAD_MISSING_ERROR)
      return
    }
    void (async () => {
      await hydrateUiStore()
      await load()
    })()
    const unSub = [
      bridge.onSessionsSync((list) => {
        const workspaceId = useUiStore.getState().activeWorkspaceId
        const hidden = workspaceId
          ? (useUiStore.getState().byWorkspace[workspaceId]?.sidebarHiddenSessionIds ?? [])
          : []
        const visible = filterSessionsForSidebar(list, hidden)
        if (workspaceId) {
          updateSessionsForWorkspace(workspaceId, list)
        }
        const validIds = new Set(list.map((x) => x.id))
        for (const id of hydratedMessageSessions.current) {
          if (!validIds.has(id)) hydratedMessageSessions.current.delete(id)
        }
        const currentActiveId = useUiStore.getState().activeSessionId
        if (currentActiveId && visible.some((x) => x.id === currentActiveId)) return
        // 空白新对话（未落库的会话）下保持 null，避免把列表首条强行选为当前会话
        if (currentActiveId === null) return
        setActiveId(visible[0]?.id ?? null)
      }),
      bridge.onStream(handleStream)
    ]
    return () => unSub.forEach((f) => f())
  }, [
    bridge,
    handleStream,
    hydrateUiStore,
    load,
    msgApi,
    preloadOk,
    setActiveId,
    updateSessionsForWorkspace
  ])

  useEffect(() => {
    if (!preloadOk || !activeId) return
    void ensureSessionMessages(activeId)
  }, [activeId, ensureSessionMessages, preloadOk])

  const pickWorkspace = useCallback(async () => {
    const r = await bridge.selectWorkspace()
    if (r.path) {
      msgApi.success('已选择工作区')
    }
  }, [bridge, msgApi])

  const switchComposerWorkspace = useCallback(
    async (workspaceId: string) => {
      if (!workspaceId || workspaceId === composerSelectedWorkspaceId) return
      if (!supportsMultiWorkspaceApi && workspaceId !== HOME_WORKSPACE_ID) return
      const workspace = await bridge.activateWorkspace(workspaceId)
      if (!workspace) {
        msgApi.error('切换工作区失败')
      }
    },
    [bridge, composerSelectedWorkspaceId, msgApi, supportsMultiWorkspaceApi]
  )

  const handleComposerWorkspaceMenuClick = useCallback<NonNullable<MenuProps['onClick']>>(
    ({ key }) => {
      if (key === '__pick__') {
        void pickWorkspace()
        return
      }
      void switchComposerWorkspace(String(key))
    },
    [pickWorkspace, switchComposerWorkspace]
  )

  const handleComposerPlusMenuClick = useCallback<NonNullable<MenuProps['onClick']>>(({ key }) => {
    if (key === 'build' || key === 'ask' || key === 'plan') {
      setComposerMode(key)
    }
  }, [])

  const composerPlusMenuItems = useMemo<MenuProps['items']>(
    () =>
      (['build', 'ask', 'plan'] as const).map((mode) => ({
        key: mode,
        label: (
          <span className="app-composer-plus-menu-title">
            <span>{mode === 'build' ? '构建' : mode === 'ask' ? '问答' : '计划'}</span>
            {composerMode === mode ? (
              <CheckOutlined className="app-composer-plus-menu-check" aria-hidden />
            ) : null}
          </span>
        )
      })),
    [composerMode]
  )

  const composerWorkspaceMenuItems = useMemo<MenuProps['items']>(() => {
    const ordered = [...workspacesWithComposerHomeStub].sort((a, b) => {
      if (a.id === HOME_WORKSPACE_ID) return -1
      if (b.id === HOME_WORKSPACE_ID) return 1
      return 0
    })
    const rows: MenuProps['items'] = ordered.map((w) => ({
      key: w.id,
      label: w.id === HOME_WORKSPACE_ID ? '主目录' : w.name,
      disabled: w.id === composerSelectedWorkspaceId
    }))
    return [
      ...(rows ?? []),
      { type: 'divider' },
      {
        key: '__pick__',
        label: supportsMultiWorkspaceApi ? '添加工作区…' : '选择工作区目录…',
        icon: <FolderOpenOutlined />
      }
    ]
  }, [composerSelectedWorkspaceId, supportsMultiWorkspaceApi, workspacesWithComposerHomeStub])

  const sendAgentText = useCallback(
    async (text: string, mode: AgentComposerMode, sendOpts?: AgentSendOptions) => {
      const t = text.trim()
      const planContext = sendOpts?.planContext?.trim()
      if (!t && !planContext) return
      const displayContent =
        sendOpts?.userDisplayText?.trim() || t || (planContext ? '执行计划' : '')
      const activeWorkspace = workspacesWithComposerHomeStub.find(
        (x) => x.id === composerSelectedWorkspaceId
      )
      if (!activeWorkspace?.path) {
        msgApi.warning('请先为当前工作区绑定路径')
        return
      }
      let sessionId: string
      if (activeId) {
        sessionId = activeId
      } else {
        const created = await bridge.createSession()
        if (!created) {
          msgApi.warning('请先创建或选择工作区')
          return
        }
        sessionId = created.id
        setActiveId(sessionId)
      }
      hydratedMessageSessions.current.add(sessionId)
      lastSendComposerModeRef.current = mode
      setMessages((m) => {
        const cur = m[sessionId] ?? []
        return {
          ...m,
          [sessionId]: [...cur, { id: randomId(), role: 'user' as const, content: displayContent }]
        }
      })
      const r = await bridge.sendAgentMessage(sessionId, t, {
        mode,
        ...(planContext ? { planContext, userDisplayText: displayContent } : {})
      })
      if (!r.ok) {
        msgApi.error('发送失败: ' + r.error)
        setMessages((m) => {
          const cur = m[sessionId] ?? []
          return {
            ...m,
            [sessionId]: appendAssistantText(cur, `发送失败：${r.error}`, true)
          }
        })
      }
    },
    [
      activeId,
      appendAssistantText,
      bridge,
      composerSelectedWorkspaceId,
      msgApi,
      setActiveId,
      workspacesWithComposerHomeStub
    ]
  )

  const send = async () => {
    const t = input.trim()
    const planContext = activeId ? pendingPlanBySession[activeId]?.trim() : undefined
    if (!t && !planContext) return
    setInput('')
    if (activeId && planContext) {
      setPendingPlanBySession((prev) => {
        const next = { ...prev }
        delete next[activeId]
        return next
      })
    }
    const mode = planContext ? 'build' : composerMode
    await sendAgentText(t, mode, planContext ? { planContext } : undefined)
  }

  /** 关联计划到当前会话并切 Build；不写入输入框、不自动发送 */
  const preparePlanExecution = useCallback(
    (planContent: string) => {
      const body = planContent.trim()
      if (!body) return
      if (!activeId) {
        msgApi.warning('请先选择会话')
        return
      }
      setPendingPlanBySession((prev) => ({ ...prev, [activeId]: body }))
      setComposerMode('build')
      useUiStore.getState().requestComposerFocus()
      msgApi.info(
        '已切换到构建模式。可在输入框补充对计划的修改，发送后开始实施（留空发送则按计划执行）'
      )
    },
    [activeId, msgApi]
  )

  const clearPendingPlan = useCallback(() => {
    if (!activeId) return
    setPendingPlanBySession((prev) => {
      if (!prev[activeId]) return prev
      const next = { ...prev }
      delete next[activeId]
      return next
    })
  }, [activeId])

  const currentMessages = useMemo(
    () => (activeId ? (messages[activeId] ?? []) : []),
    [activeId, messages]
  )
  const messageTurns = useMemo(() => buildMessageTurns(currentMessages), [currentMessages])
  const currentTimeline = useMemo(
    () => (activeId ? (timeline[activeId] ?? []) : []),
    [activeId, timeline]
  )
  const latestAssistantMessageId = useMemo(() => {
    for (let i = currentMessages.length - 1; i >= 0; i -= 1) {
      const msg = currentMessages[i]
      if (msg?.role === 'assistant') return msg.id
    }
    return null
  }, [currentMessages])
  const isRun = activeId ? running[activeId] : false
  const isQueued = activeId ? queued[activeId] : undefined
  const currentRunStats = activeId ? runStats[activeId] : undefined
  const activeHitl = activeId ? hitlPending[activeId] : undefined

  const resumeHitl = useCallback(
    async (decision: 'accept' | 'reject') => {
      if (!activeId || !activeHitl) return
      if (decision === 'reject') {
        clearAssistantStreamDraft(activeId)
      }
      const r = await bridge.resumeAgentHitl(activeId, activeHitl.hitlId, decision)
      if (!r.ok) {
        msgApi.error(r.error)
        return
      }
      setHitlPending((h) => {
        const next = { ...h }
        delete next[activeId]
        return next
      })
    },
    [activeHitl, activeId, bridge, clearAssistantStreamDraft, msgApi]
  )
  const [liveTick, setLiveTick] = useState(0)
  useEffect(() => {
    if (!isRun) return
    const id = window.setInterval(() => setLiveTick((n) => n + 1), 500)
    return () => window.clearInterval(id)
  }, [isRun])

  const timelineWallMs = useMemo(() => {
    const st = activeId ? runStats[activeId] : undefined
    const started = st?.startedAt
    if (isRun && started != null) return Math.max(0, Date.now() - started + liveTick * 0)
    if (st?.durationMs != null && st.durationMs >= 0) return st.durationMs
    return 0
  }, [activeId, runStats, isRun, liveTick])

  const hasInput = input.trim().length > 0
  const hasPendingPlan = Boolean(activeId && pendingPlanBySession[activeId]?.trim())
  const canSend = hasInput || hasPendingPlan
  const showSendButton = !isRun || canSend
  const showStopButton = Boolean(activeId && isRun && !canSend)
  const activeWorkspace = useMemo(
    () => workspacesWithComposerHomeStub.find((w) => w.id === composerSelectedWorkspaceId),
    [composerSelectedWorkspaceId, workspacesWithComposerHomeStub]
  )

  useEffect(() => {
    if (!preloadOk || !supportsMultiWorkspaceApi || !didInitialWorkspaceLoadRef.current) return
    if (activeWorkspaceId != null) return
    void bridge.activateWorkspace(HOME_WORKSPACE_ID)
  }, [activeWorkspaceId, bridge, preloadOk, supportsMultiWorkspaceApi])
  const isEmptyConversation = currentMessages.length === 0

  useEffect(() => {
    if (isEmptyConversation) setMessagesScrollSurfaceHot(false)
  }, [isEmptyConversation])

  useEffect(() => {
    setMessagesScrollSurfaceHot(false)
  }, [activeId])

  const openExternalWithConfirm = useCallback(
    (href: string) => {
      const target = (() => {
        try {
          const parsed = new URL(href)
          return parsed.host || href
        } catch {
          return href
        }
      })()
      modalApi.confirm({
        title: '即将打开外部链接',
        content: `目标地址：${target}`,
        centered: true,
        okText: '继续打开',
        cancelText: '取消',
        onOk: async () => {
          const r = await bridge.openExternal(href)
          if (!r.ok) msgApi.warning('打开链接失败')
        }
      })
    },
    [bridge, modalApi, msgApi]
  )

  useEffect(() => {
    if (!preloadOk) return
    return bridge.onMemorySync((payload) => {
      const d = payload.lastExtractionDelta
      if (!d) return
      const total = d.added + d.updated + d.deleted
      if (total <= 0) return
      const parts: string[] = []
      if (d.added) parts.push(`新增 ${d.added}`)
      if (d.updated) parts.push(`更新 ${d.updated}`)
      if (d.deleted) parts.push(`删除 ${d.deleted}`)
      msgApi.info(`已更新用户记忆（${parts.join('，')}）`)
    })
  }, [bridge, msgApi, preloadOk])

  const onMarkdownClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null
      const anchor = target?.closest('a')
      if (!anchor) return
      const href = anchor.getAttribute('href') ?? ''
      if (!/^(https?:|mailto:)/i.test(href)) return
      event.preventDefault()
      openExternalWithConfirm(href)
    },
    [openExternalWithConfirm]
  )

  useEffect(() => {
    // 切换会话后默认回到底部，便于继续跟随最新回复。
    autoScrollRef.current = true
    const rafId = window.requestAnimationFrame(() => {
      scrollMessagesToBottom('auto')
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [activeId, scrollMessagesToBottom])

  useLayoutEffect(() => {
    if (!autoScrollRef.current) return
    const rafId = window.requestAnimationFrame(() => {
      scrollMessagesToBottom('auto')
      // 再补一次，避免流式内容换行导致高度在下一帧继续增长。
      window.requestAnimationFrame(() => {
        if (autoScrollRef.current) scrollMessagesToBottom('auto')
      })
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [currentMessages, currentTimeline, scrollMessagesToBottom])

  const composerWorkspaceToolbar = (
    <div className="app-composer-toolbar">
      <Dropdown
        menu={{ items: composerWorkspaceMenuItems, onClick: handleComposerWorkspaceMenuClick }}
        trigger={['click']}
      >
        <button type="button" className="app-composer-workspace-trigger" aria-haspopup="menu">
          <span className="app-composer-workspace-trigger-body">
            <span className="app-composer-workspace-name">
              {activeWorkspace?.name ?? '未选择工作区'}
            </span>
            <DownOutlined className="app-composer-workspace-trigger-chevron" aria-hidden />
          </span>
        </button>
      </Dropdown>
    </div>
  )

  const hitlApprovalBar =
    activeHitl && activeHitl.toolCalls.length > 0 ? (
      <Alert
        type="warning"
        showIcon
        className="app-hitl-bar"
        message="工具执行待批准"
        description={
          <ul className="app-hitl-tool-list">
            {activeHitl.toolCalls.map((t) => (
              <li key={t.id}>
                <Text code>{t.name}</Text>
                {t.args ? <Text type="secondary"> {t.args}</Text> : null}
              </li>
            ))}
          </ul>
        }
        action={
          <Space>
            <Button size="small" onClick={() => void resumeHitl('reject')}>
              拒绝
            </Button>
            <Button size="small" type="primary" onClick={() => void resumeHitl('accept')}>
              批准
            </Button>
          </Space>
        }
      />
    ) : null

  const planReadyBar =
    hasPendingPlan && activeId ? (
      <Alert
        type="info"
        showIcon
        className="app-plan-ready-bar"
        message="计划已就绪"
        description="可在下方输入对计划的修改说明；留空直接发送将按计划实施。"
        action={
          <Button size="small" onClick={clearPendingPlan}>
            取消
          </Button>
        }
      />
    ) : null

  const composerInput = (
    <div className="app-composer">
      <div className="app-composer-inner">
        <TextArea
          ref={composerInputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoSize={isEmptyConversation ? { minRows: 4, maxRows: 16 } : { minRows: 1, maxRows: 12 }}
          variant="borderless"
          placeholder={
            hasPendingPlan
              ? '补充对计划的修改说明（可选），Enter 发送'
              : 'Enter发送，Shift+Enter换行'
          }
          className="app-composer-input"
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <div className="app-composer-footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Dropdown
              menu={{ items: composerPlusMenuItems, onClick: handleComposerPlusMenuClick }}
              trigger={['hover']}
              placement="topLeft"
            >
              <Button
                type="default"
                className="app-composer-plus-btn"
                icon={<PlusOutlined />}
                aria-label="对话模式"
              />
            </Dropdown>
            {composerMode !== 'build' ? (
              <span
                className={`app-composer-mode-hint${composerMode === 'plan' ? ' is-plan' : ''}`}
              >
                {composerMode === 'ask' ? '问答' : '计划'}
              </span>
            ) : null}
          </div>
          <div className="app-composer-actions">
            {showSendButton && (
              <Button
                type="primary"
                icon={<SendOutlined />}
                onClick={() => void send()}
                disabled={!activeWorkspace?.path || !canSend}
                className="app-send-btn"
              >
                发送
              </Button>
            )}
            {showStopButton && (
              <Button
                danger
                icon={<StopOutlined />}
                onClick={() => void bridge.cancelAgent(activeId!)}
                className="app-stop-btn"
              >
                停止
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )

  return {
    preloadOk,
    bridge,
    isWinCustomChrome,
    isRightPaneCollapsed,
    onRightPaneExpand,
    onLeftTogglePortalHostChange,
    composerSelectedWorkspaceId,
    workspacesWithComposerHomeStub,
    sessionsByWorkspace,
    activeId,
    isQueued,
    currentRunStats,
    composerWorkspaceToolbar,
    hitlApprovalBar,
    planReadyBar,
    composerInput,
    isEmptyConversation,
    messageTurns,
    latestAssistantMessageId,
    isRun,
    currentTimeline,
    timelineOpenOverride,
    setTimelineOpenOverride,
    planAssistantIds,
    timelineWallMs,
    messagesScrollSurfaceHot,
    setMessagesScrollSurfaceHot,
    handleMessagesShellMouseLeave,
    messagesSimpleBarRef,
    messagesBottomRef,
    isNearBottom,
    autoScrollRef,
    preparePlanExecution,
    onMarkdownClick
  }
}
