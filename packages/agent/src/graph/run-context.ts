import type { AppSettings, StreamEvent, ToolTimelineEvent } from '@agenxy/shared'
import type { LanguageModel } from 'ai'

import type { ToolEndedCall } from './plan-after-tool.js'
import type { ReactRunBridge } from './react-run-bridge.js'

/**
 * 单次 agent 流水线运行时的可变上下文。
 *
 * 贯穿 intent 分类、工具准备、ReAct 与 plan-after-tool 各阶段。
 */
export type AgenxyGraphRunContext = {
  settings: AppSettings
  signal: AbortSignal
  onTool: (e: ToolTimelineEvent) => void
  emit: (event: StreamEvent) => void
  runToolEvents: ToolTimelineEvent[]
  afterToolEnd?: (ended: ToolEndedCall) => Promise<void>
  reactBridge: ReactRunBridge
  /** createAgent 注入的模型；未设则各阶段从 settings 解析 */
  provider?: LanguageModel
}
