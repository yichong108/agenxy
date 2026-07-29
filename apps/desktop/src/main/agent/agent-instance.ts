/**
 * Desktop agent 实例 — 注入 Electron 侧工具组装与 Langfuse。
 *
 * 模型仍从每次 send 的 settings 解析（不在此固定 provider），
 * 工作区 root 由 session 注入 runMeta。
 */
import { createAgent, type CreateAgentOptions } from '@agenwork/agent'

import { buildAgentRunPrompt, prepareAgentTooling } from '@/main/agent/agent-tooling'
import { runLangfuseReactObservation } from '@/main/langfuse'

const desktopAgentOptions: CreateAgentOptions = {
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
