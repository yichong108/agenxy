import { configureGlobalLogger, LogLevel, propagateAttributes } from '@langfuse/core'
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
  /** Agenwork 侧 trace id（sessionId:runId），写入 metadata 便于关联 */
  traceId: string
  /** Langfuse trace 展示名，默认 `agenwork-react` */
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
 * 用单一 Langfuse trace 包裹完整 ReAct 运行。
 *
 * 层级：`agenwork-graph` (agent) → `react` (chain)；通过 OpenTelemetry SDK 自动采集 AI SDK 调用。
 *
 * @param ctx - session、tags、metadata、traceId、可选 input
 * @param fn - 执行函数
 * @param options.formatOutput - 运行结束后写入根 observation 的 output
 * @returns fn 的返回值
 */
export async function runLangfuseReactObservation<T>(
  ctx: LangfuseReactTraceContext,
  fn: () => Promise<T>,
  options?: { formatOutput?: (result: T) => unknown }
): Promise<T> {
  const keys = readLangfuseKeys()
  if (!keys) return fn()

  const traceName = ctx.traceName ?? 'agenwork-react'
  const metadata = toPropagatedMetadata(ctx.traceMetadata)

  mainLog.info('[langfuse] runLangfuseReactObservation:', {
    sessionId: ctx.sessionId,
    traceId: ctx.traceId,
    traceName
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
              tags: ctx.tags?.length ? ctx.tags : ['agenwork'],
              metadata
            },
            () => fn()
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
