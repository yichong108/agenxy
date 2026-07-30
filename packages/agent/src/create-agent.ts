/**
 * createAgent 是 agent 的唯一入口工厂。
 * 它负责创建 agent 实例，并提供 send 方法，用于发起一次 agent run。
 */

import {
  type AgentComposerMode,
  type AppSettings,
  type StreamEvent,
  type ToolTimelineEvent
} from '@agenwork/shared'
import type { LanguageModel } from 'ai'

import type { ReactRunBridge } from './graph/react-run-bridge.js'
import type { AgenworkGraphRunContext } from './graph/run-context.js'
import type { AgenworkRunMeta, PreparedTooling } from './graph/state.js'
import { type AgentMessage, contentToText, findLastAiMessage } from './messages.js'
import { runWorkflow, type WorkflowDeps } from './run-workflow.js'

/** 未注入 prepareTooling 时的默认 system prompt */
const DEFAULT_RUN_PROMPT = 'You are a helpful coding assistant.'

/**
 * createAgent 本地运行环境配置。
 */
export type CreateAgentLocalOptions = {
  /** 工作区根目录；send 时若未指定 runMeta.root 则使用此值 */
  cwd?: string
}

/**
 * createAgent 配置项。
 *
 * 最简用法只需 provider 与 local.cwd；其余未传时使用内置默认。
 *
 * @example
 * ```ts
 * const agent = await createAgent({
 *   provider: model,
 *   local: { cwd: process.cwd() }
 * })
 * ```
 */
export type CreateAgentOptions = {
  /** AI SDK LanguageModel；未传则在 send 时从 settings 解析 */
  provider?: LanguageModel
  /** 本地运行环境 */
  local?: CreateAgentLocalOptions
  /** 工具与 prompt 组装；未传则使用空工具 + 默认 prompt */
  prepareTooling?: WorkflowDeps['prepareTooling']
  /** 可观测性包装（如 Langfuse）；未传则直接执行 */
  wrapReactRun?: WorkflowDeps['wrapReactRun']
}

/**
 * 单次 run 的宿主回调：流式输出、timeline 与持久化。
 */
export type AgentRunCallbacks = {
  onTextDelta: (text: string) => void
  onTool: (event: ToolTimelineEvent) => void
  emit: (event: StreamEvent) => void
  persistMessages: (messages: AgentMessage[]) => void
}

/**
 * 单次 agent run 的输入。
 */
export type AgentRunInput = {
  composerMode: AgentComposerMode
  messages: AgentMessage[]
  abortController: AbortController
  settings: AppSettings
  runMeta: AgenworkRunMeta
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
}

/**
 * 默认工具组装：无工具，仅基础 system prompt。
 *
 * Desktop 等宿主应注入完整 prepareTooling（文件系统、MCP、skills 等）。
 *
 * @param _args - 与宿主 prepareTooling 相同的参数（默认实现忽略）
 * @returns 空工具集与默认 prompt
 */
async function defaultPrepareTooling(
  _args: Parameters<NonNullable<CreateAgentOptions['prepareTooling']>>[0]
): Promise<PreparedTooling> {
  return { tools: [], runPrompt: DEFAULT_RUN_PROMPT }
}

/**
 * 创建 agent 实例 — packages/agent 的唯一入口工厂。
 *
 * 最简入参为 provider + local.cwd；prepareTooling / wrapReactRun 等未传时使用默认。
 * 可 `await createAgent(...)`（函数本身同步，await 无害）。
 *
 * 注意：不直接与外部耦合。同会话「运行中不可再发」由宿主按 session 互斥；
 * 不同会话各自独立 send，互不排队。
 *
 * @param options - 创建配置；均可选，空对象即使用全部默认
 * @returns 可 send 的 agent 实例
 */
export function createAgent(options: CreateAgentOptions = {}): Agent {
  const defaultCwd = options.local?.cwd?.trim() || undefined
  const deps: WorkflowDeps = {
    prepareTooling: options.prepareTooling ?? defaultPrepareTooling,
    wrapReactRun: options.wrapReactRun,
    provider: options.provider
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
      callbacks,
      recursionLimit,
      invokeTimeoutMs
    } = input

    const root = input.runMeta.root?.trim() || defaultCwd || process.cwd()
    const runMeta: AgenworkRunMeta = { ...input.runMeta, root }

    const runToolEvents: ToolTimelineEvent[] = []
    const streamedCharsRef = { current: 0 }

    const reactBridge: ReactRunBridge = {
      abortController,
      recursionLimit,
      invokeTimeoutMs,
      streamedCharsRef,
      pushStreamToken: (token) => callbacks.onTextDelta(token)
    }

    const runContext: AgenworkGraphRunContext = {
      settings,
      signal: abortController.signal,
      onTool: (e) => {
        runToolEvents.push(e)
        callbacks.onTool(e)
      },
      emit: callbacks.emit,
      runToolEvents,
      reactBridge,
      provider: options.provider
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
    send
  }
}
