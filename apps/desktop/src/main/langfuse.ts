import type { Serialized } from '@langchain/core/load/serializable'
import type { ChainValues } from '@langchain/core/utils/types'
import { configureGlobalLogger, LogLevel, propagateAttributes } from '@langfuse/core'
import { CallbackHandler } from '@langfuse/langchain'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { startActiveObservation } from '@langfuse/tracing'
import { NodeSDK } from '@opentelemetry/sdk-node'

import { mainLog } from '@/main/logger'

const TRACE_METADATA_MAX_LEN = 200

let sdk: NodeSDK | null = null
let spanProcessor: LangfuseSpanProcessor | null = null

if (process.env.LANGFUSE_DEBUG === 'true') {
  configureGlobalLogger({
    level: LogLevel.DEBUG
  })
}

function isTracingDisabled(): boolean {
  const v = (process.env.LANGFUSE_TRACING_DISABLED ?? '').trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

function readLangfuseKeys(): {
  publicKey: string
  secretKey: string
  baseUrl: string
} | null {
  if (isTracingDisabled()) return null

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim() ?? ''
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim() ?? ''

  if (!publicKey || !secretKey) return null

  const baseUrl = process.env.LANGFUSE_BASE_URL ?? ''

  return { publicKey, secretKey, baseUrl }
}

export async function startLangfuseTracingIfConfigured(): Promise<void> {
  if (sdk) return

  const keys = readLangfuseKeys()
  if (!keys) {
    mainLog.info('[langfuse] 未配置密钥，跳过追踪初始化')
    return
  }

  try {
    process.env.LANGFUSE_PUBLIC_KEY = keys.publicKey
    process.env.LANGFUSE_SECRET_KEY = keys.secretKey
    process.env.LANGFUSE_BASE_URL = keys.baseUrl

    spanProcessor = new LangfuseSpanProcessor({
      publicKey: keys.publicKey,
      secretKey: keys.secretKey,
      baseUrl: keys.baseUrl
    })
    const next = new NodeSDK({ spanProcessors: [spanProcessor] })
    next.start()
    sdk = next

    mainLog.info('[langfuse] 追踪已启用')
  } catch (e) {
    mainLog.warn('[langfuse] 启动失败:', e instanceof Error ? e.message : e)
  }
}

export async function shutdownLangfuseTracing(): Promise<void> {
  if (spanProcessor) {
    try {
      await spanProcessor.forceFlush()
      await spanProcessor.shutdown()
    } catch {
      // ignore
    }
    spanProcessor = null
  }

  if (sdk) {
    try {
      await sdk.shutdown()
    } catch {
      // ignore
    } finally {
      sdk = null
    }
  }
}

export async function flushLangfuseTracing(): Promise<void> {
  if (!spanProcessor) return
  try {
    await spanProcessor.forceFlush()
  } catch {
    // ignore
  }
}

export type LangfuseRunContext = {
  sessionId: string
  tags?: string[]
  traceMetadata?: Record<string, unknown>
}

export type LangfuseReactTraceContext = LangfuseRunContext & {
  /** Agenxy 侧 trace id（sessionId:runId），写入 metadata 便于关联 */
  traceId: string
  /** Langfuse trace 展示名，默认 `agenxy-react` */
  traceName?: string
  /** 写入根 observation 的用户输入 */
  input?: unknown
}

/**
 * 将 traceMetadata 转为 Langfuse propagateAttributes 要求的 string map。
 *
 * @param metadata - 任意键值 metadata
 * @returns 值长度 ≤200 的 string 记录；空对象时返回 undefined
 */
function toPropagatedMetadata(
  metadata?: Record<string, unknown>
): Record<string, string> | undefined {
  if (!metadata) return undefined

  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue
    const raw = typeof value === 'string' ? value : JSON.stringify(value)
    out[key] =
      raw.length > TRACE_METADATA_MAX_LEN ? `${raw.slice(0, TRACE_METADATA_MAX_LEN - 1)}…` : raw
  }

  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 为 LangChain 调用创建 Langfuse CallbackHandler。
 *
 * 产品策略：仅挂到主 ReAct（`createReactAgent` / `runReactAgentWithGuard`），
 * 不上报意图思考、意图分类、工具后计划、记忆提取等辅助 LLM，避免 LangGraph/RunnableSequence 噪音。
 *
 * @param ctx - sessionId、tags、traceMetadata（建议含 run_id / trace_id）
 * @returns 已配置时返回 handler，否则 null
 */
export function createLangfuseCallbackHandler(ctx: LangfuseRunContext): CallbackHandler | null {
  const keys = readLangfuseKeys()
  if (!keys) return null

  process.env.LANGFUSE_BASE_URL = keys.baseUrl
  process.env.LANGFUSE_PUBLIC_KEY = keys.publicKey
  process.env.LANGFUSE_SECRET_KEY = keys.secretKey

  try {
    const options = {
      sessionId: ctx.sessionId,
      tags: ctx.tags?.length ? ctx.tags : ['agenxy'],
      traceMetadata: ctx.traceMetadata
    }
    mainLog.info('[langfuse] 创建 CallbackHandler:', options)

    const handler = new CallbackHandler(options)
    return handler
  } catch (e) {
    mainLog.warn('[langfuse] CallbackHandler 创建失败:', e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * 将 HITL 多次 `agent.invoke` 产生的顶层 LangGraph span 挂到首条 chain 下。
 *
 * LangGraph 每次顶层 invoke 都会触发 CallbackHandler 新建无 parentRunId 的 chain span；
 * 本 wrapper 把后续 invoke 的 chain 作为第一条 LangGraph 的子 span，避免 Langfuse UI 出现并列 sibling。
 *
 * @param handler - 原始 Langfuse CallbackHandler
 * @returns 可安全复用于 while-loop 多次 invoke 的 handler
 */
export function wrapLangfuseHandlerForMultiInvoke(handler: CallbackHandler): CallbackHandler {
  let rootChainRunId: string | null = null

  return new Proxy(handler, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop === 'handleChainStart' && typeof value === 'function') {
        return async (
          chain: Serialized,
          inputs: ChainValues,
          runId: string,
          parentRunId?: string,
          tags?: string[],
          metadata?: Record<string, unknown>,
          runType?: string,
          name?: string
        ) => {
          let effectiveParentRunId = parentRunId
          if (!effectiveParentRunId) {
            if (rootChainRunId && rootChainRunId !== runId) {
              effectiveParentRunId = rootChainRunId
            } else if (!rootChainRunId) {
              rootChainRunId = runId
            }
          }
          return value.call(
            target,
            chain,
            inputs,
            runId,
            effectiveParentRunId,
            tags,
            metadata,
            runType,
            name
          )
        }
      }
      if (typeof value === 'function') {
        return value.bind(target)
      }
      return value
    }
  }) as CallbackHandler
}

/**
 * 用单一 Langfuse trace 包裹完整 ReAct 运行（含 Build HITL 多次 `invoke` / `Command.resume` 恢复）。
 *
 * 层级：`agenxy-graph` (agent) → `react` (chain) → LangGraph…；多次 invoke 经 wrapLangfuseHandlerForMultiInvoke 嵌套。
 *
 * @param ctx - session、tags、metadata、traceId、可选 input
 * @param fn - 接收 CallbackHandler 的执行函数（未配置 Langfuse 时 handler 为 null）
 * @param options.formatOutput - 运行结束后写入根 observation 的 output
 * @returns fn 的返回值
 */
export async function runLangfuseReactObservation<T>(
  ctx: LangfuseReactTraceContext,
  fn: (handler: CallbackHandler | null) => Promise<T>,
  options?: { formatOutput?: (result: T) => unknown }
): Promise<T> {
  const keys = readLangfuseKeys()
  if (!keys) return fn(null)

  const baseHandler = createLangfuseCallbackHandler(ctx)
  const handler = baseHandler ? wrapLangfuseHandlerForMultiInvoke(baseHandler) : null
  const traceName = ctx.traceName ?? 'agenxy-react'
  const metadata = toPropagatedMetadata(ctx.traceMetadata)

  mainLog.info('[langfuse] runLangfuseReactObservation:', {
    sessionId: ctx.sessionId,
    traceId: ctx.traceId,
    traceName,
    handler: Boolean(handler)
  })

  return startActiveObservation(
    traceName,
    async (obs) => {
      if (ctx.input !== undefined) {
        obs.update({ input: ctx.input })
      }

      const result = await startActiveObservation(
        'react',
        async () =>
          propagateAttributes(
            {
              sessionId: ctx.sessionId,
              tags: ctx.tags?.length ? ctx.tags : ['agenxy'],
              metadata
            },
            () => fn(handler)
          ),
        { asType: 'chain' }
      )

      if (options?.formatOutput) {
        obs.update({ output: options.formatOutput(result) })
      }

      return result
    },
    { asType: 'agent' }
  )
}
