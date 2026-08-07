/**
 * Cursor SDK 的 AG-UI AbstractAgent 适配器。
 *
 * 导出形态与 OpenWorkerAgent 对齐：继承 `AbstractAgent`，`run(input)` 返回
 * `Observable<BaseEvent>`，可经 `runAgent()` / `subscribe()` / `abortRun()` 接入 Desktop。
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
import {
  Agent,
  CursorAgentError,
  CursorSdkError,
  type Run,
  type SDKAgent,
  type SDKMessage
} from '@cursor/sdk'
import type { AgentComposerMode, McpServerEntry } from '@openworker/shared'
import { Observable, type Subscriber } from 'rxjs'

/** Cursor 侧 MCP 宿主能力形状（与 OpenWorker AgentMcp 对齐；v1 为空实现） */
export type CursorAgentMcp = {
  probe: (entry: McpServerEntry) => Promise<{ ok: boolean; error?: string }>
  warmup: (configPath?: string) => Promise<unknown[]>
  dispose: () => Promise<void>
}

/**
 * 每轮 Cursor send 的默认参数（不含流式回调；回调由本适配器映射为 AG-UI 事件）。
 *
 * 经 `runAgent({ forwardedProps })` 传入时，AG-UI 会对 forwardedProps 做
 * `structuredClone`。`abortController` 不可克隆，CursorAgent 会在克隆前剥离并合并。
 */
export type CursorAgentRunDefaults = {
  composerMode?: AgentComposerMode
  workspacePath?: string
  abortController?: AbortController
}

/**
 * CursorAgent 配置：AG-UI AgentConfig + Cursor SDK 选项。
 */
export type CursorAgentConfig = AgentConfig & {
  agent: {
    apiKey: string
    /** 模型 ID，默认 composer-2.5 */
    model?: string
    local?: { cwd?: string }
  }
  /**
   * 每轮 send 的默认参数。
   * 优先级：runDefaults < 克隆前剥离的 extras < RunAgentInput.forwardedProps
   */
  runDefaults?: CursorAgentRunDefaults
}

/**
 * 从 RunAgentInput.forwardedProps 解析可覆盖的 Cursor 运行参数。
 *
 * @param forwarded - AG-UI forwardedProps
 * @returns 部分 CursorAgentRunDefaults
 */
function parseForwardedProps(forwarded: unknown): CursorAgentRunDefaults {
  if (!forwarded || typeof forwarded !== 'object') return {}
  const src = forwarded as Record<string, unknown>
  const out: CursorAgentRunDefaults = {}

  if (typeof src.composerMode === 'string') {
    out.composerMode = src.composerMode as AgentComposerMode
  }
  if (src.abortController instanceof AbortController) {
    out.abortController = src.abortController
  }
  if (typeof src.workspacePath === 'string') {
    out.workspacePath = src.workspacePath
  }

  return out
}

/**
 * 在 AG-UI structuredClone(forwardedProps) 之前剥离不可克隆字段。
 *
 * @param forwarded - 原始 forwardedProps
 * @returns cloneable 与 extras
 */
function detachNonCloneableForwardedProps(forwarded: unknown): {
  cloneable: Record<string, unknown>
  extras: CursorAgentRunDefaults
} {
  if (!forwarded || typeof forwarded !== 'object') {
    return { cloneable: {}, extras: {} }
  }

  const cloneable = { ...(forwarded as Record<string, unknown>) }
  const extras: CursorAgentRunDefaults = {}

  // provider 对 Cursor 无意义，避免 structuredClone 失败
  if ('provider' in cloneable) {
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
 * 从 AG-UI messages 提取本轮用户文本。
 *
 * Cursor SDK agent 自行维护会话上下文，故不回放历史 CoreMessage。
 *
 * @param messages - AG-UI 消息列表
 * @returns 用户文本
 * @throws 无有效用户消息时抛出
 */
function extractUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const text = aguiContentToText(message.content).trim()
    if (!text) throw new Error('Last user message is empty')
    return text
  }
  throw new Error('RunAgentInput.messages must contain a user message')
}

/**
 * 将工具参数规范为 AG-UI TOOL_CALL_ARGS 的 JSON 字符串。
 *
 * @param args - 工具入参
 * @returns JSON 字符串
 */
function toolArgsToJsonDelta(args: unknown): string {
  if (args == null) return '{}'
  if (typeof args === 'string') {
    if (!args) return '{}'
    try {
      JSON.parse(args)
      return args
    } catch {
      return JSON.stringify({ summary: args })
    }
  }
  try {
    return JSON.stringify(args)
  } catch {
    return JSON.stringify({ summary: String(args) })
  }
}

/**
 * 将工具结果规范为字符串。
 *
 * @param result - 工具结果
 * @returns 字符串内容
 */
function toolResultToContent(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
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
 * 展开 Error.cause 链，便于定位 Connect/HTTP2 底层失败。
 *
 * @param error - 捕获的异常
 * @returns 由外到内的消息列表
 */
function collectErrorMessages(error: unknown): string[] {
  const out: string[] = []
  let current: unknown = error
  const seen = new Set<unknown>()
  while (current != null && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error) {
      if (current.message.trim()) out.push(current.message.trim())
      current = current.cause
      continue
    }
    out.push(String(current))
    break
  }
  return out
}

/**
 * 将捕获的异常映射为 RUN_ERROR 文案（含 Cursor SDK 元数据与 cause）。
 *
 * @param error - send 抛出的异常
 * @returns 错误消息
 */
function formatRunError(error: unknown): string {
  const parts: string[] = []

  if (error instanceof CursorSdkError || error instanceof CursorAgentError) {
    if (error.message.trim()) parts.push(error.message.trim())
    if (error.code) parts.push(`code=${error.code}`)
    if (error.status != null) parts.push(`status=${error.status}`)
    if (error.endpoint) parts.push(`endpoint=${error.endpoint}`)
    if (error.operation) parts.push(`operation=${error.operation}`)
    if (error.requestId) parts.push(`requestId=${error.requestId}`)
  } else if (error instanceof Error) {
    if (error.message.trim()) parts.push(error.message.trim())
  } else if (error != null) {
    parts.push(String(error))
  }

  const chain = collectErrorMessages(error)
  for (const msg of chain) {
    if (!parts.some((p) => p.includes(msg))) parts.push(msg)
  }

  let text = parts.filter(Boolean).join(' | ') || 'Run failed'

  // Cursor SDK 经 Electron/代理访问托管 API 失败时常见此文案
  if (/network request failed/i.test(text)) {
    text +=
      '（Cursor SDK 无法连接 Cursor 云端 API。请确认：1) API Key 有效；2) 本机可访问 api.cursor.com / *.cursor.sh；3) 代理/VPN/防火墙未阻断 HTTP/2；4) 保存设置后重启应用再试）'
  }

  return text
}

/**
 * ask 模式提示前缀：约束模型勿改动工作区。
 */
const ASK_MODE_PREFIX =
  '[Read-only mode] Do not modify files, delete paths, or run shell commands that change system state. Answer with explanations and read-only inspection only.\n\n'

/** v1 空 MCP 实现，保持与 OpenWorkerAgent.mcp 调用面兼容 */
const EMPTY_MCP: CursorAgentMcp = {
  async probe() {
    return { ok: false, error: 'CursorAgent does not manage OpenWorker MCP servers' }
  },
  async warmup() {
    return []
  },
  async dispose() {
    /* no-op */
  }
}

/**
 * AG-UI AbstractAgent 实现：内部委托 Cursor SDK local Agent。
 *
 * 与 OpenWorkerAgent 相同契约：
 * - `run(input): Observable<BaseEvent>`
 * - 支持 `runAgent()` / `subscribe()` / `abortRun()` / `clone()` / `dispose()`
 */
export class CursorAgent extends AbstractAgent {
  /** CopilotKit Runtime 可能注入的 per-request headers（本适配器暂不转发） */
  public headers?: Record<string, string>

  private readonly config: CursorAgentConfig
  private readonly runDefaults: CursorAgentRunDefaults
  private sdkAgent: SDKAgent | null = null
  private sdkAgentPromise: Promise<SDKAgent> | null = null
  private activeAbort: AbortController | null = null
  private activeRun: Run | null = null
  /**
   * 自 forwardedProps 剥离、供本轮 run 合并的不可克隆字段。
   * 由 prepareRunAgentInput 写入，translateRun 结束后清空。
   */
  private pendingForwardedExtras: CursorAgentRunDefaults = {}

  /**
   * 创建 Cursor AG-UI Agent。
   *
   * @param config - AgentConfig + Cursor SDK 选项与 run 默认参数
   */
  constructor(config: CursorAgentConfig) {
    const { agent: _agentOptions, runDefaults, ...rest } = config
    super(rest)
    this.config = config
    this.runDefaults = runDefaults ?? {}
  }

  /**
   * 克隆当前 agent（新 Cursor SDK 实例，复制 AG-UI 消息与 state）。
   *
   * @returns 新的 CursorAgent
   */
  public clone(): CursorAgent {
    const cloned = new CursorAgent({
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
   * 取消当前进行中的 run（中断底层 Cursor SDK run）。
   */
  public abortRun(): void {
    this.activeAbort?.abort()
    const run = this.activeRun
    if (run?.supports('cancel')) {
      void run.cancel().catch(() => {
        /* ignore cancel race */
      })
    }
    super.abortRun()
  }

  /**
   * MCP 宿主侧能力（v1 为空实现，保持接口与 OpenWorkerAgent 对齐）。
   */
  public get mcp(): CursorAgentMcp {
    return EMPTY_MCP
  }

  /**
   * 释放底层 Cursor SDK agent。
   */
  public async dispose(): Promise<void> {
    this.abortRun()
    const agent = this.sdkAgent
    this.sdkAgent = null
    this.sdkAgentPromise = null
    if (agent) {
      await agent[Symbol.asyncDispose]()
    }
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
   * 典型序列：`RUN_STARTED` → (`TEXT_MESSAGE_*` | `TOOL_CALL_*`)* → `RUN_FINISHED` | `RUN_ERROR`
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
        this.activeRun = null
        this.pendingForwardedExtras = {}
      })

      return () => {
        abortController.abort()
        const run = this.activeRun
        if (run?.supports('cancel')) {
          void run.cancel().catch(() => {
            /* ignore */
          })
        }
      }
    })
  }

  /**
   * 惰性创建（或复用）底层 Cursor SDK local agent。
   *
   * @param cwd - 工作区根目录
   * @returns SDKAgent
   */
  /**
   * 丢弃已缓存的 SDK agent（网络/鉴权失败后便于下次重建）。
   */
  private async resetSdkAgent(): Promise<void> {
    const prev = this.sdkAgent
    this.sdkAgent = null
    this.sdkAgentPromise = null
    if (!prev) return
    try {
      await prev[Symbol.asyncDispose]()
    } catch {
      /* ignore */
    }
  }

  private async ensureSdkAgent(cwd?: string): Promise<SDKAgent> {
    if (this.sdkAgent) return this.sdkAgent
    if (this.sdkAgentPromise) return this.sdkAgentPromise

    const apiKey = this.config.agent.apiKey.trim()
    if (!apiKey) {
      throw new Error('请先在设置中配置 Cursor API Key')
    }
    const modelId = (this.config.agent.model ?? 'composer-2.5').trim() || 'composer-2.5'
    const resolvedCwd = cwd?.trim() || this.config.agent.local?.cwd?.trim() || undefined

    this.sdkAgentPromise = Agent.create({
      apiKey,
      model: { id: modelId },
      local: {
        ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
        settingSources: []
      }
    })
      .then((agent) => {
        this.sdkAgent = agent
        return agent
      })
      .catch(async (error) => {
        this.sdkAgentPromise = null
        this.sdkAgent = null
        throw error
      })

    try {
      return await this.sdkAgentPromise
    } catch (error) {
      this.sdkAgentPromise = null
      throw error
    }
  }

  /**
   * 将 Cursor SDK stream 翻译为 AG-UI 事件并推入 subscriber。
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
    const startedToolCalls = new Set<string>()

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

    const emitAssistantText = (text: string) => {
      if (!text) return
      ensureTextStart()
      const content: TextMessageContentEvent = {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: text,
        timestamp: Date.now()
      }
      emit(content)
    }

    /**
     * 尚未判定归属的 assistant 纯文本。
     * 若随后出现 tool_call → Thought；否则在 run 结束时落入 Result。
     */
    let pendingAssistantText = ''

    const emitThinkingText = (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const custom: CustomEvent = {
        type: EventType.CUSTOM,
        name: 'cursor.thinking',
        value: { text: trimmed },
        timestamp: Date.now()
      }
      emit(custom)
    }

    const flushPendingAsThinking = () => {
      if (!pendingAssistantText) return
      emitThinkingText(pendingAssistantText)
      pendingAssistantText = ''
    }

    const flushPendingAsResult = () => {
      if (!pendingAssistantText) return
      emitAssistantText(pendingAssistantText)
      pendingAssistantText = ''
    }

    const handleSdkMessage = (event: SDKMessage) => {
      switch (event.type) {
        case 'assistant': {
          const hasToolUse = event.message.content.some((block) => block.type === 'tool_use')
          for (const block of event.message.content) {
            if (block.type === 'text') {
              if (hasToolUse) {
                // 同条含 tool_use：先前挂起文本 + 本段均视为过程叙述
                flushPendingAsThinking()
                emitThinkingText(block.text)
              } else {
                pendingAssistantText += block.text
              }
              continue
            }
            if (block.type === 'tool_use') {
              // 工具细节以 tool_call 事件为准；此处忽略避免重复
            }
          }
          break
        }
        case 'tool_call': {
          // 工具出现前的纯文本是中间过程，归入 Thought
          flushPendingAsThinking()
          ensureTextStart()
          const toolCallId = event.call_id
          if (event.status === 'running' && !startedToolCalls.has(toolCallId)) {
            startedToolCalls.add(toolCallId)
            const start: ToolCallStartEvent = {
              type: EventType.TOOL_CALL_START,
              toolCallId,
              toolCallName: event.name,
              parentMessageId: messageId,
              timestamp: Date.now()
            }
            emit(start)

            const args: ToolCallArgsEvent = {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId,
              delta: toolArgsToJsonDelta(event.args),
              timestamp: Date.now()
            }
            emit(args)

            const end: ToolCallEndEvent = {
              type: EventType.TOOL_CALL_END,
              toolCallId,
              timestamp: Date.now()
            }
            emit(end)
          }

          if (event.status === 'completed' || event.status === 'error') {
            if (!startedToolCalls.has(toolCallId)) {
              startedToolCalls.add(toolCallId)
              const start: ToolCallStartEvent = {
                type: EventType.TOOL_CALL_START,
                toolCallId,
                toolCallName: event.name,
                parentMessageId: messageId,
                timestamp: Date.now()
              }
              emit(start)
              const args: ToolCallArgsEvent = {
                type: EventType.TOOL_CALL_ARGS,
                toolCallId,
                delta: toolArgsToJsonDelta(event.args),
                timestamp: Date.now()
              }
              emit(args)
              const end: ToolCallEndEvent = {
                type: EventType.TOOL_CALL_END,
                toolCallId,
                timestamp: Date.now()
              }
              emit(end)
            }

            const result: ToolCallResultEvent = {
              type: EventType.TOOL_CALL_RESULT,
              messageId: randomUUID(),
              toolCallId,
              content:
                event.status === 'error'
                  ? toolResultToContent(event.result) || 'Tool call failed'
                  : toolResultToContent(event.result),
              role: 'tool',
              timestamp: Date.now()
            }
            emit(result)
          }
          break
        }
        case 'thinking': {
          if (!event.text) break
          const custom: CustomEvent = {
            type: EventType.CUSTOM,
            name: 'cursor.thinking',
            value: { text: event.text, thinkingDurationMs: event.thinking_duration_ms },
            timestamp: Date.now()
          }
          emit(custom)
          break
        }
        default:
          break
      }
    }

    const merged: CursorAgentRunDefaults = {
      ...this.runDefaults,
      ...this.pendingForwardedExtras,
      ...parseForwardedProps(input.forwardedProps),
      abortController
    }

    try {
      if (abortController.signal.aborted) {
        const aborted = new Error('Aborted')
        aborted.name = 'AbortError'
        throw aborted
      }

      const userText = extractUserText(input.messages ?? [])
      const cwd = merged.workspacePath?.trim() || this.config.agent.local?.cwd?.trim() || undefined
      const sdkAgent = await this.ensureSdkAgent(cwd)

      const composerMode = merged.composerMode === 'ask' ? 'ask' : 'build'
      const prompt = composerMode === 'ask' ? `${ASK_MODE_PREFIX}${userText}` : userText

      const run = await sdkAgent.send(prompt)

      this.activeRun = run

      const onAbort = () => {
        if (run.supports('cancel')) {
          void run.cancel().catch(() => {
            /* ignore */
          })
        }
      }
      if (abortController.signal.aborted) {
        onAbort()
      } else {
        abortController.signal.addEventListener('abort', onAbort, { once: true })
      }

      try {
        for await (const event of run.stream()) {
          if (abortController.signal.aborted) break
          handleSdkMessage(event)
        }
      } finally {
        abortController.signal.removeEventListener('abort', onAbort)
      }

      // 未再跟工具的挂起文本视为最终回答
      flushPendingAsResult()

      const result = await run.wait()
      ensureTextEnd()

      if (result.status === 'cancelled' || abortController.signal.aborted) {
        const runError: RunErrorEvent = {
          type: EventType.RUN_ERROR,
          message: result.error?.message || 'Cancelled',
          code: 'CANCELLED',
          timestamp: Date.now()
        }
        emit(runError)
        if (!subscriber.closed) subscriber.complete()
        return
      }

      if (result.status === 'error') {
        const detail = result.error?.message || 'Cursor agent run failed'
        const message = formatRunError(new Error(detail))
        console.error('[cursor-agent] run failed', {
          runId: result.id,
          status: result.status,
          error: result.error,
          message
        })
        // 失败后丢弃句柄，避免 SDK 内部 session 进入不可恢复状态
        void this.resetSdkAgent()
        const runError: RunErrorEvent = {
          type: EventType.RUN_ERROR,
          message,
          code: 'ERROR',
          timestamp: Date.now()
        }
        emit(runError)
        if (!subscriber.closed) subscriber.complete()
        return
      }

      const finished: RunFinishedEvent = {
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        result: result.result,
        timestamp: Date.now()
      }
      emit(finished)
      if (!subscriber.closed) subscriber.complete()
    } catch (error) {
      // 异常中断：已开工具则挂起文本归 Thought，否则尝试作为 Result
      if (startedToolCalls.size > 0) flushPendingAsThinking()
      else flushPendingAsResult()
      ensureTextEnd()

      const cancelled = isAbortError(error) || abortController.signal.aborted
      const message = formatRunError(error)
      if (!cancelled) {
        console.error('[cursor-agent] run threw', error)
        void this.resetSdkAgent()
      }
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
