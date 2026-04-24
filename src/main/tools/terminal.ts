import { type ChildProcess, spawn } from 'node:child_process'
import { ensureWorkspaceExists } from '../path-guard.js'

const running = new Map<string, ChildProcess>()

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false }
  return {
    text: s.slice(0, max) + `\n[输出已截断，原长度 ${s.length} 字符]`,
    truncated: true
  }
}

/**
 * 在工作区根目录执行 shell 命令（MVP: Windows 为 cmd 风格 / 无 PTY，跨平台用 shell）
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
        // 先粗暴截断避免内存涨
        out = out.slice(0, maxOutputChars * 2)
        child.stdout?.removeAllListeners('data')
        child.stderr?.removeAllListeners('data')
        void killCommand(sessionKey)
        const { text } = truncate(out, maxOutputChars)
        resolve(text + '\n[进程因输出过长被终止]')
      }
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)
    const done = (code: number | null) => {
      running.delete(sessionKey)
      const { text } = truncate(out, maxOutputChars)
      resolve(text + (code && code !== 0 ? `\n[退出码 ${code}]` : ''))
    }
    child.on('error', (err) => {
      running.delete(sessionKey)
      resolve(`子进程错误: ${err.message}`)
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
