import type { ToolEndedCall } from '@/main/agent/graph/plan-after-tool'
import type { AppSettings, StreamEvent, ToolTimelineEvent } from '@/shared/ipc'

/**
 * Graph 节点通过 configurable 访问的运行时上下文（settings、IPC、工具 timeline）。
 */
export type AgenxyGraphRunContext = {
  settings: AppSettings
  signal: AbortSignal
  onTool: (event: ToolTimelineEvent) => void
  emit: (event: StreamEvent) => void
  /** 可变 tool/plan timeline，execute_react 结束后写回持久化 */
  runToolEvents: ToolTimelineEvent[]
  /** 由 init_plan_after_tool 节点注入：工具结束后串行 plan */
  afterToolEnd?: (ended: ToolEndedCall) => Promise<void>
}
