/**
 * @file create-agent.ts 单元测试
 */

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
    const agent = createAgent({ provider: stubModel, local: { cwd: '/tmp/ws' } })
    expect(agent.send).toBeTypeOf('function')
  })

  it('send 未传 workspacePath 时回退 local.cwd', async () => {
    const agent = createAgent({ provider: stubModel, local: { cwd: '/tmp/ws' } })
    const callbacks = createCallbacks()

    const result = await agent.send({
      composerMode: 'ask',
      messages: [],
      abortController: new AbortController(),
      terminalKey: 'term:s1',
      ...callbacks,
      maxSteps: 10,
      invokeTimeoutMs: 60_000
    })

    expect(runReactLoop).toHaveBeenCalledOnce()
    const [model, runPrompt] = vi.mocked(runReactLoop).mock.calls[0]!
    expect(model).toBe(stubModel)
    expect(runPrompt).toContain('工作区根目录：/tmp/ws')
    expect(result.messages).toEqual([{ role: 'assistant', content: 'hello' }])
  })

  it('send 优先使用本轮 workspacePath', async () => {
    const agent = createAgent({ provider: stubModel, local: { cwd: '/tmp/ws' } })
    const callbacks = createCallbacks()

    await agent.send({
      composerMode: 'ask',
      messages: [],
      abortController: new AbortController(),
      workspacePath: '/tmp/other',
      terminalKey: 'term:s1',
      ...callbacks,
      maxSteps: 10,
      invokeTimeoutMs: 60_000
    })

    const [, runPrompt] = vi.mocked(runReactLoop).mock.calls[0]!
    expect(runPrompt).toContain('工作区根目录：/tmp/other')
  })

  it('未传 local 时使用默认 cwd（process.cwd）', async () => {
    const agent = createAgent({ provider: stubModel })
    const callbacks = createCallbacks()

    await agent.send({
      composerMode: 'ask',
      messages: [],
      abortController: new AbortController(),
      terminalKey: 'term:s1',
      ...callbacks,
      maxSteps: 10,
      invokeTimeoutMs: 60_000
    })

    const [, runPrompt] = vi.mocked(runReactLoop).mock.calls[0]!
    expect(runPrompt).toContain(`工作区根目录：${process.cwd()}`)
  })
})
