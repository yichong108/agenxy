import { configureGlobalLogger, LogLevel } from '@langfuse/core'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { NodeSDK } from '@opentelemetry/sdk-node'

import { mainLog } from '@/main/logger'

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
