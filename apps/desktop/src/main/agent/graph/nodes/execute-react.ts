import type { LangGraphRunnableConfig } from '@langchain/langgraph'

import { executeReactPhase } from '@/main/agent/graph/run-react-phase'
import type { AgenxyGraphStateType } from '@/main/agent/graph/state'

/**
 * ReAct 执行节点：运行 createReactAgent 子图（含 HITL、Langfuse）。
 *
 * @param state - prepare_tooling 之后的 graph 状态
 * @param config - 需含 configurable.runContext.reactBridge
 * @returns messages 与 toolEvents 更新
 */
export async function executeReactNode(
  state: AgenxyGraphStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<AgenxyGraphStateType>> {
  const result = await executeReactPhase(state, config)
  return {
    messages: result.messages,
    toolEvents: result.toolEvents
  }
}
