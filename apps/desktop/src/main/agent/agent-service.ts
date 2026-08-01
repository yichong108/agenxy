import {
  type Agent,
  assistantMessage,
  contentToText,
  type CoreMessage,
  killCommand,
  resolveChatModel,
  type ToolObservation,
  userMessage
} from '@agenwork/agent'
import type { WebContents } from 'electron'

import { createSessionAgent } from '@/main/agent/agent-instance'
import { agentLog } from '@/main/agent/agent-log'
import { flushLangfuseTracing } from '@/main/langfuse'
import { getSessionMessages, getSettings, getWorkspaceById, setSessionMessages } from '@/main/store'
import {
  type AgentSendOptions,
  type ChatMessage,
  EVENTS,
  MAX_AGENT_LOOP_STEPS,
  normalizeComposerMode,
  type StreamEvent,
  type ToolTimelineEvent
} from '@/shared/ipc'

/** @deprecated 从 `@/main/agent/agent-log` 导入 */
export { agentLog } from '@/main/agent/agent-log'

type SessionRuntime = {
  workspaceId: string
  /** 该会话独立的 agent 实例（勿跨会话复用） */
  agent: Agent
  messages: CoreMessage[]
  controller: AbortController | null
  terminalKey: string
  /** 本轮发给 UI 的用户展示文案（与模型侧 content 可能不同） */
  pendingUserDisplayText?: string
}

/**
 * 按工作区创建会话级 agent。
 *
 * @param workspaceId - 工作区 ID
 * @returns 新 Agent
 */
function createAgentForWorkspace(workspaceId: string): Agent {
  const cwd = getWorkspaceById(workspaceId)?.path?.trim() || undefined
  return createSessionAgent({ cwd })
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

/**
 * 将内存中的 CoreMessage 转为可持久化的 ChatMessage。
 *
 * 仅保留 user 与最后一条有文本的 assistant；tool 轮次靠 toolEvents 承载。
 * 最后一个 user 消息优先使用 pendingUserDisplayText（UI 展示文案）。
 *
 * @param coreMessages - AI SDK CoreMessage 列表
 * @param userDisplayText - 本轮用户展示文案（可选）
 * @returns ChatMessage 列表
 */
function toPersistedMessages(coreMessages: CoreMessage[], userDisplayText?: string): ChatMessage[] {
  const visible = coreMessages.filter((msg) => msg.role === 'user' || msg.role === 'assistant')

  let lastAssistantIndex = -1
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    if (visible[i]?.role === 'assistant') {
      lastAssistantIndex = i
      break
    }
  }

  let lastUserIndex = -1
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    if (visible[i]?.role === 'user') {
      lastUserIndex = i
      break
    }
  }

  const out: ChatMessage[] = []
  for (let i = 0; i < visible.length; i += 1) {
    const msg = visible[i]!
    if (msg.role === 'user') {
      const content =
        i === lastUserIndex && userDisplayText?.trim()
          ? userDisplayText
          : contentToText(msg.content)
      out.push({
        id: `u-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'user',
        content
      })
      continue
    }
    if (msg.role === 'assistant') {
      if (i !== lastAssistantIndex) continue
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

/**
 * 从持久化 ChatMessage 恢复为 AI SDK CoreMessage。
 *
 * @param messages - 磁盘/store 中的 ChatMessage
 * @returns CoreMessage 列表
 */
function fromPersistedMessages(messages: ChatMessage[]): CoreMessage[] {
  const list: CoreMessage[] = []
  for (const msg of messages) {
    if (!msg.content?.trim()) continue
    if (msg.role === 'user') {
      list.push(userMessage(msg.content))
      continue
    }
    if (msg.role === 'assistant') {
      list.push(assistantMessage(msg.content))
      continue
    }
    if (msg.role === 'system') {
      list.push({ role: 'system', content: msg.content })
    }
  }
  return list
}

function persistSessionMessages(
  workspaceId: string,
  sessionId: string,
  coreMessages: CoreMessage[],
  opts?: {
    toolEventsForLastAssistant?: ToolTimelineEvent[]
    userDisplayText?: string
  }
): void {
  const list = toPersistedMessages(coreMessages, opts?.userDisplayText)
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

export function bindAgentIpc(wc: WebContents): void {
  webContents = wc
}

/**
 * 初始化或校正会话运行时：每个会话绑定独立 agent。
 *
 * 若会话已存在但工作区变更，则重建该会话的 agent（更新 cwd）。
 *
 * @param workspaceId - 工作区 ID
 * @param sessionId - 会话 ID
 */
export function initSessionState(workspaceId: string, sessionId: string): void {
  const existing = sessions.get(sessionId)
  if (existing) {
    if (existing.workspaceId !== workspaceId) {
      existing.workspaceId = workspaceId
      existing.agent = createAgentForWorkspace(workspaceId)
    }
    return
  }

  const persisted = getSessionMessages(workspaceId, sessionId)
  sessions.set(sessionId, {
    workspaceId,
    agent: createAgentForWorkspace(workspaceId),
    messages: fromPersistedMessages(persisted),
    controller: null,
    terminalKey: `term:${sessionId}`
  })
}

/**
 * 读取会话内存中的 CoreMessage 列表。
 *
 * @param sessionId - 会话 ID
 * @returns CoreMessage 列表（无会话时为空数组）
 */
export function getSessionCoreMessages(sessionId: string): CoreMessage[] {
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
  void killCommand(`term:${sessionId}`)
}

/**
 * 当前会话是否已有智能体在运行。
 *
 * @param sessionId - 会话 ID
 * @returns 若该会话存在且 controller 非空则为 true
 */
export function isSessionRunning(sessionId: string): boolean {
  return Boolean(sessions.get(sessionId)?.controller)
}

/**
 * 运行用户消息。
 *
 * 同会话同时只允许一次 run：已有运行中的智能体时直接拒绝。
 * 不同会话各自独立，可并行执行。
 *
 * @param sessionId - 会话 ID
 * @param userText - 用户输入文本
 * @param options - 发送选项（模式等）
 */
export async function runUserMessage(
  sessionId: string,
  userText: string,
  options?: AgentSendOptions
): Promise<void> {
  const composerMode = normalizeComposerMode(options?.mode)
  const agentUserText = userText.trim()
  const userDisplayText = options?.userDisplayText?.trim() || agentUserText
  if (!agentUserText) {
    emit({ type: 'error', sessionId, message: '消息为空' })
    return
  }
  const settings = getSettings()
  agentLog.info(`settings: ${JSON.stringify(settings, null, 2)}, composerMode: ${composerMode}`)

  const session = sessions.get(sessionId)
  if (!session) {
    emit({ type: 'error', sessionId, message: '会话不存在或已过期' })
    return
  }
  if (session.controller) {
    throw new Error('当前会话已有智能体在运行，请等待完成或停止后再发送')
  }

  const workspace = getWorkspaceById(session.workspaceId)
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

  const ac = new AbortController()
  // 在任意 await 之前占住会话，避免同会话并发进入
  session.controller = ac
  session.pendingUserDisplayText = userDisplayText

  const runId = makeRunId()
  const traceId = makeTraceId(sessionId, runId)
  const runStartedAt = Date.now()
  const runToolEvents: ToolTimelineEvent[] = []

  try {
    agentLog.info(
      `[runUserMessage] run-start: ${runId}, traceId: ${traceId}, sessionId: ${sessionId}, timestampMs: ${runStartedAt}`
    )
    emit({ type: 'run-start', sessionId, runId, traceId, timestampMs: runStartedAt })

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

    /** agent 仅上报 ToolObservation；宿主映射为 UI/IPC 用的 ToolTimelineEvent */
    const onTool = (obs: ToolObservation) => {
      const e: ToolTimelineEvent = {
        kind: 'tool',
        ...obs,
        runId: obs.runId ?? runId,
        traceId: obs.traceId ?? traceId,
        timestampMs: obs.timestampMs ?? Date.now()
      }
      runToolEvents.push(e)
      emitTool(e)
    }

    // 用户消息的追加与持久化由宿主完成；agent 只消费已含本轮用户消息的列表
    session.messages = [...session.messages, userMessage(agentUserText)]
    persistSessionMessages(session.workspaceId, sessionId, session.messages, {
      userDisplayText: session.pendingUserDisplayText
    })

    const model = resolveChatModel(settings)
    if (!model) {
      throw new Error('请先在设置中配置 API Key')
    }

    const graphResult = await session.agent.send({
      composerMode,
      messages: session.messages,
      model,
      abortController: ac,
      settings,
      runMeta: {
        sessionId,
        runId,
        traceId,
        workspaceId: session.workspaceId,
        root,
        userDisplayText,
        agentUserText
      },
      maxSteps: MAX_AGENT_LOOP_STEPS,
      invokeTimeoutMs: settings.agentRunTimeoutMs,
      callbacks: {
        onTextDelta: (text) => {
          emit({ type: 'text-delta', sessionId, text, runId, traceId })
        },
        onTool,
        emit
      }
    })

    const latest = sessions.get(sessionId)
    if (!latest) return

    latest.messages = graphResult.messages

    persistSessionMessages(latest.workspaceId, sessionId, latest.messages, {
      toolEventsForLastAssistant: runToolEvents.length > 0 ? runToolEvents : undefined,
      userDisplayText: latest.pendingUserDisplayText
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

    emit({
      type: 'error',
      sessionId,
      message,
      runId,
      traceId,
      timestampMs: Date.now(),
      durationMs: Date.now() - runStartedAt
    })

    const latest = sessions.get(sessionId)
    if (latest) {
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
          durationMs: Date.now() - runStartedAt
        }
      })
      persistSessionMessages(latest.workspaceId, sessionId, latest.messages, {
        toolEventsForLastAssistant: runToolEvents.length > 0 ? runToolEvents : undefined,
        userDisplayText: latest.pendingUserDisplayText
      })
    }
  } finally {
    const latest = sessions.get(sessionId)
    if (latest) {
      latest.controller = null
      latest.pendingUserDisplayText = undefined
    }
    void flushLangfuseTracing()
  }
}
