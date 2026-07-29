/**
 * createAgent 是 agent 的唯一入口工厂。
 * 它负责创建 agent 实例，并提供 send 方法，用于发起一次 agent run。
 */

import {
  type AgentComposerMode,
  type AppSettings,
  type StreamEvent,
  type ToolTimelineEvent
} from '@agenxy/shared'

import type { ReactRunBridge } from './graph/react-run-bridge.js'
import type { AgenxyGraphRunContext } from './graph/run-context.js'
import type { AgenxyRunMeta } from './graph/state.js'
import {
  TOOL_REJECTED_RESULT,
  cancelAllHitlWaiters,
  formatToolArgs,
  submitHitlDecision,
  type HitlUserDecision,
  type PendingToolCall
} from './hitl.js'
import { setAgentLogger, type AgentLogger } from './logger.js'
import { type AgentMessage, contentToText, findLastAiMessage } from './messages.js'
import { runWorkflow, type WorkflowDeps } from './run-workflow.js'

/**
 * createAgent 配置项：宿主注入工具组装与可观测性等依赖。
 */
export type CreateAgentOptions = {
  prepareTooling: WorkflowDeps['prepareTooling']
  wrapReactRun?: WorkflowDeps['wrapReactRun']
  logger?: AgentLogger
}

/**
 * 单次 run 的宿主回调：流式输出、HITL、timeline 与持久化。
 */
export type AgentRunCallbacks = {
  onTextDelta: (text: string) => void
  onStreamReset: () => void
  onHitlRequired: (
    hitlId: string,
    toolCalls: Array<{ id: string; name: string; args: string }>
  ) => void
  onToolsRejected: (toolCalls: PendingToolCall[]) => void
  onTool: (event: ToolTimelineEvent) => void
  emit: (event: StreamEvent) => void
  persistMessages: (messages: AgentMessage[]) => void
  setPendingHitl?: (hitlId: string, toolCalls: PendingToolCall[]) => void
}

/**
 * 单次 agent run 的输入。
 */
export type AgentRunInput = {
  composerMode: AgentComposerMode
  messages: AgentMessage[]
  abortController: AbortController
  settings: AppSettings
  runMeta: AgenxyRunMeta
  callbacks: AgentRunCallbacks
  recursionLimit: number
  invokeTimeoutMs: number
}

/**
 * 单次 agent run 的结果。
 */
export type AgentRunResult = {
  messages: AgentMessage[]
  toolEvents: ToolTimelineEvent[]
  streamedChars: number
}

/**
 * createAgent 返回的 agent 实例。
 */
export type Agent = {
  /** 发起一次 run；同会话互斥由宿主保证，不同会话可并行 */
  send: (input: AgentRunInput) => Promise<AgentRunResult>
  submitHitlDecision: (hitlId: string, decision: HitlUserDecision) => boolean
  cancelAllHitlWaiters: (reason?: string) => void
}

/**
 * 创建 agent 实例 — packages/agent 的唯一入口工厂。
 *
 * 封装 ReAct 流水线与 HITL，宿主仅注入工具与可观测性依赖。
 *
 * 注意：不直接与外部耦合。同会话「运行中不可再发」由宿主按 session 互斥；
 * 不同会话各自独立 send，互不排队。
 *
 * @param options - 宿主依赖与运行时参数
 * @returns 可 send 的 agent 实例
 */
export function createAgent(options: CreateAgentOptions): Agent {
  const deps: WorkflowDeps = {
    prepareTooling: options.prepareTooling,
    wrapReactRun: options.wrapReactRun
  }

  if (options.logger) {
    setAgentLogger(options.logger)
  }

  /**
   * 发起一次 agent run
   *
   * @param input - 单次 run 的输入
   * @returns 单次 run 的结果
   */
  async function send(input: AgentRunInput): Promise<AgentRunResult> {
    const {
      composerMode,
      messages,
      abortController,
      settings,
      runMeta,
      callbacks,
      recursionLimit,
      invokeTimeoutMs
    } = input

    const runToolEvents: ToolTimelineEvent[] = []
    const streamedCharsRef = { current: 0 }

    const reactBridge: ReactRunBridge = {
      abortController,
      recursionLimit,
      invokeTimeoutMs,
      streamedCharsRef,
      pushStreamToken: (token) => callbacks.onTextDelta(token),
      resetStream: () => {
        streamedCharsRef.current = 0
        callbacks.onStreamReset()
      },
      setPendingHitl: (hitlId, toolCalls) => {
        callbacks.setPendingHitl?.(hitlId, toolCalls)
      },
      emitHitlRequired: (hitlId, toolCalls) => {
        reactBridge.resetStream()
        callbacks.onHitlRequired(
          hitlId,
          toolCalls.map((t) => ({
            id: t.id,
            name: t.name,
            args: formatToolArgs(t.args)
          }))
        )
      },
      emitToolsRejected: (toolCalls) => {
        reactBridge.resetStream()
        const now = Date.now()
        for (const tc of toolCalls) {
          const formattedArgs = formatToolArgs(tc.args)
          callbacks.onTool({
            kind: 'tool',
            id: tc.id,
            name: tc.name,
            status: 'start',
            args: formattedArgs,
            runId: runMeta.runId,
            traceId: runMeta.traceId,
            timestampMs: now
          })
          callbacks.onTool({
            kind: 'tool',
            id: tc.id,
            name: tc.name,
            status: 'end',
            result: TOOL_REJECTED_RESULT,
            runId: runMeta.runId,
            traceId: runMeta.traceId,
            timestampMs: now,
            durationMs: 0
          })
        }
        callbacks.onToolsRejected(toolCalls)
      }
    }

    const runContext: AgenxyGraphRunContext = {
      settings,
      signal: abortController.signal,
      onTool: (e) => {
        runToolEvents.push(e)
        callbacks.onTool(e)
      },
      emit: callbacks.emit,
      runToolEvents,
      reactBridge
    }

    const workflowResult = await runWorkflow(
      {
        composerMode,
        messages,
        runMeta,
        runContext,
        initRunCallbacks: {
          persistMessages: callbacks.persistMessages
        },
        signal: abortController.signal
      },
      deps
    )

    // 如果流式文本为空，则尝试 fallback 到最后一轮 AI 消息。
    // 因为流式文本为空，说明用户没有输入，或者输入了但是没有触发流式输出。
    // 这时候尝试 fallback 到最后一轮 AI 消息，可能能得到一些有价值的内容。
    // 当然，如果流式文本不为空，则不进行 fallback。
    // 这里 fallback 到最后一轮 AI 消息，而不是第一轮 AI 消息，是因为第一轮 AI 消息可能是系统提示词，不是用户输入。
    // 当然，如果最后一轮 AI 消息也没有内容，则不进行 fallback。
    // fallback是为了什么？避免用户输入了但是没有触发流式输出，导致用户没有收到任何内容。
    if (streamedCharsRef.current === 0) {
      const lastAi = findLastAiMessage(workflowResult.messages)
      const fallback = lastAi ? contentToText(lastAi.content) : ''
      if (fallback) {
        callbacks.onTextDelta(fallback)
      }
    }

    return {
      messages: workflowResult.messages,
      toolEvents: workflowResult.toolEvents,
      streamedChars: streamedCharsRef.current
    }
  }

  return {
    send,
    submitHitlDecision,
    cancelAllHitlWaiters
  }
}
