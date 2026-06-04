import type { BaseMessage } from '@langchain/core/messages'

import { getAgenxyGraph } from '@/main/agent/graph/build-graph'
import type { InitRunCallbacks } from '@/main/agent/graph/nodes/init-run'
import type { AgenxyGraphRunContext } from '@/main/agent/graph/run-context'
import type { AgenxyGraphStateType, AgenxyRunMeta } from '@/main/agent/graph/state'
import type { AgentComposerMode } from '@/shared/ipc'

export type RunAgenxyGraphInput = {
  composerMode: AgentComposerMode
  runMeta: AgenxyRunMeta
  messages: BaseMessage[]
  runContext: AgenxyGraphRunContext
  initRunCallbacks: InitRunCallbacks
  signal?: AbortSignal
}

export type RunAgenxyGraphResult = {
  messages: BaseMessage[]
  toolEvents: AgenxyGraphStateType['toolEvents']
}

/**
 * 通过外层 StateGraph 执行一次用户消息处理（完整流水线）。
 *
 * @param input - graph 初始状态与 runContext（含 reactBridge）
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
      tooling: null,
      toolEvents: []
    },
    {
      configurable: {
        thread_id: threadId,
        runContext: input.runContext,
        initRunCallbacks: input.initRunCallbacks
      },
      signal: input.signal
    }
  )

  return {
    messages: finalState.messages,
    toolEvents: finalState.toolEvents
  }
}
