import {
  BugOutlined,
  CheckOutlined,
  DownOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  RightOutlined,
  SendOutlined,
  StopOutlined
} from '@ant-design/icons'
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Dropdown,
  FloatButton,
  Input,
  Menu,
  Space,
  Tag,
  Typography,
  MenuProps
} from 'antd'
import { findAndReplace } from 'mdast-util-find-and-replace'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import 'highlight.js/styles/github.css'

import { WorkspaceLeftPane } from '@/renderer/src/left-pane'
import { WorkspaceRightPane } from '@/renderer/src/right-pane/WorkspaceRightPane'
import { useUiStore } from '@/renderer/src/store/ui-store'
import { useWorkspaceStore } from '@/renderer/src/store/workspace-store'
import {
  type ChatMessage,
  type SessionInfo,
  type StreamEvent,
  type ToolTimelineEvent,
  HOME_WORKSPACE_ID,
  type WorkspaceInfo
} from '@/shared/ipc'

function filterSessionsForSidebar(
  list: SessionInfo[] | undefined,
  hiddenIds: string[] | undefined
): SessionInfo[] {
  const hidden = new Set(hiddenIds ?? [])
  return (list ?? []).filter((s) => !hidden.has(s.id))
}

/** Cursor 风格时间线标题用：Worked for 1m 2.3s */
function formatWorkedDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const sec = ms / 1000
  if (sec < 60) {
    const t = sec.toFixed(1)
    return t.endsWith('.0') ? `${Math.round(sec)}s` : `${t}s`
  }
  const s = Math.floor(sec)
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return `${m}m ${rs}s`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h}h ${rm}m`
}

import '@/renderer/src/App.scss'
import { renderLog } from './logger'

const { Text } = Typography
const { TextArea } = Input

const PRELOAD_MISSING_ERROR = '未检测到 preload 注入（window.bridge 不存在）'

function randomId() {
  return `m-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function appendAssistantText(list: ChatMessage[], text: string, forceNew = false): ChatMessage[] {
  const next = [...list]
  const last = next[next.length - 1]
  if (!forceNew && last?.role === 'assistant') {
    next[next.length - 1] = { ...last, content: text }
    return next
  }
  next.push({ id: randomId(), role: 'assistant', content: text })
  return next
}

function remarkLinkifyBareUrls() {
  return (tree: Parameters<typeof findAndReplace>[0]) => {
    findAndReplace(
      tree,
      [
        [
          /https?:\/\/[^\s<>()]+/g,
          (rawUrl: string) => {
            const match = rawUrl.match(/^(.*?)([),.;!?，。！？、；：]+)?$/)
            const pureUrl = match?.[1] ?? rawUrl
            const trailing = match?.[2] ?? ''
            const linkNode = {
              type: 'link' as const,
              url: pureUrl,
              title: null,
              children: [{ type: 'text' as const, value: pureUrl }]
            }
            if (!trailing) return linkNode
            return [linkNode, { type: 'text' as const, value: trailing }]
          }
        ]
      ],
      {
        ignore: ['link', 'linkReference', 'code', 'inlineCode']
      }
    )
  }
}

type RunStats = {
  runId?: string
  traceId?: string
  startedAt?: number
  durationMs?: number
  toolCalls: number
  toolErrors: number
  status: 'running' | 'done' | 'error'
}

export function App() {
  const RIGHT_PANE_MIN_WIDTH = 420
  const RIGHT_PANE_MAX_WIDTH = 860
  const RIGHT_PANE_DEFAULT_WIDTH = 560
  const RIGHT_PANE_COLLAPSED_WIDTH = 56
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
  const legacyWorkspaceId = 'legacy-single-workspace'
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
  const hydrateUiStore = useUiStore((s) => s.hydrateFromMain)

  /** 未开启时为 Cursor 风格的 Build（可写可执行）；开启后为 Ask 只读问答 */
  const [composerAskOn, setComposerAskOn] = useState(false)

  /** 顶栏工作区下拉始终含 Home；侧栏移除 Home 后主进程同步列表可能不含该项 */
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

  /** 顶栏当前工作区：与主进程一致；仅 null 时视为 Home（避免列表尚未合并时误当作无效选中） */
  const composerSelectedWorkspaceId = useMemo(
    () => activeWorkspaceId ?? HOME_WORKSPACE_ID,
    [activeWorkspaceId]
  )

  /** 避免首屏 load 完成前把「无选中」误判为需要强制回到 Home */
  const didInitialWorkspaceLoadRef = useRef(false)
  const isDevEnv = import.meta.env.DEV

  const isWinCustomChrome = preloadOk && bridge.platform === 'win32'

  const winMenubarItems: MenuProps['items'] = useMemo(() => {
    if (!isWinCustomChrome) return []
    const viewChildren: MenuProps['items'] = [
      {
        key: 'reload',
        label: '重新加载',
        onClick: () => {
          void bridge.windowAction('reload')
        }
      }
    ]
    if (isDevEnv) {
      viewChildren.push({
        key: 'devtools',
        label: '切换开发者工具',
        onClick: () => {
          void bridge
            .toggleDevtools()
            .then(() => {
              window.location.reload()
            })
            .catch(() => {})
        }
      })
    }
    return [
      {
        key: 'file',
        label: '文件',
        children: [
          {
            key: 'quit',
            label: '退出',
            onClick: () => {
              void bridge.windowAction('quit')
            }
          }
        ]
      },
      {
        key: 'edit',
        label: '编辑',
        children: [
          { key: 'undo', label: '撤销', onClick: () => void bridge.webEdit('undo') },
          { key: 'redo', label: '重做', onClick: () => void bridge.webEdit('redo') },
          { type: 'divider' },
          { key: 'cut', label: '剪切', onClick: () => void bridge.webEdit('cut') },
          { key: 'copy', label: '复制', onClick: () => void bridge.webEdit('copy') },
          { key: 'paste', label: '粘贴', onClick: () => void bridge.webEdit('paste') },
          { key: 'selectAll', label: '全选', onClick: () => void bridge.webEdit('selectAll') }
        ]
      },
      {
        key: 'view',
        label: '视图',
        children: viewChildren
      },
      {
        key: 'window',
        label: '窗口',
        children: [
          { key: 'min', label: '最小化', onClick: () => void bridge.windowAction('minimize') },
          {
            key: 'max',
            label: '最大化 / 还原',
            onClick: () => void bridge.windowAction('maximize-toggle')
          },
          { key: 'close', label: '关闭窗口', onClick: () => void bridge.windowAction('close') }
        ]
      },
      {
        key: 'help',
        label: '帮助',
        children: [
          {
            key: 'about',
            label: '关于 trou',
            onClick: () => void bridge.showAbout()
          }
        ]
      }
    ]
  }, [bridge, isDevEnv, isWinCustomChrome])

  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({})
  const [timeline, setTimeline] = useState<Record<string, ToolTimelineEvent[]>>({})
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [queued, setQueued] = useState<Record<string, number | undefined>>({})
  const [runStats, setRunStats] = useState<Record<string, RunStats | undefined>>({})
  /** 工具时间线手风琴：key 为 assistant message id，未设置时由 isRun 推导默认展开/收起 */
  const [timelineOpenOverride, setTimelineOpenOverride] = useState<Record<string, boolean>>({})
  /** 模型意图思考：key 为 assistant message id，未设置时默认收起 */
  const [intentThinkingOpenOverride, setIntentThinkingOpenOverride] = useState<
    Record<string, boolean>
  >({})
  const [rightPaneWidth, setRightPaneWidth] = useState(RIGHT_PANE_DEFAULT_WIDTH)
  const [isRightPaneCollapsed, setIsRightPaneCollapsed] = useState(false)
  const [isRightPaneResizing, setIsRightPaneResizing] = useState(false)
  const rightPaneResizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const rightPaneExpandedWidthRef = useRef(RIGHT_PANE_DEFAULT_WIDTH)

  const streamBuf = useRef<Record<string, string>>({})
  const intentBuf = useRef<Record<string, string>>({})
  const assistantMsgId = useRef<Record<string, string | null>>({})
  const hydratedMessageSessions = useRef<Set<string>>(new Set())
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const messagesBottomRef = useRef<HTMLDivElement | null>(null)
  const autoScrollRef = useRef(true)

  const isNearBottom = useCallback((el: HTMLDivElement) => {
    const threshold = 48
    return el.scrollTop + el.clientHeight >= el.scrollHeight - threshold
  }, [])

  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = messagesScrollRef.current
    const bottomEl = messagesBottomRef.current
    if (bottomEl) {
      bottomEl.scrollIntoView({ block: 'end', behavior })
      return
    }
    if (el) el.scrollTo({ top: el.scrollHeight, behavior })
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
      }
    },
    [msgApi]
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
    if (key === 'ask') setComposerAskOn((v) => !v)
  }, [])

  const composerPlusMenuItems = useMemo<MenuProps['items']>(
    () => [
      {
        key: 'ask',
        label: (
          <div className="app-composer-plus-menu-label">
            <span className="app-composer-plus-menu-title">
              {composerAskOn ? (
                <CheckOutlined style={{ marginRight: 8 }} />
              ) : (
                <span style={{ display: 'inline-block', width: 22 }} aria-hidden />
              )}
              Ask
            </span>
            <span className="app-composer-plus-menu-desc">
              只读问答与讲解；改代码、跑终端请用默认 Build（不勾选此项）
            </span>
          </div>
        )
      }
    ],
    [composerAskOn]
  )

  const composerWorkspaceMenuItems = useMemo<MenuProps['items']>(() => {
    const ordered = [...workspacesWithComposerHomeStub].sort((a, b) => {
      if (a.id === HOME_WORKSPACE_ID) return -1
      if (b.id === HOME_WORKSPACE_ID) return 1
      return 0
    })
    const rows: MenuProps['items'] = ordered.map((w) => ({
      key: w.id,
      label: w.id === HOME_WORKSPACE_ID ? 'Home' : w.name,
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

  // 发送当前输入消息，并立即在本地追加用户消息（尚无会话时先创建再发送）
  const send = async () => {
    const t = input.trim()
    if (!t) return
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
    // activeId 变更会触发 ensureSessionMessages；新会话此时主进程可能尚未持久化消息，
    // 若拉取到空列表会覆盖本地用户消息与 run-start 的 assistant 占位，导致流式增量全部丢弃。
    hydratedMessageSessions.current.add(sessionId)
    setInput('')
    setMessages((m) => {
      const cur = m[sessionId] ?? []
      return {
        ...m,
        [sessionId]: [...cur, { id: randomId(), role: 'user' as const, content: t }]
      }
    })
    const r = await bridge.sendAgentMessage(sessionId, t, {
      mode: composerAskOn ? 'ask' : 'build'
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
  }

  // 检查 React DevTools 是否已加载完成
  const checkDevToolsReady = (): boolean => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__
    const ready = !!(hook && (hook.renderers?.size > 0 || hook._renderers))
    renderLog.info('checkDevToolsReady', ready)
    return ready
  }

  const toggleDevtools = async () => {
    bridge
      .toggleDevtools()
      .then(() => {
        if (checkDevToolsReady()) {
          console.log('✅ React DevTools 已就绪')
        } else {
          console.log('[devtool]⏳ 正在等待 React DevTools 加载完成...')
        }
        setTimeout(() => {
          window.location.reload()
        }, 1000)
      })
      .catch((err: Error) => {
        console.error('打开 DevTools 失败:', err)
      })
  }

  const currentMessages = useMemo(
    () => (activeId ? (messages[activeId] ?? []) : []),
    [activeId, messages]
  )
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
  const showSendButton = !isRun || hasInput
  const showStopButton = Boolean(activeId && isRun && !hasInput)
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

  const handleRightPaneResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (isRightPaneCollapsed) return
      if (event.button !== 0) return
      event.preventDefault()
      rightPaneResizeStartRef.current = {
        startX: event.clientX,
        startWidth: rightPaneWidth
      }
      setIsRightPaneResizing(true)
    },
    [isRightPaneCollapsed, rightPaneWidth]
  )

  const handleRightPaneCollapseToggle = useCallback(() => {
    setIsRightPaneCollapsed((prev) => {
      if (prev) {
        setRightPaneWidth(rightPaneExpandedWidthRef.current)
        return false
      }
      rightPaneExpandedWidthRef.current = rightPaneWidth
      return true
    })
  }, [rightPaneWidth])

  useEffect(() => {
    if (!isRightPaneResizing) return
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMouseMove = (event: MouseEvent) => {
      const dragState = rightPaneResizeStartRef.current
      if (!dragState) return
      const delta = event.clientX - dragState.startX
      const nextWidth = Math.min(
        RIGHT_PANE_MAX_WIDTH,
        Math.max(RIGHT_PANE_MIN_WIDTH, dragState.startWidth - delta)
      )
      setRightPaneWidth(nextWidth)
      rightPaneExpandedWidthRef.current = nextWidth
    }

    const handleMouseUp = () => {
      rightPaneResizeStartRef.current = null
      setIsRightPaneResizing(false)
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
  }, [isRightPaneResizing, RIGHT_PANE_MAX_WIDTH, RIGHT_PANE_MIN_WIDTH])

  const composerWorkspaceToolbar = (
    <div className="app-composer-toolbar">
      <Dropdown
        menu={{ items: composerWorkspaceMenuItems, onClick: handleComposerWorkspaceMenuClick }}
        trigger={['click']}
      >
        <Button type="default" className="app-composer-workspace-trigger">
          <span className="app-composer-workspace-name">
            {activeWorkspace?.name ?? '未选择工作区'}
          </span>
          <DownOutlined />
        </Button>
      </Dropdown>
    </div>
  )

  const composerInput = (
    <div className="app-composer">
      <div className="app-composer-inner">
        <TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoSize={{ minRows: 1, maxRows: 6 }}
          variant="borderless"
          placeholder="Plan / Build，/ 命令，@ 上下文（Enter 发送，Shift+Enter 换行）"
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
              trigger={['click']}
              placement="topLeft"
            >
              <Button
                type="default"
                className="app-composer-plus-btn"
                icon={<PlusOutlined />}
                aria-label="对话模式"
              />
            </Dropdown>
            {composerAskOn ? <span className="app-composer-mode-hint">Ask</span> : null}
          </div>
          <div className="app-composer-actions">
            {showSendButton && (
              <Button
                type="primary"
                icon={<SendOutlined />}
                onClick={() => void send()}
                disabled={!activeWorkspace?.path || !input.trim()}
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

  return (
    <div className="app-shell">
      {isWinCustomChrome ? (
        <div className="app-win-titlebar">
          <Menu
            mode="horizontal"
            selectable={false}
            triggerSubMenuAction="click"
            items={winMenubarItems}
            className="app-win-menubar"
          />
        </div>
      ) : null}
      <div className={`app-body ${isRightPaneResizing ? 'is-right-resizing' : ''}`}>
        <WorkspaceLeftPane ensureSessionMessages={ensureSessionMessages} />
        <div className="app-main-pane">
          <div className="app-topbar">
            {activeId && (
              <Space>
                <Text type="secondary">会话</Text>
                <Text>
                  {
                    (sessionsByWorkspace[composerSelectedWorkspaceId] ?? []).find(
                      (s) => s.id === activeId
                    )?.name
                  }
                </Text>
                {isRun && <Tag color="processing">执行中</Tag>}
                {isQueued && isQueued > 0 && <Tag color="warning">排队 #{isQueued}</Tag>}
                {currentRunStats && (
                  <Text type="secondary">
                    本轮: {currentRunStats.toolCalls} 次调用 / {currentRunStats.toolErrors} 次错误 /{' '}
                    {((currentRunStats.durationMs ?? 0) / 1000).toFixed(2)}s
                  </Text>
                )}
                {currentRunStats?.traceId && (
                  <Tag color="default">trace: {currentRunStats.traceId.slice(-12)}</Tag>
                )}
              </Space>
            )}
          </div>
          <div className={`app-content ${isEmptyConversation ? 'is-empty-conversation' : ''}`}>
            {!preloadOk && (
              <div className="app-preload-alert-wrap">
                <Alert
                  type="error"
                  showIcon
                  message="preload 注入失败"
                  description="当前窗口未接收到主进程暴露的 API（window.bridge）。请重启 dev 进程后重试。"
                />
              </div>
            )}
            {isEmptyConversation ? (
              <div className="app-composer-hero">
                <div className="app-composer-hero-inner">
                  {composerWorkspaceToolbar}
                  {composerInput}
                </div>
              </div>
            ) : (
              <>
                <div className="app-messages-shell">
                  <div
                    className="app-messages-scroll"
                    ref={messagesScrollRef}
                    onScroll={(e) => {
                      autoScrollRef.current = isNearBottom(e.currentTarget)
                    }}
                  >
                    {currentMessages.map((m) => {
                      const isLatestAssistant =
                        m.role === 'assistant' && m.id === latestAssistantMessageId
                      const showTimelineAccordion = isLatestAssistant && currentTimeline.length > 0
                      const intentText = m.intentThinking?.trim()
                      const intentThinkingExpanded =
                        intentThinkingOpenOverride[m.id] !== undefined
                          ? intentThinkingOpenOverride[m.id]!
                          : false
                      const timelineExpanded =
                        timelineOpenOverride[m.id] !== undefined
                          ? timelineOpenOverride[m.id]!
                          : Boolean(isRun && showTimelineAccordion)
                      return (
                        <Card
                          key={m.id}
                          size="small"
                          className={`app-message-card ${m.role === 'user' ? 'is-user' : 'is-assistant'}`}
                        >
                          <div className="app-message-content">
                            {m.role === 'assistant' ? (
                              <>
                                {intentText ? (
                                  <div className="app-intent-accordion">
                                    <button
                                      type="button"
                                      className="app-intent-accordion-head"
                                      aria-expanded={intentThinkingExpanded}
                                      onClick={() =>
                                        setIntentThinkingOpenOverride((prev) => ({
                                          ...prev,
                                          [m.id]: !intentThinkingExpanded
                                        }))
                                      }
                                    >
                                      <RightOutlined
                                        className={`app-timeline-chevron${intentThinkingExpanded ? ' is-open' : ''}`}
                                      />
                                      <span className="app-timeline-accordion-title">思考</span>
                                    </button>
                                    {intentThinkingExpanded ? (
                                      <div className="app-intent-accordion-body">
                                        <div className="app-intent-preamble">{intentText}</div>
                                      </div>
                                    ) : null}
                                  </div>
                                ) : null}
                                {showTimelineAccordion ? (
                                  <div className="app-timeline-accordion">
                                    <button
                                      type="button"
                                      className="app-timeline-accordion-head"
                                      aria-expanded={timelineExpanded}
                                      onClick={() =>
                                        setTimelineOpenOverride((prev) => ({
                                          ...prev,
                                          [m.id]: !timelineExpanded
                                        }))
                                      }
                                    >
                                      <RightOutlined
                                        className={`app-timeline-chevron${timelineExpanded ? ' is-open' : ''}`}
                                      />
                                      <span className="app-timeline-accordion-title">
                                        Worked for {formatWorkedDuration(timelineWallMs)}
                                      </span>
                                    </button>
                                    {timelineExpanded ? (
                                      <div className="app-timeline-wrap">
                                        {currentTimeline.map((e, idx) => (
                                          <div
                                            key={`${e.kind}-${'id' in e ? e.id : idx}-${idx}`}
                                            className="app-timeline-item"
                                          >
                                            {e.kind === 'error' ? (
                                              <Text type="danger">{e.message}</Text>
                                            ) : (
                                              <>
                                                <Text code>
                                                  {e.name} {e.status === 'start' ? '…' : '✓'}
                                                </Text>
                                                {e.args && <Text type="secondary"> {e.args}</Text>}
                                                {e.status === 'end' && e.result && (
                                                  <pre className="app-timeline-result">
                                                    {e.result}
                                                  </pre>
                                                )}
                                              </>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    ) : null}
                                  </div>
                                ) : null}
                                <div className="app-message-markdown" onClick={onMarkdownClick}>
                                  <ReactMarkdown
                                    remarkPlugins={[remarkGfm, remarkLinkifyBareUrls]}
                                    rehypePlugins={[rehypeHighlight]}
                                  >
                                    {m.content || (isRun && isLatestAssistant ? '…' : '')}
                                  </ReactMarkdown>
                                </div>
                              </>
                            ) : (
                              m.content
                            )}
                          </div>
                        </Card>
                      )
                    })}
                    <div ref={messagesBottomRef} />
                  </div>
                </div>
                <div className="app-composer-stack">
                  {composerWorkspaceToolbar}
                  {composerInput}
                </div>
              </>
            )}
          </div>
        </div>
        {!isRightPaneCollapsed ? (
          <div
            className={`app-right-resizer ${isRightPaneResizing ? 'is-dragging' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整右侧栏宽度"
            onMouseDown={handleRightPaneResizeStart}
          />
        ) : null}
        <WorkspaceRightPane
          bridge={bridge}
          activeWorkspaceId={composerSelectedWorkspaceId}
          activeWorkspacePath={
            workspacesWithComposerHomeStub.find((x) => x.id === composerSelectedWorkspaceId)
              ?.path ?? null
          }
          width={isRightPaneCollapsed ? RIGHT_PANE_COLLAPSED_WIDTH : rightPaneWidth}
          isCollapsed={isRightPaneCollapsed}
          onToggleCollapse={handleRightPaneCollapseToggle}
        />
      </div>

      {isDevEnv && (
        <FloatButton
          icon={<BugOutlined />}
          tooltip="切换 DevTools"
          onClick={() => void toggleDevtools()}
          className="app-devtools-float"
        />
      )}
    </div>
  )
}
