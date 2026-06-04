import type { BaseMessage } from '@langchain/core/messages'

import { getAgenxyGraph } from '@/main/agent/graph/build-graph'
import type { ExecuteReactPhaseFn } from '@/main/agent/graph/nodes/execute-react'
import type { InitRunCallbacks } from '@/main/agent/graph/nodes/init-run'
import type { AgenxyGraphStateType, AgenxyRunMeta } from '@/main/agent/graph/state'
import type { AgentComposerMode } from '@/shared/ipc'

export type RunAgenxyGraphInput = {
  composerMode: AgentComposerMode
  runMeta: AgenxyRunMeta
  messages: BaseMessage[]
  initRunCallbacks: InitRunCallbacks
  runPhase: ExecuteReactPhaseFn
  signal?: AbortSignal
}

export type RunAgenxyGraphResult = {
  messages: BaseMessage[]
  toolEvents: AgenxyGraphStateType['toolEvents']
}

/**
 * 通过外层 StateGraph 执行一次用户消息处理（P1：init_run + execute_react 桥接）。
 *
 * @param input - graph 初始状态与运行时回调
 * @returns 运行结束后的 messages 与 toolEvents
 */
export async function runAgenxyGraph(input: RunAgenxyGraphInput): Promise<RunAgenxyGraphResult> {
  const graph = getAgenxyGraph()
  const threadId = input.runMeta.threadId

  const finalState = await graph.invoke(
    {
      messages: input.messages,
      composerMode: input.composerMode,
      runMeta: input.runMeta,
      detectedIntents: [],
      toolEvents: []
    },
    {
      configurable: {
        thread_id: threadId,
        initRunCallbacks: input.initRunCallbacks,
        runPhase: input.runPhase
      },
      signal: input.signal
    }
  )

  return {
    messages: finalState.messages,
    toolEvents: finalState.toolEvents
  }
}
