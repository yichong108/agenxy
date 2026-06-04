import type { AgenxyGraphStateType } from '@/main/agent/graph/state'

/**
 * init_run 之后按 composer mode 路由：Build 走意图分类，Ask/Plan 直接准备工具。
 *
 * @param state - 当前 graph 状态
 * @returns 下一节点名
 */
export function routeAfterInit(state: AgenxyGraphStateType): 'classify_intent' | 'prepare_tooling' {
  return state.composerMode === 'build' ? 'classify_intent' : 'prepare_tooling'
}
