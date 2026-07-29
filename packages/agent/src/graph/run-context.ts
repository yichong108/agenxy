import type { AppSettings, StreamEvent, ToolTimelineEvent } from '@agenwork/shared'
import type { LanguageModel } from 'ai'

import type { ReactRunBridge } from './react-run-bridge.js'

/**
 * 单次 agent 流水线运行时的可变上下文。
 *
 * 贯穿 intent 分类、工具准备与 ReAct 各阶段。
 */
export type AgenworkGraphRunContext = {
  settings: AppSettings
  signal: AbortSignal
  onTool: (e: ToolTimelineEvent) => void
  emit: (event: StreamEvent) => void
  runToolEvents: ToolTimelineEvent[]
  reactBridge: ReactRunBridge
  /** createAgent 注入的模型；未设则各阶段从 settings 解析 */
  provider?: LanguageModel
}
