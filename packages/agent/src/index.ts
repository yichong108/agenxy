/**
 * @agenxy/agent 公共 API — 以 createAgent 为入口，辅以工具定义与宿主持久化所需类型。
 */

export {
  createAgent,
  type Agent,
  type AgentRunCallbacks,
  type AgentRunInput,
  type AgentRunResult,
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

export type { HitlUserDecision, PendingToolCall } from './hitl.js'
export { HITL_EXEMPT_TOOL_NAMES } from './hitl.js'

export { shouldLoadSkill, type UserIntent } from './intent-classifier.js'
export { SKILLS_WITH_TAGS, type SkillTagEntry } from './skill-tags.js'

export { getAuxChatModel } from './llm.js'

export { setAgentLogger, type AgentLogger } from './logger.js'
