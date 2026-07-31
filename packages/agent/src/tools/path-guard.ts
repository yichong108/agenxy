import fs from 'node:fs'
import path from 'node:path'

/**
 * 将用户传入路径解析为工作区内绝对路径，防止穿越。
 *
 * 支持相对工作区根路径，或以工作区为前缀的绝对路径（解析后必须仍在 root 下）。
 *
 * @param input - 相对或绝对路径
 * @param workspaceRoot - 工作区根目录
 * @returns 工作区内的绝对路径
 * @throws {Error} 当路径逃出工作区时抛出
 */
export function resolveSafePath(input: string, workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot)
  const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input)
  const rel = path.relative(root, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`禁止访问工作区外的路径：${input}`)
  }
  return abs
}

/**
 * 校验工作区根目录存在且为目录。
 *
 * @param workspaceRoot - 工作区根；空值视为未设置
 * @returns 规范化后的绝对路径
 * @throws {Error} 未设置或路径无效时抛出
 */
export function ensureWorkspaceExists(workspaceRoot: string | null | undefined): string {
  if (!workspaceRoot) {
    throw new Error('未设置工作区根目录')
  }
  const p = path.resolve(workspaceRoot)
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    throw new Error('工作区无效或已不存在')
  }
  return p
}
