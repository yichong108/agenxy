#!/usr/bin/env node
/**
 * 测试脚本：使用 REST API 向 Langfuse 发送一条 tracing 数据
 * 使用 /api/public/ingestion 批量摄入端点
 */

// 配置
const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || 'pk-lf-cf72a098-12f7-4dba-9dda-bffb32879c5a'
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || 'sk-lf-377b2143-adf6-42bc-ace8-91070e8b2f6c'
const LANGFUSE_BASE_URL = process.env.LANGFUSE_BASE_URL || 'http://127.0.0.1:3000'

// 生成唯一 ID
const generateId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
const traceId = `trace-${generateId()}`
const spanId = `span-${generateId()}`
const generationId = `gen-${generateId()}`
const scoreId = `score-${generateId()}`

const now = Date.now()
const startTime = new Date(now).toISOString()
const endTime = new Date(now + 500).toISOString()

// 基础认证 Header
const authHeader = 'Basic ' + Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64')

async function ingestEvents(events) {
  const url = `${LANGFUSE_BASE_URL}/api/public/ingestion`

  const body = {
    batch: events,
    metadata: {
      sdk_name: 'test-script',
      sdk_version: '1.0.0',
      sdk_integration: 'Node',
      batch_size: events.length,
    },
  }

  console.log('\n📦 发送的事件数据:')
  console.log(JSON.stringify(body, null, 2))

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
    },
    body: JSON.stringify(body),
  })

  const responseData = await response.json()

  if (!response.ok) {
    console.error('\n❌ 响应错误:', response.status)
    console.error(JSON.stringify(responseData, null, 2))
    throw new Error(`摄入失败: ${response.status}`)
  }

  return responseData
}

async function createTraceWithObservations() {
  // 创建批量事件 - 使用正确的 Langfuse ingestion 格式
  const events = [
    // Trace 事件
    {
      id: `event-trace-${generateId()}`,
      type: 'trace-create',
      timestamp: startTime,
      body: {
        id: traceId,
        name: 'test-trace-from-script',
        userId: 'test-user-001',
        sessionId: `session-${now}`,
        tags: ['test', 'manual', 'script'],
        metadata: {
          source: 'test-script',
          environment: 'development',
        },
        timestamp: startTime,
      },
    },
    // Span 事件
    {
      id: `event-span-${generateId()}`,
      type: 'span-create',
      timestamp: startTime,
      body: {
        id: spanId,
        traceId: traceId,
        name: 'test-operation',
        startTime: startTime,
        endTime: endTime,
        input: {
          prompt: '这是一个测试请求的输入',
          parameters: { temperature: 0.7, maxTokens: 1024 },
        },
        output: {
          response: '这是测试请求的输出结果',
          status: 'success',
        },
        metadata: { model: 'gpt-4', provider: 'openai' },
      },
    },
    // Generation 事件
    {
      id: `event-gen-${generateId()}`,
      type: 'generation-create',
      timestamp: startTime,
      body: {
        id: generationId,
        traceId: traceId,
        name: 'test-llm-generation',
        startTime: startTime,
        endTime: new Date(now + 800).toISOString(),
        model: 'gpt-4',
        modelParameters: { temperature: 0.7, maxTokens: 1024 },
        input: [
          { role: 'system', content: '你是一个有帮助的助手' },
          { role: 'user', content: '你好，请介绍一下 Langfuse' },
        ],
        output: {
          role: 'assistant',
          content: 'Langfuse 是一个开源的 LLM 可观测性平台，用于追踪、监控和分析 AI 应用。',
        },
        usage: { inputTokens: 45, outputTokens: 32, totalTokens: 77, inputCost: 0.001, outputCost: 0.002, totalCost: 0.003 },
      },
    },
    // Score 事件
    {
      id: `event-score-${generateId()}`,
      type: 'score-create',
      timestamp: endTime,
      body: {
        id: scoreId,
        traceId: traceId,
        name: 'test-quality-score',
        value: 0.95,
        comment: '测试评分：响应质量很好',
      },
    },
  ]

  return await ingestEvents(events)
}

async function verifyTrace(traceId) {
  const url = `${LANGFUSE_BASE_URL}/api/public/traces/${traceId}`

  const response = await fetch(url, {
    headers: {
      'Authorization': authHeader,
    },
  })

  if (response.status === 200) {
    return await response.json()
  } else if (response.status === 404) {
    return null
  } else {
    const error = await response.text()
    throw new Error(`验证失败: ${response.status} ${error}`)
  }
}

async function listRecentTraces() {
  const url = `${LANGFUSE_BASE_URL}/api/public/traces?limit=5`

  const response = await fetch(url, {
    headers: {
      'Authorization': authHeader,
    },
  })

  if (response.status === 200) {
    return await response.json()
  } else {
    const error = await response.text()
    throw new Error(`查询失败: ${response.status} ${error}`)
  }
}

async function main() {
  console.log('🚀 开始创建 Langfuse Trace 数据')
  console.log('=' .repeat(50))
  console.log(`   Base URL: ${LANGFUSE_BASE_URL}`)
  console.log(`   Public Key: ${LANGFUSE_PUBLIC_KEY.slice(0, 20)}...`)
  console.log(`   Trace ID: ${traceId}`)
  console.log('=' .repeat(50))

  try {
    // 创建 Trace 和 Observations
    console.log('\n📋 批量摄入 Trace 数据...')
    const result = await createTraceWithObservations()

    console.log('\n📊 响应结果:')
    console.log(JSON.stringify(result, null, 2))

    // 等待数据写入
    console.log('\n⏱️  等待数据同步...')
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // 查询最近的 traces
    console.log('\n🔍 查询最近的 traces...')
    const traces = await listRecentTraces()
    if (traces.data?.length > 0) {
      console.log(`   找到 ${traces.data.length} 条 traces:`)
      for (const trace of traces.data) {
        console.log(`   - ${trace.name} [${trace.id}]`)
      }

      // 检查我们的 trace 是否在列表中
      const ourTrace = traces.data.find(t => t.id === traceId)
      if (ourTrace) {
        console.log(`\n   ✓ 找到我们的 Trace!`)
      } else {
        console.log(`\n   ⚠️ 未找到我们的 Trace，可能还在处理中`)
      }
    } else {
      console.log('   未找到任何 traces')
    }

    // 输出 Trace URL
    const traceUrl = `${LANGFUSE_BASE_URL}/traces/${traceId}`
    console.log('\n' + '='.repeat(50))
    console.log('✅ 数据已提交!')
    console.log('='.repeat(50))
    console.log(`\n   🔗 查看 Trace: ${traceUrl}`)
    console.log(`   📊 Trace ID: ${traceId}`)
    console.log(`\n   提示: 如果 Trace 未显示，请等待几秒后刷新页面`)
    console.log(`        或者直接在浏览器中打开上面的链接查看`)

  } catch (error) {
    console.error('\n❌ 错误:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

main()
