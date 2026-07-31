import type { AppSettings, StreamEvent, ToolTimelineEvent } from '@agenwork/shared'
import type { LanguageModel } from 'ai'

import type { ReactRunBridge } from './react-run-bridge.js'

/**
 * 单次 agent 流水线运行时的可变上下文。
 *
 * 贯穿工具准备与 ReAct 各阶段；宿主可在 prepareTooling 中使用 emit / signal。
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
