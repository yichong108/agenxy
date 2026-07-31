/**
 * @agenwork/agent 公共 API — 以 createAgent 为入口，辅以工具定义与宿主持久化所需类型。
 */

export {
  createAgent,
  type Agent,
  type AgentRunCallbacks,
  type AgentRunInput,
  type AgentRunResult,
  type CreateAgentLocalOptions,
  type CreateAgentOptions,
  type CreateAgentSkillsOptions
} from './create-agent.js'

export { defineTool, type NamedTool, type ToolExecutorContext } from './define-tool.js'

export {
  type AgentMessage,
  type AgentToolCall,
  aiMessage,
  contentToText,
  findLastAiMessage,
  getAgentMessageType,
  getBaseMessageType,
  humanMessage,
  isInternalAgentMessage
} from './messages.js'

export {
  loadSkillsFromPaths,
  parseSkillFrontmatter,
  sanitizeSkillToolName,
  type LoadedSkillsBundle
} from './skills/load-skills.js'

export { getChatModel, resolveChatModel } from './llm.js'

export { agentLog, type AgentLogger } from './logger.js'

/** 工作区工具组装（宿主 prepareTooling 用） */
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
