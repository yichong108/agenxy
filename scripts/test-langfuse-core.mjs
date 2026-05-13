#!/usr/bin/env node
/**
 * 使用 @langfuse/core 发送 tracing 数据
 * 此脚本使用项目中已安装的依赖
 */

// 动态导入 ESM 模块
const { Langfuse } = await import('@langfuse/core')

const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || 'pk-lf-cf72a098-12f7-4dba-9dda-bffb32879c5a'
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || 'sk-lf-377b2143-adf6-42bc-ace8-91070e8b2f6c'
const LANGFUSE_BASE_URL = process.env.LANGFUSE_BASE_URL || 'http://127.0.0.1:3000'

const traceId = `test-${Date.now()}`

console.log('🚀 使用 @langfuse/core 创建 Trace')
console.log('='.repeat(50))

const langfuse = new Langfuse({
  publicKey: LANGFUSE_PUBLIC_KEY,
  secretKey: LANGFUSE_SECRET_KEY,
  baseUrl: LANGFUSE_BASE_URL,
})

// 创建 Trace
const trace = langfuse.trace({
  id: traceId,
  name: 'test-from-core',
  userId: 'test-user',
  metadata: { source: 'core-sdk' },
})

// 创建 Span
trace.span({
  name: 'test-span',
  input: 'test input',
  output: 'test output',
})

// 创建 Generation
trace.generation({
  name: 'test-generation',
  model: 'gpt-4',
  input: 'Hello',
  output: 'Hi there!',
})

// 刷新
await langfuse.flushAsync()

console.log('✅ Trace 已发送:', traceId)
console.log(`🔗 http://localhost:3000/traces/${traceId}`)
