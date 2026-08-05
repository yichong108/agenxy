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

vi.mock('../src/skills/load-skills.js', () => ({
  loadSkillsFromPaths: vi.fn(async () => ({ tools: {}, hint: '' }))
}))

vi.mock('../src/mcp/mcp-runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/mcp/mcp-runtime.js')>()
  return {
    ...actual,
    buildMcpToolsFromConfig: vi.fn(async () => ({
      tools: {},
      contextHints: '',
      servers: []
    }))
  }
})

import { createAgent } from '../src/create-agent.js'
import { runReactLoop } from '../src/react-loop.js'
import { loadSkillsFromPaths } from '../src/skills/load-skills.js'

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
    vi.mocked(loadSkillsFromPaths).mockClear()
    vi.mocked(loadSkillsFromPaths).mockResolvedValue({ tools: {}, hint: '' })
  })

  it('返回含 send / mcp 的实例', () => {
    const agent = createAgent({ provider: stubModel, local: { cwd: '/tmp/ws' } })
    expect(agent.send).toBeTypeOf('function')
    expect(agent.mcp).toBeTypeOf('object')
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
    expect(result.result).toBe('hello')
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

  it('send 成功时返回助手文本', async () => {
    const agent = createAgent({ provider: stubModel, local: { cwd: '/tmp/ws' } })
    const callbacks = createCallbacks()

    const result = await agent.send('hi', {
      composerMode: 'ask',
      ...callbacks
    })

    expect(result.result).toBe('hello')
  })

  it('取消时 send 抛错且保留已追加用户消息', async () => {
    const agent = createAgent({ provider: stubModel, local: { cwd: '/tmp/ws' } })
    const callbacks = createCallbacks()
    const abortError = new Error('Aborted')
    abortError.name = 'AbortError'
    vi.mocked(runReactLoop).mockRejectedValueOnce(abortError)

    await expect(
      agent.send('hi', {
        composerMode: 'ask',
        ...callbacks
      })
    ).rejects.toThrow('Aborted')

    expect(agent.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('失败时 send 抛错', async () => {
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
  })

  it('build 模式将 skills 名称摘要合并进 system prompt', async () => {
    vi.mocked(loadSkillsFromPaths).mockResolvedValue({
      tools: {},
      hint: '可用技能工具（可自动调用）：\n- debug_workflow: 故障排查\n- code_review: 代码审查'
    })

    const agent = createAgent({ provider: stubModel, local: { cwd: '/tmp/ws' } })
    await agent.send('修一下报错', { composerMode: 'build' })

    expect(loadSkillsFromPaths).toHaveBeenCalledOnce()
    const [, runPrompt] = vi.mocked(runReactLoop).mock.calls[0]!
    expect(runPrompt).toContain('可用技能工具（可自动调用）')
    expect(runPrompt).toContain('debug_workflow')
    expect(runPrompt).toContain('code_review')
  })

  it('ask 模式不加载 skills、不注入技能摘要', async () => {
    vi.mocked(loadSkillsFromPaths).mockResolvedValue({
      tools: {},
      hint: '可用技能工具（可自动调用）：\n- debug_workflow: 故障排查'
    })

    const agent = createAgent({ provider: stubModel, local: { cwd: '/tmp/ws' } })
    await agent.send('这段代码做什么？', { composerMode: 'ask' })

    expect(loadSkillsFromPaths).not.toHaveBeenCalled()
    const [, runPrompt] = vi.mocked(runReactLoop).mock.calls[0]!
    expect(runPrompt).not.toContain('可用技能工具')
    expect(runPrompt).not.toContain('debug_workflow')
  })
})
