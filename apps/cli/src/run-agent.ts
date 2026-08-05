/**
 * 创建并驱动 CLI 侧 OpenWorkerAgent：经 AG-UI 事件流式输出文本与工具事件。
 */

import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import {
  EventType,
  randomUUID,
  type Message,
  type RunErrorEvent,
  type TextMessageContentEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent
} from '@ag-ui/client'
import { getChatModel, OpenWorkerAgent, type OpenWorkerAgentRunDefaults } from '@openworker/agent'
import { type AgentComposerMode, type AppSettings, MAX_AGENT_LOOP_STEPS } from '@openworker/shared'

/**
 * 根据设置与工作区创建 CLI OpenWorkerAgent 实例。
 *
 * @param settings - 含 API Key / 模型的 AppSettings
 * @param cwd - 工作区根目录
 * @returns OpenWorkerAgent 实例
 * @throws 未配置 API Key 时抛出
 */
export function createCliAgent(settings: AppSettings, cwd: string): OpenWorkerAgent {
  const provider = getChatModel(settings)
  if (!provider) {
    throw new Error(
      '请先配置 OPENWORKERER_API_KEY（或 OPENAI_API_KEY），参见 apps/cli/.env.example'
    )
  }

  const workspacePath = resolve(cwd)
  return new OpenWorkerAgent({
    agentId: 'openworker-cli',
    description: 'Openworker CLI agent',
    agent: {
      provider,
      local: { cwd: workspacePath }
    },
    runDefaults: {
      workspacePath
    }
  })
}

/**
 * 向 stdout 打印本轮 AG-UI 工具相关事件（简要一行）。
 *
 * @param event - AG-UI BaseEvent（仅处理 TOOL_CALL_* / RUN_ERROR）
 */
function printAguiEvent(event: {
  type: string
  toolCallName?: string
  toolCallId?: string
  message?: string
  content?: string
}): void {
  if (event.type === EventType.TOOL_CALL_START) {
    const name = (event as ToolCallStartEvent).toolCallName || 'tool'
    process.stdout.write(`\n[tool] ${name} …\n`)
    return
  }
  if (event.type === EventType.TOOL_CALL_RESULT) {
    const e = event as ToolCallResultEvent
    process.stdout.write(`[tool] ${e.toolCallId} done\n`)
    return
  }
  if (event.type === EventType.RUN_ERROR) {
    const e = event as RunErrorEvent
    process.stderr.write(`\n[error] ${e.message}\n`)
  }
}

/**
 * 发送一轮用户消息并经 AG-UI 流式打印助手回复。
 *
 * @param agent - OpenWorkerAgent 实例
 * @param userText - 用户输入
 * @param options - mode / settings
 */
export async function runOnce(
  agent: OpenWorkerAgent,
  userText: string,
  options: {
    mode: AgentComposerMode
    settings: AppSettings
  }
): Promise<void> {
  const abortController = new AbortController()
  const onSigInt = () => {
    abortController.abort()
  }
  process.once('SIGINT', onSigInt)

  const userMessage: Message = {
    id: randomUUID(),
    role: 'user',
    content: userText
  }
  agent.messages = [...agent.messages, userMessage]

  const forwardedProps: OpenWorkerAgentRunDefaults = {
    composerMode: options.mode,
    abortController,
    tavily: { apiKey: options.settings.tavilyApiKey },
    maxSteps: MAX_AGENT_LOOP_STEPS,
    invokeTimeoutMs: options.settings.agentRunTimeoutMs
  }

  try {
    process.stdout.write('\n')

    const { unsubscribe } = agent.subscribe({
      onEvent: ({ event }) => {
        if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
          process.stdout.write((event as TextMessageContentEvent).delta)
          return
        }
        printAguiEvent(event)
      }
    })

    try {
      await agent.runAgent({
        runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tools: [],
        context: [],
        forwardedProps
      })
    } finally {
      unsubscribe()
    }

    process.stdout.write('\n')
  } finally {
    process.off('SIGINT', onSigInt)
  }
}

/**
 * 交互式 REPL：循环读取 stdin，直到空行 / exit / Ctrl+D。
 *
 * @param agent - OpenWorkerAgent 实例
 * @param options - mode / settings
 */
export async function runRepl(
  agent: OpenWorkerAgent,
  options: {
    mode: AgentComposerMode
    settings: AppSettings
  }
): Promise<void> {
  const rl = createInterface({ input, output })
  try {
    for (;;) {
      const line = (await rl.question('> ')).trim()
      if (!line || line === 'exit' || line === 'quit') break
      await runOnce(agent, line, options)
    }
  } finally {
    rl.close()
  }
}
