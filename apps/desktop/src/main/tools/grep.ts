import { spawn } from 'node:child_process'
import path from 'node:path'

import { rgPath } from '@vscode/ripgrep'

import { ensureWorkspaceExists, resolveSafePath } from '@/main/path-guard'

/** Hard cap on output lines (Cursor-style responsiveness). */
export const GREP_MAX_OUTPUT_LINES = 2000

const RG_TIMEOUT_MS = 60_000

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
  const rgArgs = [
    '--hidden',
    '--no-require-git',
    '--no-config',
    '--color',
    'never',
    '--crlf'
  ]

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
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
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

function runRipgrep(rgArgs: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
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
 * Cursor-compatible grep: spawns bundled ripgrep (`@vscode/ripgrep`) in the workspace.
 */
export async function grepWorkspace(workspace: string, args: GrepToolArgs): Promise<string> {
  const root = ensureWorkspaceExists(workspace)
  const pattern = args.pattern?.trim()
  if (!pattern) {
    return 'pattern is empty'
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
    return `Grep failed: ${stderr}`
  }

  const trimmed = stdout.trimEnd()
  if (!trimmed) {
    if (code === 1) {
      return `No matches for /${pattern}/`
    }
    const err = parseRgError(stderr)
    if (err) return `Grep failed: ${err}`
    if (code !== 0 && code !== 1) {
      return `Grep failed: ripgrep exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`
    }
    return `No matches for /${pattern}/`
  }

  const normalized = normalizeOutputPaths(trimmed, root)
  const { text } = applyHeadLimit(normalized, args.head_limit)
  return text
}

/** Tool description aligned with Cursor's grep tool. */
export const GREP_TOOL_DESCRIPTION = `A powerful search tool built on ripgrep

Usage:
- Prefer grep for exact symbol/string searches. Whenever possible, use this instead of terminal grep/rg. This tool is faster.
- Supports full regex syntax, e.g. "log.*Error", "function\\s+\\w+". Escape special regex characters for literal matches.
- Avoid overly broad glob patterns (e.g. '*') as they bypass .gitignore rules and may be slow.
- Use 'type' (ripgrep --type, e.g. ts, js, py, rust) or 'glob' when filtering by file type.
- output_mode: "content" shows matching lines (default), "files_with_matches" shows file paths only, "count" shows match counts per file.
- Pattern syntax follows ripgrep (not GNU grep); escape braces in Go/C++ literals (e.g. interface\\{\\}).
- multiline: true enables cross-line patterns (rg -U --multiline-dotall).
- Content output uses ripgrep format: ':' for match lines, '-' for context lines, grouped by file with --heading.
- Results are capped for responsiveness; truncated output notes how many lines were omitted.`
