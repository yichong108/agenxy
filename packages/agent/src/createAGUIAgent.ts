/**
 * OpenWorker AG-UI 适配器：将 createAgent 桥接为 AG-UI AbstractAgent。
 *
 * 导出形态与官方集成一致：继承 `AbstractAgent`，`run(input)` 返回 `Observable<BaseEvent>`，
 * 可直接用于 CopilotKit / HttpAgent 服务端或 `runAgent()` 客户端管线。
 */

import {
  AbstractAgent,
  EventType,
  randomUUID,
  type AgentConfig,
  type BaseEvent,
  type CustomEvent,
  type Message,
  type RunAgentInput,
  type RunAgentParameters,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent
} from '@ag-ui/client'
import type { CoreMessage, CoreToolMessage } from 'ai'
import { Observable, type Subscriber } from 'rxjs'

import {
  createAgent,
  type Agent,
  type AgentMcp,
  type AgentRunInput,
  type CreateAgentOptions
} from './create-agent.js'
import type { ToolObservation } from './define-tool.js'

/**
 * 每轮 createAgent.send 的默认参数（不含流式回调；回调由本适配器映射为 AG-UI 事件）。
 *
 * 注意：经 `runAgent({ forwardedProps })` 传入时，AG-UI 会对 forwardedProps 做
 * `structuredClone`。`provider`（LanguageModel，含 url 等函数）与 `abortController`
 * 不可克隆，OpenWorkerAgent 会在克隆前剥离并在本轮 run 中合并回 send 选项。
 */
export type OpenWorkerAgentRunDefaults = Omit<
  AgentRunInput,
  'onTextDelta' | 'onTextRevoke' | 'onThinking' | 'onTool' | 'onEmit'
>

/**
 * OpenWorkerAgent 配置：AG-UI AgentConfig + createAgent 选项。
 *
 * @example
 * ```ts
 * const agent = new OpenWorkerAgent({
 *   agentId: 'openworker',
 *   description: 'OpenWorker desktop agent',
 *   agent: { provider: model, local: { cwd } },
 *   runDefaults: { composerMode: 'build', workspacePath: cwd }
 * })
 * await agent.runAgent({ runId: 'r1' })
 * ```
 */
export type OpenWorkerAgentConfig = AgentConfig & {
  /** createAgent 配置（provider 必填） */
  agent: CreateAgentOptions
  /**
   * 每轮 send 的默认参数。
   * 优先级：runDefaults < 克隆前剥离的 extras < RunAgentInput.forwardedProps
   */
  runDefaults?: OpenWorkerAgentRunDefaults
}

/**
 * 从 RunAgentInput.forwardedProps 解析可覆盖的 Agent 运行参数。
 *
 * @param forwarded - AG-UI forwardedProps
 * @returns 部分 OpenWorkerAgentRunDefaults
 */
function parseForwardedProps(forwarded: unknown): OpenWorkerAgentRunDefaults {
  if (!forwarded || typeof forwarded !== 'object') return {}
  const src = forwarded as Record<string, unknown>
  const out: OpenWorkerAgentRunDefaults = {}

  if (typeof src.composerMode === 'string') {
    out.composerMode = src.composerMode as OpenWorkerAgentRunDefaults['composerMode']
  }
  if (src.provider != null) {
    out.provider = src.provider as OpenWorkerAgentRunDefaults['provider']
  }
  if (src.abortController instanceof AbortController) {
    out.abortController = src.abortController
  }
  if (typeof src.workspacePath === 'string') {
    out.workspacePath = src.workspacePath
  }
  if (typeof src.terminalKey === 'string') {
    out.terminalKey = src.terminalKey
  }
  if (src.tavily != null && typeof src.tavily === 'object') {
    out.tavily = src.tavily as OpenWorkerAgentRunDefaults['tavily']
  }
  if (typeof src.maxSteps === 'number') {
    out.maxSteps = src.maxSteps
  }
  if (typeof src.invokeTimeoutMs === 'number') {
    out.invokeTimeoutMs = src.invokeTimeoutMs
  }

  return out
}

/**
 * 在 AG-UI structuredClone(forwardedProps) 之前剥离不可克隆字段。
 *
 * AI SDK OpenAI LanguageModel 内含 `url: ({ path }) => \`${baseURL}${path}\``，
 * 直接克隆会报 “could not be cloned”。AbortController 克隆后与原实例断开，
 * 宿主侧 abort() 将失效，故一并保留原引用。
 *
 * @param forwarded - 原始 forwardedProps
 * @returns cloneable（可安全 structuredClone）与 extras（本轮合并回 send）
 */
function detachNonCloneableForwardedProps(forwarded: unknown): {
  cloneable: Record<string, unknown>
  extras: OpenWorkerAgentRunDefaults
} {
  if (!forwarded || typeof forwarded !== 'object') {
    return { cloneable: {}, extras: {} }
  }

  const cloneable = { ...(forwarded as Record<string, unknown>) }
  const extras: OpenWorkerAgentRunDefaults = {}

  if ('provider' in cloneable && cloneable.provider != null) {
    extras.provider = cloneable.provider as OpenWorkerAgentRunDefaults['provider']
    delete cloneable.provider
  }

  if (cloneable.abortController instanceof AbortController) {
    extras.abortController = cloneable.abortController
    delete cloneable.abortController
  } else if ('abortController' in cloneable) {
    delete cloneable.abortController
  }

  return { cloneable, extras }
}

/**
 * 将 AG-UI 消息 content 转为纯文本。
 *
 * @param content - 字符串或多模态片段数组
 * @returns 纯文本
 */
function aguiContentToText(content: Message['content']): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (
        part &&
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part
      ) {
        return typeof part.text === 'string' ? part.text : ''
      }
      return ''
    })
    .join('')
}

/**
 * 将 AI SDK CoreMessage 列表转换为 AG-UI Message 列表。
 *
 * 与 `aguiMessagesToCore` 对称，供宿主组装 `RunAgentInput.messages`。
 * 跳过 system（createAgent 使用独立 system prompt）。
 *
 * @param messages - AI SDK CoreMessage 列表
 * @returns AG-UI Message 列表
 */
export function coreMessagesToAgui(messages: CoreMessage[]): Message[] {
  const result: Message[] = []

  for (const message of messages) {
    if (message.role === 'user') {
      const content =
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
      result.push({
        id: randomUUID(),
        role: 'user',
        content
      })
      continue
    }

    if (message.role === 'assistant') {
      if (typeof message.content === 'string') {
        result.push({
          id: randomUUID(),
          role: 'assistant',
          content: message.content
        })
        continue
      }

      let text = ''
      const toolCalls: NonNullable<Extract<Message, { role: 'assistant' }>['toolCalls']> = []
      for (const part of message.content) {
        if (part.type === 'text') {
          text += part.text
          continue
        }
        if (part.type === 'tool-call') {
          toolCalls.push({
            id: part.toolCallId,
            type: 'function',
            function: {
              name: part.toolName,
              arguments: JSON.stringify(part.args ?? {})
            }
          })
        }
      }
      result.push({
        id: randomUUID(),
        role: 'assistant',
        content: text || undefined,
        ...(toolCalls.length > 0 ? { toolCalls } : {})
      })
      continue
    }

    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue
        const content =
          typeof part.result === 'string' ? part.result : JSON.stringify(part.result ?? '')
        result.push({
          id: randomUUID(),
          role: 'tool',
          toolCallId: part.toolCallId,
          content
        })
      }
    }
  }

  return result
}

/**
 * 将 AG-UI Message 列表转换为 AI SDK CoreMessage 列表。
 *
 * 跳过 system / developer / activity / reasoning（createAgent 使用独立 system prompt）。
 *
 * @param messages - AG-UI 消息
 * @returns CoreMessage 列表
 */
export function aguiMessagesToCore(messages: Message[]): CoreMessage[] {
  const result: CoreMessage[] = []

  for (const message of messages) {
    if (message.role === 'user') {
      result.push({ role: 'user', content: aguiContentToText(message.content) })
      continue
    }

    if (message.role === 'assistant') {
      const toolCalls = message.toolCalls ?? []
      if (toolCalls.length === 0) {
        result.push({ role: 'assistant', content: message.content ?? '' })
        continue
      }

      const parts: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }
      > = []
      if (message.content) {
        parts.push({ type: 'text', text: message.content })
      }
      for (const tc of toolCalls) {
        let args: unknown = {}
        try {
          args = JSON.parse(tc.function.arguments || '{}')
        } catch {
          args = { raw: tc.function.arguments }
        }
        parts.push({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function.name,
          args
        })
      }
      result.push({ role: 'assistant', content: parts })
      continue
    }

    if (message.role === 'tool') {
      const toolMsg: CoreToolMessage = {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.toolCallId,
            toolName: 'unknown',
            result: message.content
          }
        ]
      }
      result.push(toolMsg)
    }
  }

  return result
}

/**
 * 从 AG-UI messages 提取本轮用户文本，并得到 send 前应写入底层 agent 的历史。
 *
 * createAgent.send 会自行追加 userText，因此历史不含最后一条 user。
 *
 * @param messages - AG-UI 消息列表
 * @returns userText 与历史 CoreMessage
 * @throws 无有效用户消息时抛出
 */
export function extractUserTurn(messages: Message[]): {
  userText: string
  history: CoreMessage[]
} {
  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIndex = i
      break
    }
  }
  if (lastUserIndex < 0) {
    throw new Error('RunAgentInput.messages must contain a user message')
  }

  const lastUser = messages[lastUserIndex]!
  const userText = aguiContentToText(lastUser.content).trim()
  if (!userText) {
    throw new Error('Last user message is empty')
  }

  return {
    userText,
    history: aguiMessagesToCore(messages.slice(0, lastUserIndex))
  }
}

/**
 * 将工具观察参数规范为 AG-UI TOOL_CALL_ARGS 的 JSON 字符串。
 *
 * @param args - ToolObservation.args
 * @returns JSON 字符串
 */
function toolArgsToJsonDelta(args: string | undefined): string {
  if (args == null || args === '') return '{}'
  try {
    JSON.parse(args)
    return args
  } catch {
    return JSON.stringify({ summary: args })
  }
}

/**
 * 判断异常是否由 AbortController 取消触发。
 *
 * @param error - 捕获的未知异常
 * @returns 是否为 abort 类错误
 */
function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.toLowerCase().includes('abort'))
  )
}

/**
 * 将捕获的异常映射为 RUN_ERROR 文案。
 *
 * @param error - send 抛出的异常
 * @returns 错误消息
 */
function formatRunError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error != null) return String(error)
  return 'Run failed'
}

/**
 * AG-UI AbstractAgent 实现：内部委托 createAgent。
 *
 * 与官方 `VercelAISDKAgent` / `ClaudeAgentAdapter` 相同契约：
 * - `run(input): Observable<BaseEvent>`
 * - 支持 `runAgent()` / `subscribe()` / `abortRun()` / `clone()`
 */
export class OpenWorkerAgent extends AbstractAgent {
  /** CopilotKit Runtime 可能注入的 per-request headers（本适配器暂不转发至 LLM） */
  public headers?: Record<string, string>

  private readonly config: OpenWorkerAgentConfig
  private readonly inner: Agent
  private readonly runDefaults: OpenWorkerAgentRunDefaults
  private activeAbort: AbortController | null = null
  /**
   * 自 forwardedProps 剥离、供本轮 run 合并的不可克隆字段（provider / abortController）。
   * 由 prepareRunAgentInput 写入，translateRun 结束后清空。
   */
  private pendingForwardedExtras: OpenWorkerAgentRunDefaults = {}

  /**
   * 创建 OpenWorker AG-UI Agent。
   *
   * @param config - AgentConfig + createAgent 选项与 run 默认参数
   */
  constructor(config: OpenWorkerAgentConfig) {
    const { agent: agentOptions, runDefaults, ...rest } = config
    super(rest)
    this.config = config
    this.inner = createAgent(agentOptions)
    this.runDefaults = runDefaults ?? {}
  }

  /**
   * 克隆当前 agent（新 createAgent 实例，复制 AG-UI 消息与 state）。
   *
   * @returns 新的 OpenWorkerAgent
   */
  public clone(): OpenWorkerAgent {
    const cloned = new OpenWorkerAgent({
      ...this.config,
      threadId: this.threadId,
      initialMessages: structuredClone(this.messages),
      initialState: structuredClone(this.state)
    })
    if (this.headers) {
      cloned.headers = { ...this.headers }
    }
    return cloned
  }

  /**
   * 取消当前进行中的 run（中断底层 createAgent.send）。
   */
  public abortRun(): void {
    this.activeAbort?.abort()
    super.abortRun()
  }

  /**
   * MCP 宿主侧能力（probe / warmup / dispose）。
   *
   * 供 Desktop 等宿主管理连接池；勿经此绕过 AG-UI 去调用底层 send。
   */
  public get mcp(): AgentMcp {
    return this.inner.mcp
  }

  /**
   * 释放底层 MCP 连接池（进程退出或宿主销毁时调用）。
   */
  public async dispose(): Promise<void> {
    await this.inner.mcp.dispose()
  }

  /**
   * 组装 RunAgentInput：在 AG-UI structuredClone 之前剥离不可克隆的 forwardedProps。
   *
   * @param parameters - runAgent 入参
   * @returns 可安全克隆的 RunAgentInput
   */
  protected prepareRunAgentInput(parameters?: RunAgentParameters): RunAgentInput {
    const { cloneable, extras } = detachNonCloneableForwardedProps(parameters?.forwardedProps)
    this.pendingForwardedExtras = extras
    return super.prepareRunAgentInput({
      ...parameters,
      forwardedProps: cloneable
    })
  }

  /**
   * 按 AG-UI 协议执行一轮，产出事件 Observable。
   *
   * 典型序列：`RUN_STARTED` → (`CUSTOM(openworker.text.delta|revoke)` | `CUSTOM(cursor.thinking)` | `TOOL_CALL_*`)* → `TEXT_MESSAGE_*` → `RUN_FINISHED` | `RUN_ERROR`
   *
   * @param input - AG-UI RunAgentInput
   * @returns BaseEvent 流
   */
  public run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const fromForwarded = {
        ...this.pendingForwardedExtras,
        ...parseForwardedProps(input.forwardedProps)
      }
      const abortController =
        fromForwarded.abortController ?? this.runDefaults.abortController ?? new AbortController()
      this.activeAbort = abortController

      void this.translateRun(input, abortController, subscriber).finally(() => {
        if (this.activeAbort === abortController) {
          this.activeAbort = null
        }
        this.pendingForwardedExtras = {}
      })

      return () => {
        abortController.abort()
      }
    })
  }

  /**
   * 将 createAgent.send 回调翻译为 AG-UI 事件并推入 subscriber。
   *
   * @param input - AG-UI 入参
   * @param abortController - 本轮取消控制器
   * @param subscriber - RxJS 订阅者
   */
  private async translateRun(
    input: RunAgentInput,
    abortController: AbortController,
    subscriber: Subscriber<BaseEvent>
  ): Promise<void> {
    const threadId = input.threadId || this.threadId || randomUUID()
    const runId = input.runId || randomUUID()

    const emit = (event: BaseEvent) => {
      if (!subscriber.closed) subscriber.next(event)
    }

    const started: RunStartedEvent = {
      type: EventType.RUN_STARTED,
      threadId,
      runId,
      timestamp: Date.now()
    }
    emit(started)

    const messageId = randomUUID()
    let textStarted = false
    let textEnded = false
    /** 本步推测性 Result 缓冲；工具步 revoke 清空，收尾步再一次性写入 TEXT_MESSAGE_* */
    let pendingResultText = ''

    const ensureTextStart = () => {
      if (textStarted) return
      textStarted = true
      const start: TextMessageStartEvent = {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: 'assistant',
        timestamp: Date.now()
      }
      emit(start)
    }

    const ensureTextEnd = () => {
      if (!textStarted || textEnded) return
      textEnded = true
      const end: TextMessageEndEvent = {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
        timestamp: Date.now()
      }
      emit(end)
    }

    /**
     * 将确认后的最终回答写入 AG-UI TEXT_MESSAGE（供 AbstractAgent.apply / 落盘）。
     * 运行中的打字机预览走 CUSTOM，避免工具步过程叙述污染 messages。
     */
    const flushResultText = (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      ensureTextStart()
      const content: TextMessageContentEvent = {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: text,
        timestamp: Date.now()
      }
      emit(content)
    }

    const merged: OpenWorkerAgentRunDefaults = {
      ...this.runDefaults,
      ...this.pendingForwardedExtras,
      ...parseForwardedProps(input.forwardedProps),
      abortController
    }

    try {
      const { userText, history } = extractUserTurn(input.messages ?? [])
      this.inner.messages = history

      const runResult = await this.inner.send(userText, {
        ...merged,
        onTextDelta: (text) => {
          if (!text) return
          pendingResultText += text
          // UI 打字机预览；不写入 TEXT_MESSAGE，以免工具步污染 AG-UI messages
          const preview: CustomEvent = {
            type: EventType.CUSTOM,
            name: 'openworker.text.delta',
            value: { delta: text, messageId },
            timestamp: Date.now()
          }
          emit(preview)
        },
        onTextRevoke: () => {
          pendingResultText = ''
          const revoke: CustomEvent = {
            type: EventType.CUSTOM,
            name: 'openworker.text.revoke',
            value: { messageId },
            timestamp: Date.now()
          }
          emit(revoke)
        },
        onThinking: (text, durationMs) => {
          const trimmed = text.trim()
          if (!trimmed) return
          const custom: CustomEvent = {
            type: EventType.CUSTOM,
            name: 'cursor.thinking',
            value: {
              text: trimmed,
              ...(typeof durationMs === 'number' && Number.isFinite(durationMs)
                ? { thinkingDurationMs: durationMs }
                : {})
            },
            timestamp: Date.now()
          }
          emit(custom)
        },
        onTool: (observation: ToolObservation) => {
          ensureTextStart()
          if (observation.status === 'start') {
            const start: ToolCallStartEvent = {
              type: EventType.TOOL_CALL_START,
              toolCallId: observation.id,
              toolCallName: observation.name,
              parentMessageId: messageId,
              timestamp: observation.timestampMs ?? Date.now()
            }
            emit(start)

            const args: ToolCallArgsEvent = {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: observation.id,
              delta: toolArgsToJsonDelta(observation.args),
              timestamp: observation.timestampMs ?? Date.now()
            }
            emit(args)

            const end: ToolCallEndEvent = {
              type: EventType.TOOL_CALL_END,
              toolCallId: observation.id,
              timestamp: observation.timestampMs ?? Date.now()
            }
            emit(end)
            return
          }

          const result: ToolCallResultEvent = {
            type: EventType.TOOL_CALL_RESULT,
            messageId: randomUUID(),
            toolCallId: observation.id,
            content: observation.result ?? '',
            role: 'tool',
            timestamp: observation.timestampMs ?? Date.now()
          }
          emit(result)
        },
        onEmit: (event) => {
          const custom: CustomEvent = {
            type: EventType.CUSTOM,
            name: 'openworker.stream',
            value: event,
            timestamp: Date.now()
          }
          emit(custom)
        }
      })

      // 确认后的最终回答写入 TEXT_MESSAGE（apply / 落盘）；预览已由 CUSTOM delta 展示
      const finalText =
        typeof runResult.result === 'string' && runResult.result.trim()
          ? runResult.result
          : pendingResultText
      flushResultText(finalText)
      ensureTextEnd()

      const finished: RunFinishedEvent = {
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        result: runResult.result,
        timestamp: Date.now()
      }
      emit(finished)
      if (!subscriber.closed) subscriber.complete()
    } catch (error) {
      ensureTextEnd()

      const cancelled = isAbortError(error) || abortController.signal.aborted
      const runError: RunErrorEvent = {
        type: EventType.RUN_ERROR,
        message: formatRunError(error),
        code: cancelled ? 'CANCELLED' : 'ERROR',
        timestamp: Date.now()
      }
      emit(runError)
      if (!subscriber.closed) subscriber.complete()
    }
  }
}
