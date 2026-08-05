import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { app } from 'electron'

import { mainLog } from '@/main/logger'
import { userDataPath } from '@/main/store'

/** 用户技能根目录：`Electron userData/skills` */
export function userSkillsAbsRoot(): string {
  return path.join(userDataPath(), 'skills')
}

/** 扩展用缓存目录（预留） */
export function skillsCacheRoot(): string {
  return path.join(userSkillsAbsRoot(), '.cache')
}

/**
 * 内置技能（随包分发）源路径。
 * 打包：`resources/skills`。
 * 开发：由 electron-vite define 注入的 `packages/skills/content` 目录。
 */
export function getBundledSkillsSourceDir(): string | null {
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
 * 创建 `skills`、`skills/.cache`。
 * 不再将内置技能整棵复制到用户目录（内置仅从随包目录只读加载）。
 */
export async function ensureUserSkillsLayout(): Promise<void> {
  const root = userSkillsAbsRoot()
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(skillsCacheRoot(), { recursive: true })
  if (!app.isPackaged) {
    mainLog.info('[skills] 用户技能目录:', root)
  }
}
