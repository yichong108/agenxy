import { BugOutlined, SendOutlined, StopOutlined } from '@ant-design/icons'
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Form,
  FloatButton,
  Input,
  Menu,
  Modal,
  Space,
  Switch,
  Tag,
  Typography,
  MenuProps
} from 'antd'
import { findAndReplace } from 'mdast-util-find-and-replace'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import 'highlight.js/styles/github.css'

import { WorkspaceLeftPane } from '@/renderer/src/left-pane'
import { WorkspaceRightPane } from '@/renderer/src/right-pane/WorkspaceRightPane'
import { useUiStore } from '@/renderer/src/store/ui-store'

function filterSessionsForSidebar(
  list: SessionInfo[] | undefined,
  hiddenIds: string[] | undefined
): SessionInfo[] {
  const hidden = new Set(hiddenIds ?? [])
  return (list ?? []).filter((s) => !hidden.has(s.id))
}
import {
  applySettingsForm,
  defaultProviderProfiles,
  defaultSettings,
  MAX_MCP_SERVERS,
  mergeFormIntoProviderProfiles,
  parseMcpServersFromUnknown,
  settingsToFormValues,
  type AppSettings,
  type ChatMessage,
  type McpServerEntry,
  type McpWarmupReport,
  type ModelProviderId,
  type ProviderProfile,
  type SessionInfo,
  type SettingsFormValues,
  type SkillUiEntry,
  type SkillsMarketCatalogItem,
  type SkillsRuntimeState,
  type StreamEvent,
  type ToolTimelineEvent,
  defaultWorkspaceUiState,
  type WorkspaceInfo,
  type WorkspaceUiState
} from '@/shared/ipc'

import '@/renderer/src/App.scss'

const { Text } = Typography
const { TextArea } = Input

const PRELOAD_MISSING_ERROR = '未检测到 preload 注入（window.bridge 不存在）'

const DEFAULT_SETTINGS: AppSettings = JSON.parse(JSON.stringify(defaultSettings))
const DEFAULT_FORM_VALUES: SettingsFormValues = settingsToFormValues(DEFAULT_SETTINGS)

function cloneProviderProfiles(
  p: Record<ModelProviderId, ProviderProfile>
): Record<ModelProviderId, ProviderProfile> {
  return JSON.parse(JSON.stringify(p)) as Record<ModelProviderId, ProviderProfile>
}

function randomId() {
  return `m-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** MCP env 存为对象，编辑弹窗用多行 JSON 展示 */
function stringifyMcpEnvForForm(env: McpServerEntry['env']): string {
  if (env == null) return ''
  if (typeof env !== 'object' || Array.isArray(env)) return ''
  return JSON.stringify(env, null, 2)
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

type WorkspaceDropMarker = {
  workspaceId: string
  placement: 'before' | 'after'
}

export function App() {
  const SIDEBAR_MIN_WIDTH = 240
  const SIDEBAR_MAX_WIDTH = 560
  const SIDEBAR_DEFAULT_WIDTH = 300
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
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionsByWorkspace, setSessionsByWorkspace] = useState<Record<string, SessionInfo[]>>({})
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId)
  const setActiveWorkspaceId = useUiStore((s) => s.setActiveWorkspaceId)
  const activeId = useUiStore((s) => s.activeSessionId)
  const setActiveId = useUiStore((s) => s.setActiveSessionId)
  const input = useUiStore((s) => s.inputDraft)
  const setInput = useUiStore((s) => s.setInputDraft)
  const hydrateUiStore = useUiStore((s) => s.hydrateFromMain)
  const byWorkspaceUi = useUiStore((s) => s.byWorkspace)
  const sessionsByWorkspaceForSidebar = useMemo(() => {
    const out: Record<string, SessionInfo[]> = {}
    for (const [wid, list] of Object.entries(sessionsByWorkspace)) {
      out[wid] = filterSessionsForSidebar(list, byWorkspaceUi[wid]?.sidebarHiddenSessionIds)
    }
    return out
  }, [sessionsByWorkspace, byWorkspaceUi])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [mcpDraft, setMcpDraft] = useState<McpServerEntry[]>([])
  const [mcpEditorOpen, setMcpEditorOpen] = useState(false)
  const [mcpEditorRecord, setMcpEditorRecord] = useState<McpServerEntry | null>(null)
  /** 每次打开编辑/添加弹窗递增，保证 Form remount 从而应用 initialValues（解决编辑不回显） */
  const [mcpEditorNonce, setMcpEditorNonce] = useState(0)
  /** 环境变量 JSON 不用 Form 托管，避免 TextArea 与共享 form 实例不同步导致无法回显 */
  const [mcpEnvTextLocal, setMcpEnvTextLocal] = useState('')
  const [mcpProbingId, setMcpProbingId] = useState<string | null>(null)
  /** 主进程池化预热结果（启动 / 保存 MCP / 手动重检） */
  const [mcpWarmup, setMcpWarmup] = useState<McpWarmupReport | null>(null)
  const [mcpWarmupBusy, setMcpWarmupBusy] = useState(false)
  /** Cursor 风格 `{ "mcpServers": { ... } }` 或本应用数组 JSON 粘贴导入 */
  const [mcpJsonImportText, setMcpJsonImportText] = useState('')
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [skillsState, setSkillsState] = useState<SkillsRuntimeState | null>(null)
  const [skillsStateLoading, setSkillsStateLoading] = useState(false)
  const [skillsMarketInstallingId, setSkillsMarketInstallingId] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [form] = Form.useForm<SettingsFormValues>()
  const [mcpForm] = Form.useForm<{
    name: string
    command: string
    argsText: string
    cwd: string
    enabled: boolean
  }>()
  const profilesDraftRef =
    useRef<Record<ModelProviderId, ProviderProfile>>(defaultProviderProfiles())
  const settingsProviderRef = useRef<ModelProviderId>('deepseek')
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Set<string>>(new Set())
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null)
  const [workspaceDropMarker, setWorkspaceDropMarker] = useState<WorkspaceDropMarker | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
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
            label: '关于 AgentWeave',
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
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)
  const [isSidebarResizing, setIsSidebarResizing] = useState(false)
  const sidebarResizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const sidebarExpandedWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH)
  const [rightPaneWidth, setRightPaneWidth] = useState(RIGHT_PANE_DEFAULT_WIDTH)
  const [isRightPaneCollapsed, setIsRightPaneCollapsed] = useState(false)
  const [isRightPaneResizing, setIsRightPaneResizing] = useState(false)
  const rightPaneResizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const rightPaneExpandedWidthRef = useRef(RIGHT_PANE_DEFAULT_WIDTH)

  const mcpWarmupSummary = useMemo(() => {
    if (!mcpWarmup) return null
    if (!mcpWarmup.servers.length) {
      return '当前没有已启用且 command 非空的 MCP 参与预检。'
    }
    const ok = mcpWarmup.servers.filter((x) => x.ok).length
    const bad = mcpWarmup.servers.length - ok
    return `已检查 ${mcpWarmup.servers.length} 台：成功 ${ok}，失败 ${bad}。成功项的连接会留在主进程池中，Agent 调用工具时复用，空闲一段时间后自动断开。`
  }, [mcpWarmup])

  const installedSkillRows = useMemo(() => {
    if (!skillsState) return []
    return [
      ...skillsState.builtinCode,
      ...skillsState.builtinPackaged,
      ...skillsState.installedMarket,
      ...skillsState.legacyUser
    ]
  }, [skillsState])

  const installedMarketFolderIds = useMemo(() => {
    const ids = new Set<string>()
    if (!skillsState) return ids
    for (const row of skillsState.installedMarket) {
      if (row.marketFolderId) ids.add(row.marketFolderId)
    }
    return ids
  }, [skillsState])

  const streamBuf = useRef<Record<string, string>>({})
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
    const settingsResult = await bridge.getSettings()
    setSettings(settingsResult)
    profilesDraftRef.current = cloneProviderProfiles(settingsResult.providerProfiles)
    settingsProviderRef.current = settingsResult.provider
    form.setFieldsValue(settingsToFormValues(settingsResult))

    if (supportsMultiWorkspaceApi) {
      const workspacePayload = await bridgeCompat.listWorkspaces!()
      const workspaceList = workspacePayload.list
      setWorkspaces(workspaceList)
      setActiveWorkspaceId(workspacePayload.activeWorkspaceId)
      setExpandedWorkspaceIds(new Set(workspaceList.map((workspace) => workspace.id)))

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
      const hidden =
        useUiStore.getState().byWorkspace[activeWsId]?.sidebarHiddenSessionIds ?? []
      const activeListRaw = sessionsMap[activeWsId] ?? []
      const activeList = filterSessionsForSidebar(activeListRaw, hidden)
      setSessions(activeList)
      const currentActiveId = useUiStore.getState().activeSessionId
      const nextActiveId =
        currentActiveId && activeList.some((x) => x.id === currentActiveId)
          ? currentActiveId
          : (activeList[0]?.id ?? null)
      setActiveId(nextActiveId)
      if (nextActiveId) {
        await ensureSessionMessages(nextActiveId, true)
      }
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
    setSessions(legacyVisible)
    const currentActiveId = useUiStore.getState().activeSessionId
    const nextActiveId =
      currentActiveId && legacyVisible.some((x) => x.id === currentActiveId)
        ? currentActiveId
        : (legacyVisible[0]?.id ?? null)
    setActiveId(nextActiveId)
    if (nextActiveId) {
      await ensureSessionMessages(nextActiveId, true)
    }
  }, [
    bridge,
    bridgeCompat,
    ensureSessionMessages,
    form,
    setActiveId,
    setActiveWorkspaceId,
    supportsMultiWorkspaceApi
  ])

  const handleStream = useCallback(
    (e: StreamEvent) => {
      console.log(e)
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
      const w = await bridge.getMcpWarmupStatus()
      if (w.report) setMcpWarmup(w.report)
      setMcpWarmupBusy(w.inFlight)
    })()
    const unSub = [
      supportsMultiWorkspaceApi
        ? bridgeCompat.onWorkspacesSync!((payload) => {
            setWorkspaces(payload.list)
            setActiveWorkspaceId(payload.activeWorkspaceId)
            setExpandedWorkspaceIds(new Set(payload.list.map((workspace) => workspace.id)))
            const listByWorkspace = bridgeCompat.listSessionsByWorkspace
            if (!listByWorkspace) return
            void Promise.all(
              payload.list.map(async (workspace) => {
                const list = await listByWorkspace(workspace.id)
                return [workspace.id, list] as const
              })
            ).then((entries) => {
              setSessionsByWorkspace((prev) => {
                const next = { ...prev }
                for (const [workspaceId, list] of entries) {
                  next[workspaceId] = list
                }
                return next
              })
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
          }),
      bridge.onSettingsSync((s) => {
        setSettings(s)
        profilesDraftRef.current = cloneProviderProfiles(s.providerProfiles)
        settingsProviderRef.current = s.provider
        form.setFieldsValue(settingsToFormValues(s))
      }),
      bridge.onSessionsSync((list) => {
        const workspaceId = useUiStore.getState().activeWorkspaceId
        const hidden = workspaceId
          ? (useUiStore.getState().byWorkspace[workspaceId]?.sidebarHiddenSessionIds ?? [])
          : []
        const visible = filterSessionsForSidebar(list, hidden)
        setSessions(visible)
        if (workspaceId) {
          setSessionsByWorkspace((prev) => ({ ...prev, [workspaceId]: list }))
        }
        const validIds = new Set(list.map((x) => x.id))
        for (const id of hydratedMessageSessions.current) {
          if (!validIds.has(id)) hydratedMessageSessions.current.delete(id)
        }
        const currentActiveId = useUiStore.getState().activeSessionId
        if (currentActiveId && visible.some((x) => x.id === currentActiveId)) return
        setActiveId(visible[0]?.id ?? null)
      }),
      bridge.onStream(handleStream),
      bridge.onMcpWarmup((r) => {
        setMcpWarmup(r)
        setMcpWarmupBusy(false)
      })
    ]
    return () => unSub.forEach((f) => f())
  }, [
    bridge,
    form,
    handleStream,
    hydrateUiStore,
    load,
    msgApi,
    preloadOk,
    setActiveId,
    setActiveWorkspaceId,
    supportsMultiWorkspaceApi,
    bridgeCompat
  ])

  useEffect(() => {
    if (!preloadOk || !activeId) return
    void ensureSessionMessages(activeId)
  }, [activeId, ensureSessionMessages, preloadOk])

  const pickWorkspace = async () => {
    const r = await bridge.selectWorkspace()
    if (r.path) {
      msgApi.success('已选择工作区')
    }
  }

  // 发送当前输入消息，并立即在本地追加用户消息
  const send = async () => {
    if (!activeId) return
    const t = input.trim()
    if (!t) return
    const activeWorkspace = workspaces.find((x) => x.id === activeWorkspaceId)
    if (!activeWorkspace?.path) {
      msgApi.warning('请先为当前工作区绑定路径')
      return
    }
    setInput('')
    setMessages((m) => {
      const cur = m[activeId] ?? []
      return {
        ...m,
        [activeId]: [...cur, { id: randomId(), role: 'user' as const, content: t }]
      }
    })
    const r = await bridge.sendAgentMessage(activeId, t)
    if (!r.ok) {
      msgApi.error('发送失败: ' + r.error)
      setMessages((m) => {
        const cur = m[activeId] ?? []
        return {
          ...m,
          [activeId]: appendAssistantText(cur, `发送失败：${r.error}`, true)
        }
      })
    }
  }

  const openSettings = () => {
    profilesDraftRef.current = cloneProviderProfiles(settings.providerProfiles)
    settingsProviderRef.current = settings.provider
    form.setFieldsValue(settingsToFormValues(settings))
    setSettingsOpen(true)
  }

  const onSettingsProviderChange = (next: ModelProviderId) => {
    const prev = settingsProviderRef.current
    if (prev === next) return
    const cur = form.getFieldsValue(['baseUrl', 'model', 'apiKey', 'enableTools']) as Pick<
      ProviderProfile,
      'baseUrl' | 'model' | 'apiKey' | 'enableTools'
    >
    profilesDraftRef.current[prev] = {
      ...profilesDraftRef.current[prev],
      baseUrl: String(cur.baseUrl ?? ''),
      model: String(cur.model ?? ''),
      apiKey: String(cur.apiKey ?? ''),
      enableTools: prev === 'deepseek' ? true : Boolean(cur.enableTools)
    }
    settingsProviderRef.current = next
    const nextProf = profilesDraftRef.current[next]
    form.setFieldsValue({
      provider: next,
      baseUrl: nextProf.baseUrl,
      model: nextProf.model,
      apiKey: nextProf.apiKey,
      enableTools: next === 'deepseek' ? true : nextProf.enableTools
    })
  }

  const saveSettings = async () => {
    const v = await form.validateFields()
    const nextProfiles = mergeFormIntoProviderProfiles(profilesDraftRef.current, v)
    const next = applySettingsForm(settings, v, nextProfiles)
    const saved = await bridge.setSettings(next)
    profilesDraftRef.current = cloneProviderProfiles(saved.providerProfiles)
    settingsProviderRef.current = saved.provider
    setSettings(saved)
    setSettingsOpen(false)
    msgApi.success('已保存（Secret 仅保存在本机主进程）')
  }

  const openMcpHub = useCallback(() => {
    setMcpDraft(JSON.parse(JSON.stringify(settings.mcpServers ?? [])))
    setMcpJsonImportText('')
    setMcpOpen(true)
  }, [settings.mcpServers])

  const reloadSkillsState = useCallback(async () => {
    setSkillsStateLoading(true)
    try {
      const next = await bridge.getSkillsState()
      setSkillsState(next)
    } finally {
      setSkillsStateLoading(false)
    }
  }, [bridge])

  const openSkillsHub = useCallback(() => {
    setSkillsOpen(true)
    void reloadSkillsState()
  }, [reloadSkillsState])

  const installMarketSkill = useCallback(
    async (item: SkillsMarketCatalogItem) => {
      setSkillsMarketInstallingId(item.id)
      try {
        const r = await bridge.installSkillFromMarket(item)
        if (r.ok) {
          msgApi.success(`已安装「${item.name}」`)
          await reloadSkillsState()
        } else {
          msgApi.error(r.error)
        }
      } finally {
        setSkillsMarketInstallingId(null)
      }
    },
    [bridge, msgApi, reloadSkillsState]
  )

  const uninstallSkillRow = useCallback(
    async (row: SkillUiEntry) => {
      if (row.kind === 'market') {
        const folderId = row.marketFolderId
        if (!folderId) return
        modalApi.confirm({
          title: '卸载市场技能？',
          content: `将删除目录「market/${folderId}」及其中的文件。`,
          centered: true,
          okButtonProps: { danger: true },
          onOk: async () => {
            const r = await bridge.uninstallSkill({ kind: 'market', folderId })
            if (r.ok) {
              msgApi.success('已卸载')
              await reloadSkillsState()
            } else {
              msgApi.error(r.error)
            }
          }
        })
        return
      }
      if (row.kind === 'legacy') {
        const rel = row.legacyFolderRelative
        if (!rel) {
          msgApi.warning('该条目位于兼容根目录，无法按文件夹卸载；请手动编辑 userData/skills。')
          return
        }
        modalApi.confirm({
          title: '卸载兼容技能目录？',
          content: `将删除「skills/${rel}」。`,
          centered: true,
          okButtonProps: { danger: true },
          onOk: async () => {
            const r = await bridge.uninstallSkill({ kind: 'legacy', legacyFolderRelative: rel })
            if (r.ok) {
              msgApi.success('已卸载')
              await reloadSkillsState()
            } else {
              msgApi.error(r.error)
            }
          }
        })
      }
    },
    [bridge, modalApi, msgApi, reloadSkillsState]
  )

  const saveMcpServers = useCallback(async () => {
    const payload = JSON.parse(JSON.stringify(mcpDraft)) as McpServerEntry[]
    const saved = await bridge.setSettings({ mcpServers: payload })
    setSettings(saved)
    setMcpDraft(JSON.parse(JSON.stringify(saved.mcpServers ?? [])) as McpServerEntry[])
    setMcpJsonImportText('')
    setMcpOpen(false)
    msgApi.success('MCP 配置已保存')
  }, [bridge, mcpDraft, msgApi])

  const importMcpFromJsonText = useCallback(() => {
    const t = mcpJsonImportText.trim()
    if (!t) {
      msgApi.error('请粘贴 JSON')
      return
    }
    try {
      const parsed = JSON.parse(t) as unknown
      const entries = parseMcpServersFromUnknown(parsed)
      if (entries.length === 0) {
        msgApi.error(
          '未解析到任何 MCP。支持：① Cursor 形态 { "mcpServers": { "名称": { "command", "args", "env" } } }；② 本应用使用的服务器对象数组。'
        )
        return
      }
      const mergedLen = mcpDraft.length + entries.length
      const dropped = mergedLen > MAX_MCP_SERVERS ? mergedLen - MAX_MCP_SERVERS : 0
      setMcpDraft((prev) => [...prev, ...entries].slice(0, MAX_MCP_SERVERS))
      if (dropped > 0) {
        msgApi.warning(`最多共 ${MAX_MCP_SERVERS} 条，已截断 ${dropped} 条导入项`)
      }
      setMcpJsonImportText('')
      msgApi.success(`已加入列表 ${entries.length} 条（请点击「保存 MCP」持久化）`)
    } catch {
      msgApi.error('JSON 解析失败')
    }
  }, [mcpDraft, mcpJsonImportText, msgApi])

  const openMcpAdd = useCallback(() => {
    setMcpEditorNonce((n) => n + 1)
    setMcpEnvTextLocal('')
    setMcpEditorRecord({
      id: randomId(),
      name: '新 MCP 服务器',
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.']
    })
    setMcpEditorOpen(true)
  }, [])

  const openMcpEdit = useCallback(
    (row: McpServerEntry) => {
      setMcpEditorNonce((n) => n + 1)
      const merged = mcpDraft.find((x) => x.id === row.id) ?? row
      setMcpEditorRecord({ ...merged })
      setMcpEnvTextLocal(stringifyMcpEnvForForm(merged.env))
      setMcpEditorOpen(true)
    },
    [mcpDraft]
  )

  // 共享 mcpForm 在子表单重挂载后可能仍保留旧字段，打开后强制同步（环境变量见 mcpEnvTextLocal）
  useLayoutEffect(() => {
    if (!mcpEditorOpen || !mcpEditorRecord) return
    mcpForm.setFieldsValue({
      name: mcpEditorRecord.name,
      command: mcpEditorRecord.command,
      argsText: (mcpEditorRecord.args ?? []).join('\n'),
      cwd: mcpEditorRecord.cwd ?? '',
      enabled: mcpEditorRecord.enabled
    })
    setMcpEnvTextLocal(stringifyMcpEnvForForm(mcpEditorRecord.env))
  }, [mcpEditorOpen, mcpEditorRecord, mcpEditorNonce, mcpForm])

  /**
   * 编辑暂存MCP服务器配置
   */
  const submitMcpEditor = useCallback(async () => {
    if (!mcpEditorRecord) {
      return Promise.reject(new Error('未选择编辑项'))
    }
    const v = await mcpForm.validateFields()
    const argsTextRaw = String(v.argsText ?? '')
    const args = argsTextRaw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (args.length === 0) {
      msgApi.error('参数至少填写一行（每行一个参数）')
      return Promise.reject(new Error('args empty'))
    }
    let env: Record<string, unknown> | undefined
    const trimmedEnv = mcpEnvTextLocal.trim()
    if (trimmedEnv) {
      try {
        const parsed = JSON.parse(trimmedEnv) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          msgApi.error('环境变量须为 JSON 对象，例如 {"KEY":"value"} 或含嵌套对象')
          return Promise.reject(new Error('env shape'))
        }
        const o: Record<string, unknown> = {}
        for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
          if (val === undefined) continue
          o[k] = val
        }
        if (Object.keys(o).length) env = o
      } catch {
        msgApi.error('环境变量 JSON 解析失败')
        return Promise.reject(new Error('env json'))
      }
    }
    const cwdTrim = String(v.cwd ?? '').trim()
    const nextRow: McpServerEntry = {
      id: mcpEditorRecord.id,
      name: v.name.trim() || mcpEditorRecord.id,
      enabled: v.enabled,
      command: v.command.trim(),
      args,
      ...(cwdTrim ? { cwd: cwdTrim } : {}),
      ...(env ? { env } : {})
    }
    setMcpDraft((prev) => {
      const i = prev.findIndex((x) => x.id === nextRow.id)
      if (i >= 0) {
        const copy = [...prev]
        copy[i] = nextRow
        return copy
      }
      return [...prev, nextRow]
    })
    setMcpEditorOpen(false)
    setMcpEditorRecord(null)
    setMcpEnvTextLocal('')
    msgApi.success('已写入列表（请点击主窗口底部「保存 MCP」持久化）')
  }, [mcpEditorRecord, mcpEnvTextLocal, mcpForm, msgApi])

  const probeMcpRow = useCallback(
    async (row: McpServerEntry) => {
      setMcpProbingId(row.id)
      try {
        const r = await bridge.mcpProbeServer(row)
        if (r.ok) {
          modalApi.info({
            title: `「${row.name}」连接成功`,
            width: 600,
            centered: true,
            content: (
              <div>
                <Text>共 {r.tools.length} 个工具：</Text>
                <ul style={{ marginTop: 8, paddingLeft: 18, maxHeight: 360, overflow: 'auto' }}>
                  {r.tools.map((t) => (
                    <li key={t.name} style={{ marginBottom: 6 }}>
                      <Text code>{t.name}</Text>
                      {t.description ? (
                        <Text type="secondary">
                          {' '}
                          {t.description.length > 160
                            ? `${t.description.slice(0, 160)}…`
                            : t.description}
                        </Text>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })
        } else {
          msgApi.error(r.error)
        }
      } finally {
        setMcpProbingId(null)
      }
    },
    [bridge, modalApi, msgApi]
  )

  const rerunMcpWarmup = useCallback(async () => {
    setMcpWarmupBusy(true)
    try {
      const r = await bridge.mcpRunWarmup()
      setMcpWarmup(r)
    } catch {
      msgApi.error('MCP 预检失败')
    } finally {
      setMcpWarmupBusy(false)
    }
  }, [bridge, msgApi])

  // 检查 React DevTools 是否已加载完成
  const checkDevToolsReady = (): boolean => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__
    return !!(hook && (hook.renderers?.size > 0 || hook._renderers))
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
        window.location.reload()
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
  const hasInput = input.trim().length > 0
  const showSendButton = !isRun || hasInput
  const showStopButton = Boolean(activeId && isRun && !hasInput)
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

  useEffect(() => {
    if (!activeWorkspaceId) return
    setExpandedWorkspaceIds((prev) => {
      const next = new Set(prev)
      next.add(activeWorkspaceId)
      return next
    })
  }, [activeWorkspaceId])

  const handleWorkspaceToggle = useCallback((workspaceId: string) => {
    setExpandedWorkspaceIds((prev) => {
      const next = new Set(prev)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      return next
    })
  }, [])

  const handleSidebarResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
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
  }, [isSidebarResizing])

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

  const handleSessionClick = useCallback(
    async (workspaceId: string, sessionId: string) => {
      if (workspaceId !== activeWorkspaceId && supportsMultiWorkspaceApi) {
        const workspace = await bridgeCompat.activateWorkspace!(workspaceId)
        if (!workspace) {
          msgApi.error('切换工作区失败')
          return
        }
      }
      setActiveId(sessionId)
    },
    [activeWorkspaceId, bridgeCompat, msgApi, setActiveId, supportsMultiWorkspaceApi]
  )

  const createSessionInWorkspace = useCallback(
    async (workspaceId: string) => {
      if (!workspaceId) return
      if (workspaceId !== activeWorkspaceId && supportsMultiWorkspaceApi) {
        const workspace = await bridgeCompat.activateWorkspace!(workspaceId)
        if (!workspace) {
          msgApi.error('切换工作区失败')
          return
        }
      }
      const session = await bridge.createSession()
      if (!session) {
        msgApi.warning('请先创建或选择工作区')
        return
      }
      setExpandedWorkspaceIds((prev) => {
        const next = new Set(prev)
        next.add(workspaceId)
        return next
      })
      setActiveId(session.id)
    },
    [activeWorkspaceId, bridge, bridgeCompat, msgApi, setActiveId, supportsMultiWorkspaceApi]
  )

  const createSessionForActiveWorkspace = useCallback(() => {
    if (!activeWorkspaceId) {
      msgApi.warning('请先创建或选择工作区')
      return
    }
    void createSessionInWorkspace(activeWorkspaceId)
  }, [activeWorkspaceId, createSessionInWorkspace, msgApi])

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
      if (workspace.isDefault) return
      modalApi.confirm({
        title: '从侧边栏移除此工作区？',
        content: '该工作区下的会话将保留并合并到默认工作区，之后可通过「添加并切换工作区」重新加入。',
        centered: true,
        okText: '移除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          const { ok } = await bridge.removeWorkspace(workspace.id)
          if (ok) {
            msgApi.success('已从侧边栏移除')
          } else {
            msgApi.error('移除失败（默认工作区不可移除）')
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
        setActiveId(nextId)
        if (nextId) void ensureSessionMessages(nextId, true)
      }
      msgApi.success('已从侧边栏移除')
    },
    [ensureSessionMessages, msgApi, sessionsByWorkspace, setActiveId]
  )

  const handleWorkspaceDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, workspaceId: string) => {
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
    (event: React.DragEvent<HTMLDivElement>, workspaceId: string) => {
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
    async (event: React.DragEvent<HTMLDivElement>, targetWorkspaceId: string) => {
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
    [bridgeCompat, draggingWorkspaceId, workspaceDropMarker, workspaces]
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
      <div
        className={`app-body ${isSidebarResizing ? 'is-sidebar-resizing' : ''} ${isRightPaneResizing ? 'is-right-resizing' : ''}`}
      >
        <WorkspaceLeftPane
          sidebarWidth={sidebarWidth}
          isSidebarCollapsed={isSidebarCollapsed}
          isSidebarResizing={isSidebarResizing}
          activeWorkspaceId={activeWorkspaceId}
          activeSessionId={activeId}
          workspaces={workspaces}
          sessionsByWorkspace={sessionsByWorkspaceForSidebar}
          expandedWorkspaceIds={expandedWorkspaceIds}
          draggingWorkspaceId={draggingWorkspaceId}
          workspaceDropMarker={workspaceDropMarker}
          onOpenMcpHub={openMcpHub}
          onOpenSkillsHub={openSkillsHub}
          onOpenSettings={openSettings}
          onCreateSessionForActiveWorkspace={createSessionForActiveWorkspace}
          onToggleWorkspace={handleWorkspaceToggle}
          onWorkspaceDragStart={handleWorkspaceDragStart}
          onWorkspaceDragOver={handleWorkspaceDragOver}
          onWorkspaceDrop={(event, workspaceId) => {
            void handleWorkspaceDrop(event, workspaceId)
          }}
          onWorkspaceDragEnd={handleWorkspaceDragEnd}
          onCreateSessionInWorkspace={(workspaceId) => {
            void createSessionInWorkspace(workspaceId)
          }}
          onSessionClick={(workspaceId, sessionId) => {
            void handleSessionClick(workspaceId, sessionId)
          }}
          onRenameSession={handleSessionRenameRequest}
          onDeleteSession={handleSessionDeleteRequest}
          onRemoveSessionFromSidebar={handleRemoveSessionFromSidebar}
          onRemoveWorkspaceFromSidebar={
            supportsMultiWorkspaceApi ? handleRemoveWorkspaceFromSidebar : undefined
          }
          onPickWorkspace={() => {
            void pickWorkspace()
          }}
          onSidebarResizeStart={handleSidebarResizeStart}
          onSidebarCollapseToggle={handleSidebarCollapseToggle}
          mcpOpen={mcpOpen}
          mcpDraft={mcpDraft}
          mcpJsonImportText={mcpJsonImportText}
          mcpWarmupSummary={mcpWarmupSummary}
          mcpWarmup={mcpWarmup}
          mcpWarmupBusy={mcpWarmupBusy}
          mcpProbingId={mcpProbingId}
          onCloseMcpHub={() => {
            setMcpOpen(false)
            setMcpJsonImportText('')
          }}
          onSaveMcpServers={() => {
            void saveMcpServers()
          }}
          onRerunMcpWarmup={() => {
            void rerunMcpWarmup()
          }}
          onMcpJsonImportTextChange={setMcpJsonImportText}
          onImportMcpFromJsonText={importMcpFromJsonText}
          onOpenMcpAdd={openMcpAdd}
          onSetMcpEnabled={(id, checked) => {
            setMcpDraft((prev) => prev.map((x) => (x.id === id ? { ...x, enabled: checked } : x)))
          }}
          onProbeMcpRow={(row) => {
            void probeMcpRow(row)
          }}
          onOpenMcpEdit={openMcpEdit}
          onDeleteMcpRow={(id) => {
            setMcpDraft((prev) => prev.filter((x) => x.id !== id))
          }}
          onOpenExternalWithConfirm={openExternalWithConfirm}
          settingsOpen={settingsOpen}
          settingsForm={form}
          defaultSettingsFormValues={DEFAULT_FORM_VALUES}
          onSaveSettings={() => {
            void saveSettings()
          }}
          onCloseSettings={() => setSettingsOpen(false)}
          onSettingsProviderChange={onSettingsProviderChange}
          skillsOpen={skillsOpen}
          skillsStateLoading={skillsStateLoading}
          installedSkillRows={installedSkillRows}
          installedMarketFolderIds={installedMarketFolderIds}
          skillsMarketInstallingId={skillsMarketInstallingId}
          onCloseSkillsHub={() => setSkillsOpen(false)}
          onReloadSkillsState={() => {
            void reloadSkillsState()
          }}
          onInstallMarketSkill={(item) => {
            void installMarketSkill(item)
          }}
          onUninstallSkillRow={(row) => {
            void uninstallSkillRow(row)
          }}
        />
        <div className="app-main-pane">
          <div className="app-topbar">
            {activeId && (
              <Space>
                <Text type="secondary">会话</Text>
                <Text>
                  {(sessionsByWorkspace[activeWorkspaceId ?? ''] ?? []).find((s) => s.id === activeId)
                    ?.name}
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
          <div className="app-content">
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
            <div className="app-messages-shell">
              <div
                className="app-messages-scroll"
                ref={messagesScrollRef}
                onScroll={(e) => {
                  autoScrollRef.current = isNearBottom(e.currentTarget)
                }}
              >
                {currentMessages.map((m) => (
                  <Card
                    key={m.id}
                    size="small"
                    className={`app-message-card ${m.role === 'user' ? 'is-user' : 'is-assistant'}`}
                  >
                    <div className="app-message-content">
                      {m.role === 'assistant' ? (
                        <div className="app-message-markdown" onClick={onMarkdownClick}>
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkLinkifyBareUrls]}
                            rehypePlugins={[rehypeHighlight]}
                          >
                            {m.content || (isRun ? '…' : '')}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        m.content
                      )}
                    </div>
                    {m.role === 'assistant' &&
                      m.id === latestAssistantMessageId &&
                      currentTimeline.length > 0 && (
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
                                    <pre className="app-timeline-result">{e.result}</pre>
                                  )}
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                  </Card>
                ))}
                {!currentMessages.length && (
                  <Card size="small" className="app-empty-card">
                    <Text type="secondary" className="app-empty-tip">
                      发一条消息开始；务必先选择工作区并配置 API Key。
                    </Text>
                  </Card>
                )}
                <div ref={messagesBottomRef} />
              </div>
            </div>
            <div className="app-composer">
              <TextArea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                autoSize={{ minRows: 1, maxRows: 6 }}
                placeholder="输入消息… (Enter 发送，Shift+Enter 换行)"
                className="app-composer-input"
                onPressEnter={(e) => {
                  if (!e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              <div className="app-composer-actions">
                {showSendButton && (
                  <Button
                    type="primary"
                    icon={<SendOutlined />}
                    onClick={() => void send()}
                    disabled={!activeId}
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
          activeWorkspaceId={activeWorkspaceId}
          activeWorkspacePath={workspaces.find((x) => x.id === activeWorkspaceId)?.path ?? null}
          width={isRightPaneCollapsed ? RIGHT_PANE_COLLAPSED_WIDTH : rightPaneWidth}
          isCollapsed={isRightPaneCollapsed}
          onToggleCollapse={handleRightPaneCollapseToggle}
        />
      </div>

      <Modal
        title={
          mcpDraft.some((x) => x.id === mcpEditorRecord?.id) ? '编辑 MCP 服务器' : '添加 MCP 服务器'
        }
        open={mcpEditorOpen}
        onOk={() => submitMcpEditor()}
        onCancel={() => {
          setMcpEditorOpen(false)
          setMcpEditorRecord(null)
          setMcpEnvTextLocal('')
        }}
        okText="写入列表"
        destroyOnHidden
        width={520}
        centered
      >
        {mcpEditorRecord ? (
          <Form
            key={`mcp-editor-${mcpEditorRecord.id}-${mcpEditorNonce}`}
            form={mcpForm}
            layout="vertical"
            preserve={false}
            initialValues={{
              name: mcpEditorRecord.name,
              command: mcpEditorRecord.command,
              argsText: (mcpEditorRecord.args ?? []).join('\n'),
              cwd: mcpEditorRecord.cwd ?? '',
              enabled: mcpEditorRecord.enabled
            }}
          >
            <Form.Item
              name="name"
              label="显示名称"
              rules={[{ required: true, message: '请填写名称' }]}
            >
              <Input placeholder="例如 Filesystem MCP" />
            </Form.Item>
            <Form.Item
              name="command"
              label="可执行文件"
              rules={[{ required: true, message: '请填写命令' }]}
            >
              <Input placeholder="如 npx、uvx、node" />
            </Form.Item>
            <Form.Item
              name="argsText"
              label="参数（每行一个）"
              rules={[{ required: true, message: '至少填写一行参数' }]}
              extra="示例：-y 换行 @modelcontextprotocol/server-filesystem 换行 工作区绝对路径"
            >
              <TextArea
                rows={5}
                placeholder={['-y', '@modelcontextprotocol/server-filesystem', '.'].join('\n')}
              />
            </Form.Item>
            <Form.Item name="cwd" label="工作目录 cwd（可选）">
              <Input placeholder="子进程启动目录，默认可留空" />
            </Form.Item>
            <Form.Item
              label="环境变量 JSON（可选）"
              extra="支持嵌套对象/数组，会原样写入配置；启动 MCP 子进程时非字符串会 JSON.stringify 后作为环境变量值传入。"
            >
              <TextArea
                rows={3}
                placeholder="{}"
                value={mcpEnvTextLocal}
                onChange={(e) => setMcpEnvTextLocal(e.target.value)}
              />
            </Form.Item>
            <Form.Item name="enabled" label="添加后立即启用" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Form>
        ) : null}
      </Modal>

      <Modal
        title="重命名会话"
        open={!!renameId}
        onOk={() => {
          const v = renameName.trim()
          if (renameId && v) {
            void bridge.renameSession(renameId, v).then(() => {
              msgApi.success('已重命名')
              setRenameId(null)
            })
          }
        }}
        onCancel={() => setRenameId(null)}
        okText="保存"
        destroyOnHidden
        centered
      >
        <Input
          value={renameName}
          onChange={(e) => setRenameName(e.target.value)}
          placeholder="名称"
        />
      </Modal>

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
