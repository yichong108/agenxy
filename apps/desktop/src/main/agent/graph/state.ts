import type { BaseMessage } from '@langchain/core/messages'
import { Annotation, messagesStateReducer } from '@langchain/langgraph'

import type { NamedTool } from '@/main/agent/agent-tooling'
import type { UserIntent } from '@/main/agent/intent-classifier'
import type { AgentComposerMode, ToolTimelineEvent } from '@/shared/ipc'

/**
 * prepare_tooling 节点写入的工具与 prompt 快照。
 */
export type PreparedTooling = {
  tools: NamedTool[]
  runPrompt: string
}

/**
 * 单次 agent 运行的元数据，供 graph 节点与 IPC 桥接共享。
 */
export type AgenxyRunMeta = {
  sessionId: string
  runId: string
  traceId: string
  threadId: string
  workspaceId: string
  root: string
  userDisplayText: string
  agentUserText: string
  planContext?: string
}

/**
 * execute_react 节点完成后写回 graph 的状态片段。
 */
export type AgenxyReactPhaseResult = {
  messages: BaseMessage[]
  toolEvents: ToolTimelineEvent[]
}

/**
 * init_run 之后、execute_react 执行前的 graph 状态快照。
 */
export type AgenxyGraphState = {
  messages: BaseMessage[]
  composerMode: AgentComposerMode
  runMeta: AgenxyRunMeta
  detectedIntents: UserIntent[]
  toolEvents: ToolTimelineEvent[]
}

/**
 * Agenxy 外层 StateGraph 的状态定义。
 */
export const AgenxyGraphAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => []
  }),
  composerMode: Annotation<AgentComposerMode>({
    reducer: (_, next) => next,
    default: () => 'build' as AgentComposerMode
  }),
  runMeta: Annotation<AgenxyRunMeta>({
    reducer: (_, next) => next,
    default: () => ({
      sessionId: '',
      runId: '',
      traceId: '',
      threadId: '',
      workspaceId: '',
      root: '',
      userDisplayText: '',
      agentUserText: ''
    })
  }),
  detectedIntents: Annotation<UserIntent[]>({
    reducer: (_, next) => next,
    default: () => []
  }),
  tooling: Annotation<PreparedTooling | null>({
    reducer: (_, next) => next,
    default: () => null
  }),
  toolEvents: Annotation<ToolTimelineEvent[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => []
  })
})

export type AgenxyGraphStateType = typeof AgenxyGraphAnnotation.State
