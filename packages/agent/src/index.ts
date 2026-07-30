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
  type CreateAgentOptions
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

export { shouldLoadSkill, type UserIntent } from './intent-classifier.js'
export { SKILLS_WITH_TAGS, type SkillTagEntry } from './skill-tags.js'

export { getChatModel, resolveChatModel } from './llm.js'

export { agentLog, type AgentLogger } from './logger.js'
