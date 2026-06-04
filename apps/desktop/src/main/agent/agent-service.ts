import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage
} from '@langchain/core/messages'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { ChatOpenAI } from '@langchain/openai'
import type { CallbackHandler } from '@langfuse/langchain'
import type { WebContents } from 'electron'

import { agentLog } from '@/main/agent/agent-log'
import type { NamedTool } from '@/main/agent/agent-tooling'
import { StreamBatcher } from '@/main/agent/batcher'
import { AGENXY_INTERNAL_KW, AGENXY_USER_DISPLAY_KW } from '@/main/agent/constants'
import { runAgenxyGraph } from '@/main/agent/graph/run-graph'
import {
  agentCheckpointer,
  buildRejectionStateMessages,
  cancelAllHitlWaiters,
  extractPendingToolCalls,
  formatToolArgs,
  type HitlUserDecision,
  isPausedBeforeTools,
  isRejectedToolResult,
  makeHitlId,
  partitionPendingToolCalls,
  type PendingToolCall,
  submitHitlDecision,
  TOOL_REJECTED_RESULT,
  waitForHitlDecision
} from '@/main/agent/hitl'
import { ConcurrencyQueue } from '@/main/agent/queue'
import { isAbortError } from '@/main/agent/run-utils'
import { flushLangfuseTracing, runLangfuseReactObservation } from '@/main/langfuse'
import { extractMemoriesAfterRun } from '@/main/memory/memory-extractor'
import { getSessionMessages, getSettings, getWorkspaceById, setSessionMessages } from '@/main/store'
import { killCommand } from '@/main/tools/terminal'
import {
  type AgentSendOptions,
  type AppSettings,
  type ChatMessage,
  EVENTS,
  getActiveProviderProfile,
  MAX_CONCURRENT_AGENT_STREAMS,
  type ModelProviderId,
  normalizeComposerMode,
  STREAM_FLUSH_CHARS,
  STREAM_FLUSH_MS,
  type StreamEvent,
  type ToolCallEvent,
  type ToolTimelineEvent
} from '@/shared/ipc'

/** @deprecated 从 `@/main/agent/constants` 导入 */
export { AGENXY_USER_DISPLAY_KW } from '@/main/agent/constants'

/** @deprecated 从 `@/main/agent/agent-log` 导入 */
export { agentLog } from '@/main/agent/agent-log'

type SessionRuntime = {
  workspaceId: string
  /** System prompt is not included; it's appended at each request */
  messages: BaseMessage[]
  controller: AbortController | null
  /** Consistent with terminal key for the session */
  terminalKey: string
  /** Active LangGraph HITL wait (tool approval before tools node) */
  pendingHitl?: {
    hitlId: string
    toolCalls: PendingToolCall[]
  }
}

const sessions = new Map<string, SessionRuntime>()
let webContents: WebContents | null = null
let agentQueue: ConcurrencyQueue | null = null
const MAX_PERSISTED_MESSAGES = 200

function makeRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function makeTraceId(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`
}

function getQueue(): ConcurrencyQueue {
  if (!agentQueue) {
    agentQueue = new ConcurrencyQueue(Math.max(1, MAX_CONCURRENT_AGENT_STREAMS))
  }
  return agentQueue
}

// send event to renderer
function emit(event: StreamEvent): void {
  if (!webContents || webContents.isDestroyed()) return
  webContents.send(EVENTS.AGENT_STREAM, event)
}

function trimPersistedMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_PERSISTED_MESSAGES) return messages
  return messages.slice(-MAX_PERSISTED_MESSAGES)
}

function getBaseMessageType(msg: BaseMessage): string {
  const maybeGetType = (msg as { getType?: () => string }).getType
  if (typeof maybeGetType === 'function') return maybeGetType.call(msg)
  const maybeInternalType = (msg as { _getType?: () => string })._getType
  if (typeof maybeInternalType === 'function') return maybeInternalType.call(msg)
  return ''
}

function isInternalGraphMessage(msg: BaseMessage): boolean {
  const kw = (msg as { additional_kwargs?: Record<string, unknown> }).additional_kwargs
  return kw?.[AGENXY_INTERNAL_KW] === true
}

function toPersistedMessages(coreMessages: BaseMessage[]): ChatMessage[] {
  const visible: BaseMessage[] = []
  for (const msg of coreMessages) {
    const messageType = getBaseMessageType(msg)
    if (messageType === 'system' || isInternalGraphMessage(msg)) continue
    visible.push(msg)
  }

  let lastAiIndex = -1
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    if (getBaseMessageType(visible[i]) === 'ai') {
      lastAiIndex = i
      break
    }
  }

  const out: ChatMessage[] = []
  for (let i = 0; i < visible.length; i += 1) {
    const msg = visible[i]!
    const messageType = getBaseMessageType(msg)
    if (messageType === 'human') {
      const kw = (msg as { additional_kwargs?: Record<string, unknown> }).additional_kwargs
      const display =
        typeof kw?.[AGENXY_USER_DISPLAY_KW] === 'string'
          ? (kw[AGENXY_USER_DISPLAY_KW] as string)
          : contentToText(msg.content)
      out.push({
        id: `u-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'user',
        content: display
      })
      continue
    }
    if (messageType === 'ai') {
      if (i !== lastAiIndex) continue
      const content = contentToText(msg.content)
      if (!content.trim()) continue
      out.push({
        id: `a-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'assistant',
        content
      })
    }
  }
  return trimPersistedMessages(out)
}

function fromPersistedMessages(messages: ChatMessage[]): BaseMessage[] {
  const list: BaseMessage[] = []
  for (const msg of messages) {
    if (!msg.content?.trim()) continue
    if (msg.role === 'user') {
      list.push(new HumanMessage(msg.content))
      continue
    }
    if (msg.role === 'assistant') {
      list.push(new AIMessage(msg.content))
      continue
    }
    if (msg.role === 'system') {
      list.push(new SystemMessage(msg.content))
    }
  }
  return list
}

function persistSessionMessages(
  workspaceId: string,
  sessionId: string,
  coreMessages: BaseMessage[],
  opts?: {
    toolEventsForLastAssistant?: ToolTimelineEvent[]
  }
): void {
  const list = toPersistedMessages(coreMessages)
  const toolEvents = opts?.toolEventsForLastAssistant
  if (toolEvents && toolEvents.length > 0) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const row = list[i]
      if (row?.role === 'assistant') {
        list[i] = { ...row, toolEvents }
        break
      }
    }
  }
  setSessionMessages(workspaceId, sessionId, list)
}

function ensureOpenAiV1BaseUrl(baseUrl: string, fallback: string): string {
  const u = baseUrl.trim() || fallback
  if (!u) return fallback
  if (/\/v1\/?$/i.test(u)) return u.replace(/\/+$/, '')
  return `${u.replace(/\/+$/, '')}/v1`
}

function openAiBaseUrlForProvider(_provider: ModelProviderId, rawBaseUrl: string): string {
  const deepseekDefault = 'https://api.deepseek.com/v1'
  return ensureOpenAiV1BaseUrl(rawBaseUrl, deepseekDefault)
}

function createLanguageModel(settings: AppSettings) {
  const profile = getActiveProviderProfile(settings)
  if (!profile.apiKey?.trim()) {
    throw new Error('请先在设置中配置 API Key')
  }
  const apiKey = profile.apiKey.trim()
  const baseURL = openAiBaseUrlForProvider(settings.provider, profile.baseUrl)
  return new ChatOpenAI({
    apiKey,
    model: profile.model,
    configuration: { baseURL },
    streaming: true,
    temperature: 0
  })
}

function buildAgentMessageWithPlan(userText: string, planContext: string): string {
  const userPart = userText.trim() || '（用户未附加说明，请严格按计划步骤实施。）'
  return [
    '用户已确认以下 **计划模式** 中的计划，并切换到 **构建模式** 实施。',
    '除非用户消息明确修订、缩小或重排范围，否则按计划执行。',
    '',
    '--- 计划 ---',
    planContext.trim(),
    '--- 计划结束 ---',
    '',
    '用户消息：',
    userPart
  ].join('\n')
}

const PLAN_STEP_TIMEOUT_MS = 14_000
const PLAN_STEP_MAX_CHARS = 480
const MAX_PLAN_STEPS_PER_RUN = 16

type PlanAfterToolContext = {
  toolName: string
  args?: string
  result?: string
}

/**
 * After a tool returns, stream a short "next step" plan (Cursor-style) before the ReAct loop continues.
 */
async function streamPlanAfterTool(
  settings: AppSettings,
  userText: string,
  ctx: PlanAfterToolContext,
  ac: AbortController,
  planBatcher: StreamBatcher
): Promise<string> {
  const model = createLanguageModel(settings)
  const system = new SystemMessage(
    '你是「下一步计划」助手。编码智能体刚完成一次工具调用，将继续处理同一用户任务。\n' +
      '根据用户目标与工具输出，用**中文**写 1–3 句简短完整话描述**接下来**要做什么（仅高层概要；不要写具体工具函数名；不要 Markdown 标题或代码块）。\n' +
      '若输出为空、失败或异常，简要说明如何补救。语气简洁、面向用户。'
  )
  const human = new HumanMessage(
    [
      `用户消息：\n${userText.trim() || '（空消息）'}`,
      `已完成工具：${ctx.toolName}`,
      ctx.args ? `参数：${ctx.args}` : '',
      ctx.result ? `输出（已截断）：\n${ctx.result.slice(0, 700)}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
  )
  const deadline = Date.now() + PLAN_STEP_TIMEOUT_MS
  let acc = ''
  try {
    const stream = await model.stream([system, human], { signal: ac.signal })
    for await (const chunk of stream) {
      if (Date.now() > deadline) break
      const piece = contentToText((chunk as { content?: unknown }).content)
      if (!piece) continue
      acc += piece
      planBatcher.push(piece)
      if (acc.length >= PLAN_STEP_MAX_CHARS) break
    }
  } catch (e) {
    if (isAbortError(e)) throw e
    agentLog.warn('[streamPlanAfterTool] failed:', e instanceof Error ? e.message : e)
  }
  return acc.trim()
}

type ReactAgentRunContext = {
  sessionId: string
  runId: string
  traceId: string
  threadId: string
  hitlEnabled: boolean
  toolsByName: Map<string, NamedTool>
  onPendingHitl: (hitlId: string, toolCalls: PendingToolCall[]) => void
  emitHitlRequired: (hitlId: string, toolCalls: PendingToolCall[]) => void
  onToolsRejected?: (toolCalls: PendingToolCall[]) => void
}

async function executePendingToolCalls(
  pending: PendingToolCall[],
  toolsByName: Map<string, NamedTool>
): Promise<ToolMessage[]> {
  const out: ToolMessage[] = []
  for (const tc of pending) {
    const impl = toolsByName.get(tc.name)
    if (!impl) {
      out.push(
        new ToolMessage({
          content: `Tool not found: ${tc.name}`,
          tool_call_id: tc.id,
          name: tc.name,
          status: 'error'
        })
      )
      continue
    }
    try {
      const result = await impl.invoke(tc.args)
      const content = typeof result === 'string' ? result : JSON.stringify(result)
      out.push(
        new ToolMessage({
          content,
          tool_call_id: tc.id,
          name: tc.name
        })
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      out.push(
        new ToolMessage({
          content: message,
          tool_call_id: tc.id,
          name: tc.name,
          status: 'error'
        })
      )
    }
  }
  return out
}

/**
 * Run ReAct agent with timeout guard; optional LangGraph interruptBefore tools + Command.resume loop.
 */
async function runReactAgentWithGuard(
  agent: ReturnType<typeof createReactAgent>,
  messages: BaseMessage[],
  ac: AbortController,
  onToken: (token: string) => void,
  options: {
    recursionLimit: number
    timeoutMs: number
    langfuseHandler?: CallbackHandler | null
  },
  runCtx: ReactAgentRunContext
): Promise<BaseMessage[]> {
  const { recursionLimit, timeoutMs, langfuseHandler } = options
  const graphConfig = {
    configurable: { thread_id: runCtx.threadId },
    signal: ac.signal,
    recursionLimit,
    callbacks: [
      {
        handleLLMNewToken(token: string) {
          onToken(token)
        }
      },
      ...(langfuseHandler ? [langfuseHandler] : [])
    ]
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort()
      reject(new Error(`Model-tool loop timeout (>${timeoutMs}ms), run aborted`))
    }, timeoutMs)
  })

  let input: { messages: BaseMessage[] } | null = { messages }
  let hitlRound = 0
  const graphStateConfig = { configurable: { thread_id: runCtx.threadId } }

  try {
    agentLog.info(
      `[runReactAgentWithGuard] thread=${runCtx.threadId} hitl=${runCtx.hitlEnabled} recursionLimit=${recursionLimit}`
    )

    while (true) {
      const result = await Promise.race([agent.invoke(input, graphConfig), timeoutPromise])
      const state = await agent.getState(graphStateConfig)
      const stateMessages = (state.values?.messages ?? []) as BaseMessage[]

      if (!runCtx.hitlEnabled || !isPausedBeforeTools(state.next)) {
        if (stateMessages.length > 0) return stateMessages
        const fallback = (result as { messages?: BaseMessage[] })?.messages
        return Array.isArray(fallback) && fallback.length > 0 ? fallback : stateMessages
      }

      const pending = extractPendingToolCalls(stateMessages)
      if (pending.length === 0) {
        agentLog.warn('[runReactAgentWithGuard] interrupt before tools but no tool_calls in state')
        return stateMessages
      }

      const { approvalRequired, autoExecute } = partitionPendingToolCalls(pending)
      if (approvalRequired.length === 0) {
        agentLog.info(
          `[runReactAgentWithGuard] read-only tools only (${autoExecute.map((t) => t.name).join(', ')}), skip HITL`
        )
        input = null
        continue
      }

      const hitlId = makeHitlId(runCtx.runId, hitlRound++)
      runCtx.onPendingHitl(hitlId, approvalRequired)
      runCtx.emitHitlRequired(hitlId, approvalRequired)

      const decision = await waitForHitlDecision(hitlId, ac.signal)
      agentLog.info(`[runReactAgentWithGuard] hitl decision=${decision} hitlId=${hitlId}`)

      if (decision === 'reject') {
        const autoResults =
          autoExecute.length > 0
            ? await executePendingToolCalls(autoExecute, runCtx.toolsByName)
            : []
        await agent.updateState(graphStateConfig, {
          messages: [...autoResults, ...buildRejectionStateMessages(approvalRequired)]
        })
        runCtx.onToolsRejected?.(approvalRequired)
      }

      // Approve: null continues into tools node. Reject: null after synthetic tool results above.
      input = null
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}

export function bindAgentIpc(wc: WebContents): void {
  webContents = wc
}

export function initSessionState(workspaceId: string, sessionId: string): void {
  if (!sessions.has(sessionId)) {
    const persisted = getSessionMessages(workspaceId, sessionId)
    sessions.set(sessionId, {
      workspaceId,
      messages: fromPersistedMessages(persisted),
      controller: null,
      terminalKey: `term:${sessionId}`
    })
  }
}

export function getSessionCoreMessages(sessionId: string): BaseMessage[] {
  return sessions.get(sessionId)?.messages ?? []
}

export function clearSessionState(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (s?.controller) {
    s.controller.abort()
  }
  void killCommand(s?.terminalKey ?? `term:${sessionId}`)
  sessions.delete(sessionId)
}

export function cancelRun(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (s?.controller) {
    s.controller.abort()
  }
  if (s) {
    s.pendingHitl = undefined
  }
  cancelAllHitlWaiters('运行已取消')
  void killCommand(`term:${sessionId}`)
}

export function resumeAgentHitl(
  sessionId: string,
  hitlId: string,
  decision: HitlUserDecision
): { ok: true } | { ok: false; error: string } {
  const s = sessions.get(sessionId)
  if (!s?.pendingHitl || s.pendingHitl.hitlId !== hitlId) {
    return { ok: false, error: '当前会话没有待审批的工具调用' }
  }
  s.pendingHitl = undefined
  const submitted = submitHitlDecision(hitlId, decision)
  if (!submitted) {
    return { ok: false, error: '审批请求已过期或已处理' }
  }
  return { ok: true }
}

export async function runUserMessage(
  sessionId: string,
  userText: string,
  onQueued: (pos: number) => void,
  options?: AgentSendOptions
): Promise<void> {
  const composerMode = normalizeComposerMode(options?.mode)
  const planContext = options?.planContext?.trim()
  const userDisplayText =
    options?.userDisplayText?.trim() || userText.trim() || (planContext ? '执行计划' : '')
  const agentUserText = planContext
    ? buildAgentMessageWithPlan(userText, planContext)
    : userText.trim()
  if (!agentUserText) {
    emit({ type: 'error', sessionId, message: '消息为空' })
    return
  }
  const settings = getSettings()
  agentLog.info(`settings: ${JSON.stringify(settings, null, 2)}, composerMode: ${composerMode}`)

  const existingSession = sessions.get(sessionId)
  if (!existingSession) {
    emit({ type: 'error', sessionId, message: '会话不存在或已过期' })
    return
  }
  const workspace = getWorkspaceById(existingSession.workspaceId)
  agentLog.info(`[runUserMessage] workspace: ${workspace?.path}`)

  const root = workspace?.path?.trim() || ''
  if (!root) {
    emit({
      type: 'error',
      sessionId,
      message: '当前会话未绑定工作区目录，请先绑定路径'
    })
    return
  }
  const queue = getQueue()
  if (queue.willBlock()) {
    onQueued(queue.waiting + 1)
  }
  await queue.run(async () => {
    onQueued(0) // 0 = obtained execution right (no queue bar displayed)
    const session = sessions.get(sessionId)
    if (!session) {
      agentLog.error(`[runUserMessage] session not found for sessionId: ${sessionId}`)
      emit({ type: 'error', sessionId, message: '会话不存在或已过期' })
      return
    }
    const ac = new AbortController()
    const runId = makeRunId()
    const traceId = makeTraceId(sessionId, runId)
    const runStartedAt = Date.now()
    session.controller = ac

    agentLog.info(
      `[runUserMessage] run-start: ${runId}, traceId: ${traceId}, sessionId: ${sessionId}, timestampMs: ${runStartedAt}`
    )
    emit({ type: 'run-start', sessionId, runId, traceId, timestampMs: runStartedAt })

    const runToolEvents: ToolTimelineEvent[] = []
    let planStepsThisRun = 0
    let planChain: Promise<void> = Promise.resolve()

    const emitTool = (e: ToolTimelineEvent) => {
      emit({
        type: 'tool',
        sessionId,
        runId,
        traceId,
        event: {
          ...e,
          runId: e.runId ?? runId,
          traceId: e.traceId ?? traceId,
          timestampMs: e.timestampMs ?? Date.now()
        }
      })
    }

    type ToolEndedCall = ToolCallEvent & { status: 'end' }

    const schedulePlanAfterTool = (ended: ToolEndedCall) => {
      if (ac.signal.aborted) return
      if (composerMode === 'plan') return
      if (planStepsThisRun >= MAX_PLAN_STEPS_PER_RUN) return
      planStepsThisRun += 1
      const stepId = `plan-${ended.id}`
      const startedAt = Date.now()

      planChain = planChain
        .then(async () => {
          if (ac.signal.aborted) return
          emit({
            type: 'plan-step-start',
            sessionId,
            runId,
            traceId,
            stepId,
            afterToolId: ended.id,
            toolName: ended.name
          })

          const planRecord = {
            kind: 'plan' as const,
            id: stepId,
            afterToolId: ended.id,
            toolName: ended.name,
            status: 'streaming' as const,
            text: '',
            runId,
            traceId,
            timestampMs: startedAt
          }
          runToolEvents.push(planRecord)

          const planBatcher = new StreamBatcher(STREAM_FLUSH_MS, STREAM_FLUSH_CHARS, (t) => {
            emit({ type: 'plan-delta', sessionId, stepId, text: t, runId, traceId })
            const idx = runToolEvents.findIndex((x) => x.kind === 'plan' && x.id === stepId)
            if (idx >= 0) {
              const row = runToolEvents[idx]
              if (row?.kind === 'plan') {
                runToolEvents[idx] = { ...row, text: row.text + t }
              }
            }
          })

          let text = ''
          try {
            text = await streamPlanAfterTool(
              settings,
              userText,
              { toolName: ended.name, args: ended.args, result: ended.result },
              ac,
              planBatcher
            )
          } catch (e) {
            planBatcher.flush()
            if (isAbortError(e)) throw e
            throw e
          }
          planBatcher.flush()

          const idx = runToolEvents.findIndex((x) => x.kind === 'plan' && x.id === stepId)
          if (idx >= 0) {
            const prev = runToolEvents[idx]
            const prevText = prev?.kind === 'plan' ? prev.text : ''
            runToolEvents[idx] = {
              kind: 'plan',
              id: stepId,
              afterToolId: ended.id,
              toolName: ended.name,
              status: 'end',
              text: text || prevText,
              runId,
              traceId,
              timestampMs: startedAt,
              durationMs: Date.now() - startedAt
            }
          }
          emit({ type: 'plan-step-end', sessionId, stepId, runId, traceId })
        })
        .catch((e) => {
          if (isAbortError(e)) return
          agentLog.warn('[schedulePlanAfterTool] failed:', e instanceof Error ? e.message : e)
        })
    }

    const onTool = (e: ToolTimelineEvent) => {
      runToolEvents.push(e)
      emitTool(e)
      if (e.kind === 'tool' && e.status === 'end' && !isRejectedToolResult(e.result)) {
        schedulePlanAfterTool(e as ToolEndedCall)
      }
    }
    const recursionLimit = settings.maxAgentLoopSteps
    const invokeTimeoutMs = settings.agentRunTimeoutMs
    const threadId = `${sessionId}:${runId}`

    const batcher = new StreamBatcher(STREAM_FLUSH_MS, STREAM_FLUSH_CHARS, (t) => {
      emit({ type: 'text-delta', sessionId, text: t, runId, traceId })
    })

    try {
      let streamedChars = 0

      const graphResult = await runAgenxyGraph({
        composerMode,
        messages: session.messages,
        signal: ac.signal,
        runMeta: {
          sessionId,
          runId,
          traceId,
          threadId,
          workspaceId: session.workspaceId,
          root,
          userDisplayText,
          agentUserText,
          planContext
        },
        runContext: {
          settings,
          onTool,
          emit
        },
        initRunCallbacks: {
          persistMessages: (messages) => {
            session.messages = messages
            persistSessionMessages(session.workspaceId, sessionId, messages)
          }
        },
        runPhase: async (graphState) => {
          const prepared = graphState.tooling
          if (!prepared) {
            throw new Error('[runPhase] tooling not prepared by graph')
          }
          const { tools, runPrompt } = prepared

          agentLog.info(
            `[runUserMessage] mode=${composerMode} runPrompt: ${JSON.stringify(runPrompt, null, 2)}`
          )

          const hitlEnabled = composerMode === 'build' && settings.toolApprovalInBuild !== false
          const toolsByName = new Map(tools.map((t) => [t.name, t]))

          const model = createLanguageModel(settings).bindTools(tools as never[])

          const agent = createReactAgent({
            llm: model,
            tools: tools as never[],
            prompt: runPrompt,
            checkpointer: agentCheckpointer,
            ...(hitlEnabled ? { interruptBefore: ['tools'] as const } : {})
          })

          const onStreamToken = (token: string) => {
            streamedChars += token.length
            batcher.push(token)
          }

          const runMessages = await runLangfuseReactObservation(
            {
              sessionId,
              tags: ['agenxy', 'graph', 'react', composerMode],
              traceMetadata: {
                run_id: runId,
                trace_id: traceId,
                workspace_id: session.workspaceId,
                step: 'react'
              },
              traceId,
              traceName: 'agenxy-graph',
              input: userDisplayText || agentUserText
            },
            async (reactLangfuseHandler) => {
              agentLog.info(
                `[runUserMessage] react Langfuse: ${reactLangfuseHandler ? '已启用' : '未配置'}`
              )

              const agentInvokeOpts = {
                recursionLimit,
                timeoutMs: invokeTimeoutMs,
                langfuseHandler: reactLangfuseHandler
              }

              const [msgs] = await Promise.all([
                runReactAgentWithGuard(
                  agent,
                  graphState.messages,
                  ac,
                  onStreamToken,
                  agentInvokeOpts,
                  {
                    sessionId,
                    runId,
                    traceId,
                    threadId,
                    hitlEnabled,
                    toolsByName,
                    onPendingHitl: (hitlId, toolCalls) => {
                      session.pendingHitl = { hitlId, toolCalls }
                    },
                    emitHitlRequired: (hitlId, toolCalls) => {
                      streamedChars = 0
                      emit({ type: 'stream-reset', sessionId, runId, traceId })
                      emit({
                        type: 'hitl-required',
                        sessionId,
                        runId,
                        traceId,
                        hitlId,
                        toolCalls: toolCalls.map((t) => ({
                          id: t.id,
                          name: t.name,
                          args: formatToolArgs(t.args)
                        }))
                      })
                    },
                    onToolsRejected: (toolCalls) => {
                      streamedChars = 0
                      emit({ type: 'stream-reset', sessionId, runId, traceId })
                      const now = Date.now()
                      for (const tc of toolCalls) {
                        onTool({
                          kind: 'tool',
                          id: tc.id,
                          name: tc.name,
                          status: 'start',
                          args: formatToolArgs(tc.args),
                          runId,
                          traceId,
                          timestampMs: now
                        })
                        onTool({
                          kind: 'tool',
                          id: tc.id,
                          name: tc.name,
                          status: 'end',
                          result: TOOL_REJECTED_RESULT,
                          runId,
                          traceId,
                          timestampMs: now,
                          durationMs: 0
                        })
                      }
                    }
                  }
                ),
                planChain
              ]).then(([msgs]) => [msgs])

              return msgs
            },
            {
              formatOutput: (messages) => {
                const lastAi = [...messages]
                  .reverse()
                  .find((msg) => getBaseMessageType(msg) === 'ai') as AIMessage | undefined
                return lastAi ? contentToText(lastAi.content) : ''
              }
            }
          )

          return {
            messages: runMessages.length > 0 ? runMessages : graphState.messages,
            toolEvents: runToolEvents
          }
        }
      })

      session.messages = graphResult.messages
      session.pendingHitl = undefined

      if (streamedChars === 0) {
        const lastAi = [...session.messages]
          .reverse()
          .find((msg) => getBaseMessageType(msg) === 'ai') as AIMessage | undefined
        const fallback = lastAi ? contentToText(lastAi.content) : ''
        if (fallback) {
          batcher.push(fallback)
        }
      }
      batcher.flush()
      persistSessionMessages(session.workspaceId, sessionId, session.messages, {
        toolEventsForLastAssistant: graphResult.toolEvents
      })
      emit({
        type: 'done',
        sessionId,
        runId,
        traceId,
        timestampMs: Date.now(),
        durationMs: Date.now() - runStartedAt
      })

      const lastAi = [...session.messages]
        .reverse()
        .find((msg) => getBaseMessageType(msg) === 'ai') as AIMessage | undefined
      const assistantForMemory = lastAi ? contentToText(lastAi.content) : ''
      void extractMemoriesAfterRun({
        sessionId,
        userText: userDisplayText || agentUserText,
        assistantText: assistantForMemory
      }).catch((err) => {
        agentLog.warn('[runUserMessage] memory extract:', err instanceof Error ? err.message : err)
      })
    } catch (e) {
      batcher.flush()
      const message = e instanceof Error ? e.message : String(e)
      emit({
        type: 'error',
        sessionId,
        message,
        runId,
        traceId,
        timestampMs: Date.now(),
        durationMs: Date.now() - runStartedAt
      })
      onTool({
        kind: 'error',
        message,
        runId,
        traceId,
        timestampMs: Date.now(),
        durationMs: Date.now() - runStartedAt
      })
      persistSessionMessages(session.workspaceId, sessionId, session.messages, {
        toolEventsForLastAssistant: runToolEvents.length > 0 ? runToolEvents : undefined
      })
    } finally {
      session.controller = null
      session.pendingHitl = undefined
      batcher.flush()
      // Agent 运行结束后 flush Langfuse 数据（确保追踪数据被及时发送）
      void flushLangfuseTracing()
    }
  })
}
