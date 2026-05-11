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
    return `Not a file: ${relPath}`
  }
  if (st.size > MAX_READ) {
    const fh = await fs.open(file, 'r')
    try {
      const buf = Buffer.alloc(MAX_READ)
      const { bytesRead } = await fh.read(buf, 0, MAX_READ, 0)
      return (
        buf.subarray(0, bytesRead).toString('utf8') +
        `\n\n[Truncated: file is ${st.size} bytes, only first ${MAX_READ} bytes read]`
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
  return `Written: ${path.relative(root, file)}`
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
      return `File does not exist: ${relPath}`
    }
    throw e
  }
  if (!st.isFile()) {
    return `Not a file (directories not deleted): ${relPath}`
  }
  await fs.unlink(file)
  return `Deleted: ${path.relative(root, file)}`
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
    return `Not a directory: ${relPath}`
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
          lines.push(`${prefix}${e.name}/ (subitems omitted)`)
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
  return lines.length ? lines.join('\n') : '(empty directory)'
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
    return 'query is empty'
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
              : 'match'
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
    : `No text files containing "${query}" found (scanned, max ${maxFiles} matching files)`
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

/** Extra excludes under user data root (Electron/Chromium caches, etc.) */
const GLOB_EXCLUDE_USERDATA_EXTRA = [
  '**/Cache/**',
  '**/GPUCache/**',
  '**/blob_storage/**',
  '**/skills/.cache/**',
  '**/Code Cache/**',
  '**/DawnGraphiteCache/**'
] as const

async function globFilesUnderRoot(
  rootAbs: string,
  pat: string,
  budget: number,
  exclude: readonly string[]
): Promise<{ relPosix: string[]; hitCap: boolean }> {
  const relPosix: string[] = []
  const iter = fs.glob(pat, {
    cwd: rootAbs,
    exclude: [...exclude]
  })
  for await (const entry of iter) {
    const abs = path.resolve(rootAbs, entry)
    const relToRoot = path.relative(rootAbs, abs)
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
    relPosix.push(relToRoot.split(path.sep).join('/'))
    if (relPosix.length >= budget) {
      break
    }
  }
  const hitCap = relPosix.length >= budget
  return { relPosix, hitCap }
}

function rootsAreSame(a: string, b: string): boolean {
  return path.normalize(path.resolve(a)) === path.normalize(path.resolve(b))
}

/**
 * Glob find **files** (not directories) under workspace root and optional Electron userData root by filename pattern.
 * Pattern is Node glob relative to each root (same pattern used for both locations).
 */
export async function globFilesTool(
  workspace: string,
  pattern: string,
  options?: { maxFiles?: number; userDataRoot?: string | null }
): Promise<string> {
  const root = ensureWorkspaceExists(workspace)
  const pat = pattern.trim()
  if (!pat) {
    return 'pattern is empty'
  }
  const norm = pat.replace(/\\/g, '/')
  if (path.isAbsolute(pat)) {
    return 'Please use relative glob patterns from root (do not use absolute paths)'
  }
  if (norm.split('/').some((seg) => seg === '..')) {
    return 'pattern cannot contain .. segments'
  }

  const maxFiles = Math.min(Math.max(options?.maxFiles ?? 200, 1), 500)
  const wsBudget = Math.ceil(maxFiles / 2)
  const udBudget = maxFiles - wsBudget

  let wsRel: string[] = []
  let wsHitCap = false
  try {
    const ws = await globFilesUnderRoot(root, pat, wsBudget, GLOB_EXCLUDE)
    wsRel = ws.relPosix
    wsHitCap = ws.hitCap
  } catch (e) {
    return `Workspace glob failed: ${(e as Error).message}`
  }

  let udRel: string[] = []
  let udHitCap = false
  const udRaw = options?.userDataRoot?.trim()
  if (udRaw && udBudget > 0 && !rootsAreSame(root, udRaw)) {
    const udAbs = path.resolve(udRaw)
    try {
      const st = await fs.stat(udAbs)
      if (st.isDirectory()) {
        const excludeUd = [...GLOB_EXCLUDE, ...GLOB_EXCLUDE_USERDATA_EXTRA]
        try {
          const ud = await globFilesUnderRoot(udAbs, pat, udBudget, excludeUd)
          udRel = ud.relPosix
          udHitCap = ud.hitCap
        } catch (e) {
          return (
            (wsRel.length ? `【Workspace】\n${wsRel.sort().join('\n')}\n\n` : '') +
            `User data directory glob failed: ${(e as Error).message}`
          )
        }
      }
    } catch {
      // userData doesn't exist or unreadable: ignore, return workspace results only
    }
  }

  if (!wsRel.length && !udRel.length) {
    return `No files matched: ${pattern}`
  }

  const lines: string[] = []
  if (wsRel.length) {
    lines.push('[Workspace]\n' + [...wsRel].sort().join('\n'))
  }
  if (udRel.length) {
    lines.push('[User Data] (relative to Electron userData root)\n' + [...udRel].sort().join('\n'))
  }

  const truncatedNote =
    wsHitCap || udHitCap ? `\n(max ${maxFiles} results returned, one partition capped)` : ''
  return lines.join('\n\n') + truncatedNote
}
