/**
 * @file create-agent.ts 单元测试
 */

import { defaultSettings } from '@agenwork/shared'
import type { LanguageModel } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/react-loop.js', () => ({
  runReactLoop: vi.fn(async () => [{ role: 'assistant' as const, content: 'hello' }])
}))

import { createAgent } from '../src/create-agent.js'
import { runReactLoop } from '../src/react-loop.js'

function createCallbacks() {
  return {
    onTextDelta: vi.fn(),
    onTool: vi.fn(),
    onEmit: vi.fn()
  }
}

/** 测试用占位模型（send 不再内部 resolve） */
const stubModel = { modelId: 'test-model' } as LanguageModel

describe('createAgent', () => {
  beforeEach(() => {
    vi.mocked(runReactLoop).mockClear()
  })

  it('返回含 send 的实例', () => {
    const agent = createAgent({ local: { cwd: '/tmp/ws' } })
    expect(agent.send).toBeTypeOf('function')
  })

  it('send 未传 workspacePath 时回退 local.cwd', async () => {
    const agent = createAgent({ local: { cwd: '/tmp/ws' } })
    const callbacks = createCallbacks()

    const result = await agent.send({
      composerMode: 'ask',
      messages: [],
      provider: stubModel,
      abortController: new AbortController(),
      settings: defaultSettings,
      runMeta: {
        sessionId: 's1',
        runId: 'r1',
        traceId: 't1',
        workspaceId: 'w1',
        agentUserText: 'hi'
      },
      ...callbacks,
      maxSteps: 10,
      invokeTimeoutMs: 60_000
    })

    expect(runReactLoop).toHaveBeenCalledOnce()
    const [, runPrompt] = vi.mocked(runReactLoop).mock.calls[0]!
    expect(runPrompt).toContain('工作区根目录：/tmp/ws')
    expect(result.messages).toEqual([{ role: 'assistant', content: 'hello' }])
  })

  it('send 优先使用本轮 workspacePath', async () => {
    const agent = createAgent({ local: { cwd: '/tmp/ws' } })
    const callbacks = createCallbacks()

    await agent.send({
      composerMode: 'ask',
      messages: [],
      provider: stubModel,
      abortController: new AbortController(),
      settings: defaultSettings,
      workspacePath: '/tmp/other',
      runMeta: {
        sessionId: 's1',
        runId: 'r1',
        traceId: 't1',
        workspaceId: 'w1',
        agentUserText: 'hi'
      },
      ...callbacks,
      maxSteps: 10,
      invokeTimeoutMs: 60_000
    })

    const [, runPrompt] = vi.mocked(runReactLoop).mock.calls[0]!
    expect(runPrompt).toContain('工作区根目录：/tmp/other')
  })
})
