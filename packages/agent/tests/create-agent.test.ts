/**
 * @file create-agent.ts 单元测试
 */

import type { LanguageModel } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/react-loop.js', () => ({
  runReactLoop: vi.fn(async (_model, _prompt, messages) => [
    ...messages,
    { role: 'assistant' as const, content: 'hello' }
  ])
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

  it('返回含 send / wait 的实例', () => {
    const agent = createAgent({ provider: stubModel, local: { cwd: '/tmp/ws' } })
    expect(agent.send).toBeTypeOf('function')
    expect(agent.wait).toBeTypeOf('function')
    expect(agent.messages).toEqual([])
  })

  it('createAgent 可注入初始 messages', () => {
    const agent = createAgent({
      provider: stubModel,
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(agent.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('send 未传 workspacePath 时回退 local.cwd', async () => {
    const agent = createAgent({ provider: stubModel, local: { cwd: '/tmp/ws' } })
    const callbacks = createCallbacks()

    const result = await agent.send('ping', {
      composerMode: 'ask',
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
    expect(result.messages).toEqual([
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'hello' }
    ])
    expect(agent.messages).toEqual(result.messages)
  })

  it('send 优先使用本轮 workspacePath', async () => {
    const agent = createAgent({ provider: stubModel, local: { cwd: '/tmp/ws' } })
    const callbacks = createCallbacks()

    await agent.send('ping', {
      composerMode: 'ask',
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

    await agent.send('ping', {
      composerMode: 'ask',
      abortController: new AbortController(),
      terminalKey: 'term:s1',
      ...callbacks,
      maxSteps: 10,
      invokeTimeoutMs: 60_000
    })

    const [, runPrompt] = vi.mocked(runReactLoop).mock.calls[0]!
    expect(runPrompt).toContain(`工作区根目录：${process.cwd()}`)
  })

  it('send(userText, {}) 形态可用且支持连续 send', async () => {
    const agent = createAgent({
      provider: stubModel,
      messages: [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'ack' }
      ]
    })

    await agent.send('ping', { composerMode: 'ask' })

    const [, , firstPass] = vi.mocked(runReactLoop).mock.calls[0]!
    expect(firstPass).toEqual([
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'ping' }
    ])
    expect(agent.messages).toEqual([
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'hello' }
    ])

    vi.mocked(runReactLoop).mockClear()
    vi.mocked(runReactLoop).mockImplementationOnce(async (_m, _p, msgs) => [
      ...msgs,
      { role: 'assistant' as const, content: 'again' }
    ])

    await agent.send('pong', {})

    const [, , secondPass] = vi.mocked(runReactLoop).mock.calls[0]!
    expect(secondPass).toEqual([
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'pong' }
    ])
    expect(agent.messages.at(-1)).toEqual({ role: 'assistant', content: 'again' })
  })

  it('userText 为空时抛错', async () => {
    const agent = createAgent({ provider: stubModel })
    await expect(agent.send('   ', {})).rejects.toThrow('userText is empty')
  })

  it('wait 在 send 成功后返回 finished 与助手文本', async () => {
    const agent = createAgent({ provider: stubModel, local: { cwd: '/tmp/ws' } })
    const callbacks = createCallbacks()

    const sendPromise = agent.send('hi', {
      composerMode: 'ask',
      ...callbacks
    })
    const waitResult = await agent.wait()
    await sendPromise

    expect(waitResult).toEqual({
      status: 'finished',
      result: 'hello'
    })
    // 重复 wait 返回同一终态
    await expect(agent.wait()).resolves.toEqual(waitResult)
  })

  it('wait 在取消时返回 cancelled', async () => {
    const agent = createAgent({ provider: stubModel, local: { cwd: '/tmp/ws' } })
    const callbacks = createCallbacks()
    const abortError = new Error('Aborted')
    abortError.name = 'AbortError'
    vi.mocked(runReactLoop).mockRejectedValueOnce(abortError)

    const sendPromise = agent.send('hi', {
      composerMode: 'ask',
      ...callbacks
    })
    await expect(sendPromise).rejects.toThrow('Aborted')

    const waitResult = await agent.wait()
    expect(waitResult.status).toBe('cancelled')
    expect(waitResult.result).toBe('')
    expect(waitResult.error).toBe(abortError)
    // 失败时仍保留已追加的用户消息
    expect(agent.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('wait 在失败时返回 error', async () => {
    const agent = createAgent({ provider: stubModel, local: { cwd: '/tmp/ws' } })
    const callbacks = createCallbacks()
    const boom = new Error('model failed')
    vi.mocked(runReactLoop).mockRejectedValueOnce(boom)

    await expect(
      agent.send('hi', {
        composerMode: 'ask',
        ...callbacks
      })
    ).rejects.toThrow('model failed')

    const waitResult = await agent.wait()
    expect(waitResult.status).toBe('error')
    expect(waitResult.error).toBe(boom)
  })

  it('未 send 时 wait 抛错', async () => {
    const agent = createAgent({ provider: stubModel })
    await expect(agent.wait()).rejects.toThrow('No agent run to wait for')
  })
})
