/** IPC 与流式事件类型（主进程 / 预加载 / 渲染层共享） */

export const IPC = {
  WORKSPACE_SELECT: 'workspace:select',
  WORKSPACE_GET: 'workspace:get',
  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_ADD: 'workspace:add',
  WORKSPACE_ACTIVATE: 'workspace:activate',
  WORKSPACE_RENAME: 'workspace:rename',
  WORKSPACE_REMOVE: 'workspace:remove',
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
  EXTERNAL_OPEN: 'external:open'
} as const

export const EVENTS = {
  AGENT_STREAM: 'agent:stream',
  WORKSPACE_CHANGED: 'workspace:changed',
  WORKSPACES_SYNC: 'workspaces:sync',
  SESSIONS_SYNC: 'sessions:sync',
  SETTINGS_SYNC: 'settings:sync'
} as const

export type AppSettings = {
  /** 当前仅支持 DeepSeek */
  provider: 'deepseek'
  apiKey: string
  baseUrl: string
  model: string
  /** 最大并行 Agent 流 */
  maxConcurrentStreams: number
  /** 流式 IPC 合并：毫秒 */
  streamFlushMs: number
  /** 流式 IPC 合并：字符数 */
  streamFlushChars: number
  /** 终端/命令输出单条结果最大字符 */
  maxTerminalOutputChars: number
  /** ReAct 模型-工具循环最大步数（LangGraph recursionLimit） */
  maxAgentLoopSteps: number
  /** 单次 agent 运行超时（毫秒） */
  agentRunTimeoutMs: number
}

export const defaultSettings: AppSettings = {
  provider: 'deepseek',
  apiKey: 'sk-0b08965fd66e4fd28ba42a449ea8b6ee',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  maxConcurrentStreams: 2,
  streamFlushMs: 32,
  streamFlushChars: 320,
  maxTerminalOutputChars: 1_000,
  maxAgentLoopSteps: 24,
  agentRunTimeoutMs: 120_000
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
}

export const defaultWorkspaceUiState: WorkspaceUiState = {
  activeSessionId: null,
  inputDraft: ''
}

export type WorkspaceInfo = {
  id: string
  name: string
  path: string | null
  createdAt: number
  updatedAt: number
  isDefault?: boolean
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
