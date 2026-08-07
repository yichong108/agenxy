/** 终端/命令单条输出最大字符（内置） */
export const MAX_TERMINAL_OUTPUT_CHARS = 10000

type RunRef = {
  traceId?: string
  runId?: string
}

type Timing = {
  timestampMs?: number
  durationMs?: number
}

type RunMeta = RunRef & Timing

/**
 * 工具调用时间线事件（UI / 持久化视图模型）。
 *
 * 由宿主从 AG-UI `TOOL_CALL_*` 事件派生，不直接等于协议事件。
 */
export type ToolCallEvent = {
  kind: 'tool'
  id: string
  name: string
  status: 'start' | 'end'
  args?: string
  result?: string
} & RunMeta

/**
 * 工具/运行错误时间线事件。
 */
export type ToolErrorEvent = {
  kind: 'error'
  message: string
  errorCode?: string
} & RunMeta

/**
 * 思考时间线事件（UI 视图模型）。
 *
 * 由宿主从 AG-UI `CUSTOM(cursor.thinking)` 派生；展示层归并为 Worked → Thought。
 */
export type ThinkingTimelineEvent = {
  kind: 'thinking'
  id: string
  text: string
} & RunMeta

/** 助手消息旁展示的工具/思考时间线条目（扁平原子事件，供展示层再聚合） */
export type ToolTimelineEvent = ToolCallEvent | ToolErrorEvent | ThinkingTimelineEvent
