import { findAndReplace } from 'mdast-util-find-and-replace'

import { aguiEventsToToolTimeline } from '@/renderer/src/center-pane/agui-timeline'
import type { ChatMessage, SessionInfo, ToolTimelineEvent } from '@/shared/ipc'

export const PRELOAD_MISSING_ERROR = '未检测到 preload 注入（window.bridge 不存在）'

/**
 * 根据消息与会话上下文计算助手消息的展示时间线。
 *
 * 历史消息：从落盘的 AG-UI 事件在渲染层派生；进行中：使用 liveTimeline。
 *
 * @param message - 当前消息
 * @param latestAssistantId - 最新 assistant 消息 id
 * @param isRun - 会话是否正在 run
 * @param liveTimeline - 直播时间线（已由 AG-UI 派生）
 * @returns 展示用 ToolTimelineEvent
 */
export function assistantDisplayTimeline(
  message: ChatMessage,
  latestAssistantId: string | null,
  isRun: boolean,
  liveTimeline: ToolTimelineEvent[]
): ToolTimelineEvent[] {
  if (message.role !== 'assistant') return []
  if (message.id === latestAssistantId && isRun) return liveTimeline
  if (message.aguiEvents && message.aguiEvents.length > 0) {
    return aguiEventsToToolTimeline(message.aguiEvents)
  }
  if (message.id === latestAssistantId && liveTimeline.length > 0) return liveTimeline
  return []
}

export function filterSessionsForSidebar(
  list: SessionInfo[] | undefined,
  hiddenIds: string[] | undefined
): SessionInfo[] {
  const hidden = new Set(hiddenIds ?? [])
  return (list ?? []).filter((s) => !hidden.has(s.id))
}

/** Cursor 风格时间线标题用：耗时 1 分 2.3 秒 */
export function formatWorkedDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const sec = ms / 1000
  if (sec < 60) {
    const t = sec.toFixed(1)
    return t.endsWith('.0') ? `${Math.round(sec)}s` : `${t}s`
  }
  const s = Math.floor(sec)
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return `${m}m ${rs}s`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h}h ${rm}m`
}

export type MessageTurn = {
  /** 消息组 ID */
  key: string
  /** 消息列表 */
  messages: ChatMessage[]
}

/**
 * 将消息转换为消息回合(比如一轮用户消息和一轮 assistant 消息算作一个回合)
 *
 * TODO: fix用户发送第二个回合消息后，第一个回合的 assistant 消息不见了。
 *
 * 将线性数组归类为回合数组，每个回合包含多个消息。
 *
 * 例如：
 * 输入：[
 *  { id: '1', role: 'user', content: 'Hello' },
 *  { id: '2', role: 'assistant', content: 'Hello, how can I help you?' },
 *  { id: '3', role: 'user', content: 'I have a question' },
 * ]
 * 输出：[
 *  { key: '1', messages: [{ id: '1', role: 'user', content: 'Hello' }] },
 *  { key: '2', messages: [{ id: '2', role: 'assistant', content: 'Hello, how can I help you?' }, { id: '3', role: 'user', content: 'I have a question' }] },
 * ]
 *
 * @param messages 消息
 * @returns 消息回合
 */
export function buildMessageTurns(messages: ChatMessage[]): MessageTurn[] {
  const turns: MessageTurn[] = []
  let batch: ChatMessage[] = []

  const flush = () => {
    if (batch.length === 0) return
    turns.push({ key: batch[0]!.id, messages: batch })
    batch = []
  }

  for (const m of messages) {
    if (m.role === 'user') {
      flush()
      batch = [m]
    } else if (batch.length === 0) {
      batch = [m]
    } else {
      batch.push(m)
    }
  }
  flush()
  return turns
}

export function randomId() {
  return `m-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function appendAssistantText(
  list: ChatMessage[],
  text: string,
  forceNew = false
): ChatMessage[] {
  const next = [...list]
  const last = next[next.length - 1]
  if (!forceNew && last?.role === 'assistant') {
    next[next.length - 1] = { ...last, content: text }
    return next
  }
  next.push({ id: randomId(), role: 'assistant', content: text })
  return next
}

export function remarkLinkifyBareUrls() {
  return (tree: Parameters<typeof findAndReplace>[0]) => {
    findAndReplace(
      tree,
      [
        [
          /https?:\/\/[^\s<>()]+/g,
          (rawUrl: string) => {
            const match = rawUrl.match(/^(.*?)([),.;!?，。！？、；：]+)?$/)
            const pureUrl = match?.[1] ?? rawUrl
            const trailing = match?.[2] ?? ''
            const linkNode = {
              type: 'link' as const,
              url: pureUrl,
              title: null,
              children: [{ type: 'text' as const, value: pureUrl }]
            }
            if (!trailing) return linkNode
            return [linkNode, { type: 'text' as const, value: trailing }]
          }
        ]
      ],
      {
        ignore: ['link', 'linkReference', 'code', 'inlineCode']
      }
    )
  }
}

export type RunStats = {
  runId?: string
  traceId?: string
  startedAt?: number
  durationMs?: number
  toolCalls: number
  toolErrors: number
  status: 'running' | 'done' | 'error'
}
