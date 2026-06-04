import type { LangGraphRunnableConfig } from '@langchain/langgraph'

import { agentLog } from '@/main/agent/agent-log'
import type { AgenxyGraphRunContext } from '@/main/agent/graph/run-context'
import type { AgenxyGraphStateType } from '@/main/agent/graph/state'
import { contentToText, findLastAiMessage } from '@/main/agent/message-utils'
import { extractMemoriesAfterRun } from '@/main/memory/memory-extractor'

/**
 * 回合结束后提取用户长期记忆（不挂 Langfuse，避免辅助 LLM 噪音）。
 *
 * @param state - 含 runMeta 与最终 messages
 * @param config - 需含 configurable.runContext.settings
 * @returns 空 state 更新
 */
export async function extractMemoryNode(
  state: AgenxyGraphStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<AgenxyGraphStateType>> {
  const runContext = config.configurable?.runContext as AgenxyGraphRunContext | undefined
  if (!runContext) {
    throw new Error('[extractMemoryNode] missing configurable.runContext')
  }

  const { settings } = runContext
  if (!settings.memoryEnabled || !settings.autoExtractMemory) {
    return {}
  }

  const { runMeta, messages } = state
  const lastAi = findLastAiMessage(messages)
  const assistantText = lastAi ? contentToText(lastAi.content) : ''
  const userText = runMeta.userDisplayText || runMeta.agentUserText

  try {
    await extractMemoriesAfterRun({
      sessionId: runMeta.sessionId,
      userText,
      assistantText
    })
  } catch (err) {
    agentLog.warn('[extractMemoryNode] failed:', err instanceof Error ? err.message : String(err))
  }

  return {}
}
