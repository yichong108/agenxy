/**
 * @openworker/uni-agent 公共 API。
 *
 * 宿主 AG-UI 入口仅为 `UniAgent` 类；内部按 agentType 委托后端。
 */

export {
  UniAgent,
  type UniAgentConfig,
  type UniAgentRunDefaults,
  type UniAgentRunInput
} from './uni-agent.js'

/** 宿主工具转发（避免 Desktop 直依 agent / cursor-agent） */
export { type AgentMcp, getChatModel, resolveChatModel } from '@openworker/agent'

export {
  listSkillsFromPaths,
  loadSkillsFromPaths,
  parseSkillFrontmatter,
  sanitizeSkillToolName,
  type LoadedSkillsBundle,
  type SkillListItem
} from '@openworker/agent'

export { ensureWorkspaceExists, resolveSafePath } from '@openworker/agent'

export {
  completeCommandInWorkspace,
  killCommand,
  runCommand,
  type RunCommandHandlers
} from '@openworker/agent'
