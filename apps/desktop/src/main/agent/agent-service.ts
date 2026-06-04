import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { WebContents } from 'electron'

import { agentLog } from '@/main/agent/agent-log'
import { StreamBatcher } from '@/main/agent/batcher'
import { AGENXY_INTERNAL_KW, AGENXY_USER_DISPLAY_KW } from '@/main/agent/constants'
import type { ReactRunBridge } from '@/main/agent/graph/react-run-bridge'
import { runAgenxyGraph } from '@/main/agent/graph/run-graph'
import {
  cancelAllHitlWaiters,
  formatToolArgs,
  type HitlUserDecision,
  type PendingToolCall,
  submitHitlDecision,
  TOOL_REJECTED_RESULT
} from '@/main/agent/hitl'
import { contentToText, findLastAiMessage, getBaseMessageType } from '@/main/agent/message-utils'
import { ConcurrencyQueue } from '@/main/agent/queue'
import { flushLangfuseTracing } from '@/main/langfuse'
import { getSessionMessages, getSettings, getWorkspaceById, setSessionMessages } from '@/main/store'
import { killCommand } from '@/main/tools/terminal'
import {
  type AgentSendOptions,
  type ChatMessage,
  EVENTS,
  MAX_CONCURRENT_AGENT_STREAMS,
  normalizeComposerMode,
  STREAM_FLUSH_CHARS,
  STREAM_FLUSH_MS,
  type StreamEvent,
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
  /** LangGraph HITL 暂停：等待 Command.resume（经 IPC 桥接） */
  pendingHitl?: {
    hitlId: string
    threadId: string
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

/**
 * 恢复 LangGraph HITL：将用户决策交给 IPC 桥接，由 runReactAgentWithGuard 发出 Command.resume。
 *
 * @param sessionId - 会话 ID
 * @param hitlId - 审批批次 ID
 * @param decision - accept / reject
 */
export function resumeAgentHitl(
  sessionId: string,
  hitlId: string,
  decision: HitlUserDecision
): { ok: true } | { ok: false; error: string } {
  const s = sessions.get(sessionId)
  const pending = s?.pendingHitl
  if (!s || !pending || pending.hitlId !== hitlId) {
    return { ok: false, error: '当前会话没有待审批的工具调用' }
  }
  s.pendingHitl = undefined
  const submitted = submitHitlDecision(hitlId, decision)
  if (!submitted) {
    return { ok: false, error: '审批请求已过期或已处理' }
  }
  agentLog.info(
    `[resumeAgentHitl] hitlId=${hitlId} decision=${decision} thread=${pending.threadId}`
  )
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

    const onTool = (e: ToolTimelineEvent) => {
      runToolEvents.push(e)
      emitTool(e)
    }
    const recursionLimit = settings.maxAgentLoopSteps
    const invokeTimeoutMs = settings.agentRunTimeoutMs
    const threadId = `${sessionId}:${runId}`

    const batcher = new StreamBatcher(STREAM_FLUSH_MS, STREAM_FLUSH_CHARS, (t) => {
      emit({ type: 'text-delta', sessionId, text: t, runId, traceId })
    })

    try {
      const streamedCharsRef = { current: 0 }

      const reactBridge: ReactRunBridge = {
        abortController: ac,
        recursionLimit,
        invokeTimeoutMs,
        streamedCharsRef,
        pushStreamToken: (token) => batcher.push(token),
        resetStream: () => {
          streamedCharsRef.current = 0
          emit({ type: 'stream-reset', sessionId, runId, traceId })
        },
        setPendingHitl: (hitlId, hitlThreadId, toolCalls) => {
          session.pendingHitl = { hitlId, threadId: hitlThreadId, toolCalls }
        },
        emitHitlRequired: (hitlId, toolCalls) => {
          reactBridge.resetStream()
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
        emitToolsRejected: (toolCalls) => {
          reactBridge.resetStream()
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
          signal: ac.signal,
          onTool,
          emit,
          runToolEvents,
          reactBridge
        },
        initRunCallbacks: {
          persistMessages: (messages) => {
            session.messages = messages
            persistSessionMessages(session.workspaceId, sessionId, messages)
          }
        }
      })

      session.messages = graphResult.messages
      session.pendingHitl = undefined

      if (streamedCharsRef.current === 0) {
        const lastAi = findLastAiMessage(session.messages)
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
