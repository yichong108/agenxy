import type { LangGraphRunnableConfig } from '@langchain/langgraph'

import { createPlanAfterToolCoordinator } from '@/main/agent/graph/plan-after-tool'
import type { AgenxyGraphRunContext } from '@/main/agent/graph/run-context'
import type { AgenxyGraphStateType } from '@/main/agent/graph/state'

/**
 * 初始化 plan-after-tool 协调器，注入 runContext.afterToolEnd。
 *
 * ReAct 在每次工具结束后 await 该回调，等效于 react 子图 tools → plan → agent 串行边。
 *
 * @param state - 当前 graph 状态
 * @param config - 需含 configurable.runContext
 * @returns 空 state 更新
 */
export async function initPlanAfterToolNode(
  state: AgenxyGraphStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<AgenxyGraphStateType>> {
  const runContext = config.configurable?.runContext as AgenxyGraphRunContext | undefined
  if (!runContext) {
    throw new Error('[initPlanAfterToolNode] missing configurable.runContext')
  }

  const { runMeta, composerMode } = state
  const coordinator = createPlanAfterToolCoordinator({
    composerMode,
    sessionId: runMeta.sessionId,
    runId: runMeta.runId,
    traceId: runMeta.traceId,
    userText: runMeta.userDisplayText || runMeta.agentUserText,
    settings: runContext.settings,
    signal: config.signal ?? runContext.signal,
    emit: runContext.emit,
    runToolEvents: runContext.runToolEvents
  })

  runContext.afterToolEnd = coordinator.afterToolEnd
  return {}
}
