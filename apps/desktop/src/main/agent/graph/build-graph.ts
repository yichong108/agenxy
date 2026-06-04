import { END, START, StateGraph } from '@langchain/langgraph'

import { classifyIntentNode } from '@/main/agent/graph/nodes/classify-intent'
import { executeReactNode } from '@/main/agent/graph/nodes/execute-react'
import { extractMemoryNode } from '@/main/agent/graph/nodes/extract-memory'
import { initPlanAfterToolNode } from '@/main/agent/graph/nodes/init-plan-after-tool'
import { initRunNode } from '@/main/agent/graph/nodes/init-run'
import { prepareToolingNode } from '@/main/agent/graph/nodes/prepare-tooling'
import { routeAfterExecuteReact, routeAfterInit } from '@/main/agent/graph/routing'
import { AgenxyGraphAnnotation } from '@/main/agent/graph/state'

let compiledGraph: ReturnType<typeof buildAgenxyGraph> | null = null

/**
 * 编译 Agenxy 外层 StateGraph。
 *
 * init_run → classify? → init_plan_after_tool → prepare_tooling → execute_react → extract_memory? → END
 *
 * @returns 可 invoke 的 compiled graph
 */
function buildAgenxyGraph() {
  return new StateGraph(AgenxyGraphAnnotation)
    .addNode('init_run', initRunNode)
    .addNode('classify_intent', classifyIntentNode)
    .addNode('init_plan_after_tool', initPlanAfterToolNode)
    .addNode('prepare_tooling', prepareToolingNode)
    .addNode('execute_react', executeReactNode)
    .addNode('extract_memory', extractMemoryNode)
    .addEdge(START, 'init_run')
    .addConditionalEdges('init_run', routeAfterInit, ['classify_intent', 'init_plan_after_tool'])
    .addEdge('classify_intent', 'init_plan_after_tool')
    .addEdge('init_plan_after_tool', 'prepare_tooling')
    .addEdge('prepare_tooling', 'execute_react')
    .addConditionalEdges('execute_react', routeAfterExecuteReact, ['extract_memory', END])
    .addEdge('extract_memory', END)
    .compile()
}

/**
 * 获取单例 compiled graph，避免每次 run 重复 compile。
 *
 * @returns Agenxy 外层 StateGraph 实例
 */
export function getAgenxyGraph() {
  if (!compiledGraph) {
    compiledGraph = buildAgenxyGraph()
  }
  return compiledGraph
}
