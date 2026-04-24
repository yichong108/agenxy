import path from 'node:path'
import fs from 'node:fs'

/**
 * 将用户传入路径解析为工作区内绝对路径，防止穿越。
 * 支持相对工作区根路径，或以工作区为前缀的绝对路径（解析后 must stay under root）。
 */
export function resolveSafePath(input: string, workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot)
  const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input)
  const rel = path.relative(root, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`拒绝访问工作区外路径: ${input}`)
  }
  return abs
}

export function ensureWorkspaceExists(workspaceRoot: string | null | undefined): string {
  if (!workspaceRoot) {
    throw new Error('未选择工作区，请先在侧栏选择文件夹')
  }
  const p = path.resolve(workspaceRoot)
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    throw new Error('工作区无效或已不存在，请重新选择')
  }
  return p
}
