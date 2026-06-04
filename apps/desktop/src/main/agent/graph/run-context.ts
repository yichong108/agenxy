import type { AppSettings, StreamEvent, ToolTimelineEvent } from '@/shared/ipc'

/**
 * Graph 节点通过 configurable 访问的运行时上下文（settings、IPC、工具 timeline）。
 */
export type AgenxyGraphRunContext = {
  settings: AppSettings
  onTool: (event: ToolTimelineEvent) => void
  emit: (event: StreamEvent) => void
}
