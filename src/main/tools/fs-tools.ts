import fs from 'node:fs/promises'
import path from 'node:path'

import { resolveSafePath, ensureWorkspaceExists } from '@/main/path-guard'

const MAX_READ = 500_000

const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.toml',
  '.css',
  '.html',
  '.txt',
  '.vue',
  '.rs',
  '.go',
  '.py'
])

function looksTextual(file: string): boolean {
  const ext = path.extname(file).toLowerCase()
  if (!ext) return true
  return TEXT_EXT.has(ext)
}

export async function readFileTool(workspace: string, relPath: string): Promise<string> {
  const root = ensureWorkspaceExists(workspace)
  const file = resolveSafePath(relPath, root)
  const st = await fs.stat(file)
  if (!st.isFile()) {
    return `不是文件: ${relPath}`
  }
  if (st.size > MAX_READ) {
    const fh = await fs.open(file, 'r')
    try {
      const buf = Buffer.alloc(MAX_READ)
      const { bytesRead } = await fh.read(buf, 0, MAX_READ, 0)
      return (
        buf.subarray(0, bytesRead).toString('utf8') +
        `\n\n[已截断：文件 ${st.size} 字节，仅读取前 ${MAX_READ} 字节]`
      )
    } finally {
      await fh.close()
    }
  }
  return await fs.readFile(file, 'utf8')
}

export async function writeFileTool(
  workspace: string,
  relPath: string,
  content: string
): Promise<string> {
  const root = ensureWorkspaceExists(workspace)
  const file = resolveSafePath(relPath, root)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, 'utf8')
  return `已写入: ${path.relative(root, file)}`
}

export async function deleteFileTool(workspace: string, relPath: string): Promise<string> {
  const root = ensureWorkspaceExists(workspace)
  const file = resolveSafePath(relPath, root)
  let st
  try {
    st = await fs.stat(file)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      return `文件不存在: ${relPath}`
    }
    throw e
  }
  if (!st.isFile()) {
    return `不是文件（未删除目录）: ${relPath}`
  }
  await fs.unlink(file)
  return `已删除: ${path.relative(root, file)}`
}

export async function listDirTool(
  workspace: string,
  relPath: string,
  options?: { depth?: number }
): Promise<string> {
  const root = ensureWorkspaceExists(workspace)
  const dir = resolveSafePath(relPath || '.', root)
  const st = await fs.stat(dir)
  if (!st.isDirectory()) {
    return `不是目录: ${relPath}`
  }
  const depth = Math.min(options?.depth ?? 2, 5)
  const lines: string[] = []
  const skipDir = new Set(['node_modules', '.git', 'dist', 'out', 'release', '.next'])

  async function walk(d: string, dLevel: number, prefix: string) {
    const entries = await fs.readdir(d, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (skipDir.has(e.name)) {
          lines.push(`${prefix}${e.name}/ (已省略子项)`)
          continue
        }
        lines.push(`${prefix}${e.name}/`)
        if (dLevel < depth) {
          await walk(full, dLevel + 1, prefix + '  ')
        }
      } else {
        lines.push(`${prefix}${e.name}`)
      }
    }
  }
  await walk(dir, 0, '')
  return lines.length ? lines.join('\n') : '(空目录)'
}

export async function searchWorkspace(
  workspace: string,
  query: string,
  options?: { maxFiles?: number; glob?: string }
): Promise<string> {
  const root = ensureWorkspaceExists(workspace)
  const maxFiles = options?.maxFiles ?? 64
  const results: string[] = []
  let count = 0
  if (!query.trim()) {
    return 'query 为空'
  }
  const lower = query.toLowerCase()

  async function walk(d: string) {
    if (count >= maxFiles) return
    const entries = await fs.readdir(d, { withFileTypes: true })
    for (const e of entries) {
      if (count >= maxFiles) return
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (
          e.name === 'node_modules' ||
          e.name === '.git' ||
          e.name === 'dist' ||
          e.name === 'out'
        ) {
          continue
        }
        await walk(full)
      } else {
        if (!looksTextual(full)) continue
        try {
          const st = await fs.stat(full)
          if (st.size > 400_000) continue
          const text = await fs.readFile(full, 'utf8')
          const lowerText = text.toLowerCase()
          if (!lowerText.includes(lower)) continue
          const rel = path.relative(root, full)
          const lineIdx = text.split('\n').findIndex((l) => l.toLowerCase().includes(lower))
          const preview =
            lineIdx >= 0
              ? `L${lineIdx + 1}: ${text.split('\n')[lineIdx]!.trim().slice(0, 200)}`
              : '匹配'
          results.push(`${rel}\n  ${preview}`)
          count++
        } catch {
          // skip
        }
      }
    }
  }
  await walk(root)
  return results.length
    ? results.join('\n\n')
    : `未找到含 "${query}" 的文本文件（已扫描，最多 ${maxFiles} 个匹配文件）`
}

const GLOB_EXCLUDE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/out/**',
  '**/release/**',
  '**/.next/**',
  '**/coverage/**'
] as const

/**
 * 在工作区根下按文件名 glob 查找**文件**（不含目录）。pattern 为相对工作区的 Node glob。
 */
export async function globFilesTool(
  workspace: string,
  pattern: string,
  options?: { maxFiles?: number }
): Promise<string> {
  const root = ensureWorkspaceExists(workspace)
  const pat = pattern.trim()
  if (!pat) {
    return 'pattern 为空'
  }
  const norm = pat.replace(/\\/g, '/')
  if (path.isAbsolute(pat)) {
    return '请使用相对工作区根的 glob 模式（不要用绝对路径）'
  }
  if (norm.split('/').some((seg) => seg === '..')) {
    return 'pattern 中不得包含 .. 段'
  }

  const maxFiles = Math.min(Math.max(options?.maxFiles ?? 200, 1), 500)
  const results: string[] = []

  try {
    const iter = fs.glob(pat, {
      cwd: root,
      exclude: [...GLOB_EXCLUDE]
    })
    for await (const entry of iter) {
      if (results.length >= maxFiles) {
        break
      }
      const abs = path.resolve(root, entry)
      const relToRoot = path.relative(root, abs)
      if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
        continue
      }
      try {
        const st = await fs.stat(abs)
        if (!st.isFile()) {
          continue
        }
      } catch {
        continue
      }
      results.push(relToRoot.split(path.sep).join('/'))
    }
  } catch (e) {
    return `glob 失败: ${(e as Error).message}`
  }

  results.sort()
  if (!results.length) {
    return `未匹配到文件: ${pattern}`
  }
  const truncated = results.length >= maxFiles
  const suffix = truncated ? `\n（最多返回 ${maxFiles} 条，已截断）` : ''
  return results.join('\n') + suffix
}
