import fs from 'node:fs/promises'
import path from 'node:path'

import { listSkillsFromPaths, type SkillListItem } from '@openworker/agent'
import { app } from 'electron'

import { mainLog } from '@/main/logger'
import { existsSync } from 'node:fs'
import { getElectronSkillsDir } from '../path'

export type { SkillListItem }

/**
 * 列出用户 skills 目录下的可用技能（供输入框 `/` 斜杠菜单）。
 *
 * 扫描 `~/.openworker/skills`，规则与 agent send 时加载技能一致。
 *
 * @returns 技能列表；目录为空或不存在时返回空数组
 */
export async function listUserSkills(): Promise<SkillListItem[]> {
  const skillsDir = getElectronSkillsDir()
  try {
    return await listSkillsFromPaths([skillsDir])
  } catch (err) {
    mainLog.warn('[skills] 列出技能失败:', err)
    return []
  }
}

/**
 * 创建用户 `skills` 目录。
 * 将内置技能整棵复制到用户目录。
 */
export async function ensureUserSkillsLayout(): Promise<void> {
  const targetSkillsPath = getElectronSkillsDir()
  await fs.mkdir(targetSkillsPath, { recursive: true })

  // 内置技能目录（假设内置技能放在 app 根目录下的 resources/skills 目录）
  const builtinSkillsPath = getSkillsSourceDir()

  if (!builtinSkillsPath) {
    mainLog.warn('[skills] 未找到内置技能目录, 跳过复制')
    return
  }

  try {
    // 检查内置技能目录是否存在
    await fs.access(builtinSkillsPath)
    // 递归复制内置技能到用户技能目录
    await copyDirRecursive(builtinSkillsPath, targetSkillsPath)
    mainLog.info('[skills] 已将内置技能复制到用户目录:', targetSkillsPath)
  } catch {
    mainLog.warn('[skills] 未找到内置技能目录, 跳过复制:', builtinSkillsPath)
  }
}

/**
 * 内置技能（随包分发）源路径。
 * 打包：`resources/skills`。
 * 开发：由 electron-vite define 注入的 `packages/skills/content` 目录。
 */
export function getSkillsSourceDir(): string | null {
  if (app.isPackaged) {
    const absRoot = path.join(process.resourcesPath, 'skills')
    return existsSync(absRoot) ? absRoot : null
  }
  const fromPackage = __OPENWORKERER_BUNDLED_SKILLS_DIR__
  if (existsSync(fromPackage)) return fromPackage
  mainLog.warn('[skills] 开发模式下未找到内置技能目录，已尝试:', fromPackage)
  return null
}

/**
 * 递归复制目录及其内容
 */
async function copyDirRecursive(src: string, dest: string) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath)
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath)
    }
  }
}
