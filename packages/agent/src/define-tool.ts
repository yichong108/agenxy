import { tool, type Tool, type ToolSet } from 'ai'
import type { z } from 'zod'

/**
 * 工具执行生命周期观察（start / end）。
 *
 * 供宿主映射为产品侧时间线（如 ToolTimelineEvent）；agent 包本身不依赖 UI/IPC 类型。
 * runId / traceId 由宿主在 onTool 回调中自行附加，不在此结构中携带。
 */
export type ToolObservation = {
  id: string
  name: string
  status: 'start' | 'end'
  args?: string
  result?: string
  timestampMs?: number
  durationMs?: number
}

/**
 * 工具生命周期观察回调。
 *
 * AI SDK 的 ToolExecutionOptions 不含 onTool，故由宿主/工作流注入。
 * 会话与追踪 ID 由宿主在回调外维护，不注入本回调参数。
 */
export type ToolOnTool = (e: ToolObservation) => void

type ToolDefinition<T extends z.ZodTypeAny> = {
  name: string
  description: string
  /** Zod schema，对应 AI SDK Tool.parameters */
  parameters: T
  execute: (input: z.infer<T>, onTool: ToolOnTool) => Promise<unknown>
  /**
   * 将 execute 结果格式化为时间线观察字符串（TOOL_CALL_RESULT / onTool）。
   * 未提供时：string 原样，其它 JSON.stringify。
   */
  formatResult?: (result: unknown) => string
  /**
   * 将 execute 结果映射为返回给模型的工具结果。
   * 未提供时返回 execute 的原始结果（与历史行为一致）。
   * 用于：观察侧携带结构化 diff，模型侧仅返回短摘要。
   */
  toModelResult?: (result: unknown) => unknown
  truncateTo?: number
}

/**
 * 将工具参数规范为 JSON 字符串，供时间线解析（如 path / content）。
 *
 * @param parsed - zod 解析后的入参
 * @returns JSON 字符串；无法序列化时退回 String
 */
function toolArgsToObservation(parsed: unknown): string {
  try {
    return JSON.stringify(parsed ?? {})
  } catch {
    return String(parsed)
  }
}

/**
 * 将工具执行结果规范为观察用字符串。
 *
 * @param result - execute 返回值
 * @param formatResult - 可选自定义格式化
 */
function toolResultToObservation(
  result: unknown,
  formatResult?: (result: unknown) => string
): string {
  if (formatResult) return formatResult(result)
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
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
 * @param onTool - 工具生命周期观察回调
 * @returns 仅含该工具一项的 ToolSet
 */
export function defineTool<T extends z.ZodTypeAny>(
  def: ToolDefinition<T>,
  onTool: ToolOnTool
): ToolSet {
  const { name, description, parameters, execute, formatResult, toModelResult, truncateTo } = def

  const wrapped: Tool = tool({
    description,
    parameters,
    execute: async (input) => {
      const parsed = input as z.infer<T>
      const id = `${name}-${Date.now()}`
      const startedAt = Date.now()
      const args = toolArgsToObservation(parsed)

      onTool({
        id,
        name,
        status: 'start',
        args,
        timestampMs: startedAt
      })

      const result = await execute(parsed, onTool)
      const resultStr = toolResultToObservation(result, formatResult)
      const truncated = truncateTo ? resultStr.slice(0, truncateTo) : resultStr

      onTool({
        id,
        name,
        status: 'end',
        result: truncated,
        timestampMs: Date.now(),
        durationMs: Date.now() - startedAt
      })

      return toModelResult ? toModelResult(result) : result
    }
  })

  return { [name]: wrapped }
}

export type { Tool, ToolSet }
