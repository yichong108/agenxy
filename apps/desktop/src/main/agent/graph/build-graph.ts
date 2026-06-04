import { END, START, StateGraph } from '@langchain/langgraph'

import { executeReactNode } from '@/main/agent/graph/nodes/execute-react'
import { initRunNode } from '@/main/agent/graph/nodes/init-run'
import { AgenxyGraphAnnotation } from '@/main/agent/graph/state'

let compiledGraph: ReturnType<typeof buildAgenxyGraph> | null = null

/**
 * 编译 Agenxy 外层 StateGraph（init_run → execute_react → END）。
 *
 * @returns 可 invoke 的 compiled graph
 */
function buildAgenxyGraph() {
  return new StateGraph(AgenxyGraphAnnotation)
    .addNode('init_run', initRunNode)
    .addNode('execute_react', executeReactNode)
    .addEdge(START, 'init_run')
    .addEdge('init_run', 'execute_react')
    .addEdge('execute_react', END)
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
