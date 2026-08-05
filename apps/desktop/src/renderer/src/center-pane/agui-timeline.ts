/**
 * 将 AG-UI BaseEvent 转为 UI 工具时间线（ToolTimelineEvent）。
 *
 * 转换仅在渲染层进行；主进程只透传 / 落盘原始 AG-UI 事件。
 */
import {
  EventType,
  type BaseEvent,
  type RunErrorEvent,
  type ToolCallArgsEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent
} from '@ag-ui/client'

import type { ToolTimelineEvent } from '@/shared/ipc'

/**
 * 判断事件是否属于工具时间线快照（应落盘 / 参与 UI 派生）。
 *
 * @param event - AG-UI BaseEvent
 * @returns 是否为工具/运行错误相关事件
 */
export function isAguiTimelineSourceEvent(event: BaseEvent): boolean {
  return (
    event.type === EventType.TOOL_CALL_START ||
    event.type === EventType.TOOL_CALL_ARGS ||
    event.type === EventType.TOOL_CALL_END ||
    event.type === EventType.TOOL_CALL_RESULT ||
    event.type === EventType.RUN_ERROR
  )
}

type TimelineMeta = {
  runId?: string
  traceId?: string
}

/**
 * 将 AG-UI 事件序列派生为 ToolTimelineEvent 列表（供手风琴展示）。
 *
 * @param events - 本轮累积的 AG-UI 事件（通常为 TOOL_CALL_* / RUN_ERROR）
 * @param meta - 可选 runId / traceId，写入时间线条目
 * @returns UI 时间线
 */
export function aguiEventsToToolTimeline(
  events: BaseEvent[],
  meta?: TimelineMeta
): ToolTimelineEvent[] {
  const out: ToolTimelineEvent[] = []
  const pending = new Map<string, { name: string; args?: string }>()
  const runId = meta?.runId
  const traceId = meta?.traceId

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
