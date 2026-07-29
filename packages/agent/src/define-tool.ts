import type { ToolTimelineEvent } from '@agenwork/shared'
import type { z } from 'zod'

/**
 * Agent 工具定义：带 name、schema 与 invoke，供 ReAct 循环绑定。
 */
export type NamedTool = {
  name: string
  description: string
  schema: z.ZodTypeAny
  invoke: (input: unknown, config?: { signal?: AbortSignal }) => Promise<unknown>
}

type ToolDefinition<T extends z.ZodTypeAny> = {
  name: string
  description: string
  schema: T
  execute: (input: z.infer<T>, ctx: ToolExecutorContext) => Promise<unknown>
  formatResult?: (result: unknown) => string
  truncateTo?: number
}

/** 工具执行上下文：run 标识与 timeline 回调 */
export type ToolExecutorContext = {
  runId: string
  traceId: string
  onTool: (e: ToolTimelineEvent) => void
}

/**
 * 将 zod schema 工具定义包装为 NamedTool（含 timeline 上报）。
 *
 * @param def - 工具定义（name、schema、execute）
 * @param runCtx - 运行上下文（onTool）
 * @returns 可绑定到 ReAct 循环的 NamedTool
 */
export function defineTool<T extends z.ZodTypeAny>(
  def: ToolDefinition<T>,
  runCtx: ToolExecutorContext
): NamedTool {
  const { name, description, schema, execute, formatResult, truncateTo } = def

  return {
    name,
    description,
    schema,
    invoke: async (input: unknown) => {
      const parsed = schema.parse(input) as z.infer<T>
      const id = `${name}-${Date.now()}`
      const startedAt = Date.now()
      const args =
        typeof parsed === 'object' && parsed !== null
          ? Object.values(parsed as Record<string, unknown>).join(', ')
          : String(parsed)

      runCtx.onTool({
        kind: 'tool',
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
        kind: 'tool',
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
  }
}
