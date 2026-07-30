/**
 * @file create-agent.ts 单元测试
 */

import { defaultSettings } from '@agenwork/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/run-workflow.js', () => ({
  runWorkflow: vi.fn(async () => ({
    messages: [{ type: 'ai' as const, content: 'hello' }],
    toolEvents: []
  }))
}))

import { createAgent } from '../src/create-agent.js'
import { runWorkflow } from '../src/run-workflow.js'

function createCallbacks() {
  return {
    onTextDelta: vi.fn(),
    onTool: vi.fn(),
    emit: vi.fn(),
    persistMessages: vi.fn()
  }
}

describe('createAgent', () => {
  beforeEach(() => {
    vi.mocked(runWorkflow).mockClear()
  })

  it('返回含 send 的实例', () => {
    const agent = createAgent({ local: { cwd: '/tmp/ws' } })
    expect(agent.send).toBeTypeOf('function')
  })

  it('send 将 local.cwd 写入 runMeta.root 并调用 workflow', async () => {
    const agent = createAgent({ local: { cwd: '/tmp/ws' } })
    const callbacks = createCallbacks()

    const result = await agent.send({
      composerMode: 'ask',
      messages: [],
      abortController: new AbortController(),
      settings: defaultSettings,
      runMeta: {
        sessionId: 's1',
        runId: 'r1',
        traceId: 't1',
        workspaceId: 'w1',
        root: '',
        userDisplayText: 'hi',
        agentUserText: 'hi'
      },
      callbacks,
      recursionLimit: 10,
      invokeTimeoutMs: 60_000
    })

    expect(runWorkflow).toHaveBeenCalledOnce()
    const [input] = vi.mocked(runWorkflow).mock.calls[0]!
    expect(input.runMeta.root).toBe('/tmp/ws')
    expect(result.messages).toEqual([{ type: 'ai', content: 'hello' }])
    expect(result.toolEvents).toEqual([])
    // 无流式输出时 fallback 到最后一条 AI 消息
    expect(callbacks.onTextDelta).toHaveBeenCalledWith('hello')
  })
})
