import type { LangGraphRunnableConfig } from '@langchain/langgraph'

import { agentLog } from '@/main/agent/agent-log'
import { buildAgentRunPrompt, prepareAgentTooling } from '@/main/agent/agent-tooling'
import type { AgenxyGraphRunContext } from '@/main/agent/graph/run-context'
import type { AgenxyGraphStateType } from '@/main/agent/graph/state'

/**
 * 按 composer mode 与 detectedIntents 组装工具集与 system prompt。
 *
 * @param state - 含 composerMode、runMeta、detectedIntents
 * @param config - 需含 configurable.runContext
 * @returns tooling 快照（tools + runPrompt）
 */
export async function prepareToolingNode(
  state: AgenxyGraphStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<AgenxyGraphStateType>> {
  const runContext = config.configurable?.runContext as AgenxyGraphRunContext | undefined
  if (!runContext) {
    throw new Error('[prepareToolingNode] missing configurable.runContext')
  }

  const { composerMode, runMeta, detectedIntents } = state
  const { settings, onTool, afterToolEnd } = runContext
  const { sessionId, root, runId, traceId } = runMeta

  const toolingBundle = await prepareAgentTooling(
    composerMode,
    sessionId,
    root,
    settings,
    { runId, traceId, onTool, afterToolEnd },
    composerMode === 'build' ? { filterIntents: detectedIntents } : undefined
  )

  const runPrompt = buildAgentRunPrompt(composerMode, root, settings, toolingBundle)

  agentLog.info(`[prepareToolingNode] mode=${composerMode} tools=${toolingBundle.tools.length}`)

  return {
    tooling: {
      tools: toolingBundle.tools,
      runPrompt
    }
  }
}
