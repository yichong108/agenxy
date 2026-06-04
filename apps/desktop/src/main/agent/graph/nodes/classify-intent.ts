import type { LangGraphRunnableConfig } from '@langchain/langgraph'

import { agentLog } from '@/main/agent/agent-log'
import type { AgenxyGraphRunContext } from '@/main/agent/graph/run-context'
import type { AgenxyGraphStateType } from '@/main/agent/graph/state'
import { classifyIntent } from '@/main/agent/intent-classifier'
import { isAbortError } from '@/main/agent/run-utils'

/**
 * Build 模式意图分类节点：过滤 skills 前先识别 coding / general。
 *
 * Ask / Plan 模式不会进入此节点（由 routeAfterInit 跳过）。
 *
 * @param state - 含 runMeta 与 composerMode 的 graph 状态
 * @param config - 需含 configurable.runContext（settings、emit）
 * @returns detectedIntents 更新
 */
export async function classifyIntentNode(
  state: AgenxyGraphStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<AgenxyGraphStateType>> {
  const runContext = config.configurable?.runContext as AgenxyGraphRunContext | undefined
  if (!runContext) {
    throw new Error('[classifyIntentNode] missing configurable.runContext')
  }

  const { runMeta } = state
  const { settings, emit } = runContext
  const signal = config.signal

  let detectedIntents: AgenxyGraphStateType['detectedIntents'] = []

  try {
    const classification = await classifyIntent(
      runMeta.userDisplayText || runMeta.agentUserText,
      settings,
      signal
    )
    if (classification.intent !== 'general' && classification.confidence > 0.6) {
      detectedIntents = [classification.intent]
    }
    agentLog.info(
      `[classifyIntentNode] intent=${classification.intent} confidence=${classification.confidence.toFixed(2)}`
    )
  } catch (e) {
    if (isAbortError(e)) throw e
    agentLog.warn('[classifyIntentNode] failed:', e)
    const message = e instanceof Error ? e.message : String(e)
    emit({
      type: 'intent-classified',
      sessionId: runMeta.sessionId,
      runId: runMeta.runId,
      traceId: runMeta.traceId,
      intent: 'general',
      skillNames: [],
      error: message
    })
  }

  agentLog.info(`[classifyIntentNode] detectedIntents=${JSON.stringify(detectedIntents)}`)
  return { detectedIntents }
}
