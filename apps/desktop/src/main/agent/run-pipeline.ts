import { agentLog } from '@/main/agent/agent-log'
import { buildAgentRunPrompt, prepareAgentTooling } from '@/main/agent/agent-tooling'
import { AGENXY_USER_DISPLAY_KW } from '@/main/agent/constants'
import { createPlanAfterToolCoordinator } from '@/main/agent/graph/plan-after-tool'
import type { AgenxyGraphRunContext } from '@/main/agent/graph/run-context'
import type { AgenxyGraphStateType, AgenxyRunMeta } from '@/main/agent/graph/state'
import { classifyIntent } from '@/main/agent/intent-classifier'
import {
  type AgentMessage,
  contentToText,
  findLastAiMessage,
  humanMessage
} from '@/main/agent/messages'
import { runReactLoop } from '@/main/agent/react-loop'
import { isAbortError } from '@/main/agent/run-utils'
import { runLangfuseReactObservation } from '@/main/langfuse'
import { extractMemoriesAfterRun } from '@/main/memory/memory-extractor'
import type { AgentComposerMode } from '@/shared/ipc'

export type InitRunCallbacks = {
  persistMessages: (messages: AgentMessage[]) => void
}

export type RunAgenxyPipelineInput = {
  composerMode: AgentComposerMode
  runMeta: AgenxyRunMeta
  messages: AgentMessage[]
  runContext: AgenxyGraphRunContext
  initRunCallbacks: InitRunCallbacks
  signal?: AbortSignal
}

export type RunAgenxyPipelineResult = {
  messages: AgentMessage[]
  toolEvents: AgenxyGraphStateType['toolEvents']
}

/**
 * init_run 阶段：追加用户消息并持久化。
 *
 * @param state - 当前 pipeline 状态
 * @param callbacks - 持久化回调
 * @returns 更新后的 messages
 */
function initRunPhase(
  state: AgenxyGraphStateType,
  callbacks: InitRunCallbacks
): Partial<AgenxyGraphStateType> {
  const { runMeta } = state
  const msg = humanMessage(
    runMeta.agentUserText,
    runMeta.planContext ? runMeta.userDisplayText : undefined
  )
  const messages = [...state.messages, msg]
  callbacks.persistMessages(messages)
  return { messages }
}

/**
 * Build 模式意图分类阶段。
 *
 * @param state - 当前状态
 * @param runContext - 运行上下文
 * @param signal - 取消信号
 * @returns detectedIntents 更新
 */
async function classifyIntentPhase(
  state: AgenxyGraphStateType,
  runContext: AgenxyGraphRunContext,
  signal?: AbortSignal
): Promise<Partial<AgenxyGraphStateType>> {
  const { runMeta } = state
  const { settings, emit } = runContext
  let detectedIntents: AgenxyGraphStateType['detectedIntents'] = []

  try {
    const classification = await classifyIntent(
      runMeta.userDisplayText || runMeta.agentUserText,
      settings,
      signal
    )
    if (classification.intent !== 'general' && classification.confidence > 0.6) {
      detectedIntents = [classification.intent]
    }
    agentLog.info(
      `[classifyIntentPhase] intent=${classification.intent} confidence=${classification.confidence.toFixed(2)}`
    )
  } catch (e) {
    if (isAbortError(e)) throw e
    agentLog.warn('[classifyIntentPhase] failed:', e)
    const message = e instanceof Error ? e.message : String(e)
    emit({
      type: 'intent-classified',
      sessionId: runMeta.sessionId,
      runId: runMeta.runId,
      traceId: runMeta.traceId,
      intent: 'general',
      skillNames: [],
      error: message
    })
  }

  agentLog.info(`[classifyIntentPhase] detectedIntents=${JSON.stringify(detectedIntents)}`)
  return { detectedIntents }
}

/**
 * 初始化 plan-after-tool 协调器。
 *
 * @param state - 当前状态
 * @param runContext - 运行上下文
 * @param signal - 取消信号
 */
function initPlanAfterToolPhase(
  state: AgenxyGraphStateType,
  runContext: AgenxyGraphRunContext,
  signal?: AbortSignal
): void {
  const { runMeta, composerMode } = state
  const coordinator = createPlanAfterToolCoordinator({
    composerMode,
    sessionId: runMeta.sessionId,
    runId: runMeta.runId,
    traceId: runMeta.traceId,
    userText: runMeta.userDisplayText || runMeta.agentUserText,
    settings: runContext.settings,
    signal: signal ?? runContext.signal,
    emit: runContext.emit,
    runToolEvents: runContext.runToolEvents
  })
  runContext.afterToolEnd = coordinator.afterToolEnd
}

/**
 * 组装工具集与 system prompt。
 *
 * @param state - 当前状态
 * @param runContext - 运行上下文
 * @returns tooling 快照
 */
async function prepareToolingPhase(
  state: AgenxyGraphStateType,
  runContext: AgenxyGraphRunContext
): Promise<Partial<AgenxyGraphStateType>> {
  const { composerMode, runMeta, detectedIntents } = state
  const { settings, onTool, afterToolEnd } = runContext
  const { sessionId, root, runId, traceId } = runMeta

  const toolingBundle = await prepareAgentTooling(
    composerMode,
    sessionId,
    root,
    settings,
    { runId, traceId, onTool, afterToolEnd },
    composerMode === 'build' ? { filterIntents: detectedIntents } : undefined
  )

  const runPrompt = buildAgentRunPrompt(composerMode, root, settings, toolingBundle)

  agentLog.info(`[prepareToolingPhase] mode=${composerMode} tools=${toolingBundle.tools.length}`)

  return {
    tooling: {
      tools: toolingBundle.tools,
      runPrompt
    }
  }
}

/**
 * 执行 ReAct 主循环（含 HITL、Langfuse 包裹）。
 *
 * @param state - prepare_tooling 之后的状态
 * @param runContext - 运行上下文
 * @returns messages 与 toolEvents
 */
async function executeReactPhase(
  state: AgenxyGraphStateType,
  runContext: AgenxyGraphRunContext
): Promise<{ messages: AgentMessage[]; toolEvents: AgenxyGraphStateType['toolEvents'] }> {
  const bridge = runContext.reactBridge
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

  const onStreamToken = (token: string) => {
    bridge.streamedCharsRef.current += token.length
    bridge.pushStreamToken(token)
  }

  const runMessages = await runLangfuseReactObservation(
    {
      sessionId,
      tags: ['agenxy', 'pipeline', 'react', composerMode],
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
    async () => {
      return runReactLoop(
        settings,
        runPrompt,
        state.messages,
        tools,
        bridge.abortController,
        onStreamToken,
        {
          recursionLimit: bridge.recursionLimit,
          timeoutMs: bridge.invokeTimeoutMs
        },
        {
          sessionId,
          runId,
          traceId,
          threadId,
          hitlEnabled,
          toolsByName: new Map(),
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

/**
 * 回合结束后提取用户长期记忆。
 *
 * @param state - 含最终 messages
 * @param runContext - 运行上下文
 */
async function extractMemoryPhase(
  state: AgenxyGraphStateType,
  runContext: AgenxyGraphRunContext
): Promise<void> {
  const { settings } = runContext
  if (!settings.memoryEnabled || !settings.autoExtractMemory) return

  const { runMeta, messages } = state
  const lastAi = findLastAiMessage(messages)
  const assistantText = lastAi ? contentToText(lastAi.content) : ''
  const userText = runMeta.userDisplayText || runMeta.agentUserText

  try {
    await extractMemoriesAfterRun({
      sessionId: runMeta.sessionId,
      userText,
      assistantText
    })
  } catch (err) {
    agentLog.warn('[extractMemoryPhase] failed:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * 执行完整 agent 流水线（替代 LangGraph StateGraph）。
 *
 * init_run → classify? → init_plan_after_tool → prepare_tooling → execute_react → extract_memory? → END
 *
 * @param input - 初始状态与 runContext
 * @returns 运行结束后的 messages 与 toolEvents
 */
export async function runAgenxyPipeline(
  input: RunAgenxyPipelineInput
): Promise<RunAgenxyPipelineResult> {
  const state: AgenxyGraphStateType = {
    messages: input.messages,
    composerMode: input.composerMode,
    runMeta: input.runMeta,
    detectedIntents: [],
    tooling: null,
    toolEvents: []
  }

  const { runContext, initRunCallbacks, signal } = input

  Object.assign(state, initRunPhase(state, initRunCallbacks))

  if (state.composerMode === 'build') {
    Object.assign(state, await classifyIntentPhase(state, runContext, signal))
  }

  initPlanAfterToolPhase(state, runContext, signal)

  Object.assign(state, await prepareToolingPhase(state, runContext))

  const reactResult = await executeReactPhase(state, runContext)
  state.messages = reactResult.messages
  state.toolEvents = [...state.toolEvents, ...reactResult.toolEvents]

  if (runContext.settings.memoryEnabled && runContext.settings.autoExtractMemory) {
    await extractMemoryPhase(state, runContext)
  }

  return {
    messages: state.messages,
    toolEvents: state.toolEvents
  }
}

/** @deprecated 使用 runAgenxyPipeline */
export const runAgenxyGraph = runAgenxyPipeline

/** 兼容旧引用 */
export { AGENXY_USER_DISPLAY_KW }
