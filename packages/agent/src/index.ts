/**
 * @openworker/agent 公共 API — 宿主入口为 OpenWorkerAgent（AG-UI），勿直接使用 createAgent。
 *
 * createAgent 为包内实现细节，仅由 OpenWorkerAgent 委托；外部应经 AG-UI runAgent / 事件流交互。
 * MCP 宿主能力经 OpenWorkerAgent.mcp（probe / warmup / dispose）。
 */

/** AG-UI AbstractAgent 适配（宿主唯一对话入口） */
export {
  OpenWorkerAgent,
  aguiMessagesToCore,
  coreMessagesToAgui,
  extractUserTurn,
  type OpenWorkerAgentConfig,
  type OpenWorkerAgentRunDefaults
} from './createAGUIAgent.js'

export {
  type AgentMcp,
  type AgentRunResult,
  type AgentRunTavilyOptions,
  type CreateAgentLocalOptions,
  type CreateAgentOptions
} from './create-agent.js'

export {
  defineTool,
  filterToolSet,
  mergeToolSets,
  type ToolObservation,
  type ToolOnTool
} from './define-tool.js'

export {
  assistantMessage,
  contentToText,
  findLastAiMessage,
  findLastAssistantMessage,
  userMessage
} from './messages.js'

export {
  listSkillsFromPaths,
  loadSkillsFromPaths,
  parseSkillFrontmatter,
  sanitizeSkillToolName,
  type LoadedSkillsBundle,
  type SkillListItem
} from './skills/load-skills.js'

export { getChatModel, resolveChatModel } from './llm.js'

export { agentLog, type AgentLogger } from './logger.js'

/** 工作区工具组装 */
export {
  buildWorkspaceRunPrompt,
  buildWorkspaceTools,
  type BuildWorkspaceToolsOptions,
  type WorkspacePromptExtras
} from './tools/workspace-tools.js'

/** 路径安全（宿主 workspace 文件 API 可复用） */
export { ensureWorkspaceExists, resolveSafePath } from './tools/path-guard.js'

/** 终端进程控制（宿主 IPC / 取消 run 用） */
export {
  completeCommandInWorkspace,
  killCommand,
  runCommand,
  type RunCommandHandlers
} from './tools/terminal.js'
