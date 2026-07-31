import { spawn } from 'node:child_process'
import path from 'node:path'

import { rgPath } from '@vscode/ripgrep'

import { ensureWorkspaceExists, resolveSafePath } from './path-guard.js'

/** 输出行数硬上限（响应速度） */
export const GREP_MAX_OUTPUT_LINES = 2000

const RG_TIMEOUT_MS = 60_000

/**
 * grep 工具入参（对齐 Cursor / ripgrep 常见选项）。
 */
export type GrepToolArgs = {
  pattern: string
  path?: string
  glob?: string
  type?: string
  output_mode?: 'content' | 'files_with_matches' | 'count'
  '-i'?: boolean
  '-A'?: number
  '-B'?: number
  '-C'?: number
  multiline?: boolean
  head_limit?: number
}

function clampContext(n: number): number {
  return Math.min(Math.max(Math.floor(n), 0), 10)
}

function buildRgArgs(root: string, args: GrepToolArgs): { rgArgs: string[]; cwd: string } {
  const rgArgs = ['--hidden', '--no-require-git', '--no-config', '--color', 'never', '--crlf']

  if (args['-i']) {
    rgArgs.push('-i')
  }

  const outputMode = args.output_mode ?? 'content'

  if (outputMode === 'files_with_matches') {
    rgArgs.push('-l')
  } else if (outputMode === 'count') {
    rgArgs.push('-c')
  } else {
    rgArgs.push('--line-number', '--heading')
    if (args['-C'] !== undefined) {
      rgArgs.push('-C', String(clampContext(args['-C'])))
    } else {
      if (args['-B'] !== undefined) rgArgs.push('-B', String(clampContext(args['-B'])))
      if (args['-A'] !== undefined) rgArgs.push('-A', String(clampContext(args['-A'])))
    }
  }

  if (args.multiline) {
    rgArgs.push('-U', '--multiline-dotall')
  }

  const pattern = args.pattern.trim()
  if (pattern === '--') {
    rgArgs.push('--regexp', '\\-\\-')
  } else {
    rgArgs.push('--regexp', pattern)
  }

  if (args.glob?.trim()) {
    rgArgs.push('-g', args.glob.trim())
  }

  if (args.type?.trim()) {
    rgArgs.push('--type', args.type.trim())
  }

  let searchTarget = '.'
  if (args.path?.trim()) {
    const resolved = resolveSafePath(args.path.trim(), root)
    searchTarget = path.relative(root, resolved) || '.'
    searchTarget = searchTarget.split(path.sep).join('/')
  }

  rgArgs.push('--', searchTarget)
  return { rgArgs, cwd: root }
}

function relativizeLine(line: string, root: string): string {
  const rootResolved = path.resolve(root)
  const winRoot = rootResolved.replace(/\//g, '\\')
  const posixRoot = rootResolved.replace(/\\/g, '/')

  for (const prefix of [rootResolved, winRoot, posixRoot]) {
    if (!prefix) continue
    if (line.startsWith(prefix)) {
      const rest = line.slice(prefix.length).replace(/^[\\/]/, '')
      return rest.split(path.sep).join('/')
    }
  }
  return line.replace(/\\/g, '/')
}

function normalizeOutputPaths(output: string, root: string): string {
  if (!output) return output
  return output
    .split('\n')
    .map((line) => relativizeLine(line, root))
    .join('\n')
}

function applyHeadLimit(
  text: string,
  headLimit?: number
): { text: string; truncated: boolean; totalLines: number } {
  const lines = text.split('\n')
  const limit = headLimit
    ? Math.min(Math.max(headLimit, 1), GREP_MAX_OUTPUT_LINES)
    : GREP_MAX_OUTPUT_LINES
  if (lines.length <= limit) {
    return { text, truncated: false, totalLines: lines.length }
  }
  return {
    text:
      lines.slice(0, limit).join('\n') +
      `\n\n(showing first ${limit} of at least ${lines.length} lines)`,
    truncated: true,
    totalLines: lines.length
  }
}

function parseRgError(stderr: string): string | null {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return null

  if (lines.some((l) => l.includes('regex parse error') || l.startsWith('PCRE2:'))) {
    return lines.find((l) => l.startsWith('error:')) ?? lines[0]
  }
  if (lines.some((l) => l.startsWith('error parsing glob'))) {
    const line = lines.find((l) => l.startsWith('error parsing glob'))!
    return line.charAt(0).toUpperCase() + line.slice(1)
  }
  if (lines.some((l) => l.startsWith('grep config error'))) {
    return lines[0]
  }

  const first = lines[0]
  if (first.startsWith('error:')) return first
  return null
}

function runRipgrep(
  rgArgs: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(rgPath, rgArgs, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let killedForSize = false

    const timer = setTimeout(() => {
      killedForSize = true
      proc.kill()
    }, RG_TIMEOUT_MS)

    const onData = (chunk: Buffer, target: 'stdout' | 'stderr') => {
      const text = chunk.toString('utf8')
      if (target === 'stdout') {
        stdout += text
        if (stdout.length > 2_000_000) {
          killedForSize = true
          proc.kill()
        }
      } else {
        stderr += text
      }
    }

    proc.stdout?.on('data', (c) => onData(c, 'stdout'))
    proc.stderr?.on('data', (c) => onData(c, 'stderr'))

    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ stdout: '', stderr: err.message, code: -1 })
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (killedForSize && stdout.length > 2_000_000) {
        stdout = stdout.slice(0, 2_000_000)
      }
      resolve({ stdout, stderr, code: code ?? -1 })
    })
  })
}

/**
 * 在工作区内用捆绑的 ripgrep（`@vscode/ripgrep`）执行搜索。
 *
 * @param workspace - 工作区根目录
 * @param args - 搜索参数
 * @returns 搜索结果或错误说明
 */
export async function grepWorkspace(workspace: string, args: GrepToolArgs): Promise<string> {
  const root = ensureWorkspaceExists(workspace)
  const pattern = args.pattern?.trim()
  if (!pattern) {
    return 'pattern 不能为空'
  }

  let rgArgs: string[]
  let cwd: string
  try {
    ;({ rgArgs, cwd } = buildRgArgs(root, { ...args, pattern }))
  } catch (e) {
    return (e as Error).message
  }

  const { stdout, stderr, code } = await runRipgrep(rgArgs, cwd)

  if (code === -1 && stderr && !stdout.trim()) {
    return `grep 失败：${stderr}`
  }

  const trimmed = stdout.trimEnd()
  if (!trimmed) {
    if (code === 1) {
      return `未找到匹配：/${pattern}/`
    }
    const err = parseRgError(stderr)
    if (err) return `grep 失败：${err}`
    if (code !== 0 && code !== 1) {
      return `grep 失败：ripgrep 退出码 ${code}${stderr ? `：${stderr.trim()}` : ''}`
    }
    return `未找到匹配：/${pattern}/`
  }

  const normalized = normalizeOutputPaths(trimmed, root)
  const { text } = applyHeadLimit(normalized, args.head_limit)
  return text
}

/** 与 Cursor grep 工具对齐的工具描述。 */
export const GREP_TOOL_DESCRIPTION = `基于 ripgrep 的强大搜索工具

用法：
- 精确符号/字符串搜索优先用本工具，尽量代替终端 grep/rg，速度更快。
- 支持完整正则，如 "log.*Error"、"function\\s+\\w+"。字面量匹配需转义正则特殊字符。
- 避免过宽的 glob（如 '*'），会绕过 .gitignore 且可能很慢。
- 按文件类型过滤可用 type（ripgrep --type，如 ts、js、py）或 glob。
- output_mode："content" 显示匹配行（默认），"files_with_matches" 仅文件路径，"count" 每文件匹配数。
- 模式语法遵循 ripgrep（非 GNU grep）；Go/C++ 字面量中的花括号需转义（如 interface\\{\\}）。
- multiline: true 启用跨行匹配（rg -U --multiline-dotall）。
- 内容输出为 ripgrep 格式：':' 为匹配行，'-' 为上下文行，按文件 --heading 分组。
- 结果为响应速度设上限；截断时会说明省略行数。`
