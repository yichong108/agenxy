/**
 * Desktop agent 实例 — 注入 Electron 侧工具组装与 Langfuse。
 *
 * 模型仍从每次 send 的 settings 解析（不在此固定 provider），
 * 工作区 root 由 session 注入 runMeta。
 * MCP 通过 mcp.configPath 交给 @agenwork/agent 内部实现。
 *
 * 意图分类与 skills 筛选是 Desktop 可选增强，在 prepareTooling 内完成，
 * 不进入 @agenwork/agent 核心。
 */
import { createAgent, type CreateAgentOptions } from '@agenwork/agent'

import { buildAgentRunPrompt, prepareAgentTooling } from '@/main/agent/agent-tooling'
import { resolveFilterIntents } from '@/main/agent/intent/classify-intent'
import type { UserIntent } from '@/main/agent/intent/skill-tags'
import { runLangfuseReactObservation } from '@/main/langfuse'
import { mainLog } from '@/main/logger'
import { getMcpConfigPath } from '@/main/store'

const desktopAgentOptions: CreateAgentOptions = {
  mcp: { configPath: getMcpConfigPath() },
  prepareTooling: async ({
    composerMode,
    sessionId,
    root,
    settings,
    runCtx,
    userText,
    signal,
    emit,
    provider
  }) => {
    let filterIntents: UserIntent[] | undefined

    if (composerMode === 'build') {
      try {
        filterIntents = await resolveFilterIntents(userText, settings, signal, provider)
        mainLog.info(`[desktop prepareTooling] filterIntents=${JSON.stringify(filterIntents)}`)
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') throw e
        const message = e instanceof Error ? e.message : String(e)
        emit({
          type: 'intent-classified',
          sessionId,
          runId: runCtx.runId,
          traceId: runCtx.traceId,
          intent: 'general',
          skillNames: [],
          error: message
        })
        filterIntents = []
      }
    }

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
