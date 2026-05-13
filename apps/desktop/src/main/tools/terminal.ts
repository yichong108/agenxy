import { type ChildProcess, spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { ensureWorkspaceExists } from '@/main/path-guard'

const running = new Map<string, ChildProcess>()

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false }
  return {
    text: s.slice(0, max) + `\n[Output truncated, original length ${s.length} characters]`,
    truncated: true
  }
}

/**
 * Execute shell command in workspace root directory (MVP: Windows cmd style / no PTY, cross-platform with shell)
 */
export function runCommand(
  sessionKey: string,
  workspace: string,
  command: string,
  maxOutputChars: number
): Promise<string> {
  const cwd = ensureWorkspaceExists(workspace)
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const child = isWin
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
          cwd,
          windowsVerbatimArguments: false
        })
      : spawn('/bin/sh', ['-c', command], { cwd })
    running.set(sessionKey, child)
    let out = ''
    const push = (chunk: Buffer) => {
      out += chunk.toString('utf8')
      if (out.length > maxOutputChars * 2) {
        // Rough truncation first to avoid memory growth
        out = out.slice(0, maxOutputChars * 2)
        child.stdout?.removeAllListeners('data')
        child.stderr?.removeAllListeners('data')
        void killCommand(sessionKey)
        const { text } = truncate(out, maxOutputChars)
        resolve(text + '\n[Process terminated due to excessive output]')
      }
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)
    const done = (code: number | null) => {
      running.delete(sessionKey)
      const { text } = truncate(out, maxOutputChars)
      resolve(text + (code && code !== 0 ? `\n[Exit code ${code}]` : ''))
    }
    child.on('error', (err) => {
      running.delete(sessionKey)
      resolve(`Child process error: ${err.message}`)
    })
    child.on('close', (code) => done(code === null ? -1 : code))
  })
}

export function killCommand(sessionKey: string): Promise<void> {
  const c = running.get(sessionKey)
  if (!c) return Promise.resolve()
  return new Promise((resolve) => {
    c.once('close', () => resolve())
    if (process.platform === 'win32') {
      c.kill()
    } else {
      c.kill('SIGTERM')
    }
    setTimeout(() => {
      if (!c.killed) {
        c.kill('SIGKILL')
      }
    }, 3000)
  })
}

export function isRunning(key: string): boolean {
  return running.has(key)
}

function extractLastTokenRange(input: string): { start: number; token: string } {
  const s = input ?? ''
  let i = s.length - 1
  while (i >= 0 && /\s/.test(s[i] ?? '')) i -= 1
  if (i < 0) return { start: s.length, token: '' }
  let start = i
  while (start >= 0 && !/\s/.test(s[start] ?? '')) start -= 1
  const tokenStart = start + 1
  return { start: tokenStart, token: s.slice(tokenStart, i + 1) }
}

function isPathInsideWorkspace(workspaceRoot: string, targetPath: string): boolean {
  const rel = path.relative(workspaceRoot, targetPath)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Provide basic path completion for terminal command line (match only by last token).
 */
export async function completeCommandInWorkspace(
  workspace: string,
  commandLine: string
): Promise<string[]> {
  const workspaceRoot = ensureWorkspaceExists(workspace)
  const { start, token } = extractLastTokenRange(commandLine)
  const tokenPrefix = commandLine.slice(0, start)
  const normalizedToken = token.replace(/[\\/]+/g, path.sep)
  const hasTrailingSep = /[\\/]$/.test(token)
  const basePart = hasTrailingSep ? normalizedToken : path.dirname(normalizedToken)
  const namePart = hasTrailingSep ? '' : path.basename(normalizedToken)
  const relativeBase =
    basePart === '.' || basePart === path.sep || !basePart ? '' : basePart.replace(/^[\\/]+/, '')
  const absBase = path.resolve(workspaceRoot, relativeBase || '.')
  if (!isPathInsideWorkspace(workspaceRoot, absBase)) return []
  const entries = await readdir(absBase, { withFileTypes: true })
  const lowerNeedle = namePart.toLowerCase()
  const matched = entries
    .filter((entry) => entry.name.toLowerCase().startsWith(lowerNeedle))
    .slice(0, 80)
    .map((entry) => {
      const rawPath = relativeBase ? path.join(relativeBase, entry.name) : entry.name
      const slashPath = rawPath.split(path.sep).join('/')
      return `${tokenPrefix}${slashPath}${entry.isDirectory() ? '/' : ''}`
    })
  return matched
}
