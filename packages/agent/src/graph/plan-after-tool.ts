import {
  type AgentComposerMode,
  type AppSettings,
  type StreamEvent,
  type ToolCallEvent,
  type ToolTimelineEvent
} from '@agenxy/shared'
import { streamText } from 'ai'

import { isRejectedToolResult } from '../hitl.js'
import { getChatModel } from '../llm.js'
import { agentLog } from '../logger.js'
import { isAbortError } from '../run-utils.js'

const PLAN_STEP_TIMEOUT_MS = 14_000
const PLAN_STEP_MAX_CHARS = 480
const MAX_PLAN_STEPS_PER_RUN = 16

export type ToolEndedCall = ToolCallEvent & { status: 'end' }

export type PlanAfterToolCoordinatorOptions = {
  composerMode: AgentComposerMode
  sessionId: string
  runId: string
  traceId: string
  userText: string
  settings: AppSettings
  signal: AbortSignal
  emit: (event: StreamEvent) => void
  runToolEvents: ToolTimelineEvent[]
}

export type PlanAfterToolCoordinator = {
  afterToolEnd: (ended: ToolEndedCall) => Promise<void>
}

/**
 * 流式生成工具结束后的下一步计划文本，并逐 token 回调 onDelta。
 *
 * @param settings - 应用设置（用于选择聊天模型）
 * @param userText - 用户原始任务文本
 * @param ctx - 刚结束的工具名称、参数与结果
 * @param signal - 中止信号
 * @param onDelta - 每个文本片段的回调
 * @returns 累计生成的计划文本（已 trim）
 */
async function streamPlanAfterTool(
  settings: AppSettings,
  userText: string,
  ctx: { toolName: string; args?: string; result?: string },
  signal: AbortSignal,
  onDelta: (text: string) => void
): Promise<string> {
  const model = getChatModel(settings)
  if (!model) return ''

  const system =
    '你是「下一步计划」助手。编码智能体刚完成一次工具调用，将继续处理同一用户任务。\n' +
    '根据用户目标与工具输出，用**中文**写 1–3 句简短完整话描述**接下来**要做什么（仅高层概要；不要写具体工具函数名；不要 Markdown 标题或代码块）。\n' +
    '若输出为空、失败或异常，简要说明如何补救。语气简洁、面向用户。'

  const prompt = [
    `用户消息：\n${userText.trim() || '（空消息）'}`,
    `已完成工具：${ctx.toolName}`,
    ctx.args ? `参数：${ctx.args}` : '',
    ctx.result ? `输出（已截断）：\n${ctx.result.slice(0, 700)}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')

  const deadline = Date.now() + PLAN_STEP_TIMEOUT_MS
  let acc = ''
  try {
    const result = streamText({
      model,
      system,
      prompt,
      abortSignal: signal,
      temperature: 0
    })

    for await (const chunk of result.fullStream) {
      if (Date.now() > deadline) break
      if (chunk.type !== 'text-delta') continue
      const piece = chunk.textDelta
      if (!piece) continue
      acc += piece
      onDelta(piece)
      if (acc.length >= PLAN_STEP_MAX_CHARS) break
    }
  } catch (e) {
    if (isAbortError(e)) throw e
    agentLog.warn('[streamPlanAfterTool] failed:', e instanceof Error ? e.message : e)
  }
  return acc.trim()
}

/**
 * 创建 plan-after-tool 协调器：在每次工具结束后串行执行，再交还 ReAct 循环。
 *
 * @param opts - 运行上下文与 timeline 可变引用
 * @returns afterToolEnd 回调
 */
export function createPlanAfterToolCoordinator(
  opts: PlanAfterToolCoordinatorOptions
): PlanAfterToolCoordinator {
  let planStepsThisRun = 0

  const afterToolEnd = async (ended: ToolEndedCall): Promise<void> => {
    if (opts.signal.aborted) return
    if (opts.composerMode === 'plan') return
    if (isRejectedToolResult(ended.result)) return
    if (planStepsThisRun >= MAX_PLAN_STEPS_PER_RUN) return

    planStepsThisRun += 1
    const stepId = `plan-${ended.id}`
    const startedAt = Date.now()
    const { sessionId, runId, traceId, emit, runToolEvents, settings, userText } = opts

    emit({
      type: 'plan-step-start',
      sessionId,
      runId,
      traceId,
      stepId,
      afterToolId: ended.id,
      toolName: ended.name
    })

    const planRecord = {
      kind: 'plan' as const,
      id: stepId,
      afterToolId: ended.id,
      toolName: ended.name,
      status: 'streaming' as const,
      text: '',
      runId,
      traceId,
      timestampMs: startedAt
    }
    runToolEvents.push(planRecord)

    const onPlanDelta = (t: string): void => {
      emit({ type: 'plan-delta', sessionId, stepId, text: t, runId, traceId })
      const idx = runToolEvents.findIndex((x) => x.kind === 'plan' && x.id === stepId)
      if (idx >= 0) {
        const row = runToolEvents[idx]
        if (row?.kind === 'plan') {
          runToolEvents[idx] = { ...row, text: row.text + t }
        }
      }
    }

    let text = ''
    try {
      text = await streamPlanAfterTool(
        settings,
        userText,
        { toolName: ended.name, args: ended.args, result: ended.result },
        opts.signal,
        onPlanDelta
      )
    } catch (e) {
      if (isAbortError(e)) throw e
      throw e
    }

    const idx = runToolEvents.findIndex((x) => x.kind === 'plan' && x.id === stepId)
    if (idx >= 0) {
      const prev = runToolEvents[idx]
      const prevText = prev?.kind === 'plan' ? prev.text : ''
      runToolEvents[idx] = {
        kind: 'plan',
        id: stepId,
        afterToolId: ended.id,
        toolName: ended.name,
        status: 'end',
        text: text || prevText,
        runId,
        traceId,
        timestampMs: startedAt,
        durationMs: Date.now() - startedAt
      }
    }
    emit({ type: 'plan-step-end', sessionId, stepId, runId, traceId })
  }

  return { afterToolEnd }
}
