import { END, type LangGraphRunnableConfig } from '@langchain/langgraph'

import type { AgenxyGraphRunContext } from '@/main/agent/graph/run-context'
import type { AgenxyGraphStateType } from '@/main/agent/graph/state'

/**
 * init_run 之后按 composer mode 路由：Build 走意图分类，Ask/Plan 直接初始化 plan。
 *
 * @param state - 当前 graph 状态
 * @returns 下一节点名
 */
export function routeAfterInit(
  state: AgenxyGraphStateType
): 'classify_intent' | 'init_plan_after_tool' {
  return state.composerMode === 'build' ? 'classify_intent' : 'init_plan_after_tool'
}

/**
 * execute_react 之后：启用自动记忆提取则进入 extract_memory，否则结束。
 *
 * @param _state - 当前 graph 状态
 * @param config - 需含 configurable.runContext.settings
 * @returns 下一节点名或 END
 */
export function routeAfterExecuteReact(
  _state: AgenxyGraphStateType,
  config: LangGraphRunnableConfig
): 'extract_memory' | typeof END {
  const runContext = config.configurable?.runContext as AgenxyGraphRunContext | undefined
  const settings = runContext?.settings
  if (settings?.memoryEnabled && settings.autoExtractMemory) {
    return 'extract_memory'
  }
  return END
}
