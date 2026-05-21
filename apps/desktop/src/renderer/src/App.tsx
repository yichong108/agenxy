import {
  BugOutlined,
  CheckOutlined,
  DownOutlined,
  FolderOpenOutlined,
  MenuUnfoldOutlined,
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
  ConfigProvider,
  Dropdown,
  FloatButton,
  Input,
  Menu,
  Space,
  Tag,
  Typography,
  MenuProps
} from 'antd'
import type { InputRef } from 'antd/es/input'
import { findAndReplace } from 'mdast-util-find-and-replace'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import type SimpleBarCore from 'simplebar-core'
import SimpleBar from 'simplebar-react'
import 'simplebar-react/dist/simplebar.min.css'
import 'highlight.js/styles/github.css'

import { AboutAgenxyModal } from '@/renderer/src/AboutAgenxyModal'
import agenxyLogoUrl from '@/renderer/src/assets/agenxy-logo.png'
import { WorkspaceLeftPane } from '@/renderer/src/left-pane'
import {
  installCaptionBlockingOverlayObserver,
  resetNativeTitlebarModalStack
} from '@/renderer/src/native-titlebar-bridge'
import { parseAgentPlan } from '@/renderer/src/plan/parse-plan'
import { PlanChecklistPanel } from '@/renderer/src/plan/PlanChecklistPanel'
import { WorkspaceRightPane } from '@/renderer/src/right-pane/WorkspaceRightPane'
import { useUiStore } from '@/renderer/src/store/ui-store'
import { useWorkspaceStore } from '@/renderer/src/store/workspace-store'
import {
  type AboutAppInfo,
  type AgentComposerMode,
  type AgentSendOptions,
  type ChatMessage,
  type HitlToolCallPayload,
  type SessionInfo,
  type StreamEvent,
  type ToolTimelineEvent,
  HOME_WORKSPACE_ID,
  type WorkspaceInfo
} from '@/shared/ipc'

function assistantDisplayTimeline(
  message: ChatMessage,
  latestAssistantId: string | null,
  isRun: boolean,
  liveTimeline: ToolTimelineEvent[]
): ToolTimelineEvent[] {
  if (message.role !== 'assistant') return []
  if (message.id === latestAssistantId && isRun) return liveTimeline
  if (message.toolEvents && message.toolEvents.length > 0) return message.toolEvents
  if (message.id === latestAssistantId && liveTimeline.length > 0) return liveTimeline
  return []
}

function filterSessionsForSidebar(
  list: SessionInfo[] | undefined,
  hiddenIds: string[] | undefined
): SessionInfo[] {
  const hidden = new Set(hiddenIds ?? [])
  return (list ?? []).filter((s) => !hidden.has(s.id))
}

/** Cursor 风格时间线标题用：耗时 1 分 2.3 秒 */
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

/** 按用户消息切分轮次，便于用户气泡在滚动助手回复时 sticky 置顶（Cursor 风格） */
type MessageTurn = { key: string; messages: ChatMessage[] }

function buildMessageTurns(messages: ChatMessage[]): MessageTurn[] {
  const turns: MessageTurn[] = []
  let batch: ChatMessage[] = []

  const flush = () => {
    if (batch.length === 0) return
    turns.push({ key: batch[0]!.id, messages: batch })
    batch = []
  }

  for (const m of messages) {
    if (m.role === 'user') {
      flush()
      batch = [m]
    } else if (batch.length === 0) {
      batch = [m]
    } else {
      batch.push(m)
    }
  }
  flush()
  return turns
}

import '@/renderer/src/App.scss'
import { renderLog } from './logger'

const { Text } = Typography
const { TextArea } = Input

const PRELOAD_MISSING_ERROR = '未检测到 preload 注入（window.bridge 不存在）'

/** Windows 标题栏子菜单弹层 class，与 App.scss 中 `.ant-menu-submenu-popup.app-win-menubar-popup` 对应 */
const WIN_MENUBAR_POPUP_CLASS_NAME = 'app-win-menubar-popup'

/**
 * 仅作用于标题栏 Menu：子菜单项高度来自 Menu token `itemHeight`（默认≈controlHeightLG），
 * 单靠外层 SCSS 易被 antd css-in-js 覆盖，故用局部 ConfigProvider。
 */
const WIN_MENUBAR_MENU_THEME = {
  components: {
    Menu: {
      itemHeight: 28,
      itemMarginBlock: 0,
      /** 默认 marginXXS 会让项宽为 calc(100% - 2*margin)，视觉上左右不撑满 */
      itemMarginInline: 0,
      itemPaddingInline: 10
    }
  }
} as const

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
  const isDevEnv = import.meta.env.DEV

  const isWinCustomChrome = preloadOk && bridge.platform === 'win32'

  useEffect(() => {
    if (!preloadOk) return
    resetNativeTitlebarModalStack()
    return installCaptionBlockingOverlayObserver()
  }, [preloadOk])

  const [aboutOpen, setAboutOpen] = useState(false)
  const [aboutInfo, setAboutInfo] = useState<AboutAppInfo | null>(null)

  const openAboutAgenxy = useCallback(async () => {
    setAboutOpen(true)
    setAboutInfo(null)
    try {
      const info = await bridge.showAbout()
      setAboutInfo(info)
    } catch (e) {
      renderLog.warn('[about] 拉取版本信息失败', e)
      setAboutOpen(false)
      msgApi.error('无法加载关于信息')
    }
  }, [bridge, msgApi])

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
    return [
      {
        key: 'file',
        label: '文件',
        popupClassName: WIN_MENUBAR_POPUP_CLASS_NAME,
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
        key: 'view',
        label: '视图',
        popupClassName: WIN_MENUBAR_POPUP_CLASS_NAME,
        children: viewChildren
      },
      {
        key: 'help',
        label: '帮助',
        popupClassName: WIN_MENUBAR_POPUP_CLASS_NAME,
        children: [
          {
            key: 'about',
            label: '关于 Agenxy',
            onClick: () => void openAboutAgenxy()
          }
        ]
      }
    ]
  }, [bridge, isWinCustomChrome, openAboutAgenxy])

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
  const [rightPaneWidth, setRightPaneWidth] = useState(RIGHT_PANE_DEFAULT_WIDTH)
  const [isRightPaneCollapsed, setIsRightPaneCollapsed] = useState(true)
  const [isRightPaneResizing, setIsRightPaneResizing] = useState(false)
  const rightPaneResizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const rightPaneExpandedWidthRef = useRef(RIGHT_PANE_DEFAULT_WIDTH)
  const [leftTogglePortalHost, setLeftTogglePortalHost] = useState<HTMLDivElement | null>(null)

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

  return (
    <div className="app-shell">
      {isWinCustomChrome ? (
        <div className="app-win-titlebar">
          <span className="app-brand-logo-visual app-brand-logo-visual--titlebar">
            <img
              src={agenxyLogoUrl}
              alt=""
              width={15}
              height={15}
              className="app-win-titlebar-brand-logo"
              draggable={false}
            />
          </span>
          <ConfigProvider theme={WIN_MENUBAR_MENU_THEME}>
            <Menu
              mode="horizontal"
              selectable={false}
              triggerSubMenuAction="click"
              items={winMenubarItems}
              className="app-win-menubar"
            />
          </ConfigProvider>
          {/* 菜单仅占内容宽；右侧留白由 spacer 承担 drag，避免整行 ant-menu 的 no-drag 盖住空白区 */}
          <div className="app-win-titlebar-spacer" aria-hidden />
        </div>
      ) : null}
      <div className={`app-body ${isRightPaneResizing ? 'is-right-resizing' : ''}`}>
        <WorkspaceLeftPane leftTogglePortalHost={leftTogglePortalHost} />
        <div className="app-main-pane">
          <div className="app-topbar">
            {isWinCustomChrome ? (
              <div
                className="app-topbar-leading"
                ref={(el) => {
                  setLeftTogglePortalHost((prev) => (prev === el ? prev : el))
                }}
              />
            ) : (
              <div className="app-topbar-leading-cluster">
                <span className="app-brand-logo-visual app-brand-logo-visual--topbar">
                  <img
                    src={agenxyLogoUrl}
                    alt=""
                    width={19}
                    height={19}
                    className="app-topbar-brand-logo"
                    draggable={false}
                  />
                </span>
                <div
                  className="app-topbar-leading"
                  ref={(el) => {
                    setLeftTogglePortalHost((prev) => (prev === el ? prev : el))
                  }}
                />
              </div>
            )}
            <div className="app-topbar-body">
              {activeId ? (
                <Space>
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
                      本轮: {currentRunStats.toolCalls} 次调用 / {currentRunStats.toolErrors} 次错误
                      / {((currentRunStats.durationMs ?? 0) / 1000).toFixed(2)}s
                    </Text>
                  )}
                  {currentRunStats?.traceId && (
                    <Tag color="default">追踪: {currentRunStats.traceId.slice(-12)}</Tag>
                  )}
                </Space>
              ) : null}
            </div>
            {isRightPaneCollapsed ? (
              <div className="app-topbar-trailing">
                <Button
                  type="text"
                  icon={<MenuUnfoldOutlined />}
                  onClick={handleRightPaneCollapseToggle}
                  className="app-settings-btn app-topbar-pane-toggle"
                  title="展开右边栏"
                  aria-label="展开右边栏"
                />
              </div>
            ) : null}
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
                  {hitlApprovalBar}
                  {planReadyBar}
                  {composerInput}
                </div>
              </div>
            ) : (
              <>
                <div className="app-messages-shell" onMouseLeave={handleMessagesShellMouseLeave}>
                  <SimpleBar
                    className={`app-messages-scroll${messagesScrollSurfaceHot ? ' is-messages-scrollbar-hot' : ''}`}
                    ref={messagesSimpleBarRef}
                    autoHide={false}
                    scrollableNodeProps={{
                      onMouseEnter: () => setMessagesScrollSurfaceHot(true),
                      onScroll: (e: React.UIEvent<HTMLElement>) => {
                        autoScrollRef.current = isNearBottom(e.currentTarget as HTMLDivElement)
                      }
                    }}
                  >
                    <div className="app-messages-inner">
                      {messageTurns.map((turn) => (
                        <div key={turn.key} className="app-message-turn">
                          {turn.messages.map((m) => {
                            const isLatestAssistant =
                              m.role === 'assistant' && m.id === latestAssistantMessageId
                            const displayTimeline = assistantDisplayTimeline(
                              m,
                              latestAssistantMessageId,
                              Boolean(isRun && isLatestAssistant),
                              currentTimeline
                            )
                            const showTimelineAccordion = displayTimeline.length > 0
                            const intentText = m.intentThinking?.trim()
                            const timelineExpanded =
                              timelineOpenOverride[m.id] !== undefined
                                ? timelineOpenOverride[m.id]!
                                : Boolean(isRun && showTimelineAccordion)
                            const isUser = m.role === 'user'
                            return (
                              <Card
                                key={m.id}
                                size="small"
                                bordered={isUser}
                                className={`app-message-card ${isUser ? 'is-user is-sticky-prompt' : 'is-assistant'}`}
                              >
                                <div className="app-message-content">
                                  {m.role === 'assistant' ? (
                                    <>
                                      {showTimelineAccordion || intentText ? (
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
                                              耗时 {formatWorkedDuration(timelineWallMs)}
                                            </span>
                                          </button>
                                          {timelineExpanded ? (
                                            <div className="app-timeline-wrap">
                                              {intentText ? (
                                                <div className="app-timeline-item">
                                                  <Text
                                                    type="secondary"
                                                    className="app-timeline-plan-label"
                                                  >
                                                    思考
                                                  </Text>
                                                  <div className="app-intent-preamble">
                                                    {intentText}
                                                  </div>
                                                </div>
                                              ) : null}
                                              {displayTimeline.map((e, idx) => (
                                                <div
                                                  key={`${e.kind}-${'id' in e ? e.id : idx}-${idx}`}
                                                  className={`app-timeline-item${e.kind === 'plan' ? ' is-plan' : ''}`}
                                                >
                                                  {e.kind === 'error' ? (
                                                    <Text type="danger">{e.message}</Text>
                                                  ) : e.kind === 'plan' ? (
                                                    <>
                                                      <Text
                                                        type="secondary"
                                                        className="app-timeline-plan-label"
                                                      >
                                                        下一步
                                                        {e.toolName ? (
                                                          <Text type="secondary">
                                                            {' '}
                                                            · 在 {e.toolName} 之后
                                                          </Text>
                                                        ) : null}
                                                      </Text>
                                                      <div className="app-timeline-plan">
                                                        {e.text ||
                                                          (e.status === 'streaming' ? '…' : '')}
                                                      </div>
                                                    </>
                                                  ) : (
                                                    <>
                                                      <Text code>
                                                        {e.name}{' '}
                                                        {e.status === 'start'
                                                          ? '…'
                                                          : e.result?.includes('用户已拒绝') ||
                                                              e.result?.includes('Rejected by user')
                                                            ? '✗'
                                                            : '✓'}
                                                      </Text>
                                                      {e.args && (
                                                        <Text type="secondary"> {e.args}</Text>
                                                      )}
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
                                      {planAssistantIds.has(m.id) ? (
                                        <>
                                          <PlanChecklistPanel
                                            content={m.content}
                                            streaming={Boolean(isRun && isLatestAssistant)}
                                            onExecutePlan={() => preparePlanExecution(m.content)}
                                            executeDisabled={Boolean(isRun)}
                                          />
                                          {parseAgentPlan(m.content) ? (
                                            <details className="app-plan-full-details">
                                              <summary>查看完整说明</summary>
                                              <div
                                                className="app-message-markdown app-message-markdown--plan-extra"
                                                onClick={onMarkdownClick}
                                              >
                                                <ReactMarkdown
                                                  remarkPlugins={[remarkGfm, remarkLinkifyBareUrls]}
                                                  rehypePlugins={[rehypeHighlight]}
                                                >
                                                  {m.content}
                                                </ReactMarkdown>
                                              </div>
                                            </details>
                                          ) : (
                                            <>
                                              <div
                                                className="app-message-markdown"
                                                onClick={onMarkdownClick}
                                              >
                                                <ReactMarkdown
                                                  remarkPlugins={[remarkGfm, remarkLinkifyBareUrls]}
                                                  rehypePlugins={[rehypeHighlight]}
                                                >
                                                  {m.content ||
                                                    (isRun && isLatestAssistant ? '…' : '')}
                                                </ReactMarkdown>
                                              </div>
                                              {m.content.trim() && !(isRun && isLatestAssistant) ? (
                                                <div className="app-plan-execute-fallback">
                                                  <Button
                                                    type="primary"
                                                    size="small"
                                                    disabled={Boolean(isRun)}
                                                    onClick={() => preparePlanExecution(m.content)}
                                                  >
                                                    执行计划
                                                  </Button>
                                                </div>
                                              ) : null}
                                            </>
                                          )}
                                        </>
                                      ) : (
                                        <div
                                          className="app-message-markdown"
                                          onClick={onMarkdownClick}
                                        >
                                          <ReactMarkdown
                                            remarkPlugins={[remarkGfm, remarkLinkifyBareUrls]}
                                            rehypePlugins={[rehypeHighlight]}
                                          >
                                            {m.content || (isRun && isLatestAssistant ? '…' : '')}
                                          </ReactMarkdown>
                                        </div>
                                      )}
                                    </>
                                  ) : (
                                    m.content
                                  )}
                                </div>
                              </Card>
                            )
                          })}
                        </div>
                      ))}
                      <div ref={messagesBottomRef} />
                    </div>
                  </SimpleBar>
                </div>
                <div className="app-composer-stack">
                  {hitlApprovalBar}
                  {planReadyBar}
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
          width={isRightPaneCollapsed ? 0 : rightPaneWidth}
          isCollapsed={isRightPaneCollapsed}
          onToggleCollapse={handleRightPaneCollapseToggle}
        />
      </div>

      <AboutAgenxyModal
        open={aboutOpen}
        info={aboutInfo}
        onClose={() => {
          setAboutOpen(false)
          setAboutInfo(null)
        }}
      />

      {isDevEnv && (
        <FloatButton
          icon={<BugOutlined />}
          tooltip="切换开发者工具"
          onClick={() => void toggleDevtools()}
          className="app-devtools-float"
        />
      )}
    </div>
  )
}
