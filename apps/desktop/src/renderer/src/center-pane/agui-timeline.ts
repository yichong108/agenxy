/**
 * 将 AG-UI BaseEvent 转为 UI 工具时间线（ToolTimelineEvent）。
 *
 * 转换仅在渲染层进行；主进程只透传 / 落盘原始 AG-UI 事件。
 * Worked / Explored 等分层由 `worked-timeline.ts` 在展示层再归并。
 */
import {
  EventType,
  type BaseEvent,
  type CustomEvent,
  type RunErrorEvent,
  type ToolCallArgsEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent
} from '@ag-ui/client'

import type { ToolTimelineEvent } from '@/shared/ipc'

/** Cursor / 思考类 CUSTOM 事件名 */
export const CURSOR_THINKING_CUSTOM_NAME = 'cursor.thinking'

/**
 * 运行中 Result 打字机预览增量（尚未写入 AG-UI TEXT_MESSAGE）。
 * 仅影响 UI 展示缓冲，不进入 Worked 时间线。
 */
export const TEXT_DELTA_CUSTOM_NAME = 'openworker.text.delta'

/**
 * 撤回本步已流式预览的 Result 文本（工具步在转入 Thought 前发出）。
 * 仅影响 UI / 宿主侧展示缓冲，不进入 Worked 时间线。
 */
export const TEXT_REVOKE_CUSTOM_NAME = 'openworker.text.revoke'

/**
 * 判断事件是否属于时间线快照（应落盘 / 参与 UI 派生）。
 *
 * 含 TOOL_CALL_*、RUN_ERROR，以及 `CUSTOM(cursor.thinking)`。
 *
 * @param event - AG-UI BaseEvent
 * @returns 是否为时间线相关事件
 */
export function isAguiTimelineSourceEvent(event: BaseEvent): boolean {
  if (
    event.type === EventType.TOOL_CALL_START ||
    event.type === EventType.TOOL_CALL_ARGS ||
    event.type === EventType.TOOL_CALL_END ||
    event.type === EventType.TOOL_CALL_RESULT ||
    event.type === EventType.RUN_ERROR
  ) {
    return true
  }
  if (event.type === EventType.CUSTOM) {
    return (event as CustomEvent).name === CURSOR_THINKING_CUSTOM_NAME
  }
  return false
}

type TimelineMeta = {
  runId?: string
  traceId?: string
}

type ThinkingCustomValue = {
  text?: unknown
  thinkingDurationMs?: unknown
}

/**
 * 从 CUSTOM(cursor.thinking) 解析思考文本与耗时。
 *
 * @param event - AG-UI CustomEvent
 * @returns 文本与可选耗时；无有效文本时返回 null
 */
function parseThinkingCustom(event: CustomEvent): { text: string; durationMs?: number } | null {
  const value = event.value as ThinkingCustomValue | string | null | undefined
  if (typeof value === 'string') {
    const text = value.trim()
    return text ? { text } : null
  }
  if (!value || typeof value !== 'object') return null
  const text = typeof value.text === 'string' ? value.text.trim() : ''
  if (!text) return null
  const durationMs =
    typeof value.thinkingDurationMs === 'number' && Number.isFinite(value.thinkingDurationMs)
      ? value.thinkingDurationMs
      : undefined
  return { text, durationMs }
}

/**
 * 将 AG-UI 事件序列派生为扁平 ToolTimelineEvent 列表。
 *
 * @param events - 本轮累积的 AG-UI 事件（TOOL_CALL_* / RUN_ERROR / cursor.thinking）
 * @param meta - 可选 runId / traceId，写入时间线条目
 * @returns UI 扁平时间线（展示层再归并为 Worked 树）
 */
export function aguiEventsToToolTimeline(
  events: BaseEvent[],
  meta?: TimelineMeta
): ToolTimelineEvent[] {
  const out: ToolTimelineEvent[] = []
  const pending = new Map<string, { name: string; args?: string }>()
  const runId = meta?.runId
  const traceId = meta?.traceId
  let thinkingSeq = 0

  for (const event of events) {
    if (event.type === EventType.TOOL_CALL_START) {
      const e = event as ToolCallStartEvent
      pending.set(e.toolCallId, { name: e.toolCallName })
      continue
    }

    if (event.type === EventType.TOOL_CALL_ARGS) {
      const e = event as ToolCallArgsEvent
      const cur = pending.get(e.toolCallId)
      if (!cur) continue
      pending.set(e.toolCallId, { ...cur, args: e.delta })
      out.push({
        kind: 'tool',
        id: e.toolCallId,
        name: cur.name,
        status: 'start',
        args: e.delta,
        runId,
        traceId,
        timestampMs: e.timestamp ?? Date.now()
      })
      continue
    }

    if (event.type === EventType.TOOL_CALL_RESULT) {
      const e = event as ToolCallResultEvent
      const cur = pending.get(e.toolCallId)
      pending.delete(e.toolCallId)
      const end: ToolTimelineEvent = {
        kind: 'tool',
        id: e.toolCallId,
        name: cur?.name ?? 'unknown',
        status: 'end',
        args: cur?.args,
        result: e.content,
        runId,
        traceId,
        timestampMs: e.timestamp ?? Date.now()
      }
      const idx = out.findIndex((x) => x.kind === 'tool' && x.id === e.toolCallId)
      if (idx >= 0) {
        out[idx] = end
      } else {
        out.push(end)
      }
      continue
    }

    if (event.type === EventType.CUSTOM) {
      const e = event as CustomEvent
      if (e.name !== CURSOR_THINKING_CUSTOM_NAME) continue
      const parsed = parseThinkingCustom(e)
      if (!parsed) continue
      thinkingSeq += 1
      out.push({
        kind: 'thinking',
        id: `thinking-${thinkingSeq}-${e.timestamp ?? thinkingSeq}`,
        text: parsed.text,
        durationMs: parsed.durationMs,
        runId,
        traceId,
        timestampMs: e.timestamp ?? Date.now()
      })
      continue
    }

    if (event.type === EventType.RUN_ERROR) {
      const e = event as RunErrorEvent
      out.push({
        kind: 'error',
        message: e.message,
        errorCode: e.code,
        runId,
        traceId,
        timestampMs: e.timestamp ?? Date.now()
      })
    }
  }

  return out
}
