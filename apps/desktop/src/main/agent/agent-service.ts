import {
  killCommand,
  OpenWorkerAgent,
  type OpenWorkerAgentRunDefaults,
  resolveChatModel
} from '@openworker/agent'
import {
  EventType,
  type BaseEvent,
  type Message,
  type RunErrorEvent,
  type RunStartedEvent
} from '@ag-ui/client'
import type { WebContents } from 'electron'

import { createSessionOpenWorkerAgent } from '@/main/agent/agent-instance'
import { agentLog } from '@/main/agent/agent-log'
import { flushLangfuseTracing } from '@/main/langfuse'
import { getSessionMessages, getSettings, getWorkspaceById, setSessionMessages } from '@/main/store'
import {
  type AgentSendOptions,
  type AgentStreamPayload,
  type ChatMessage,
  EVENTS,
  MAX_AGENT_LOOP_STEPS,
  normalizeComposerMode
} from '@/shared/ipc'

/** @deprecated 从 `@/main/agent/agent-log` 导入 */
export { agentLog } from '@/main/agent/agent-log'

/** agent.subscribe 返回的取消句柄 */
type AgentUnsubscribe = { unsubscribe: () => void }

type SessionRuntime = {
  workspaceId: string
  /** 该会话独立的 AG-UI agent（勿跨会话复用）；消息以 agent.messages 为准 */
  agent: OpenWorkerAgent
  controller: AbortController | null
  subscription: AgentUnsubscribe | null
  terminalKey: string
}

/**
 * 按工作区创建会话级 OpenWorkerAgent。
 *
 * @param workspaceId - 工作区 ID
 * @param sessionId - 会话 ID（作为 AG-UI threadId）
 * @param messages - AG-UI 初始消息（可选）
 * @returns 新 OpenWorkerAgent
 */
function createAgentForWorkspace(
  workspaceId: string,
  sessionId: string,
  messages?: Message[]
): OpenWorkerAgent {
  const cwd = getWorkspaceById(workspaceId)?.path?.trim() || undefined
  return createSessionOpenWorkerAgent({ cwd, messages, threadId: sessionId })
}

const sessions = new Map<string, SessionRuntime>()
let webContents: WebContents | null = null
const MAX_PERSISTED_MESSAGES = 200

/**
 * 生成本轮 runId。
 *
 * @returns runId 字符串
 */
function makeRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 将 AG-UI Message content 转为纯文本（持久化 / 展示用）。
 *
 * @param content - AG-UI Message.content
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
 * 向渲染层推送 AG-UI 事件信封。
 *
 * @param payload - sessionId + BaseEvent
 */
function emit(payload: AgentStreamPayload): void {
  if (!webContents || webContents.isDestroyed()) return
  webContents.send(EVENTS.AGENT_STREAM, payload)
}

/**
 * 裁剪持久化消息数量上限。
 *
 * @param messages - ChatMessage 列表
 * @returns 裁剪后的列表
 */
function trimPersistedMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_PERSISTED_MESSAGES) return messages
  return messages.slice(-MAX_PERSISTED_MESSAGES)
}

/**
 * 将 AG-UI Message 转为可持久化的 ChatMessage。
 *
 * 仅保留 user 与最后一条有文本的 assistant；工具过程靠 aguiEvents 承载。
 *
 * @param messages - AG-UI Message 列表
 * @returns ChatMessage 列表
 */
function toPersistedMessages(messages: Message[]): ChatMessage[] {
  const visible = messages.filter((msg) => msg.role === 'user' || msg.role === 'assistant')

  let lastAssistantIndex = -1
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    if (visible[i]?.role === 'assistant') {
      lastAssistantIndex = i
      break
    }
  }

  const out: ChatMessage[] = []
  for (let i = 0; i < visible.length; i += 1) {
    const msg = visible[i]!
    if (msg.role === 'user') {
      out.push({
        id: msg.id || `u-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'user',
        content: aguiContentToText(msg.content)
      })
      continue
    }
    if (msg.role === 'assistant') {
      if (i !== lastAssistantIndex) continue
      const content = aguiContentToText(msg.content)
      if (!content.trim()) continue
      out.push({
        id: msg.id || `a-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'assistant',
        content
      })
    }
  }
  return trimPersistedMessages(out)
}

/**
 * 从持久化 ChatMessage 恢复为 AG-UI Message。
 *
 * @param messages - 磁盘/store 中的 ChatMessage
 * @returns AG-UI Message 列表
 */
function fromPersistedMessages(messages: ChatMessage[]): Message[] {
  const list: Message[] = []
  for (const msg of messages) {
    if (!msg.content?.trim()) continue
    if (msg.role === 'user') {
      list.push({ id: msg.id, role: 'user', content: msg.content })
      continue
    }
    if (msg.role === 'assistant') {
      list.push({ id: msg.id, role: 'assistant', content: msg.content })
      continue
    }
    if (msg.role === 'system') {
      list.push({ id: msg.id, role: 'system', content: msg.content })
    }
  }
  return list
}

/**
 * 将 AG-UI 消息轨迹持久化为 ChatMessage，并可选挂上本轮 AG-UI 事件快照。
 *
 * @param workspaceId - 工作区 ID
 * @param sessionId - 会话 ID
 * @param messages - 本轮结束后的完整 AG-UI 轨迹
 * @param opts - 可选：挂到最后一条 assistant 的 aguiEvents（原始 AG-UI，不做 UI 转换）
 */
function persistSessionMessages(
  workspaceId: string,
  sessionId: string,
  messages: Message[],
  opts?: {
    aguiEventsForLastAssistant?: BaseEvent[]
  }
): void {
  const list = toPersistedMessages(messages)
  const aguiEvents = opts?.aguiEventsForLastAssistant
  if (aguiEvents && aguiEvents.length > 0) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const row = list[i]
      if (row?.role === 'assistant') {
        list[i] = { ...row, aguiEvents }
        break
      }
    }
  }
  setSessionMessages(workspaceId, sessionId, list)
}

/**
 * 绑定主窗口 webContents，用于推送 AGENT_STREAM。
 *
 * @param wc - Electron WebContents
 */
export function bindAgentIpc(wc: WebContents): void {
  webContents = wc
}

/**
 * 初始化或校正会话运行时：每个会话绑定独立 OpenWorkerAgent。
 *
 * 若会话已存在但工作区变更，则重建该会话的 agent（更新 cwd），并保留 AG-UI 消息。
 *
 * @param workspaceId - 工作区 ID
 * @param sessionId - 会话 ID
 */
export function initSessionState(workspaceId: string, sessionId: string): void {
  const existing = sessions.get(sessionId)
  if (existing) {
    if (existing.workspaceId !== workspaceId) {
      existing.workspaceId = workspaceId
      existing.agent = createAgentForWorkspace(workspaceId, sessionId, existing.agent.messages)
    }
    return
  }

  const messages = fromPersistedMessages(getSessionMessages(workspaceId, sessionId))
  sessions.set(sessionId, {
    workspaceId,
    agent: createAgentForWorkspace(workspaceId, sessionId, messages),
    controller: null,
    subscription: null,
    terminalKey: `term:${sessionId}`
  })
}

/**
 * 读取会话当前 AG-UI Message 列表。
 *
 * @param sessionId - 会话 ID
 * @returns AG-UI Message 列表（无会话时为空数组）
 */
export function getSessionAguiMessages(sessionId: string): Message[] {
  return sessions.get(sessionId)?.agent.messages ?? []
}

/**
 * 清除会话运行时：取消进行中的 run、杀掉终端进程并删除会话条目。
 *
 * @param sessionId - 会话 ID
 */
export function clearSessionState(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (s?.controller) {
    s.controller.abort()
  }
  s?.subscription?.unsubscribe()
  s?.agent.abortRun()
  void killCommand(s?.terminalKey ?? `term:${sessionId}`)
  sessions.delete(sessionId)
}

/**
 * 取消当前会话进行中的 run。
 *
 * @param sessionId - 会话 ID
 */
export function cancelRun(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (s?.controller) {
    s.controller.abort()
  }
  s?.agent.abortRun()
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
 * 发送预检失败的 AG-UI 边界事件（RUN_STARTED + RUN_ERROR）。
 *
 * @param sessionId - 会话 ID
 * @param message - 错误文案
 * @param runId - 可选 runId
 */
function emitPreRunError(sessionId: string, message: string, runId?: string): void {
  const id = runId ?? makeRunId()
  const started: RunStartedEvent = {
    type: EventType.RUN_STARTED,
    threadId: sessionId,
    runId: id,
    timestamp: Date.now()
  }
  emit({ sessionId, event: started })
  const err: RunErrorEvent = {
    type: EventType.RUN_ERROR,
    message,
    code: 'ERROR',
    timestamp: Date.now()
  }
  emit({ sessionId, event: err })
}

/**
 * 收集本轮与工具时间线相关的原始 AG-UI 事件（供落盘；不做 UI 转换）。
 *
 * @returns 累加器：onEvent + getEvents
 */
function createAguiTimelineEventCollector(): {
  onEvent: (event: BaseEvent) => void
  getEvents: () => BaseEvent[]
} {
  const events: BaseEvent[] = []
  return {
    onEvent(event: BaseEvent) {
      if (
        event.type === EventType.TOOL_CALL_START ||
        event.type === EventType.TOOL_CALL_ARGS ||
        event.type === EventType.TOOL_CALL_END ||
        event.type === EventType.TOOL_CALL_RESULT ||
        event.type === EventType.RUN_ERROR
      ) {
        events.push(event)
      }
    },
    getEvents: () => events
  }
}

/**
 * 运行用户消息（经 OpenWorkerAgent / AG-UI runAgent）。
 *
 * 同会话同时只允许一次 run：已有运行中的智能体时直接拒绝。
 * 不同会话各自独立，可并行执行。
 * Desktop 仅组装 AG-UI Message 与 RunAgentInput；CoreMessage 转换留在 OpenWorkerAgent 内部。
 *
 * @param sessionId - 会话 ID
 * @param userText - 用户输入文本
 * @param options - 发送选项（模式、工作区路径等）
 */
export async function runUserMessage(
  sessionId: string,
  userText: string,
  options?: AgentSendOptions
): Promise<void> {
  const composerMode = normalizeComposerMode(options?.mode)
  const agentUserText = userText.trim()
  if (!agentUserText) {
    emitPreRunError(sessionId, '消息为空')
    return
  }
  const settings = getSettings()
  agentLog.info(`settings: ${JSON.stringify(settings, null, 2)}, composerMode: ${composerMode}`)

  const session = sessions.get(sessionId)
  if (!session) {
    emitPreRunError(sessionId, '会话不存在或已过期')
    return
  }
  if (session.controller) {
    throw new Error('当前会话已有智能体在运行，请等待完成或停止后再发送')
  }

  const workspace = getWorkspaceById(session.workspaceId)
  // 本轮 send 可显式传入路径；未传时回退会话绑定工作区
  const workspacePath = options?.workspacePath?.trim() || workspace?.path?.trim() || ''
  agentLog.info(
    `[runUserMessage] workspacePath: ${workspacePath}, sessionWorkspace: ${workspace?.path}`
  )

  if (!workspacePath) {
    emitPreRunError(sessionId, '当前会话未绑定工作区目录，请先绑定路径')
    return
  }

  const provider = resolveChatModel(settings)
  if (!provider) {
    emitPreRunError(sessionId, '请先在设置中配置 API Key')
    return
  }

  const ac = new AbortController()
  // 在任意 await 之前占住会话，避免同会话并发进入
  session.controller = ac

  const runId = makeRunId()
  const runStartedAt = Date.now()
  const aguiCollector = createAguiTimelineEventCollector()

  const forwardedProps: OpenWorkerAgentRunDefaults = {
    composerMode,
    provider,
    abortController: ac,
    workspacePath,
    terminalKey: session.terminalKey,
    tavily: { apiKey: settings.tavilyApiKey },
    maxSteps: MAX_AGENT_LOOP_STEPS,
    invokeTimeoutMs: settings.agentRunTimeoutMs
  }

  // 追加本轮用户消息到 AG-UI agent.messages；runAgent 以之为 RunAgentInput.messages
  const userMessage: Message = {
    id: `u-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: 'user',
    content: agentUserText
  }
  session.agent.messages = [...session.agent.messages, userMessage]

  try {
    agentLog.info(
      `[runUserMessage] run-start: ${runId}, sessionId: ${sessionId}, timestampMs: ${runStartedAt}`
    )

    const sub = session.agent.subscribe({
      onEvent: ({ event }) => {
        aguiCollector.onEvent(event)
        emit({ sessionId, event })
      }
    })
    session.subscription = sub

    await session.agent.runAgent({
      runId,
      tools: [],
      context: [],
      forwardedProps
    })

    const latest = sessions.get(sessionId)
    if (!latest) return

    const aguiEvents = aguiCollector.getEvents()
    persistSessionMessages(latest.workspaceId, sessionId, latest.agent.messages, {
      aguiEventsForLastAssistant: aguiEvents.length > 0 ? aguiEvents : undefined
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const err: RunErrorEvent = {
      type: EventType.RUN_ERROR,
      message,
      code: 'ERROR',
      timestamp: Date.now()
    }
    emit({ sessionId, event: err })
    aguiCollector.onEvent(err)

    const latest = sessions.get(sessionId)
    if (latest) {
      const aguiEvents = aguiCollector.getEvents()
      persistSessionMessages(latest.workspaceId, sessionId, latest.agent.messages, {
        aguiEventsForLastAssistant: aguiEvents.length > 0 ? aguiEvents : undefined
      })
    }
  } finally {
    const latest = sessions.get(sessionId)
    if (latest) {
      latest.subscription?.unsubscribe()
      latest.controller = null
      latest.subscription = null
    }
    void flushLangfuseTracing()
  }
}
