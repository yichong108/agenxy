import { type ChildProcess, spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { ensureWorkspaceExists } from '@/main/path-guard'

const running = new Map<string, ChildProcess>()
const cancelledSessions = new Set<string>()

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false }
  return {
    text: s.slice(0, max) + `\n[Output truncated, original length ${s.length} characters]`,
    truncated: true
  }
}

export type RunCommandHandlers = {
  /** 右侧栏终端：实时推送输出；提供时 resolve 仅返回尾部状态行，避免与流式重复 */
  onChunk?: (text: string, stream: 'stdout' | 'stderr') => void
}

function spawnWorkspaceShell(command: string, cwd: string): ChildProcess {
  const env = { ...process.env }
  if (process.platform === 'win32') {
    return spawn(command, {
      cwd,
      env,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  }
  return spawn('/bin/sh', ['-c', command], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/**
 * Execute shell command in workspace root directory (MVP: no PTY; optional streaming for right-pane terminal)
 */
export function runCommand(
  sessionKey: string,
  workspace: string,
  command: string,
  maxOutputChars: number,
  handlers?: RunCommandHandlers
): Promise<string> {
  const cwd = ensureWorkspaceExists(workspace)
  const streaming = Boolean(handlers?.onChunk)
  return new Promise((resolve) => {
    const child = spawnWorkspaceShell(command, cwd)
    running.set(sessionKey, child)
    let out = ''
    let settled = false
    const finish = (value: string) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const push = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const text = chunk.toString('utf8')
      if (!text) return
      out += text
      handlers?.onChunk?.(text, stream)
      if (out.length > maxOutputChars * 2) {
        // Rough truncation first to avoid memory growth
        out = out.slice(0, maxOutputChars * 2)
        child.stdout?.removeAllListeners('data')
        child.stderr?.removeAllListeners('data')
        void killCommand(sessionKey)
        const { text: truncated } = truncate(out, maxOutputChars)
        const msg = truncated + '\n[Process terminated due to excessive output]'
        finish(streaming ? '\n[Process terminated due to excessive output]' : msg)
      }
    }
    child.stdout?.on('data', (chunk) => push(chunk, 'stdout'))
    child.stderr?.on('data', (chunk) => push(chunk, 'stderr'))
    const done = (code: number | null) => {
      const wasCancelled = cancelledSessions.delete(sessionKey)
      running.delete(sessionKey)
      const { text } = truncate(out, maxOutputChars)
      const suffix = wasCancelled
        ? '\n[Command cancelled]'
        : code && code !== 0
          ? `\n[Exit code ${code}]`
          : ''
      finish(streaming ? suffix : text + suffix)
    }
    child.on('error', (err) => {
      running.delete(sessionKey)
      finish(`Child process error: ${err.message}`)
    })
    child.on('close', (code) => done(code === null ? -1 : code))
  })
}

export function killCommand(sessionKey: string): Promise<void> {
  const c = running.get(sessionKey)
  if (!c) return Promise.resolve()
  cancelledSessions.add(sessionKey)
  return new Promise((resolve) => {
    c.once('close', () => resolve())
    const pid = c.pid
    if (process.platform === 'win32' && pid) {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
      killer.on('error', () => {
        try {
          c.kill()
        } catch {
          /* ignore */
        }
      })
    } else {
      try {
        c.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
    setTimeout(() => {
      if (!c.killed) {
        try {
          c.kill('SIGKILL')
        } catch {
          /* ignore */
        }
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
