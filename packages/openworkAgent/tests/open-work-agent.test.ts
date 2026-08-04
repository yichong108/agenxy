/**
 * @file OpenWorkAgent AG-UI 适配器单元测试
 */

import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/client'
import type { Agent, AgentRunResult, AgentWaitResult, CoreMessage } from '@openwork/agent'
import type { LanguageModel } from 'ai'
import { firstValueFrom, toArray } from 'rxjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createAgentMock } = vi.hoisted(() => ({
  createAgentMock: vi.fn()
}))

vi.mock('@openwork/agent', () => ({
  createAgent: createAgentMock
}))

import { aguiMessagesToCore, extractUserTurn, OpenWorkAgent } from '../index.js'

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
 * @param handlers - 可选覆盖 send / wait 行为
 * @returns Agent 替身
 */
function createStubAgent(handlers?: { send?: Agent['send']; wait?: Agent['wait'] }): Agent {
  let messages: CoreMessage[] = []
  let lastWait: AgentWaitResult = { status: 'finished', result: 'Hello' }

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
      lastWait = { status: 'finished', result: 'Hello' }
      return { messages }
    })

  const wait: Agent['wait'] =
    handlers?.wait ??
    (async () => {
      if (!lastWait) throw new Error('No agent run to wait for; call send() first')
      return lastWait
    })

  return {
    get messages() {
      return messages
    },
    set messages(next: CoreMessage[]) {
      messages = [...next]
    },
    send: async (userText, input) => {
      try {
        return await send(userText, input)
      } catch (error) {
        lastWait = {
          status: 'error',
          result: '',
          error
        }
        throw error
      }
    },
    wait
  }
}

/**
 * 收集 Observable 全部事件。
 *
 * @param agent - OpenWorkAgent
 * @param input - RunAgentInput
 * @returns 事件列表
 */
async function collectEvents(agent: OpenWorkAgent, input: RunAgentInput): Promise<BaseEvent[]> {
  return firstValueFrom(agent.run(input).pipe(toArray()))
}

describe('OpenWorkAgent helpers', () => {
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
})

describe('OpenWorkAgent', () => {
  beforeEach(() => {
    createAgentMock.mockReset()
    createAgentMock.mockImplementation(() => createStubAgent())
  })

  it('run 产出与 AG-UI 一致的事件序列', async () => {
    const agent = new OpenWorkAgent({
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
            ]
          }
        }
      })
    )

    const agent = new OpenWorkAgent({
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
        },
        wait: async () => ({ status: 'error', result: '', error: new Error('boom') })
      })
    )

    const agent = new OpenWorkAgent({
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
    const agent = new OpenWorkAgent({ agent: { provider: stubModel } })
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
        ]
      }
    })
    createAgentMock.mockImplementation(() => createStubAgent({ send }))

    const agent = new OpenWorkAgent({
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

  it('clone 返回独立实例', () => {
    const agent = new OpenWorkAgent({
      agentId: 'ow',
      agent: { provider: stubModel }
    })
    const cloned = agent.clone()
    expect(cloned).toBeInstanceOf(OpenWorkAgent)
    expect(cloned).not.toBe(agent)
    expect(cloned.getAgent()).not.toBe(agent.getAgent())
  })

  it('暴露与 AG-UI AbstractAgent 一致的 API', () => {
    const agent = new OpenWorkAgent({ agent: { provider: stubModel } })
    expect(typeof agent.run).toBe('function')
    expect(typeof agent.runAgent).toBe('function')
    expect(typeof agent.abortRun).toBe('function')
    expect(typeof agent.subscribe).toBe('function')
    expect(createAgentMock).toHaveBeenCalled()
  })
})
