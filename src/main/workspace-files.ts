import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

import { ensureWorkspaceExists, resolveSafePath } from '@/main/path-guard'
import type {
  WorkspaceFileContentResult,
  WorkspaceFileNode,
  WorkspaceFileTreePayload
} from '@/shared/ipc'

const MAX_TREE_DEPTH = 5
const MAX_DIR_ENTRIES = 300
const MAX_TREE_NODES = 3000
const MAX_FILE_PREVIEW_BYTES = 300_000
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'release', '.next', '.turbo'])

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

function sortDirents(a: Dirent, b: Dirent): number {
  if (a.isDirectory() && !b.isDirectory()) return -1
  if (!a.isDirectory() && b.isDirectory()) return 1
  return a.name.localeCompare(b.name, 'zh-CN')
}

function isLikelyBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 2048))
  for (const byte of sample) {
    if (byte === 0) return true
  }
  return false
}

export async function listWorkspaceFileTree(workspacePath: string): Promise<WorkspaceFileTreePayload> {
  const root = ensureWorkspaceExists(workspacePath)
  let nodeCount = 0

  async function walk(absDir: string, relDir: string, depth: number): Promise<WorkspaceFileNode[]> {
    if (depth > MAX_TREE_DEPTH || nodeCount >= MAX_TREE_NODES) return []

    let entries = await fs.readdir(absDir, { withFileTypes: true })
    entries = entries
      .filter((entry) => !(entry.isDirectory() && SKIP_DIRS.has(entry.name)))
      .sort(sortDirents)
      .slice(0, MAX_DIR_ENTRIES)

    const nodes: WorkspaceFileNode[] = []
    for (const entry of entries) {
      if (nodeCount >= MAX_TREE_NODES) break
      nodeCount += 1

      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
      const absPath = path.join(absDir, entry.name)
      if (entry.isDirectory()) {
        const children = await walk(absPath, relPath, depth + 1)
        nodes.push({
          name: entry.name,
          path: toPosixPath(relPath),
          kind: 'directory',
          children
        })
      } else {
        nodes.push({
          name: entry.name,
          path: toPosixPath(relPath),
          kind: 'file'
        })
      }
    }
    return nodes
  }

  const nodes = await walk(root, '', 0)
  return { rootPath: root, nodes }
}

export async function readWorkspaceFileContent(
  workspacePath: string,
  relPath: string
): Promise<WorkspaceFileContentResult> {
  try {
    const root = ensureWorkspaceExists(workspacePath)
    if (!relPath?.trim()) {
      return { ok: false, error: '文件路径不能为空' }
    }
    const abs = resolveSafePath(relPath, root)
    const stat = await fs.stat(abs)
    if (!stat.isFile()) {
      return { ok: false, error: '目标不是文件' }
    }

    const full = await fs.readFile(abs)
    const truncated = full.length > MAX_FILE_PREVIEW_BYTES
    const picked = truncated ? full.subarray(0, MAX_FILE_PREVIEW_BYTES) : full
    if (isLikelyBinary(picked)) {
      return { ok: false, error: '暂不支持预览二进制文件' }
    }

    return {
      ok: true,
      path: toPosixPath(relPath),
      content: picked.toString('utf8'),
      truncated
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }
}
