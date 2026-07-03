import {
  type AgentMessage,
  aiMessage,
  contentToText,
  getAgentMessageType,
  type HitlUserDecision,
  humanMessage,
  isInternalAgentMessage,
  type PendingToolCall
} from '@agenxy/agent'
import type { WebContents } from 'electron'

import { desktopAgent } from '@/main/agent/agent-instance'
import { agentLog } from '@/main/agent/agent-log'
import { flushLangfuseTracing } from '@/main/langfuse'
import { getSessionMessages, getSettings, getWorkspaceById, setSessionMessages } from '@/main/store'
import { killCommand } from '@/main/tools/terminal'
import {
  type AgentSendOptions,
  type ChatMessage,
  EVENTS,
  normalizeComposerMode,
  type StreamEvent,
  type ToolTimelineEvent
} from '@/shared/ipc'

/** @deprecated 从 `@/main/agent/agent-log` 导入 */
export { agentLog } from '@/main/agent/agent-log'

type SessionRuntime = {
  workspaceId: string
  messages: AgentMessage[]
  controller: AbortController | null
  terminalKey: string
  pendingHitl?: {
    hitlId: string
    threadId: string
    toolCalls: PendingToolCall[]
  }
}

const sessions = new Map<string, SessionRuntime>()
let webContents: WebContents | null = null
const MAX_PERSISTED_MESSAGES = 200

function makeRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function makeTraceId(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`
}

function emit(event: StreamEvent): void {
  if (!webContents || webContents.isDestroyed()) return
  webContents.send(EVENTS.AGENT_STREAM, event)
}

function trimPersistedMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_PERSISTED_MESSAGES) return messages
  return messages.slice(-MAX_PERSISTED_MESSAGES)
}

function toPersistedMessages(coreMessages: AgentMessage[]): ChatMessage[] {
  const visible: AgentMessage[] = []
  for (const msg of coreMessages) {
    const messageType = getAgentMessageType(msg)
    if (messageType === 'system' || isInternalAgentMessage(msg)) continue
    visible.push(msg)
  }

  let lastAiIndex = -1
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    if (getAgentMessageType(visible[i]) === 'ai') {
      lastAiIndex = i
      break
    }
  }

  const out: ChatMessage[] = []
  for (let i = 0; i < visible.length; i += 1) {
    const msg = visible[i]!
    const messageType = getAgentMessageType(msg)
    if (messageType === 'human') {
      const display =
        msg.type === 'human' && msg.displayText ? msg.displayText : contentToText(msg.content)
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

function fromPersistedMessages(messages: ChatMessage[]): AgentMessage[] {
  const list: AgentMessage[] = []
  for (const msg of messages) {
    if (!msg.content?.trim()) continue
    if (msg.role === 'user') {
      list.push(humanMessage(msg.content))
      continue
    }
    if (msg.role === 'assistant') {
      list.push(aiMessage(msg.content))
      continue
    }
    if (msg.role === 'system') {
      list.push({ type: 'system', content: msg.content })
    }
  }
  return list
}

function persistSessionMessages(
  workspaceId: string,
  sessionId: string,
  coreMessages: AgentMessage[],
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

export function getSessionCoreMessages(sessionId: string): AgentMessage[] {
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
  desktopAgent.cancelAllHitlWaiters('运行已取消')
  void killCommand(`term:${sessionId}`)
}

/**
 * 恢复 HITL：将用户决策交给 agent，由 ReAct 循环继续执行。
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
  const submitted = desktopAgent.submitHitlDecision(hitlId, decision)
  if (!submitted) {
    return { ok: false, error: '审批请求已过期或已处理' }
  }
  agentLog.info(
    `[resumeAgentHitl] hitlId=${hitlId} decision=${decision} thread=${pending.threadId}`
  )
  return { ok: true }
}

/**
 * 运行用户消息。
 */
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

  let runId = ''
  let traceId = ''
  let runStartedAt = 0
  let runToolEvents: ToolTimelineEvent[] = []

  try {
    const graphResult = await desktopAgent.runQueued(async () => {
      const session = sessions.get(sessionId)
      if (!session) {
        agentLog.error(`[runUserMessage] session not found for sessionId: ${sessionId}`)
        emit({ type: 'error', sessionId, message: '会话不存在或已过期' })
        throw new Error('会话不存在或已过期')
      }

      const ac = new AbortController()
      runId = makeRunId()
      traceId = makeTraceId(sessionId, runId)
      runStartedAt = Date.now()
      session.controller = ac
      runToolEvents = []

      agentLog.info(
        `[runUserMessage] run-start: ${runId}, traceId: ${traceId}, sessionId: ${sessionId}, timestampMs: ${runStartedAt}`
      )
      emit({ type: 'run-start', sessionId, runId, traceId, timestampMs: runStartedAt })

      const threadId = `${sessionId}:${runId}`

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

      return {
        composerMode,
        messages: session.messages,
        abortController: ac,
        settings,
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
        recursionLimit: settings.maxAgentLoopSteps,
        invokeTimeoutMs: settings.agentRunTimeoutMs,
        callbacks: {
          onTextDelta: (text) => {
            emit({ type: 'text-delta', sessionId, text, runId, traceId })
          },
          onStreamReset: () => {
            emit({ type: 'stream-reset', sessionId, runId, traceId })
          },
          onHitlRequired: (hitlId, toolCalls) => {
            emit({
              type: 'hitl-required',
              sessionId,
              runId,
              traceId,
              hitlId,
              toolCalls
            })
          },
          onToolsRejected: () => {},
          onTool,
          emit,
          persistMessages: (messages) => {
            session.messages = messages
            persistSessionMessages(session.workspaceId, sessionId, messages)
          },
          setPendingHitl: (hitlId, hitlThreadId, toolCalls) => {
            session.pendingHitl = { hitlId, threadId: hitlThreadId, toolCalls }
          }
        }
      }
    }, onQueued)

    const session = sessions.get(sessionId)
    if (!session) return

    session.messages = graphResult.messages
    session.pendingHitl = undefined

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
    const message = e instanceof Error ? e.message : String(e)
    if (message === '会话不存在或已过期') return

    emit({
      type: 'error',
      sessionId,
      message,
      runId,
      traceId,
      timestampMs: Date.now(),
      durationMs: runStartedAt > 0 ? Date.now() - runStartedAt : undefined
    })

    const session = sessions.get(sessionId)
    if (session) {
      emit({
        type: 'tool',
        sessionId,
        runId,
        traceId,
        event: {
          kind: 'error',
          message,
          runId,
          traceId,
          timestampMs: Date.now(),
          durationMs: runStartedAt > 0 ? Date.now() - runStartedAt : undefined
        }
      })
      persistSessionMessages(session.workspaceId, sessionId, session.messages, {
        toolEventsForLastAssistant: runToolEvents.length > 0 ? runToolEvents : undefined
      })
    }
  } finally {
    const session = sessions.get(sessionId)
    if (session) {
      session.controller = null
      session.pendingHitl = undefined
    }
    void flushLangfuseTracing()
  }
}
