/**
 * OpenWork AG-UI 适配器：将 `@openwork/agent` 的 createAgent 桥接为 AG-UI AbstractAgent。
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
import {
  createAgent,
  type Agent,
  type AgentRunInput,
  type AgentWaitResult,
  type CreateAgentOptions,
  type ToolObservation
} from '@openwork/agent'
import type { CoreMessage, CoreToolMessage } from 'ai'
import { Observable, type Subscriber } from 'rxjs'

/**
 * 每轮 createAgent.send 的默认参数（不含流式回调；回调由本适配器映射为 AG-UI 事件）。
 */
export type OpenWorkAgentRunDefaults = Omit<AgentRunInput, 'onTextDelta' | 'onTool' | 'onEmit'>

/**
 * OpenWorkAgent 配置：AG-UI AgentConfig + createAgent 选项。
 *
 * @example
 * ```ts
 * const agent = new OpenWorkAgent({
 *   agentId: 'openwork',
 *   description: 'Openwork desktop agent',
 *   agent: { provider: model, local: { cwd } },
 *   runDefaults: { composerMode: 'build', workspacePath: cwd }
 * })
 * await agent.runAgent({ runId: 'r1' })
 * ```
 */
export type OpenWorkAgentConfig = AgentConfig & {
  /** createAgent 配置（provider 必填） */
  agent: CreateAgentOptions
  /**
   * 每轮 send 的默认参数。
   * 优先级：runDefaults < RunAgentInput.forwardedProps
   */
  runDefaults?: OpenWorkAgentRunDefaults
}

/**
 * 从 RunAgentInput.forwardedProps 解析可覆盖的 Agent 运行参数。
 *
 * @param forwarded - AG-UI forwardedProps
 * @returns 部分 OpenWorkAgentRunDefaults
 */
function parseForwardedProps(forwarded: unknown): OpenWorkAgentRunDefaults {
  if (!forwarded || typeof forwarded !== 'object') return {}
  const src = forwarded as Record<string, unknown>
  const out: OpenWorkAgentRunDefaults = {}

  if (typeof src.composerMode === 'string') {
    out.composerMode = src.composerMode as OpenWorkAgentRunDefaults['composerMode']
  }
  if (src.provider != null) {
    out.provider = src.provider as OpenWorkAgentRunDefaults['provider']
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
    out.tavily = src.tavily as OpenWorkAgentRunDefaults['tavily']
  }
  if (src.skills != null && typeof src.skills === 'object') {
    out.skills = src.skills as OpenWorkAgentRunDefaults['skills']
  }
  if (src.mcp != null && typeof src.mcp === 'object') {
    out.mcp = src.mcp as OpenWorkAgentRunDefaults['mcp']
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
 * 将 wait 终态映射为 RUN_ERROR 文案。
 *
 * @param waitResult - agent.wait 结果
 * @returns 错误消息
 */
function formatWaitError(waitResult: AgentWaitResult): string {
  if (waitResult.error instanceof Error) return waitResult.error.message
  if (waitResult.error != null) return String(waitResult.error)
  if (waitResult.status === 'cancelled') return 'Run cancelled'
  return 'Run failed'
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
 * AG-UI AbstractAgent 实现：内部委托 `@openwork/agent` 的 createAgent。
 *
 * 与官方 `VercelAISDKAgent` / `ClaudeAgentAdapter` 相同契约：
 * - `run(input): Observable<BaseEvent>`
 * - 支持 `runAgent()` / `subscribe()` / `abortRun()` / `clone()`
 */
export class OpenWorkAgent extends AbstractAgent {
  /** CopilotKit Runtime 可能注入的 per-request headers（本适配器暂不转发至 LLM） */
  public headers?: Record<string, string>

  private readonly config: OpenWorkAgentConfig
  private readonly inner: Agent
  private readonly runDefaults: OpenWorkAgentRunDefaults
  private activeAbort: AbortController | null = null

  /**
   * 创建 OpenWork AG-UI Agent。
   *
   * @param config - AgentConfig + createAgent 选项与 run 默认参数
   */
  constructor(config: OpenWorkAgentConfig) {
    const { agent: agentOptions, runDefaults, ...rest } = config
    super(rest)
    this.config = config
    this.inner = createAgent(agentOptions)
    this.runDefaults = runDefaults ?? {}
  }

  /**
   * 克隆当前 agent（新 createAgent 实例，复制 AG-UI 消息与 state）。
   *
   * @returns 新的 OpenWorkAgent
   */
  public clone(): OpenWorkAgent {
    const cloned = new OpenWorkAgent({
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
   * 底层 createAgent 实例（MCP probe/warmup/dispose 等宿主能力）。
   *
   * @returns createAgent 返回值
   */
  public getAgent(): Agent {
    return this.inner
  }

  /**
   * 按 AG-UI 协议执行一轮，产出事件 Observable。
   *
   * 典型序列：`RUN_STARTED` → (`TEXT_MESSAGE_*` | `TOOL_CALL_*`)* → `RUN_FINISHED` | `RUN_ERROR`
   *
   * @param input - AG-UI RunAgentInput
   * @returns BaseEvent 流
   */
  public run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const abortController =
        parseForwardedProps(input.forwardedProps).abortController ??
        this.runDefaults.abortController ??
        new AbortController()
      this.activeAbort = abortController

      void this.translateRun(input, abortController, subscriber).finally(() => {
        if (this.activeAbort === abortController) {
          this.activeAbort = null
        }
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

    const merged: OpenWorkAgentRunDefaults = {
      ...this.runDefaults,
      ...parseForwardedProps(input.forwardedProps),
      abortController
    }

    try {
      const { userText, history } = extractUserTurn(input.messages ?? [])
      this.inner.messages = history

      await this.inner.send(userText, {
        ...merged,
        onTextDelta: (text) => {
          if (!text) return
          ensureTextStart()
          const content: TextMessageContentEvent = {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: text,
            timestamp: Date.now()
          }
          emit(content)
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
            name: 'openwork.stream',
            value: event,
            timestamp: Date.now()
          }
          emit(custom)
        }
      })

      ensureTextEnd()

      const waitResult = await this.inner.wait()
      const finished: RunFinishedEvent = {
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        result: waitResult.result,
        timestamp: Date.now()
      }
      emit(finished)
      if (!subscriber.closed) subscriber.complete()
    } catch (error) {
      ensureTextEnd()

      let waitResult: AgentWaitResult | null = null
      try {
        waitResult = await this.inner.wait()
      } catch {
        waitResult = null
      }

      const waitFailed = waitResult?.status === 'error' || waitResult?.status === 'cancelled'
      const cancelled =
        waitResult?.status === 'cancelled' || isAbortError(error) || abortController.signal.aborted

      const message = waitFailed
        ? formatWaitError(waitResult!)
        : error instanceof Error
          ? error.message
          : String(error)

      const runError: RunErrorEvent = {
        type: EventType.RUN_ERROR,
        message,
        code: cancelled ? 'CANCELLED' : 'ERROR',
        timestamp: Date.now()
      }
      emit(runError)
      if (!subscriber.closed) subscriber.complete()
    }
  }
}
