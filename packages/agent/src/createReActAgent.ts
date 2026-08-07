/**
 * createReActAgent 是基于 ReAct 循环的 agent 入口工厂。
 * 它负责创建 agent 实例，并提供 send 方法，用于发起一次 agent run。
 */

import { type AgentComposerMode, normalizeComposerMode } from '@openworker/shared'
import type { CoreMessage, LanguageModel, ToolSet } from 'ai'

import type { PreparedTooling } from './run-types.js'
import { mergeToolSets, type ToolObservation, type ToolOnTool } from './define-tool.js'
import { contentToText, findLastAssistantMessage, userMessage } from './messages.js'
import { runReactLoop } from './react-loop.js'
import { buildWorkspaceRunPrompt, buildWorkspaceTools } from './tools/workspace-tools.js'

/**
 * 从 messages 提取最后一条助手文本。
 *
 * @param messages - 本轮结束后的 CoreMessage 列表
 * @returns 助手纯文本；无则空串
 */
function extractAssistantText(messages: CoreMessage[]): string {
  const last = findLastAssistantMessage(messages)
  return last ? contentToText(last.content) : ''
}

/**
 * 按模式组装本轮可用工具与 system prompt 的依赖函数。
 */
type PrepareToolingFn = (args: {
  composerMode: AgentComposerMode
  /** Shell 命令隔离键（宿主提供） */
  terminalKey: string
  root: string
  /** Tavily API Key（可选） */
  tavilyApiKey?: string
  /** 本轮宿主额外工具 */
  tools?: ToolSet
  /** 工具生命周期观察回调 */
  onTool: ToolOnTool
  signal?: AbortSignal
  emit: (event: unknown) => void
  provider?: LanguageModel
}) => Promise<PreparedTooling>

/**
 * createReActAgent 本地运行环境配置。
 */
export type CreateReActAgentLocalOptions = {
  /** 工作区根目录；send 时若未指定 workspacePath 则使用此值 */
  cwd?: string
}

/**
 * 单次 run 的 Tavily 联网搜索配置。
 *
 * 由宿主从应用设置等注入；未传或无有效 key 时，仍可读环境变量 TAVILY_API_KEY。
 */
export type AgentRunTavilyOptions = {
  /** Tavily API Key */
  apiKey?: string
}

/** createReActAgent 未传 local 时的默认值；cwd 缺省时在 send 侧回退 process.cwd() */
const DEFAULT_LOCAL: CreateReActAgentLocalOptions = {}

/**
 * createReActAgent 配置项。
 *
 * provider 必填；messages / local 可选（messages 默认 []，cwd 回退 process.cwd()）。
 * 工具与 prompt 由内置工作区 tooling 组装（不含 skills / MCP）。
 *
 * @example
 * ```ts
 * const agent = createReActAgent({
 *   provider: model,
 *   messages: history,
 *   local: { cwd: process.cwd() }
 * })
 * ```
 */
export type CreateReActAgentOptions = {
  /** AI SDK LanguageModel；创建时必填，send 未传 provider 时作为本轮对话模型 */
  provider: LanguageModel
  /**
   * 会话消息初始值；由 agent 持有。
   * 可选，默认 []。send 会追加本轮用户消息并在结束后写回完整轨迹，以支持连续 send。
   */
  messages?: CoreMessage[]
  /** 本地运行环境；可选，默认 {}，cwd 缺省时回退 process.cwd() */
  local?: CreateReActAgentLocalOptions
}

/**
 * 单次 agent run 的可选参数（send 的第二参）。
 *
 * 调用形态：`send(userText, options?)`。
 * 会话历史由 createReActAgent / agent.messages 持有；send 内部追加 userText 并写回。
 * 回调均为可选，未传时使用空操作。
 * 工具时间线（ToolTimelineEvent）由宿主在 onTool 中自行映射与收集。
 */
export type AgentRunInput = {
  /**
   * 发送模式；可选，默认 build（非法值亦回退 build）。
   */
  composerMode?: AgentComposerMode
  /**
   * 本轮已解析的聊天模型。
   * 可选；未传时回退 createReActAgent 时注入的 provider。
   */
  provider?: LanguageModel
  /**
   * 取消控制器；可选，未传时内部新建 AbortController。
   * 宿主若需外部取消（如 Stop），应自行传入并持有引用。
   */
  abortController?: AbortController
  /**
   * 本轮工作区根目录绝对路径。
   * 优先于 createReActAgent local.cwd；均未提供时回退 process.cwd()。
   */
  workspacePath?: string
  /**
   * Shell 命令隔离键。
   * 由宿主派生（如 `term:${sessionId}`）；缺省为 `term:default`。
   * sessionId / runId / traceId 不进入 agent，由宿主在回调外维护。
   */
  terminalKey?: string
  /**
   * Tavily 联网搜索配置。
   * 由宿主注入；未配置有效 key 且无环境变量时不注册 web_search。
   */
  tavily?: AgentRunTavilyOptions
  /**
   * 本轮宿主额外工具（AI SDK ToolSet）；可选。
   * 与工作区内置工具合并；同名时覆盖工作区工具。
   */
  tools?: ToolSet
  /**
   * 流式文本增量回调；可选。
   * 每步生成时都会增量触发；若本步最终伴有 tool calls，随后会调用 `onTextRevoke` 撤回。
   */
  onTextDelta?: (text: string) => void
  /**
   * 撤回本步已通过 `onTextDelta` 流出的 Result 文本；可选。
   * 在工具步转入 `onThinking` 之前调用，避免过程叙述留在最终回答区。
   */
  onTextRevoke?: () => void
  /**
   * 过程思考回调；可选。
   * ReAct 中间步（本步伴随 tool calls）的叙述文本走此通道，供宿主映射为 Worked → Thought。
   *
   * @param text - 本步完整思考文本
   * @param durationMs - 本步耗时（毫秒）
   */
  onThinking?: (text: string, durationMs?: number) => void
  /** 工具观察回调；可选，宿主可在此映射与收集工具时间线 */
  onTool?: (event: ToolObservation) => void
  /** 向宿主推送自定义事件（可选；桌面侧经 AG-UI CUSTOM 转发） */
  onEmit?: (event: unknown) => void
  /** 最大工具调用轮次；缺省时使用 MAX_AGENT_LOOP_STEPS */
  maxSteps?: number
  /** 循环超时（毫秒）；缺省时使用 defaultSettings.agentRunTimeoutMs */
  invokeTimeoutMs?: number
}

/**
 * 单次 agent run 的结果。
 */
export type AgentRunResult = {
  /** 本轮结束后的完整消息轨迹 */
  messages: CoreMessage[]
  /** 最终助手文本；无助手回复时为空串 */
  result: string
}

/**
 * createReActAgent 返回的 agent 实例。
 */
export type ReActAgent = {
  /**
   * 当前会话消息；创建时来自 CreateReActAgentOptions.messages。
   * send 会追加本轮用户消息，成功后写回含助手回复的完整轨迹，可直接再 send。
   */
  messages: CoreMessage[]
  /**
   * 发起一次 run：`send(userText, options?)`。
   * 内部更新 messages；同会话互斥由宿主保证，不同会话可并行。
   */
  send: (userText: string, input?: AgentRunInput) => Promise<AgentRunResult>
}

/**
 * 创建基于 ReAct 循环的 agent 实例。
 *
 * 必填 provider；messages / local 可选（messages 默认 []，cwd 回退 process.cwd()）。
 * 工具与 prompt 由内置工作区 tooling 组装（不含 skills / MCP）。
 * 可 `await createReActAgent(...)`（函数本身同步，await 无害）。
 *
 * 注意：不直接与外部耦合。同会话「运行中不可再发」由宿主按 session 互斥；
 * 不同会话各自独立 send，互不排队。
 *
 * @param options - 创建配置；provider 必填，messages / local 有默认值
 * @returns 可 send 的 agent 实例
 */
export function createReActAgent(options: CreateReActAgentOptions): ReActAgent {
  const local = options.local ?? DEFAULT_LOCAL
  const defaultCwd = local.cwd?.trim() || process.cwd()
  const defaultProvider = options.provider
  /** 会话消息由 agent 持有；初始值来自 options.messages */
  let messages: CoreMessage[] = [...(options.messages ?? [])]

  /**
   * 组装本轮工具与 system prompt：工作区内置工具 + 本轮可选 tools。
   */
  const prepareTooling: PrepareToolingFn = async ({
    composerMode,
    terminalKey,
    root,
    tavilyApiKey,
    tools: runTools,
    onTool
  }) => {
    const workspaceTools = buildWorkspaceTools({
      terminalKey,
      root,
      tavilyApiKey,
      onTool,
      mode: composerMode
    })

    return {
      tools: mergeToolSets(workspaceTools, runTools ?? {}),
      runPrompt: buildWorkspaceRunPrompt(composerMode, root, tavilyApiKey)
    }
  }

  /**
   * 发起一次 agent run：追加用户消息 → 组装工具与 prompt → ReAct 循环。
   *
   * 调用：`send(userText, options?)`。内部将 userText 追加到 agent.messages，
   * 成功后写回完整轨迹，因此可连续多次 send。
   * 消息持久化仍由宿主负责。失败时已追加的用户消息会保留在 agent.messages
   * （便于重试或展示）。
   *
   * @param userText - 本轮用户文本
   * @param input - 可选 run 参数（回调、模式、超时等）
   * @returns 运行结束后的 messages 与助手文本
   * @throws 消息为空、运行失败或取消时抛出
   */
  async function send(userText: string, input: AgentRunInput = {}): Promise<AgentRunResult> {
    const trimmed = userText.trim()
    if (!trimmed) {
      throw new Error('userText is empty')
    }

    const onTextDelta = input.onTextDelta ?? (() => {})
    const onTextRevoke = input.onTextRevoke ?? (() => {})
    const onThinking = input.onThinking ?? (() => {})
    const onTool = input.onTool ?? (() => {})
    const onEmit = input.onEmit ?? (() => {})
    const { maxSteps, invokeTimeoutMs } = input

    // 追加本轮用户消息并立即写回，保证连续 send / 失败重试时历史连贯
    const inputMessages = [...messages, userMessage(trimmed)]
    messages = inputMessages

    // 发送模式：未传或非法值时默认 build
    const composerMode = normalizeComposerMode(input.composerMode)
    // 本轮模型：send 入参优先，否则使用 createReActAgent 注入的 provider
    const provider = input.provider ?? defaultProvider
    // 取消控制器：未传时内部新建（外部无法 abort，仅满足信号链路）
    const abortController = input.abortController ?? new AbortController()
    // 工作区路径：本轮 send 入参优先，其次 createReActAgent local.cwd（已含默认）
    const root = input.workspacePath?.trim() || defaultCwd
    // Shell 隔离键由宿主提供；agent 不使用 sessionId
    const terminalKey = input.terminalKey?.trim() || 'term:default'
    const tavilyApiKey = input.tavily?.apiKey?.trim() || undefined

    const tooling = await prepareTooling({
      composerMode,
      terminalKey,
      root,
      tavilyApiKey,
      tools: input.tools,
      onTool,
      signal: abortController.signal,
      emit: onEmit,
      provider
    })

    const runMessages = await runReactLoop(
      provider,
      tooling.runPrompt,
      inputMessages,
      tooling.tools,
      abortController,
      onTextDelta,
      maxSteps,
      invokeTimeoutMs,
      onThinking,
      onTextRevoke
    )

    const finalMessages = runMessages.length > 0 ? runMessages : inputMessages
    // 写回完整轨迹，供下一次 send 直接续聊
    messages = finalMessages
    return {
      messages: finalMessages,
      result: extractAssistantText(finalMessages)
    }
  }

  return {
    get messages() {
      return messages
    },
    set messages(next: CoreMessage[]) {
      messages = [...next]
    },
    send
  }
}
