import {
  ApiOutlined,
  BugOutlined,
  PlusOutlined,
  SendOutlined,
  SettingOutlined,
  StopOutlined,
  FolderOpenOutlined, ShopOutlined
} from '@ant-design/icons'
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Form,
  FloatButton,
  Input,
  InputNumber,
  Menu,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  Dropdown,
  Divider,
  Tooltip, MenuProps
} from 'antd'
import { findAndReplace } from 'mdast-util-find-and-replace'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import 'highlight.js/styles/github.css'

import { SkillsMarketPanel } from '@/renderer/src/skills-market/SkillsMarketPanel'
import { useUiStore } from '@/renderer/src/store/ui-store'
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
  type WorkspaceInfo
} from '@/shared/ipc'

import '@/renderer/src/App.scss'

const { Text, Title } = Typography

function skillKindLabel(kind: SkillUiEntry['kind']): string {
  switch (kind) {
    case 'builtin_code':
      return '内置（代码）'
    case 'builtin_packaged':
      return '内置（随应用）'
    case 'market':
      return '市场'
    case 'legacy':
      return '兼容/本地'
    default:
      return kind
  }
}

const MCP_MARKET_LINKS: { title: string; desc: string; url: string }[] = [
  {
    title: 'Cursor Directory',
    desc: '社区收录的 MCP 与扩展，可按场景筛选',
    url: 'https://cursor.directory/mcp'
  },
  {
    title: 'Smithery',
    desc: 'MCP 注册与托管，可浏览可安装的 stdio 包',
    url: 'https://smithery.ai/'
  },
  {
    title: 'Glama MCP',
    desc: 'MCP 服务器目录与文档',
    url: 'https://glama.ai/mcp/servers'
  },
  {
    title: 'MCP 官方规范',
    desc: '协议说明、能力模型与实现参考',
    url: 'https://modelcontextprotocol.io/'
  },
  {
    title: 'awesome-mcp-servers',
    desc: 'GitHub 上的开源 MCP 服务器合集',
    url: 'https://github.com/punkpeye/awesome-mcp-servers'
  }
]
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

export function App() {
  const { message: msgApi, modal: modalApi } = AntdApp.useApp()
  const preloadOk = typeof window !== 'undefined' && typeof window.bridge !== 'undefined'
  const bridge = window.bridge
  const bridgeCompat = bridge as typeof bridge & {
    listWorkspaces?: () => Promise<{ list: WorkspaceInfo[]; activeWorkspaceId: string | null }>
    listSessionsByWorkspace?: (workspaceId: string) => Promise<SessionInfo[]>
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
      const activeList = sessionsMap[workspacePayload.activeWorkspaceId ?? ''] ?? []
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
    setSessions(legacySessions)
    const currentActiveId = useUiStore.getState().activeSessionId
    const nextActiveId =
      currentActiveId && legacySessions.some((x) => x.id === currentActiveId)
        ? currentActiveId
        : (legacySessions[0]?.id ?? null)
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
        setSessions(list)
        const workspaceId = useUiStore.getState().activeWorkspaceId
        if (workspaceId) {
          setSessionsByWorkspace((prev) => ({ ...prev, [workspaceId]: list }))
        }
        const validIds = new Set(list.map((x) => x.id))
        for (const id of hydratedMessageSessions.current) {
          if (!validIds.has(id)) hydratedMessageSessions.current.delete(id)
        }
        const currentActiveId = useUiStore.getState().activeSessionId
        if (currentActiveId && list.some((x) => x.id === currentActiveId)) return
        setActiveId(list[0]?.id ?? null)
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

  const handleWorkspaceClick = useCallback(
    async (workspaceId: string) => {
      setExpandedWorkspaceIds((prev) => {
        const next = new Set(prev)
        if (next.has(workspaceId)) next.delete(workspaceId)
        else next.add(workspaceId)
        return next
      })
      if (workspaceId === activeWorkspaceId) return
      if (!supportsMultiWorkspaceApi) {
        setActiveWorkspaceId(workspaceId)
        return
      }
      const workspace = await bridgeCompat.activateWorkspace!(workspaceId)
      if (!workspace) msgApi.error('切换工作区失败')
    },
    [activeWorkspaceId, bridgeCompat, msgApi, setActiveWorkspaceId, supportsMultiWorkspaceApi]
  )

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
      <div className="app-body">
      <div className="app-sidebar">
        <div className="app-sidebar-inner">
          <div className="app-sidebar-header">
            <Text strong className="app-brand-text">
              AgentWeave
            </Text>
            <Space size={0}>
              <Button
                type="text"
                icon={<ApiOutlined />}
                onClick={openMcpHub}
                className="app-settings-btn"
                title="MCP 与扩展"
              />
              <Button
                type="text"
                icon={<ShopOutlined />}
                onClick={openSkillsHub}
                className="app-settings-btn"
                title="技能与市场"
              />
              <Button
                type="text"
                icon={<SettingOutlined />}
                onClick={openSettings}
                className="app-settings-btn"
                title="设置"
              />
            </Space>
          </div>
          <div className="app-new-session-wrap">
            <Button
              block
              type="primary"
              icon={<PlusOutlined />}
              className="app-new-session-btn"
              onClick={async () => {
                const s = await bridge.createSession()
                if (!s) {
                  msgApi.warning('请先创建或选择工作区')
                  return
                }
                setActiveId(s.id)
              }}
            >
              新会话
            </Button>
          </div>
          <div className="app-workspace-tree">
            {workspaces.map((workspace) => {
              const isActiveWorkspace = workspace.id === activeWorkspaceId
              const isExpanded = expandedWorkspaceIds.has(workspace.id)
              const workspaceSessions = sessionsByWorkspace[workspace.id] || []
              return (
                <div
                  key={workspace.id}
                  className={`app-workspace-node ${isActiveWorkspace ? 'is-active' : ''}`}
                >
                  <button
                    type="button"
                    className="app-workspace-node-header"
                    onClick={() => void handleWorkspaceClick(workspace.id)}
                  >
                    <span
                      className={`app-workspace-chevron ${isExpanded ? 'is-open' : ''}`}
                      aria-hidden="true"
                    >
                      {'>'}
                    </span>
                    <Text className="app-workspace-name">{workspace.name}</Text>
                    {workspaceSessions.length > 0 && (
                      <span className="app-workspace-session-count">
                        {workspaceSessions.length}
                      </span>
                    )}
                  </button>
                  {isExpanded && (
                    <div className="app-session-sublist">
                      {workspaceSessions.map((s) => (
                        <Dropdown
                          key={s.id}
                          menu={{
                            items: [
                              {
                                key: 'rename',
                                label: '重命名',
                                onClick: () => {
                                  setRenameId(s.id)
                                  setRenameName(s.name)
                                }
                              },
                              {
                                key: 'del',
                                danger: true,
                                label: '删除',
                                onClick: () => {
                                  modalApi.confirm({
                                    title: '删除此会话？',
                                    onOk: () => {
                                      void bridge
                                        .deleteSession(s.id)
                                        .then(() => msgApi.success('已删除'))
                                    }
                                  })
                                }
                              }
                            ]
                          }}
                          trigger={['contextMenu']}
                        >
                          <div
                            className={`app-session-item app-session-item-sub ${s.id === activeId ? 'is-active' : ''}`}
                            onClick={() => void handleSessionClick(workspace.id, s.id)}
                          >
                            <div className="app-session-title">{s.name}</div>
                          </div>
                        </Dropdown>
                      ))}
                      {workspaceSessions.length === 0 && (
                        <div className="app-session-placeholder">当前工作区暂无会话</div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="app-workspace-btn-wrap">
            <Button block icon={<FolderOpenOutlined />} onClick={pickWorkspace}>
              添加并切换工作区
            </Button>
          </div>
        </div>
      </div>
      <div className="app-main-pane">
        <div className="app-topbar">
          {activeId && (
            <Space>
              <Text type="secondary">会话</Text>
              <Text>{sessions.find((s) => s.id === activeId)?.name}</Text>
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
      </div>

      <Modal
        title="MCP 与扩展"
        open={mcpOpen}
        onCancel={() => {
          setMcpOpen(false)
          setMcpJsonImportText('')
        }}
        width={760}
        destroyOnHidden
        footer={[
          <Button
            key="close"
            onClick={() => {
              setMcpOpen(false)
              setMcpJsonImportText('')
            }}
          >
            关闭
          </Button>,
          <Button key="save" type="primary" onClick={() => void saveMcpServers()}>
            保存 MCP
          </Button>
        ]}
      >
        <Tabs
          items={[
            {
              key: 'servers',
              label: '我的 MCP',
              children: (
                <div>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="stdio 方式连接 MCP 子进程"
                    description={
                      <div>
                        <div>
                          与 Cursor 类似：填写启动命令与参数。启用后，Agent
                          在「已开启工具」模式下会把各服务器的工具挂到对话中（工具名以 mcp_
                          开头）。应用启动时会<strong>预检</strong>已启用的服务器并
                          <strong>池化复用</strong>
                          连接，减少反复拉起子进程；长时间无调用会自动断开。
                        </div>
                        {mcpWarmupSummary ? (
                          <div style={{ marginTop: 8 }}>
                            <Text strong>预检摘要：</Text>
                            {mcpWarmupSummary}
                            {mcpWarmup ? (
                              <Text type="secondary" style={{ marginLeft: 8 }}>
                                （{new Date(mcpWarmup.atMs).toLocaleString()}）
                              </Text>
                            ) : null}
                          </div>
                        ) : null}
                        {mcpWarmupBusy ? (
                          <div style={{ marginTop: 8 }}>
                            <Text type="secondary">正在预检已启用的 MCP…</Text>
                          </div>
                        ) : null}
                      </div>
                    }
                  />
                  <Space style={{ marginBottom: 12 }}>
                    <Button
                      size="small"
                      loading={mcpWarmupBusy}
                      onClick={() => void rerunMcpWarmup()}
                    >
                      重新预检全部 MCP
                    </Button>
                  </Space>
                  <div style={{ marginBottom: 12 }}>
                    <Text strong>从 JSON 导入</Text>
                    <div style={{ marginTop: 6, marginBottom: 8 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        支持 Cursor 片段：根对象含 <Text code>mcpServers</Text>
                        ，子键为显示名，值为含 command、args、env
                        等字段的对象；也支持本应用使用的服务器对象数组。
                      </Text>
                    </div>
                    <TextArea
                      value={mcpJsonImportText}
                      onChange={(e) => setMcpJsonImportText(e.target.value)}
                      placeholder={`例如：\n{\n  "mcpServers": {\n    "mysql": {\n      "command": "npx",\n      "args": ["-y", "@f4ww4z/mcp-mysql-server"],\n      "env": { "MYSQL_HOST": "localhost" }\n    }\n  }\n}`}
                      rows={6}
                      style={{ fontFamily: 'monospace', fontSize: 12 }}
                    />
                    <Button
                      type="default"
                      style={{ marginTop: 8 }}
                      onClick={() => importMcpFromJsonText()}
                    >
                      解析并追加到列表
                    </Button>
                  </div>
                  <Space style={{ marginBottom: 12 }}>
                    <Button type="primary" onClick={openMcpAdd}>
                      添加服务器
                    </Button>
                  </Space>
                  <Table<McpServerEntry>
                    size="small"
                    rowKey="id"
                    pagination={false}
                    dataSource={mcpDraft}
                    locale={{ emptyText: '暂无 MCP，可从「MCP 市场」挑选后在此添加' }}
                    columns={[
                      { title: '名称', dataIndex: 'name', width: 140, ellipsis: true },
                      {
                        title: '命令',
                        dataIndex: 'command',
                        width: 100,
                        ellipsis: true
                      },
                      {
                        title: '参数预览',
                        key: 'args',
                        ellipsis: true,
                        render: (_, row) => (
                          <Text type="secondary" ellipsis>
                            {(row.args ?? []).join(' ').slice(0, 80)}
                            {(row.args ?? []).join(' ').length > 80 ? '…' : ''}
                          </Text>
                        )
                      },
                      {
                        title: '启用',
                        width: 72,
                        render: (_, row) => (
                          <Switch
                            checked={row.enabled}
                            onChange={(checked) =>
                              setMcpDraft((prev) =>
                                prev.map((x) => (x.id === row.id ? { ...x, enabled: checked } : x))
                              )
                            }
                          />
                        )
                      },
                      {
                        title: '启动预检',
                        key: 'warmup',
                        width: 108,
                        render: (_, row) => {
                          if (!row.enabled || !row.command?.trim()) {
                            return <Text type="secondary">—</Text>
                          }
                          const r = mcpWarmup?.servers.find((x) => x.id === row.id)
                          if (!r && mcpWarmupBusy) {
                            return (
                              <Tag color="processing" style={{ margin: 0 }}>
                                检测中
                              </Tag>
                            )
                          }
                          if (!r) return <Text type="secondary">—</Text>
                          if (r.ok) {
                            return (
                              <Tag color="success" style={{ margin: 0 }}>
                                {r.toolCount} 工具
                              </Tag>
                            )
                          }
                          return (
                            <Tag color="error" style={{ margin: 0 }} title={r.error}>
                              失败
                            </Tag>
                          )
                        }
                      },
                      {
                        title: '操作',
                        key: 'actions',
                        width: 200,
                        render: (_, row) => (
                          <Space size={4} wrap>
                            <Button
                              size="small"
                              loading={mcpProbingId === row.id}
                              onClick={() => void probeMcpRow(row)}
                            >
                              测试
                            </Button>
                            <Button size="small" onClick={() => openMcpEdit(row)}>
                              编辑
                            </Button>
                            <Button
                              size="small"
                              danger
                              onClick={() =>
                                setMcpDraft((prev) => prev.filter((x) => x.id !== row.id))
                              }
                            >
                              删除
                            </Button>
                          </Space>
                        )
                      }
                    ]}
                  />
                </div>
              )
            },
            {
              key: 'market',
              label: 'MCP 市场',
              children: (
                <div>
                  <Text type="secondary">
                    以下为常用 MCP 发现与文档站点，点击在系统浏览器中打开（需确认）。
                  </Text>
                  <Divider style={{ margin: '12px 0' }} />
                  <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                    {MCP_MARKET_LINKS.map((item) => (
                      <Card key={item.url} size="small" type="inner">
                        <Title level={5} style={{ marginTop: 0, marginBottom: 4 }}>
                          {item.title}
                        </Title>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                          {item.desc}
                        </Text>
                        <Typography.Link
                          href={item.url}
                          onClick={(e) => {
                            e.preventDefault()
                            openExternalWithConfirm(item.url)
                          }}
                        >
                          {item.url}
                        </Typography.Link>
                      </Card>
                    ))}
                  </Space>
                </div>
              )
            }
          ]}
        />
      </Modal>

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
        title="设置（模型与密钥）"
        open={settingsOpen}
        onOk={() => void saveSettings()}
        onCancel={() => setSettingsOpen(false)}
        width={520}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" initialValues={DEFAULT_FORM_VALUES}>
          <Form.Item name="provider" label="提供方" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'deepseek', label: 'DeepSeek' },
                { value: 'ollama', label: 'Ollama' }
              ]}
              onChange={(v) => onSettingsProviderChange(v as ModelProviderId)}
            />
          </Form.Item>
          <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true }]}>
            <Input placeholder="DeepSeek: https://api.deepseek.com；Ollama: http://127.0.0.1:11434" />
          </Form.Item>
          <Form.Item name="model" label="Model" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.provider !== cur.provider}>
            {() => {
              const p = form.getFieldValue('provider') as ModelProviderId
              if (p === 'ollama') return null
              return (
                <Form.Item
                  name="apiKey"
                  label="API Key"
                  rules={[{ required: true, message: '请先填写 API Key' }]}
                  hasFeedback
                >
                  <Input.Password autoComplete="off" placeholder="仅保存在本机" />
                </Form.Item>
              )
            }}
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.provider !== cur.provider}>
            {() =>
              form.getFieldValue('provider') === 'ollama' ? (
                <Form.Item
                  name="enableTools"
                  label="启用工作区工具"
                  valuePropName="checked"
                  extra="需模型支持 Ollama/OpenAI 的 tools API（如 llama3.2、qwen2.5）。deepseek-r1 等不支持，请保持关闭以免报错。"
                >
                  <Switch />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item name="maxConcurrentStreams" label="最大并行流">
            <InputNumber min={1} max={8} className="app-settings-number" />
          </Form.Item>
          <Form.Item name="streamFlushMs" label="流式合并间隔 (ms)">
            <InputNumber min={8} max={200} className="app-settings-number" />
          </Form.Item>
          <Form.Item name="streamFlushChars" label="流式合并字符数">
            <InputNumber min={32} max={2000} className="app-settings-number" />
          </Form.Item>
          <Form.Item name="maxTerminalOutputChars" label="终端输出最大字符">
            <InputNumber min={1} max={1000} className="app-settings-number" />
          </Form.Item>
          <Form.Item
            name="tavilyApiKey"
            label="Tavily API Key（联网搜索）"
            extra="选填。填写后模型可调用 web_search；注册 https://tavily.com 。也可通过环境变量 TAVILY_API_KEY 提供（不设此项时）。"
          >
            <Input.Password autoComplete="off" placeholder="留空则不启用联网搜索" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="技能与市场"
        open={skillsOpen}
        onCancel={() => setSkillsOpen(false)}
        width={920}
        destroyOnHidden
        footer={[
          <Button key="close" onClick={() => setSkillsOpen(false)}>
            关闭
          </Button>,
          <Button
            key="reload-installed"
            loading={skillsStateLoading}
            onClick={() => void reloadSkillsState()}
          >
            刷新已安装
          </Button>
        ]}
      >
        <Tabs
          items={[
            {
              key: 'installed',
              label: '已安装',
              children: (
                <div>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="卸载说明"
                    description="内置（代码）与内置（随应用）不可卸载。市场安装位于 userData/skills/market。兼容目录来自旧版种子或手动放置的技能。"
                  />
                  <Table<SkillUiEntry>
                    size="small"
                    rowKey="key"
                    loading={skillsStateLoading}
                    pagination={false}
                    dataSource={installedSkillRows}
                    locale={{ emptyText: '暂无技能数据，请点击「刷新已安装」' }}
                    scroll={{ x: 820 }}
                    columns={[
                      {
                        title: '类型',
                        dataIndex: 'kind',
                        width: 120,
                        render: (k: SkillUiEntry['kind']) => {
                          const color =
                            k === 'builtin_code'
                              ? 'purple'
                              : k === 'builtin_packaged'
                                ? 'blue'
                                : k === 'market'
                                  ? 'green'
                                  : 'orange'
                          return <Tag color={color}>{skillKindLabel(k)}</Tag>
                        }
                      },
                      { title: '工具名', dataIndex: 'toolName', width: 200, ellipsis: true },
                      { title: '标题', dataIndex: 'title', width: 160, ellipsis: true },
                      {
                        title: '描述',
                        dataIndex: 'description',
                        ellipsis: true,
                        render: (t: string) => (
                          <Tooltip title={t}>
                            <span>{t}</span>
                          </Tooltip>
                        )
                      },
                      {
                        title: '来源',
                        dataIndex: 'sourceLabel',
                        width: 220,
                        ellipsis: true
                      },
                      {
                        title: '操作',
                        key: 'actions',
                        width: 120,
                        render: (_, row) => {
                          if (row.kind === 'builtin_code' || row.kind === 'builtin_packaged') {
                            return (
                              <Tooltip title="内置技能不可卸载">
                                <Button size="small" disabled>
                                  卸载
                                </Button>
                              </Tooltip>
                            )
                          }
                          if (row.kind === 'market') {
                            return (
                              <Button
                                size="small"
                                danger
                                onClick={() => void uninstallSkillRow(row)}
                              >
                                卸载
                              </Button>
                            )
                          }
                          const canLegacy = Boolean(row.legacyFolderRelative)
                          return (
                            <Tooltip
                              title={
                                canLegacy
                                  ? '删除整个兼容技能目录'
                                  : '该条目位于 skills 根目录，无法安全卸载'
                              }
                            >
                              <Button
                                size="small"
                                danger
                                disabled={!canLegacy}
                                onClick={() => void uninstallSkillRow(row)}
                              >
                                卸载
                              </Button>
                            </Tooltip>
                          )
                        }
                      }
                    ]}
                  />
                </div>
              )
            },
            {
              key: 'market',
              label: '技能市场',
              children: (
                <SkillsMarketPanel
                  installedMarketFolderIds={installedMarketFolderIds}
                  installingId={skillsMarketInstallingId}
                  onInstall={installMarketSkill}
                />
              )
            }
          ]}
        />
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
