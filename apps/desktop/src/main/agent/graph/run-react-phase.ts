import type { LangGraphRunnableConfig } from '@langchain/langgraph'
import { createReactAgent } from '@langchain/langgraph/prebuilt'

import { agentLog } from '@/main/agent/agent-log'
import { runReactAgentWithGuard } from '@/main/agent/graph/react-agent-runner'
import type { AgenxyGraphRunContext } from '@/main/agent/graph/run-context'
import type { AgenxyGraphStateType, AgenxyReactPhaseResult } from '@/main/agent/graph/state'
import { agentCheckpointer } from '@/main/agent/hitl'
import { createStreamingLanguageModel } from '@/main/agent/llm'
import { contentToText, findLastAiMessage } from '@/main/agent/message-utils'
import { runLangfuseReactObservation } from '@/main/langfuse'

/**
 * 执行 ReAct 子图：createReactAgent + HITL + Langfuse 包裹。
 *
 * @param state - 含 tooling、messages、composerMode、runMeta 的 graph 状态
 * @param config - 需含 configurable.runContext（含 reactBridge）
 * @returns 更新后的 messages 与 toolEvents
 */
export async function executeReactPhase(
  state: AgenxyGraphStateType,
  config: LangGraphRunnableConfig
): Promise<AgenxyReactPhaseResult> {
  const runContext = config.configurable?.runContext as AgenxyGraphRunContext | undefined
  const bridge = runContext?.reactBridge
  if (!runContext || !bridge) {
    throw new Error('[executeReactPhase] missing configurable.runContext.reactBridge')
  }

  const prepared = state.tooling
  if (!prepared) {
    throw new Error('[executeReactPhase] tooling not prepared')
  }

  const { composerMode, runMeta } = state
  const { settings, runToolEvents } = runContext
  const { tools, runPrompt } = prepared
  const { sessionId, runId, traceId, threadId, workspaceId, userDisplayText, agentUserText } =
    runMeta

  agentLog.info(
    `[executeReactPhase] mode=${composerMode} runPrompt: ${JSON.stringify(runPrompt, null, 2)}`
  )

  const hitlEnabled = composerMode === 'build' && settings.toolApprovalInBuild !== false
  const toolsByName = new Map(tools.map((t) => [t.name, t]))
  const model = createStreamingLanguageModel(settings).bindTools(tools as never[])

  const agent = createReactAgent({
    llm: model,
    tools: tools as never[],
    prompt: runPrompt,
    checkpointer: agentCheckpointer,
    ...(hitlEnabled ? { interruptBefore: ['tools'] as const } : {})
  })

  const onStreamToken = (token: string) => {
    bridge.streamedCharsRef.current += token.length
    bridge.pushStreamToken(token)
  }

  const runMessages = await runLangfuseReactObservation(
    {
      sessionId,
      tags: ['agenxy', 'graph', 'react', composerMode],
      traceMetadata: {
        run_id: runId,
        trace_id: traceId,
        workspace_id: workspaceId,
        step: 'react'
      },
      traceId,
      traceName: 'agenxy-graph',
      input: userDisplayText || agentUserText
    },
    async (reactLangfuseHandler) => {
      agentLog.info(
        `[executeReactPhase] react Langfuse: ${reactLangfuseHandler ? '已启用' : '未配置'}`
      )

      return runReactAgentWithGuard(
        agent,
        state.messages,
        bridge.abortController,
        onStreamToken,
        {
          recursionLimit: bridge.recursionLimit,
          timeoutMs: bridge.invokeTimeoutMs,
          langfuseHandler: reactLangfuseHandler
        },
        {
          sessionId,
          runId,
          traceId,
          threadId,
          hitlEnabled,
          toolsByName,
          onPendingHitl: (hitlId, toolCalls) => {
            bridge.setPendingHitl(hitlId, threadId, toolCalls)
          },
          emitHitlRequired: (hitlId, toolCalls) => {
            bridge.resetStream()
            bridge.emitHitlRequired(hitlId, toolCalls)
          },
          onToolsRejected: (toolCalls) => {
            bridge.resetStream()
            bridge.emitToolsRejected(toolCalls)
          }
        }
      )
    },
    {
      formatOutput: (messages) => {
        const lastAi = findLastAiMessage(messages)
        return lastAi ? contentToText(lastAi.content) : ''
      }
    }
  )

  return {
    messages: runMessages.length > 0 ? runMessages : state.messages,
    toolEvents: runToolEvents
  }
}
