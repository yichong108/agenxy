import type { AppSettings, StreamEvent, ToolTimelineEvent } from '@agenxy/shared'

import type { ToolEndedCall } from './plan-after-tool.js'
import type { ReactRunBridge } from './react-run-bridge.js'

/**
 * Pipeline 运行时上下文（settings、IPC、工具 timeline）。
 */
export type AgenxyGraphRunContext = {
  settings: AppSettings
  signal: AbortSignal
  onTool: (event: ToolTimelineEvent) => void
  emit: (event: StreamEvent) => void
  runToolEvents: ToolTimelineEvent[]
  afterToolEnd?: (ended: ToolEndedCall) => Promise<void>
  reactBridge: ReactRunBridge
}
