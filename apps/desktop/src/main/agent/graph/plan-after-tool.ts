import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'

import { agentLog } from '@/main/agent/agent-log'
import { StreamBatcher } from '@/main/agent/batcher'
import { isRejectedToolResult } from '@/main/agent/hitl'
import { isAbortError } from '@/main/agent/run-utils'
import {
  type AgentComposerMode,
  type AppSettings,
  getActiveProviderProfile,
  STREAM_FLUSH_CHARS,
  STREAM_FLUSH_MS,
  type StreamEvent,
  type ToolCallEvent,
  type ToolTimelineEvent
} from '@/shared/ipc'

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
  /** 可变 timeline 数组，plan 步骤写入其中供持久化 */
  runToolEvents: ToolTimelineEvent[]
}

export type PlanAfterToolCoordinator = {
  /**
   * 工具执行结束后串行触发 plan-after-tool（ReAct tools → plan → agent 语义）。
   *
   * @param ended - 已完成的工具 timeline 事件
   */
  afterToolEnd: (ended: ToolEndedCall) => Promise<void>
}

function ensureOpenAiV1BaseUrl(baseUrl: string, fallback: string): string {
  const u = baseUrl.trim() || fallback
  if (!u) return fallback
  if (/\/v1\/?$/i.test(u)) return u.replace(/\/+$/, '')
  return `${u.replace(/\/+$/, '')}/v1`
}

function createPlanLanguageModel(settings: AppSettings) {
  const profile = getActiveProviderProfile(settings)
  const apiKey = profile.apiKey?.trim() || ''
  const baseURL = ensureOpenAiV1BaseUrl(profile.baseUrl, 'https://api.deepseek.com/v1')
  return new ChatOpenAI({
    apiKey,
    model: profile.model,
    configuration: { baseURL },
    streaming: true,
    temperature: 0
  })
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}

/**
 * 流式生成工具后的「下一步计划」文案。
 */
async function streamPlanAfterTool(
  settings: AppSettings,
  userText: string,
  ctx: { toolName: string; args?: string; result?: string },
  signal: AbortSignal,
  planBatcher: StreamBatcher
): Promise<string> {
  const model = createPlanLanguageModel(settings)
  const system = new SystemMessage(
    '你是「下一步计划」助手。编码智能体刚完成一次工具调用，将继续处理同一用户任务。\n' +
      '根据用户目标与工具输出，用**中文**写 1–3 句简短完整话描述**接下来**要做什么（仅高层概要；不要写具体工具函数名；不要 Markdown 标题或代码块）。\n' +
      '若输出为空、失败或异常，简要说明如何补救。语气简洁、面向用户。'
  )
  const human = new HumanMessage(
    [
      `用户消息：\n${userText.trim() || '（空消息）'}`,
      `已完成工具：${ctx.toolName}`,
      ctx.args ? `参数：${ctx.args}` : '',
      ctx.result ? `输出（已截断）：\n${ctx.result.slice(0, 700)}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
  )
  const deadline = Date.now() + PLAN_STEP_TIMEOUT_MS
  let acc = ''
  try {
    const stream = await model.stream([system, human], { signal })
    for await (const chunk of stream) {
      if (Date.now() > deadline) break
      const piece = contentToText((chunk as { content?: unknown }).content)
      if (!piece) continue
      acc += piece
      planBatcher.push(piece)
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
 * Plan 模式跳过；Build/Ask 模式启用。
 *
 * @param opts - 运行上下文与 timeline 可变引用
 * @returns afterToolEnd 回调，供 ToolExecutorContext 在工具返回前 await
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

    const planBatcher = new StreamBatcher(STREAM_FLUSH_MS, STREAM_FLUSH_CHARS, (t) => {
      emit({ type: 'plan-delta', sessionId, stepId, text: t, runId, traceId })
      const idx = runToolEvents.findIndex((x) => x.kind === 'plan' && x.id === stepId)
      if (idx >= 0) {
        const row = runToolEvents[idx]
        if (row?.kind === 'plan') {
          runToolEvents[idx] = { ...row, text: row.text + t }
        }
      }
    })

    let text = ''
    try {
      text = await streamPlanAfterTool(
        settings,
        userText,
        { toolName: ended.name, args: ended.args, result: ended.result },
        opts.signal,
        planBatcher
      )
    } catch (e) {
      planBatcher.flush()
      if (isAbortError(e)) throw e
      throw e
    }
    planBatcher.flush()

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
