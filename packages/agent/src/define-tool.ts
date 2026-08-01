import { tool, type Tool, type ToolSet } from 'ai'
import type { z } from 'zod'

/**
 * 工具执行生命周期观察（start / end）。
 *
 * 供宿主映射为产品侧时间线（如 ToolTimelineEvent）；agent 包本身不依赖 UI/IPC 类型。
 */
export type ToolObservation = {
  id: string
  name: string
  status: 'start' | 'end'
  args?: string
  result?: string
  runId?: string
  traceId?: string
  timestampMs?: number
  durationMs?: number
}

/**
 * 工具执行上下文：run 标识与观察回调。
 *
 * AI SDK 的 ToolExecutionOptions 不含 runId / onTool，故由宿主/工作流注入。
 */
export type ToolExecutorContext = {
  runId: string
  traceId: string
  onTool: (e: ToolObservation) => void
}

type ToolDefinition<T extends z.ZodTypeAny> = {
  name: string
  description: string
  /** Zod schema，对应 AI SDK Tool.parameters */
  parameters: T
  execute: (input: z.infer<T>, ctx: ToolExecutorContext) => Promise<unknown>
  formatResult?: (result: unknown) => string
  truncateTo?: number
}

/**
 * 合并多个 AI SDK ToolSet（同名后者覆盖前者）。
 *
 * @param sets - 待合并的 ToolSet
 * @returns 合并后的 ToolSet
 */
export function mergeToolSets(...sets: ToolSet[]): ToolSet {
  return Object.assign({}, ...sets) as ToolSet
}

/**
 * 按工具名过滤 ToolSet。
 *
 * @param tools - 原始 ToolSet
 * @param predicate - 保留条件（参数为工具名）
 * @returns 过滤后的 ToolSet
 */
export function filterToolSet(tools: ToolSet, predicate: (name: string) => boolean): ToolSet {
  const out: ToolSet = {}
  for (const [name, t] of Object.entries(tools)) {
    if (predicate(name)) out[name] = t
  }
  return out
}

/**
 * 将 zod 工具定义包装为单键 AI SDK ToolSet（含生命周期观察上报）。
 *
 * 返回 ToolSet 而非自定义结构，可直接传给 streamText / generateText，
 * 或多个结果经 mergeToolSets 合并。
 *
 * @param def - 工具定义（name、parameters、execute）
 * @param runCtx - 运行上下文（onTool）
 * @returns 仅含该工具一项的 ToolSet
 */
export function defineTool<T extends z.ZodTypeAny>(
  def: ToolDefinition<T>,
  runCtx: ToolExecutorContext
): ToolSet {
  const { name, description, parameters, execute, formatResult, truncateTo } = def

  const wrapped: Tool = tool({
    description,
    parameters,
    execute: async (input) => {
      const parsed = input as z.infer<T>
      const id = `${name}-${Date.now()}`
      const startedAt = Date.now()
      const args =
        typeof parsed === 'object' && parsed !== null
          ? Object.values(parsed as Record<string, unknown>).join(', ')
          : String(parsed)

      runCtx.onTool({
        id,
        name,
        status: 'start',
        args,
        runId: runCtx.runId,
        traceId: runCtx.traceId,
        timestampMs: startedAt
      })

      const result = await execute(parsed, runCtx)
      const resultStr = formatResult ? formatResult(result) : String(result)
      const truncated = truncateTo ? resultStr.slice(0, truncateTo) : resultStr

      runCtx.onTool({
        id,
        name,
        status: 'end',
        result: truncated,
        runId: runCtx.runId,
        traceId: runCtx.traceId,
        timestampMs: Date.now(),
        durationMs: Date.now() - startedAt
      })

      return result
    }
  })

  return { [name]: wrapped }
}

export type { Tool, ToolSet }
