/** IPC 与流式事件类型（主进程 / 预加载 / 渲染层共享） */

export const IPC = {
  WORKSPACE_SELECT: 'workspace:select',
  WORKSPACE_GET: 'workspace:get',
  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_ADD: 'workspace:add',
  WORKSPACE_ACTIVATE: 'workspace:activate',
  WORKSPACE_REORDER: 'workspace:reorder',
  WORKSPACE_RENAME: 'workspace:rename',
  WORKSPACE_REMOVE: 'workspace:remove',
  WORKSPACE_FILE_TREE: 'workspace:file-tree',
  WORKSPACE_FILE_CONTENT: 'workspace:file-content',
  TERMINAL_RUN: 'terminal:run',
  TERMINAL_CANCEL: 'terminal:cancel',
  TERMINAL_COMPLETE: 'terminal:complete',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  UI_STATE_GET: 'ui-state:get',
  UI_STATE_SET: 'ui-state:set',
  SESSIONS_LIST: 'sessions:list',
  SESSIONS_LIST_BY_WORKSPACE: 'sessions:list-by-workspace',
  SESSIONS_GET_MESSAGES: 'sessions:get-messages',
  SESSIONS_CREATE: 'sessions:create',
  SESSIONS_RENAME: 'sessions:rename',
  SESSIONS_DELETE: 'sessions:delete',
  AGENT_SEND: 'agent:send',
  AGENT_CANCEL: 'agent:cancel',
  AGENT_STATUS: 'agent:status',
  DEVTOOLS_TOGGLE: 'devtools:toggle',
  EXTERNAL_OPEN: 'external:open',
  /** 探测 stdio MCP 子进程并列出工具（不落盘） */
  MCP_PROBE: 'mcp:probe',
  /** 读取最近一次 MCP 池化预热结果（应用启动或保存 MCP 后） */
  MCP_WARMUP_GET: 'mcp:warmup:get',
  /** 立即重新执行池化预热并复用/更新连接 */
  MCP_WARMUP_RUN: 'mcp:warmup:run',
  /** 聚合当前技能清单（内置 / 市场 / 兼容） */
  SKILLS_STATE: 'skills:state',
  /** 从市场 zip 安装技能包 */
  SKILLS_INSTALL: 'skills:install',
  /** 卸载市场或兼容目录技能包 */
  SKILLS_UNINSTALL: 'skills:uninstall',
  /** Windows 自定义标题栏：窗口行为（最小化 / 最大化 / 关闭 / 重载 / 退出） */
  WINDOW_ACTION: 'window:action',
  /** 触发 webContents 编辑命令（撤销、复制等） */
  WEB_EDIT: 'web:edit',
  /** 关于对话框 */
  APP_ABOUT: 'app:about'
} as const

/** 与 IPC.WINDOW_ACTION 对应的动作 */
export type WindowChromeAction = 'minimize' | 'maximize-toggle' | 'close' | 'reload' | 'quit'

/** 与 IPC.WEB_EDIT 对应的编辑命令 */
export type WebEditAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

export const EVENTS = {
  AGENT_STREAM: 'agent:stream',
  WORKSPACE_CHANGED: 'workspace:changed',
  WORKSPACES_SYNC: 'workspaces:sync',
  SESSIONS_SYNC: 'sessions:sync',
  SETTINGS_SYNC: 'settings:sync',
  /** 池化预热完成（启动、保存 MCP 或手动触发后） */
  MCP_WARMUP: 'mcp:warmup'
} as const

export type ModelProviderId = 'deepseek' | 'ollama'

/**
 * 主输入区发送模式（对齐 Cursor：Ask 只读问答，Build 可写文件、跑终端与技能/MCP）。
 * 渲染层「未勾选 Ask」时按 build 发送。
 */
export type AgentComposerMode = 'build' | 'ask'

export type AgentSendOptions = {
  mode?: AgentComposerMode
}

/** 用户配置的 stdio MCP 服务器（与 Cursor MCP 配置形态相近） */
export type McpServerEntry = {
  id: string
  /** 展示名 */
  name: string
  enabled: boolean
  /** 可执行文件，如 npx、node、uvx */
  command: string
  args: string[]
  /** 子进程工作目录，可选 */
  cwd?: string
  /**
   * 追加环境变量（持久化可为任意 JSON 结构）。
   * 启动子进程时非字符串值会经 JSON.stringify 转为字符串再传入 OS 环境（与 Node spawn 要求一致）。
   */
  env?: Record<string, unknown>
}

/** 与设置持久化、单次导入共用上限 */
export const MAX_MCP_SERVERS = 24

function newMcpEntryId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `mcp-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

function parseMcpEnvFromUnknown(envRaw: unknown): Record<string, unknown> | undefined {
  let v = envRaw
  if (typeof v === 'string' && v.trim()) {
    try {
      v = JSON.parse(v.trim()) as unknown
    } catch {
      return undefined
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const envObj: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === undefined) continue
    envObj[k] = val
  }
  return Object.keys(envObj).length > 0 ? envObj : undefined
}

function parseOneMcpServer(
  o: Record<string, unknown>,
  keyName?: string,
  /** Cursor 风格对象常省略 enabled，默认 true；本应用数组项历史行为为省略则 false */
  defaultEnabledWhenOmitted = false
): McpServerEntry | null {
  const command = typeof o.command === 'string' ? o.command.trim() : ''
  if (!command) return null
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : newMcpEntryId()
  const nameFromField = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : ''
  const name = nameFromField || (keyName?.trim() ? keyName.trim() : id)
  const args = Array.isArray(o.args)
    ? (o.args as unknown[]).filter((a): a is string => typeof a === 'string')
    : []
  const enabled = typeof o.enabled === 'boolean' ? o.enabled : defaultEnabledWhenOmitted
  const env = parseMcpEnvFromUnknown(o.env)
  const cwd = typeof o.cwd === 'string' && o.cwd.trim() ? o.cwd.trim() : undefined
  const entry: McpServerEntry = { id, name, enabled, command, args }
  if (env) entry.env = env
  if (cwd) entry.cwd = cwd
  return entry
}

/**
 * 解析 MCP 配置 JSON，支持：
 * - Cursor 形态：`{ "mcpServers": { "mysql": { "command", "args", "env?", ... } } }`（对象键为展示名）
 * - 数组形态：`McpServerEntry[]`（与本应用列表一致）
 * - `{ "mcpServers": [ ... ] }`
 */
export function parseMcpServersFromUnknown(raw: unknown): McpServerEntry[] {
  const out: McpServerEntry[] = []
  const push = (e: McpServerEntry) => {
    if (out.length >= MAX_MCP_SERVERS) return
    out.push(e)
  }

  if (raw == null) return []

  if (Array.isArray(raw)) {
    for (const x of raw) {
      if (!x || typeof x !== 'object') continue
      const e = parseOneMcpServer(x as Record<string, unknown>, undefined, false)
      if (e) push(e)
    }
    return out
  }

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const root = raw as Record<string, unknown>
    const ms = root.mcpServers
    if (ms === undefined) return []

    if (Array.isArray(ms)) {
      return parseMcpServersFromUnknown(ms)
    }

    if (typeof ms === 'object' && ms !== null && !Array.isArray(ms)) {
      for (const [key, val] of Object.entries(ms as Record<string, unknown>)) {
        if (!val || typeof val !== 'object' || Array.isArray(val)) continue
        const e = parseOneMcpServer(val as Record<string, unknown>, key, true)
        if (e) push(e)
      }
      return out
    }
  }

  return []
}

export type McpProbeToolInfo = {
  name: string
  description?: string
}

export type McpProbeResult = { ok: true; tools: McpProbeToolInfo[] } | { ok: false; error: string }

/** 单台 MCP 池化预热结果（与探测不同：成功时会保留池内连接） */
export type McpWarmupServerOk = { id: string; name: string; ok: true; toolCount: number }
export type McpWarmupServerErr = { id: string; name: string; ok: false; error: string }
export type McpWarmupServerResult = McpWarmupServerOk | McpWarmupServerErr

export type McpWarmupReport = {
  atMs: number
  servers: McpWarmupServerResult[]
}

export type McpWarmupStatus = {
  report: McpWarmupReport | null
  inFlight: boolean
}

/** 单个模型提供方的连接信息（分提供方持久化） */
export type ProviderProfile = {
  baseUrl: string
  model: string
  /** 本地 Ollama 等可为空字符串 */
  apiKey: string
  /**
   * 是否使用 LangGraph 原生工具调用（读写工作区、终端、技能工具）。
   * 多数 Ollama 上的 deepseek-r1 等模型不支持 tools API，需为 false 并走纯对话流式。
   */
  enableTools: boolean
}

export type AppSettings = {
  provider: ModelProviderId
  /** 各提供方独立配置；切换提供方时从对应项回显 */
  providerProfiles: Record<ModelProviderId, ProviderProfile>
  /** ReAct 模型-工具循环最大步数（LangGraph recursionLimit） */
  maxAgentLoopSteps: number
  /** 单次 agent 运行超时（毫秒） */
  agentRunTimeoutMs: number
  /** Tavily 联网搜索 API Key（https://tavily.com），空则禁用检索能力 */
  tavilyApiKey: string
  /** 已保存的 MCP（stdio）服务器列表；启用项会在 Agent 工具流中挂载 */
  mcpServers: McpServerEntry[]
}

/** 市场 catalog 单项（列表来自 ClawHub，安装包 URL 为官方 download 接口） */
export type SkillsMarketCatalogItem = {
  id: string
  name: string
  description: string
  version: string
  packageUrl: string
  sha256?: string
}

export type SkillsMarketCatalog = {
  items: SkillsMarketCatalogItem[]
}

export type SkillInstallKind = 'builtin_code' | 'builtin_packaged' | 'market' | 'legacy'

/** 渲染层「已安装」表格行 */
export type SkillUiEntry = {
  /** 稳定键（表格 rowKey） */
  key: string
  kind: SkillInstallKind
  /** LangChain 工具名（skill_*） */
  toolName: string
  title: string
  description: string
  sourceLabel: string
  /** 市场安装目录名（`skills/market/<id>`） */
  marketFolderId?: string
  /** 兼容技能目录相对 `userData/skills`（不含 market/.cache） */
  legacyFolderRelative?: string
}

export type SkillsRuntimeState = {
  builtinCode: SkillUiEntry[]
  builtinPackaged: SkillUiEntry[]
  installedMarket: SkillUiEntry[]
  legacyUser: SkillUiEntry[]
}

export type SkillsInstallResult = { ok: true } | { ok: false; error: string }

export type SkillsUninstallResult = { ok: true } | { ok: false; error: string }

export type SkillsUninstallPayload =
  | { kind: 'market'; folderId: string }
  | { kind: 'legacy'; legacyFolderRelative: string }

/** 主进程全局 Agent 流并发上限（代码固定，不写入用户设置） */
export const MAX_CONCURRENT_AGENT_STREAMS = 3

/** 流式 IPC 合并间隔（内置，不暴露设置） */
export const STREAM_FLUSH_MS = 32
/** 流式 IPC 合并字符数（内置） */
export const STREAM_FLUSH_CHARS = 320
/** 终端/命令单条输出最大字符（内置） */
export const MAX_TERMINAL_OUTPUT_CHARS = 2_0000

export const defaultProviderProfiles = (): Record<ModelProviderId, ProviderProfile> => ({
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: '',
    enableTools: true
  },
  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3.5:4b',
    apiKey: '',
    enableTools: true
  }
})

export const defaultSettings: AppSettings = {
  provider: 'deepseek',
  providerProfiles: defaultProviderProfiles(),
  maxAgentLoopSteps: 24,
  agentRunTimeoutMs: 120_000,
  tavilyApiKey: '',
  mcpServers: []
}

/** 当前选中提供方的连接配置 */
export function getActiveProviderProfile(s: AppSettings): ProviderProfile {
  return s.providerProfiles[s.provider]
}

/** 设置弹窗表单用的扁平字段（含当前提供方的 baseUrl/model/apiKey） */
export type SettingsFormValues = Pick<
  AppSettings,
  'maxAgentLoopSteps' | 'agentRunTimeoutMs' | 'tavilyApiKey'
> & {
  provider: ModelProviderId
  baseUrl: string
  model: string
  apiKey: string
  /** 当前提供方是否启用工具（DeepSeek 恒为 true，仅 Ollama 可改） */
  enableTools: boolean
}

export function settingsToFormValues(s: AppSettings): SettingsFormValues {
  const p = getActiveProviderProfile(s)
  return {
    provider: s.provider,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: p.apiKey,
    enableTools: s.provider === 'deepseek' ? true : p.enableTools,
    maxAgentLoopSteps: s.maxAgentLoopSteps,
    agentRunTimeoutMs: s.agentRunTimeoutMs,
    tavilyApiKey: s.tavilyApiKey ?? ''
  }
}

/** 将弹窗当前表单写入对应提供方 profile，其余提供方保持 profiles 中已有值 */
export function mergeFormIntoProviderProfiles(
  profiles: Record<ModelProviderId, ProviderProfile>,
  form: SettingsFormValues
): Record<ModelProviderId, ProviderProfile> {
  const next: Record<ModelProviderId, ProviderProfile> = {
    deepseek: { ...profiles.deepseek },
    ollama: { ...profiles.ollama }
  }
  next[form.provider] = {
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    apiKey: form.provider === 'ollama' ? '' : (form.apiKey ?? '').trim(),
    enableTools: form.provider === 'deepseek' ? true : Boolean(form.enableTools)
  }
  return next
}

export function applySettingsForm(
  prev: AppSettings,
  form: SettingsFormValues,
  providerProfiles: Record<ModelProviderId, ProviderProfile>
): AppSettings {
  return {
    ...prev,
    provider: form.provider,
    providerProfiles,
    maxAgentLoopSteps: form.maxAgentLoopSteps,
    agentRunTimeoutMs: form.agentRunTimeoutMs,
    tavilyApiKey: (form.tavilyApiKey ?? '').trim()
  }
}

export type RendererUiState = {
  activeWorkspaceId: string | null
  byWorkspace: Record<string, WorkspaceUiState>
}

export const defaultRendererUiState: RendererUiState = {
  activeWorkspaceId: null,
  byWorkspace: {}
}

export type WorkspaceUiState = {
  activeSessionId: string | null
  inputDraft: string
  /** 仍存在于主进程，但不在左侧会话列表中展示 */
  sidebarHiddenSessionIds?: string[]
}

export const defaultWorkspaceUiState: WorkspaceUiState = {
  activeSessionId: null,
  inputDraft: '',
  sidebarHiddenSessionIds: []
}

/** 固定 ID：用户主目录工作区；顶栏下拉始终含 Home 项（侧栏可无）；侧栏无可见会话时隐藏该项；移除后不会自动再出现，可从顶栏切回以恢复 */
export const HOME_WORKSPACE_ID = 'workspace-home'

export type WorkspaceInfo = {
  id: string
  name: string
  path: string | null
  createdAt: number
  updatedAt: number
  isDefault?: boolean
}

export type WorkspaceFileNode = {
  name: string
  /** 相对工作区根路径（POSIX 斜杠） */
  path: string
  kind: 'directory' | 'file'
  children?: WorkspaceFileNode[]
}

export type WorkspaceFileTreePayload = {
  rootPath: string
  nodes: WorkspaceFileNode[]
}

export type WorkspaceFileContentResult =
  | {
      ok: true
      path: string
      content: string
      truncated: boolean
    }
  | {
      ok: false
      error: string
    }

export type TerminalRunResult = {
  output: string
}

export type TerminalCompleteResult = {
  items: string[]
}

export type WorkspacesPayload = {
  list: WorkspaceInfo[]
  activeWorkspaceId: string | null
}

export type SessionInfo = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

export type MessageRole = 'user' | 'assistant' | 'system'

export type ChatMessage = {
  id: string
  role: MessageRole
  content: string
  /** 附带的工具/时间线（仅用于 UI 恢复，主进程有完整 tool 过程） */
  toolEvents?: ToolTimelineEvent[]
}

type RunRef = {
  traceId?: string
  runId?: string
}

type Timing = {
  timestampMs?: number
  durationMs?: number
}

type RunMeta = RunRef & Timing

export type ToolCallEvent = {
  kind: 'tool'
  id: string
  name: string
  status: 'start' | 'end'
  args?: string
  result?: string
} & RunMeta

export type ToolErrorEvent = {
  kind: 'error'
  message: string
  errorCode?: string
} & RunMeta

export type ToolTimelineEvent = ToolCallEvent | ToolErrorEvent

type StreamBase = {
  sessionId: string
} & RunRef

export type StreamTextDeltaEvent = StreamBase & {
  type: 'text-delta'
  text: string
}

export type StreamToolEvent = StreamBase & {
  type: 'tool'
  event: ToolTimelineEvent
}

export type StreamErrorEvent = StreamBase &
  Timing & {
    type: 'error'
    message: string
    errorCode?: string
  }

export type StreamDoneEvent = StreamBase &
  Timing & {
    type: 'done'
  }

export type StreamQueuedEvent = StreamBase & {
  type: 'queued'
  position: number
}

export type StreamRunStartEvent = StreamBase & {
  type: 'run-start'
  timestampMs?: number
}

/** StreamEvent 根据 Agent 一次 run 生命周期的阶段变化定义。 */
export type StreamEvent =
  | StreamTextDeltaEvent
  | StreamToolEvent
  | StreamErrorEvent
  | StreamDoneEvent
  | StreamQueuedEvent
  | StreamRunStartEvent
