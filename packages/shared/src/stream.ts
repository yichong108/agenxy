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

export type ToolPlanStepEvent = {
  kind: 'plan'
  id: string
  afterToolId: string
  toolName: string
  status: 'streaming' | 'end'
  text: string
} & RunMeta

export type ToolTimelineEvent = ToolCallEvent | ToolErrorEvent | ToolPlanStepEvent

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

export type StreamPlanStepStartEvent = StreamBase & {
  type: 'plan-step-start'
  stepId: string
  afterToolId: string
  toolName: string
}

export type StreamPlanDeltaEvent = StreamBase & {
  type: 'plan-delta'
  stepId: string
  text: string
}

export type StreamPlanStepEndEvent = StreamBase & {
  type: 'plan-step-end'
  stepId: string
}

export type HitlToolCallPayload = {
  id: string
  name: string
  args: string
}

export type StreamHitlRequiredEvent = StreamBase & {
  type: 'hitl-required'
  hitlId: string
  toolCalls: HitlToolCallPayload[]
}

export type StreamStreamResetEvent = StreamBase & {
  type: 'stream-reset'
}

export type HitlResumeDecision = 'accept' | 'reject'

export type StreamEvent =
  | StreamTextDeltaEvent
  | StreamIntentClassifiedEvent
  | StreamPlanStepStartEvent
  | StreamPlanDeltaEvent
  | StreamPlanStepEndEvent
  | StreamHitlRequiredEvent
  | StreamStreamResetEvent
  | StreamToolEvent
  | StreamErrorEvent
  | StreamDoneEvent
  | StreamRunStartEvent
