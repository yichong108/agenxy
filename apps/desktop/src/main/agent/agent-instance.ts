/**
 * Desktop agent 实例 — 注入 Electron 侧工具组装与 Langfuse。
 */
import { createAgent, type CreateAgentOptions } from '@agenxy/agent'

import { agentLog } from '@/main/agent/agent-log'
import { buildAgentRunPrompt, prepareAgentTooling } from '@/main/agent/agent-tooling'
import { runLangfuseReactObservation } from '@/main/langfuse'

const desktopAgentOptions: CreateAgentOptions = {
  logger: agentLog,
  prepareTooling: async ({ composerMode, sessionId, root, settings, runCtx, filterIntents }) => {
    const bundle = await prepareAgentTooling(
      composerMode,
      sessionId,
      root,
      settings,
      runCtx,
      filterIntents !== undefined ? { filterIntents } : undefined
    )
    return {
      tools: bundle.tools,
      runPrompt: buildAgentRunPrompt(composerMode, root, settings, bundle)
    }
  },
  wrapReactRun: runLangfuseReactObservation as CreateAgentOptions['wrapReactRun']
}

/**
 * Desktop 宿主环境中的 agent 单例。
 */
export const desktopAgent = createAgent(desktopAgentOptions)
