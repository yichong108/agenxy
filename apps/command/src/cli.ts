/**
 * CLI 参数解析与帮助文案。
 */

import type { AgentComposerMode } from '@openwork/shared'

/** 解析后的命令行选项 */
export type CliOptions = {
  /** 一次性提示词；为空则进入 REPL */
  prompt: string
  /** 工作区根目录 */
  cwd: string
  /** ask | build */
  mode: AgentComposerMode
  /** 是否打印帮助后退出 */
  help: boolean
}

/**
 * 打印 CLI 用法。
 */
export function printHelp(): void {
  console.log(`Openwork Command — 命令行智能体

用法:
  pnpm --filter @openwork/command start -- [options] [prompt]
  pnpm --filter @openwork/command start -- [options]

选项:
  -h, --help          显示帮助
  -C, --cwd <path>    工作区根目录（默认 process.cwd()）
  -m, --mode <mode>   ask | build（默认 build）

MCP / Skills 从用户目录 ~/.openwork/mcp.json 与 ~/.openwork/skills 自动加载。

环境变量（见 .env.example）:
  OPENWORK_API_KEY    OpenAI 兼容 API Key（必填）
  OPENWORK_BASE_URL   接口地址
  OPENWORK_MODEL      模型名
  TAVILY_API_KEY      可选联网搜索

示例:
  pnpm --filter @openwork/command start -- "列出当前目录文件"
  pnpm --filter @openwork/command start -- -m ask
`)
}

/**
 * 解析 process.argv（跳过 node / 脚本路径）。
 *
 * @param argv - 通常为 process.argv.slice(2)
 * @returns 解析后的选项
 */
export function parseArgs(argv: string[]): CliOptions {
  let cwd = process.cwd()
  let mode: AgentComposerMode = 'build'
  let help = false
  const promptParts: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-h' || arg === '--help') {
      help = true
      continue
    }
    if (arg === '-C' || arg === '--cwd') {
      const next = argv[++i]
      if (!next) throw new Error(`${arg} 需要路径参数`)
      cwd = next
      continue
    }
    if (arg === '-m' || arg === '--mode') {
      const next = argv[++i]
      if (next !== 'ask' && next !== 'build') {
        throw new Error(`${arg} 需要 ask 或 build`)
      }
      mode = next
      continue
    }
    if (arg.startsWith('-')) {
      throw new Error(`未知选项: ${arg}`)
    }
    promptParts.push(arg)
  }

  return {
    prompt: promptParts.join(' ').trim(),
    cwd,
    mode,
    help
  }
}
