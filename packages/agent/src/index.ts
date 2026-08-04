/**
 * @luneto/agent 公共 API — 以 createAgent 为入口，辅以工具定义与宿主持久化所需类型。
 *
 * 消息与工具统一使用 AI SDK 的 CoreMessage / Tool / ToolSet。
 * MCP 通过 createAgent({ provider, mcp: { configPath } }) 启用，宿主侧用 agent.mcp（probe/warmup/dispose）；
 * 不在包根导出 MCP 实现细节。
 */

export {
  createAgent,
  type Agent,
  type AgentMcp,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRunTavilyOptions,
  type AgentWaitResult,
  type AgentWaitStatus,
  type CreateAgentLocalOptions,
  type CreateAgentMcpOptions,
  type CreateAgentOptions,
  type CreateAgentSkillsOptions
} from './create-agent.js'

export {
  defineTool,
  filterToolSet,
  mergeToolSets,
  type Tool,
  type ToolObservation,
  type ToolOnTool,
  type ToolSet
} from './define-tool.js'

export {
  type CoreAssistantMessage,
  type CoreMessage,
  type CoreUserMessage,
  assistantMessage,
  contentToText,
  findLastAiMessage,
  findLastAssistantMessage,
  userMessage
} from './messages.js'

export {
  loadSkillsFromPaths,
  parseSkillFrontmatter,
  sanitizeSkillToolName,
  type LoadedSkillsBundle
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
