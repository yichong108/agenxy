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
import { loadSkillsFromPaths } from './skills/load-skills.js'

/** 未注入 prepareTooling 且未配置 skills 时的默认 system prompt */
const DEFAULT_RUN_PROMPT = 'You are a helpful coding assistant.'

/**
 * createAgent 本地运行环境配置。
 */
export type CreateAgentLocalOptions = {
  /** 工作区根目录；send 时若未指定 runMeta.root 则使用此值 */
  cwd?: string
}

/**
 * createAgent Skills 配置：仅声明扫描路径，由 agent 实现基础加载。
 *
 * 意图分类、按标签筛选等增强应由宿主在 prepareTooling 中自行完成。
 */
export type CreateAgentSkillsOptions = {
  /** 技能根目录绝对路径列表；递归扫描 SKILL.md，同名时靠前路径优先 */
  paths: string[]
}

/**
 * createAgent 配置项。
 *
 * 最简用法只需 provider 与 local.cwd；其余未传时使用内置默认。
 * 配置 skills.paths 后，默认 tooling 会加载这些路径下的技能工具。
 *
 * @example
 * ```ts
 * const agent = await createAgent({
 *   provider: model,
 *   local: { cwd: process.cwd() },
 *   skills: { paths: ['/path/to/skills'] }
 * })
 * ```
 */
export type CreateAgentOptions = {
  /** AI SDK LanguageModel；未传则在 send 时从 settings 解析 */
  provider?: LanguageModel
  /** 本地运行环境 */
  local?: CreateAgentLocalOptions
  /**
   * Skills 扫描路径；仅在未注入 prepareTooling 时由默认 tooling 使用。
   * 宿主注入 prepareTooling 时自行决定如何加载 skills。
   */
  skills?: CreateAgentSkillsOptions
  /** 工具与 prompt 组装；未传则按 skills.paths（若有）加载基础技能 */
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
 * 创建默认 tooling：无 prepareTooling 时，按 skills.paths 加载基础技能。
 *
 * @param skillPaths - createAgent 配置的技能路径
 * @returns prepareTooling 实现
 */
function createDefaultPrepareTooling(
  skillPaths: string[]
): NonNullable<CreateAgentOptions['prepareTooling']> {
  return async ({ runCtx }) => {
    if (!skillPaths.length) {
      return { tools: [], runPrompt: DEFAULT_RUN_PROMPT }
    }
    const bundle = await loadSkillsFromPaths(skillPaths, runCtx)
    const runPrompt = [DEFAULT_RUN_PROMPT, bundle.hint].filter(Boolean).join('\n\n')
    return { tools: bundle.tools, runPrompt }
  }
}

/**
 * 创建 agent 实例 — packages/agent 的唯一入口工厂。
 *
 * 最简入参为 provider + local.cwd；prepareTooling / wrapReactRun 等未传时使用默认。
 * 可选 skills.paths 提供基础 Skills；意图筛选等增强由宿主注入 prepareTooling 实现。
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
  const skillPaths = (options.skills?.paths ?? []).map((p) => p.trim()).filter(Boolean)
  const deps: WorkflowDeps = {
    prepareTooling: options.prepareTooling ?? createDefaultPrepareTooling(skillPaths),
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
