import {
  type AgentComposerMode,
  type AppSettings,
  type StreamEvent,
  type ToolTimelineEvent
} from '@agenxy/shared'

import { StreamBatcher } from './batcher.js'
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
import { ConcurrencyQueue } from './queue.js'
import { runWorkflow, type WorkflowDeps } from './run-workflow.js'

/**
 * createAgent 配置项：宿主注入工具组装与可观测性等依赖。
 */
export type CreateAgentOptions = {
  prepareTooling: WorkflowDeps['prepareTooling']
  wrapReactRun?: WorkflowDeps['wrapReactRun']
  logger?: AgentLogger
  /** 并发 run 上限，超出则排队；默认 3 */
  maxConcurrentRuns?: number
  /** 流式文本合并间隔（毫秒）；默认 32 */
  streamFlushMs?: number
  /** 流式文本合并字符数；默认 320 */
  streamFlushChars?: number
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
  setPendingHitl?: (hitlId: string, threadId: string, toolCalls: PendingToolCall[]) => void
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
  /** 直接执行一次 run（不经过并发队列） */
  run: (input: AgentRunInput) => Promise<AgentRunResult>
  /** 经并发队列执行 run；buildInput 在进入队列后调用；onQueued 在排队时收到等待位置，进入执行后收到 0 */
  runQueued: (
    buildInput: () => AgentRunInput | Promise<AgentRunInput>,
    onQueued: (position: number) => void
  ) => Promise<AgentRunResult>
  submitHitlDecision: (hitlId: string, decision: HitlUserDecision) => boolean
  cancelAllHitlWaiters: (reason?: string) => void
  queueWillBlock: () => boolean
  queueWaiting: () => number
}

/**
 * 创建 agent 实例 — packages/agent 的唯一入口工厂。
 *
 * 封装 ReAct 流水线、流式合并、HITL 与并发队列，宿主仅注入工具与可观测性依赖。
 * 
 * 注意：不直接与外部耦合。
 *
 * @param options - 宿主依赖与运行时参数
 * @returns 可 run / runQueued 的 agent 实例
 */
export function createAgent(options: CreateAgentOptions): Agent {
  const deps: WorkflowDeps = {
    prepareTooling: options.prepareTooling,
    wrapReactRun: options.wrapReactRun
  }

  if (options.logger) {
    setAgentLogger(options.logger)
  }

  const maxConcurrent = Math.max(1, options.maxConcurrentRuns ?? 3)
  const queue = new ConcurrencyQueue(maxConcurrent)
  const streamFlushMs = options.streamFlushMs ?? 32
  const streamFlushChars = options.streamFlushChars ?? 320

  /**
   * 直接执行一次 run（不经过并发队列）
   * @param input - 单次 run 的输入
   * @returns 单次 run 的结果
   */
  async function runInternal(input: AgentRunInput): Promise<AgentRunResult> {
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

    const batcher = new StreamBatcher(streamFlushMs, streamFlushChars, (t) => {
      callbacks.onTextDelta(t)
    })

    const reactBridge: ReactRunBridge = {
      abortController,
      recursionLimit,
      invokeTimeoutMs,
      streamedCharsRef,
      pushStreamToken: (token) => batcher.push(token),
      resetStream: () => {
        streamedCharsRef.current = 0
        callbacks.onStreamReset()
      },
      setPendingHitl: (hitlId, threadId, toolCalls) => {
        callbacks.setPendingHitl?.(hitlId, threadId, toolCalls)
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

    try {
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
          batcher.push(fallback)
        }
      }

      return {
        messages: workflowResult.messages,
        toolEvents: workflowResult.toolEvents,
        streamedChars: streamedCharsRef.current
      }
    } finally {
      batcher.flush()
    }
  }

  return {
    run: runInternal,
    runQueued: async (buildInput, onQueued) => {
      if (queue.willBlock()) {
        onQueued(queue.waiting + 1)
      }
      return queue.run(async () => {
        onQueued(0)
        const input = await buildInput()
        return runInternal(input)
      })
    },
    submitHitlDecision,
    cancelAllHitlWaiters,
    queueWillBlock: () => queue.willBlock(),
    queueWaiting: () => queue.waiting
  }
}
