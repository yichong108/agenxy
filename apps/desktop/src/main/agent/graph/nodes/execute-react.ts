import type { LangGraphRunnableConfig } from '@langchain/langgraph'

import type { AgenxyGraphStateType, AgenxyReactPhaseResult } from '@/main/agent/graph/state'

export type ExecuteReactPhaseFn = (state: AgenxyGraphStateType) => Promise<AgenxyReactPhaseResult>

/**
 * ReAct 执行节点：委托 configurable.runPhase 完成意图分类、工具准备与 LangGraph ReAct 循环。
 *
 * P1 仍调用 agent-service 内的原有 runPhase 闭包，后续阶段逐步内联为独立节点。
 *
 * @param state - init_run 之后的 graph 状态
 * @param config - 需含 configurable.runPhase
 * @returns messages 与 toolEvents 更新
 */
export async function executeReactNode(
  state: AgenxyGraphStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<AgenxyGraphStateType>> {
  const runPhase = config.configurable?.runPhase as ExecuteReactPhaseFn | undefined
  if (!runPhase) {
    throw new Error('[executeReactNode] missing configurable.runPhase')
  }
  const result = await runPhase(state)
  return {
    messages: result.messages,
    toolEvents: result.toolEvents
  }
}
