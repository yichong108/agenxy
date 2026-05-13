import { CallbackHandler } from '@langfuse/langchain'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { NodeSDK } from '@opentelemetry/sdk-node'

import { mainLog } from '@/main/logger'

let sdk: NodeSDK | null = null

function isTracingDisabled(): boolean {
  const v = (process.env.LANGFUSE_TRACING_DISABLED ?? '').trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

function readLangfuseKeys(): { publicKey: string; secretKey: string; baseUrl: string } | null {
  if (isTracingDisabled()) return null
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim() ?? ''
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim() ?? ''
  if (!publicKey || !secretKey) return null
  const baseUrl = process.env.LANGFUSE_BASE_URL?.trim() || 'https://cloud.langfuse.com'
  return { publicKey, secretKey, baseUrl }
}

/**
 * 在加载 `.env` 之后调用（见 `index.ts` 中 `env-bootstrap` 之后的副作用）。
 * 使用 OpenTelemetry + {@link LangfuseSpanProcessor} 将 {@link CallbackHandler} 产生的 span 上报至 Langfuse。
 */
export function startLangfuseTracingIfConfigured(): void {
  if (sdk) return
  const keys = readLangfuseKeys()
  if (!keys) return
  try {
    const processor = new LangfuseSpanProcessor({
      publicKey: keys.publicKey,
      secretKey: keys.secretKey,
      baseUrl: keys.baseUrl,
      exportMode: 'batched'
    })
    const next = new NodeSDK({ spanProcessors: [processor] })
    next.start()
    sdk = next
    mainLog.info('[langfuse] OpenTelemetry 已启动，将上报至', keys.baseUrl)
  } catch (e) {
    mainLog.warn('[langfuse] 启动失败:', e instanceof Error ? e.message : e)
  }
}

export async function shutdownLangfuseTracing(): Promise<void> {
  if (!sdk) return
  try {
    await sdk.shutdown()
  } catch (e) {
    mainLog.warn('[langfuse] shutdown 异常:', e instanceof Error ? e.message : e)
  } finally {
    sdk = null
  }
}

export type LangfuseRunContext = {
  sessionId: string
  tags?: string[]
  traceMetadata?: Record<string, unknown>
}

/** 已配置密钥且未禁用时返回 LangChain 回调，否则返回 null */
export function createLangfuseCallbackHandler(ctx: LangfuseRunContext): CallbackHandler | null {
  if (!readLangfuseKeys()) return null
  return new CallbackHandler({
    sessionId: ctx.sessionId,
    tags: ctx.tags?.length ? ctx.tags : ['agenxy'],
    traceMetadata: ctx.traceMetadata
  })
}
