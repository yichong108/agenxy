/**
 * @openworker/cli 入口 — 解析参数、创建 OpenWorkerAgent、一次性对话或 REPL。
 */

import { parseArgs, printHelp } from './cli.js'
import { loadCliEnv, settingsFromEnv } from './env.js'
import { createCliAgent, runOnce, runRepl } from './run-agent.js'

/**
 * CLI 主流程。
 *
 * 加载环境变量 → 解析参数 → OpenWorkerAgent → 一次性 prompt 或 REPL。
 */
async function main(): Promise<void> {
  loadCliEnv()

  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    printHelp()
    process.exitCode = 1
    return
  }

  if (options.help) {
    printHelp()
    return
  }

  const settings = settingsFromEnv()
  const agent = createCliAgent(settings, options.cwd)

  try {
    if (options.prompt) {
      await runOnce(agent, options.prompt, {
        mode: options.mode,
        settings
      })
    } else {
      await runRepl(agent, {
        mode: options.mode,
        settings
      })
    }
  } finally {
    await agent.dispose()
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[cli] ${message}`)
  process.exitCode = 1
})
