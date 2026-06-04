import { HumanMessage } from '@langchain/core/messages'
import type { LangGraphRunnableConfig } from '@langchain/langgraph'

import { AGENXY_USER_DISPLAY_KW } from '@/main/agent/constants'
import type { AgenxyGraphStateType } from '@/main/agent/graph/state'

export type InitRunCallbacks = {
  persistMessages: (messages: AgenxyGraphStateType['messages']) => void
}

/**
 * 图入口节点：追加用户 HumanMessage 并持久化会话。
 *
 * @param state - 当前 graph 状态（含 runMeta）
 * @param config - LangGraph 运行时配置，需含 configurable.initRunCallbacks
 * @returns 更新后的 messages
 */
export async function initRunNode(
  state: AgenxyGraphStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<AgenxyGraphStateType>> {
  const callbacks = config.configurable?.initRunCallbacks as InitRunCallbacks | undefined
  const { runMeta } = state
  const humanMessage = new HumanMessage({
    content: runMeta.agentUserText,
    additional_kwargs: runMeta.planContext
      ? { [AGENXY_USER_DISPLAY_KW]: runMeta.userDisplayText }
      : {}
  })
  const messages = [...state.messages, humanMessage]
  callbacks?.persistMessages(messages)
  return { messages }
}
