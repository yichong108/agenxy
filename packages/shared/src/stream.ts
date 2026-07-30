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

export type ToolCallEvent = {
  kind: 'tool'
  id: string
  name: string
  status: 'start' | 'end'
  args?: string
  result?: string
} & RunMeta

export type ToolErrorEvent = {
  kind: 'error'
  message: string
  errorCode?: string
} & RunMeta

export type ToolTimelineEvent = ToolCallEvent | ToolErrorEvent

type StreamBase = {
  sessionId: string
} & RunRef

export type StreamTextDeltaEvent = StreamBase & {
  type: 'text-delta'
  text: string
}

export type StreamIntentClassifiedEvent = StreamBase &
  RunRef & {
    type: 'intent-classified'
    intent: string
    skillNames: string[]
    error?: string
  }

export type StreamToolEvent = StreamBase & {
  type: 'tool'
  event: ToolTimelineEvent
}

export type StreamErrorEvent = StreamBase &
  Timing & {
    type: 'error'
    message: string
    errorCode?: string
  }

export type StreamDoneEvent = StreamBase &
  Timing & {
    type: 'done'
  }

export type StreamRunStartEvent = StreamBase & {
  type: 'run-start'
  timestampMs?: number
}

export type StreamEvent =
  | StreamTextDeltaEvent
  | StreamIntentClassifiedEvent
  | StreamToolEvent
  | StreamErrorEvent
  | StreamDoneEvent
  | StreamRunStartEvent
