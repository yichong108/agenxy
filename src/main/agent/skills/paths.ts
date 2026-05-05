import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app } from 'electron'

import { mainLog } from '@/main/logger'
import { userDataPath } from '@/main/store'

/** 用户技能根目录：`Electron userData/skills` */
export function userSkillsAbsRoot(): string {
  return path.join(userDataPath(), 'skills')
}

/** 市场安装目录：`userData/skills/market/<id>/` */
export function marketSkillsInstallRoot(): string {
  return path.join(userSkillsAbsRoot(), 'market')
}

/** 扩展用缓存目录（预留） */
export function skillsCacheRoot(): string {
  return path.join(userSkillsAbsRoot(), '.cache')
}

/**
 * 内置技能（随包分发）源路径。
 * 打包：`resources/skills`。
 * 开发：`app.getAppPath()/src/skills` 或相对 bundle 回退到项目 `src/skills`。
 */
export function getBundledSkillsSourceDir(): string | null {
  if (app.isPackaged) {
    const absRoot = path.join(process.resourcesPath, 'skills')
    return existsSync(absRoot) ? absRoot : null
  }
  const appPathSkills = path.join(app.getAppPath(), 'src', 'skills')
  if (existsSync(appPathSkills)) return appPathSkills
  /** 与旧版一致：打包后主入口多在 `out/main`，`../../src/skills` 指向仓库技能目录 */
  const fromBundle = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'src',
    'skills'
  )
  if (existsSync(fromBundle)) return fromBundle
  mainLog.warn('[skills] 开发模式下未找到内置技能目录，已尝试:', appPathSkills, fromBundle)
  return null
}

/**
 * 创建 `skills`、`skills/market`、`skills/.cache`。
 * 不再将内置技能整棵复制到用户目录（内置仅从随包目录只读加载）。
 */
export async function ensureUserSkillsLayout(): Promise<void> {
  const root = userSkillsAbsRoot()
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(marketSkillsInstallRoot(), { recursive: true })
  await fs.mkdir(skillsCacheRoot(), { recursive: true })
  if (!app.isPackaged) {
    mainLog.info('[skills] 用户技能目录:', root)
  }
}
