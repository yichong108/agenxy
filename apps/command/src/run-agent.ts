/**
 * 创建并驱动 CLI 侧 agent：流式输出文本，简要打印工具事件。
 */

import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import {
  type Agent,
  createAgent,
  getChatModel,
  type ToolObservation
} from '@luneto/agent'
import {
  type AgentComposerMode,
  type AppSettings,
  MAX_AGENT_LOOP_STEPS
} from '@luneto/shared'

/**
 * 根据设置与工作区创建 CLI agent 实例。
 *
 * @param settings - 含 API Key / 模型的 AppSettings
 * @param cwd - 工作区根目录
 * @param mcpConfigPath - 可选 MCP 配置路径
 * @returns Agent 实例
 * @throws 未配置 API Key 时抛出
 */
export function createCliAgent(
  settings: AppSettings,
  cwd: string,
  mcpConfigPath?: string
): Agent {
  const provider = getChatModel(settings)
  if (!provider) {
    throw new Error(
      '请先配置 LUNETO_API_KEY（或 OPENAI_API_KEY），参见 apps/command/.env.example'
    )
  }

  return createAgent({
    provider,
    local: { cwd: resolve(cwd) },
    ...(mcpConfigPath
      ? { mcp: { configPath: resolve(mcpConfigPath) } }
      : {})
  })
}

/**
 * 向 stdout 打印工具观察事件（简要一行）。
 *
 * @param event - ToolObservation
 */
function printToolEvent(event: ToolObservation): void {
  const name = event.name || 'tool'
  if (event.status === 'start') {
    process.stdout.write(`\n[tool] ${name} …\n`)
    return
  }
  if (event.status === 'end') {
    process.stdout.write(`[tool] ${name} done\n`)
  }
}

/**
 * 发送一轮用户消息并流式打印助手回复。
 *
 * @param agent - createAgent 实例
 * @param userText - 用户输入
 * @param options - mode / settings（超时与 Tavily）
 */
export async function runOnce(
  agent: Agent,
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

  try {
    process.stdout.write('\n')
    await agent.send(userText, {
      composerMode: options.mode,
      abortController,
      tavily: { apiKey: options.settings.tavilyApiKey },
      maxSteps: MAX_AGENT_LOOP_STEPS,
      invokeTimeoutMs: options.settings.agentRunTimeoutMs,
      onTextDelta: (text) => {
        process.stdout.write(text)
      },
      onTool: printToolEvent
    })
    process.stdout.write('\n')
  } finally {
    process.off('SIGINT', onSigInt)
  }
}

/**
 * 交互式 REPL：循环读取 stdin，直到空行 / exit / Ctrl+D。
 *
 * @param agent - createAgent 实例
 * @param options - mode / settings
 */
export async function runRepl(
  agent: Agent,
  options: {
    mode: AgentComposerMode
    settings: AppSettings
  }
): Promise<void> {
  const rl = createInterface({ input, output, terminal: true })
  console.log(
    `Luneto CLI（mode=${options.mode}）。输入消息后回车；exit / quit 退出。`
  )

  try {
    while (true) {
      const line = (await rl.question('\n> ')).trim()
      if (!line) continue
      if (line === 'exit' || line === 'quit' || line === ':q') break
      try {
        await runOnce(agent, line, options)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`\n[error] ${message}`)
      }
    }
  } finally {
    rl.close()
  }
}
