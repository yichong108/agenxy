/** IPC 与流式事件类型（主进程 / 预加载 / 渲染层共享） */

export const IPC = {
  WORKSPACE_SELECT: 'workspace:select',
  WORKSPACE_GET: 'workspace:get',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SESSIONS_LIST: 'sessions:list',
  SESSIONS_CREATE: 'sessions:create',
  SESSIONS_RENAME: 'sessions:rename',
  SESSIONS_DELETE: 'sessions:delete',
  AGENT_SEND: 'agent:send',
  AGENT_CANCEL: 'agent:cancel',
  AGENT_STATUS: 'agent:status'
} as const

export const EVENTS = {
  AGENT_STREAM: 'agent:stream',
  WORKSPACE_CHANGED: 'workspace:changed',
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
}

export const defaultSettings: AppSettings = {
  provider: 'deepseek',
  apiKey: '',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  maxConcurrentStreams: 2,
  streamFlushMs: 32,
  streamFlushChars: 320,
  maxTerminalOutputChars: 32_000
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

export type ToolTimelineEvent =
  | { kind: 'tool'; id: string; name: string; status: 'start' | 'end'; args?: string; result?: string }
  | { kind: 'error'; message: string }

export type StreamEvent =
  | { type: 'text-delta'; sessionId: string; text: string }
  | { type: 'tool'; sessionId: string; event: ToolTimelineEvent }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'done'; sessionId: string }
  | { type: 'queued'; sessionId: string; position: number }
  | { type: 'run-start'; sessionId: string }
  | { type: 'replace-messages'; sessionId: string; messages: ChatMessage[] }
