/** IPC 与流式事件类型（主进程 / 预加载 / 渲染层共享） */

import type { BaseEvent } from '@ag-ui/client'

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
  /** Windows 自定义标题栏：窗口行为（最小化 / 最大化 / 关闭 / 重载 / 退出） */
  WINDOW_ACTION: 'window:action',
  /**
   * 是否显示并允许原生窗口控制（标题栏系统按钮区）。
   * 渲染层在 antd Modal 等层打开时置为 false（Win：收起 WCO；macOS：隐藏交通灯）；关闭弹窗后 true。
   * 预加载使用 `sendSync`，以便与弹层首帧绘制同步。
   */
  WINDOW_CAPTION_CONTROLS: 'window:caption-controls',
  /** 触发 webContents 编辑命令（撤销、复制等） */
  WEB_EDIT: 'web:edit',
  /** 关于面板：返回版本/构建/引擎等信息（由渲染层展示弹窗） */
  APP_ABOUT: 'app:about',
  /** 列出用户 skills 目录下的可用技能（供输入框 `/` 菜单） */
  SKILLS_LIST: 'skills:list'
} as const

/**
 * 技能列表项 — 渲染层斜杠菜单与主进程扫描结果共用。
 */
export type SkillListItem = {
  /** 规范化技能名（与工具名一致，如 `code_review`） */
  name: string
  /** 技能描述 */
  description: string
  /** 相对 skills 根目录的 SKILL.md 路径 */
  source: string
}

/** 与 IPC.WINDOW_ACTION 对应的动作 */
export type WindowChromeAction = 'minimize' | 'maximize-toggle' | 'close' | 'reload' | 'quit'

/** 与 IPC.WEB_EDIT 对应的编辑命令 */
export type WebEditAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

/** 主进程聚合、渲染层「关于」弹窗展示（对齐 Cursor 类版本/提交/构建/引擎信息） */
export type AboutAppInfo = {
  productName: string
  version: string
  /** 构建时注入的短 SHA，无 .git 或非 CI 检出时可能为空 */
  gitCommit: string
  /** 构建时的 ISO 时间（主进程包编译时刻） */
  buildIso: string
  electron: string
  chrome: string
  node: string
  v8: string
  osLine: string
}

/** 将构建时刻 ISO 字符串格式化为 UTC 日历钟（与 `Date#toISOString` 同一时刻）。 */
export function formatBuildIsoUtcHuman(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const s = d.toISOString()
  return `${s.slice(0, 10)} ${s.slice(11, 19)} UTC`
}

export function formatAboutAppCopyText(info: AboutAppInfo): string {
  const buildLine = (formatBuildIsoUtcHuman(info.buildIso) ?? info.buildIso) || '(未知)'
  return [
    info.productName,
    `版本: ${info.version}`,
    `提交: ${info.gitCommit || '(未知)'}`,
    `构建: ${buildLine}`,
    `Electron: ${info.electron}`,
    `Chromium: ${info.chrome}`,
    `Node.js: ${info.node}`,
    `V8: ${info.v8}`,
    `操作系统: ${info.osLine}`
  ].join('\n')
}

export const EVENTS = {
  AGENT_STREAM: 'agent:stream',
  WORKSPACE_CHANGED: 'workspace:changed',
  WORKSPACES_SYNC: 'workspaces:sync',
  SESSIONS_SYNC: 'sessions:sync',
  SETTINGS_SYNC: 'settings:sync',
  /** 池化预热完成（启动、保存 MCP 或手动触发后） */
  MCP_WARMUP: 'mcp:warmup',
  /** 右侧栏终端命令的实时 stdout/stderr 片段 */
  TERMINAL_OUTPUT: 'terminal:output'
} as const

export type TerminalOutputEvent = {
  workspaceId: string
  chunk: string
  stream: 'stdout' | 'stderr'
}

export type {
  AgentComposerMode,
  AgentSendOptions,
  AgentType,
  AppSettings,
  McpServerEntry,
  ModelProviderId,
  ProviderProfile,
  SettingsFormValues,
  ToolCallEvent,
  ToolErrorEvent,
  ToolTimelineEvent
} from '@openworker/shared'
export {
  applySettingsForm,
  DEFAULT_CURSOR_MODEL,
  defaultProviderProfiles,
  defaultSettings,
  getActiveProviderProfile,
  MAX_AGENT_LOOP_STEPS,
  MAX_MCP_SERVERS,
  MAX_TERMINAL_OUTPUT_CHARS,
  mergeFormIntoProviderProfiles,
  normalizeAgentType,
  normalizeComposerMode,
  normalizeSettings,
  parseMcpServersFromUnknown,
  settingsToFormValues
} from '@openworker/shared'

/**
 * AGENT_STREAM 载荷：AG-UI BaseEvent + sessionId 信封。
 *
 * 中间事件（TEXT_MESSAGE_* / TOOL_CALL_*）不含 threadId，多会话必须带 sessionId。
 */
export type AgentStreamPayload = {
  sessionId: string
  event: BaseEvent
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
  /** 消息组 ID: 用于表示当前轮（组）消息的id，一组消息包含多个消息。对于消息发出方没有这个组的概念，但是接收方需要知道这个组的概念*/
  id: string
  /** 消息角色 */
  role: MessageRole
  /** 消息内容 */
  content: string
  /**
   * 本轮 AG-UI 时间线相关事件快照（TOOL_CALL_* / RUN_ERROR / CUSTOM cursor.thinking）。
   * 仅用于 UI 恢复；展示前由渲染层转为扁平 ToolTimelineEvent，再归并为 Worked 树。
   */
  aguiEvents?: BaseEvent[]
}
