/**
 * @file OpenWorkerAgent AG-UI 适配器单元测试
 */

import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/client'
import type { LanguageModel } from 'ai'
import { firstValueFrom, toArray } from 'rxjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createAgentMock } = vi.hoisted(() => ({
  createAgentMock: vi.fn()
}))

vi.mock('../src/create-agent.js', () => ({
  createAgent: createAgentMock
}))

import type { Agent, AgentRunResult } from '../src/create-agent.js'
import type { CoreMessage } from '../src/messages.js'
import {
  aguiMessagesToCore,
  coreMessagesToAgui,
  extractUserTurn,
  OpenWorkerAgent
} from '../src/createAGUIAgent.js'

const stubModel = { modelId: 'test-model' } as LanguageModel

function baseInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: 'thread-1',
    runId: 'run-1',
    state: {},
    messages: [{ id: 'u1', role: 'user', content: 'ping' }],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides
  }
}

/**
 * 构造可注入的 createAgent 替身。
 *
 * @param handlers - 可选覆盖 send 行为
 * @returns Agent 替身
 */
function createStubAgent(handlers?: { send?: Agent['send'] }): Agent {
  let messages: CoreMessage[] = []

  const send: Agent['send'] =
    handlers?.send ??
    (async (userText, input = {}): Promise<AgentRunResult> => {
      input.onTextDelta?.('Hel')
      input.onTextDelta?.('lo')
      messages = [
        ...messages,
        { role: 'user', content: userText },
        { role: 'assistant', content: 'Hello' }
      ]
      return { messages, result: 'Hello' }
    })

  return {
    get messages() {
      return messages
    },
    set messages(next: CoreMessage[]) {
      messages = [...next]
    },
    send,
    mcp: {
      probe: async () => ({ ok: false as const, error: 'stub' }),
      warmup: async () => [],
      dispose: async () => undefined
    }
  }
}

/**
 * 收集 Observable 全部事件。
 *
 * @param agent - OpenWorkerAgent
 * @param input - RunAgentInput
 * @returns 事件列表
 */
async function collectEvents(agent: OpenWorkerAgent, input: RunAgentInput): Promise<BaseEvent[]> {
  return firstValueFrom(agent.run(input).pipe(toArray()))
}

describe('OpenWorkerAgent helpers', () => {
  it('extractUserTurn 提取最后一条 user 并保留历史', () => {
    const { userText, history } = extractUserTurn([
      { id: '1', role: 'user', content: 'hi' },
      { id: '2', role: 'assistant', content: 'hey' },
      { id: '3', role: 'user', content: '继续' }
    ])
    expect(userText).toBe('继续')
    expect(history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey' }
    ])
  })

  it('aguiMessagesToCore 转换 assistant toolCalls', () => {
    const core = aguiMessagesToCore([
      {
        id: 'a1',
        role: 'assistant',
        content: 'calling',
        toolCalls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.ts"}' }
          }
        ]
      },
      {
        id: 't1',
        role: 'tool',
        toolCallId: 'tc1',
        content: 'ok'
      }
    ])
    expect(core[0]).toMatchObject({ role: 'assistant' })
    expect(core[1]).toMatchObject({ role: 'tool' })
  })

  it('coreMessagesToAgui 与 aguiMessagesToCore 往返保留 user/assistant 文本', () => {
    const core: CoreMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey' }
    ]
    const agui = coreMessagesToAgui(core)
    expect(agui).toHaveLength(2)
    expect(agui[0]).toMatchObject({ role: 'user', content: 'hi' })
    expect(agui[1]).toMatchObject({ role: 'assistant', content: 'hey' })
    expect(aguiMessagesToCore(agui)).toEqual(core)
  })

  it('coreMessagesToAgui 转换 assistant tool-call 与 tool 结果', () => {
    const agui = coreMessagesToAgui([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'read_file',
            args: { path: 'a.ts' }
          }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc1',
            toolName: 'read_file',
            result: 'ok'
          }
        ]
      }
    ])
    expect(agui[0]).toMatchObject({
      role: 'assistant',
      content: 'calling',
      toolCalls: [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.ts"}' }
        }
      ]
    })
    expect(agui[1]).toMatchObject({
      role: 'tool',
      toolCallId: 'tc1',
      content: 'ok'
    })
  })
})

describe('OpenWorkerAgent', () => {
  beforeEach(() => {
    createAgentMock.mockReset()
    createAgentMock.mockImplementation(() => createStubAgent())
  })

  it('run 产出与 AG-UI 一致的事件序列', async () => {
    const agent = new OpenWorkerAgent({
      agentId: 'ow',
      agent: { provider: stubModel, local: { cwd: '/tmp/ws' } },
      runDefaults: { composerMode: 'ask', terminalKey: 'term:t' }
    })

    const events = await collectEvents(agent, baseInput())
    const types = events.map((e) => e.type)

    expect(types[0]).toBe(EventType.RUN_STARTED)
    expect(types).toContain(EventType.TEXT_MESSAGE_START)
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT)
    expect(types).toContain(EventType.TEXT_MESSAGE_END)
    expect(types.at(-1)).toBe(EventType.RUN_FINISHED)

    const contents = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => ('delta' in e ? e.delta : ''))
    expect(contents.join('')).toBe('Hello')

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      threadId: 'thread-1',
      runId: 'run-1',
      result: 'Hello'
    })
  })

  it('onTool 映射为 TOOL_CALL_* 事件', async () => {
    createAgentMock.mockImplementation(() =>
      createStubAgent({
        send: async (userText, input = {}) => {
          input.onTool?.({
            id: 'read_file-1',
            name: 'read_file',
            status: 'start',
            args: 'a.ts',
            timestampMs: 1
          })
          input.onTool?.({
            id: 'read_file-1',
            name: 'read_file',
            status: 'end',
            result: 'file content',
            timestampMs: 2
          })
          input.onTextDelta?.('done')
          return {
            messages: [
              { role: 'user', content: userText },
              { role: 'assistant', content: 'done' }
            ],
            result: 'done'
          }
        }
      })
    )

    const agent = new OpenWorkerAgent({
      agent: { provider: stubModel, local: { cwd: '/tmp/ws' } }
    })
    const events = await collectEvents(agent, baseInput())
    const types = events.map((e) => e.type)
    expect(types).toContain(EventType.TOOL_CALL_START)
    expect(types).toContain(EventType.TOOL_CALL_ARGS)
    expect(types).toContain(EventType.TOOL_CALL_END)
    expect(types).toContain(EventType.TOOL_CALL_RESULT)

    const argsEvent = events.find((e) => e.type === EventType.TOOL_CALL_ARGS)
    expect(argsEvent).toMatchObject({
      toolCallId: 'read_file-1',
      delta: JSON.stringify({ summary: 'a.ts' })
    })
  })

  it('send 失败时产出 RUN_ERROR 并 complete', async () => {
    createAgentMock.mockImplementation(() =>
      createStubAgent({
        send: async () => {
          throw new Error('boom')
        }
      })
    )

    const agent = new OpenWorkerAgent({
      agent: { provider: stubModel, local: { cwd: '/tmp/ws' } }
    })
    const events = await collectEvents(agent, baseInput())

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: 'boom',
      code: 'ERROR'
    })
  })

  it('无用户消息时产出 RUN_ERROR', async () => {
    const agent = new OpenWorkerAgent({ agent: { provider: stubModel } })
    const events = await collectEvents(
      agent,
      baseInput({
        messages: [{ id: 'a', role: 'assistant', content: 'only assistant' }]
      })
    )

    expect(events[0]?.type).toBe(EventType.RUN_STARTED)
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: 'RunAgentInput.messages must contain a user message'
    })
  })

  it('forwardedProps 传入 send 选项', async () => {
    const send = vi.fn(async (userText, input = {}) => {
      input.onTextDelta?.('ok')
      return {
        messages: [
          { role: 'user' as const, content: userText },
          { role: 'assistant' as const, content: 'ok' }
        ],
        result: 'ok'
      }
    })
    createAgentMock.mockImplementation(() => createStubAgent({ send }))

    const agent = new OpenWorkerAgent({
      agent: { provider: stubModel, local: { cwd: '/tmp/ws' } },
      runDefaults: { composerMode: 'ask' }
    })

    await collectEvents(
      agent,
      baseInput({
        forwardedProps: { workspacePath: '/tmp/other', terminalKey: 'term:x' }
      })
    )

    expect(send).toHaveBeenCalledWith(
      'ping',
      expect.objectContaining({
        composerMode: 'ask',
        workspacePath: '/tmp/other',
        terminalKey: 'term:x'
      })
    )
  })

  it('runAgent 可携带含函数的 LanguageModel（避免 structuredClone 失败）', async () => {
    const send = vi.fn(async (userText, input = {}) => {
      input.onTextDelta?.('ok')
      return {
        messages: [
          { role: 'user' as const, content: userText },
          { role: 'assistant' as const, content: 'ok' }
        ],
        result: 'ok'
      }
    })
    createAgentMock.mockImplementation(() => createStubAgent({ send }))

    // 模拟 @ai-sdk/openai 的 url 解析函数；structuredClone 会因此抛错
    const modelWithUrl = {
      modelId: 'openai-compat',
      config: {
        url: ({ path }: { path: string }) => `https://api.example/v1${path}`
      }
    } as unknown as LanguageModel

    const abortController = new AbortController()
    const agent = new OpenWorkerAgent({
      agent: { provider: stubModel, local: { cwd: '/tmp/ws' } }
    })
    agent.messages = [{ id: 'u1', role: 'user', content: 'ping' }]

    await expect(
      agent.runAgent({
        runId: 'run-clone-safe',
        tools: [],
        context: [],
        forwardedProps: {
          provider: modelWithUrl,
          abortController,
          workspacePath: '/tmp/ws'
        }
      })
    ).resolves.toMatchObject({ result: 'ok' })

    expect(send).toHaveBeenCalledWith(
      'ping',
      expect.objectContaining({
        provider: modelWithUrl,
        abortController,
        workspacePath: '/tmp/ws'
      })
    )
  })

  it('clone 返回独立实例', () => {
    const agent = new OpenWorkerAgent({
      agentId: 'ow',
      agent: { provider: stubModel }
    })
    const cloned = agent.clone()
    expect(cloned).toBeInstanceOf(OpenWorkerAgent)
    expect(cloned).not.toBe(agent)
    expect(cloned.mcp).not.toBe(agent.mcp)
  })

  it('暴露与 AG-UI AbstractAgent 一致的 API', () => {
    const agent = new OpenWorkerAgent({ agent: { provider: stubModel } })
    expect(typeof agent.run).toBe('function')
    expect(typeof agent.runAgent).toBe('function')
    expect(typeof agent.abortRun).toBe('function')
    expect(typeof agent.subscribe).toBe('function')
    expect(agent.mcp).toBeTypeOf('object')
    expect(createAgentMock).toHaveBeenCalled()
  })
})
