/**
 * Desktop 技能路径解析 — 仅供 createAgent.skills.paths 使用。
 *
 * 扫描优先级：内置随包目录 → market 安装子目录 → 用户根目录下其余技能包（跳过 market / .cache）。
 * 加载与工具组装由 @openwork/agent 的 loadSkillsFromPaths 完成。
 */
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

import {
  getBundledSkillsSourceDir,
  marketSkillsInstallRoot,
  userSkillsAbsRoot
} from '@/main/agent/skills/paths'

export {
  ensureUserSkillsLayout,
  getBundledSkillsSourceDir,
  marketSkillsInstallRoot,
  skillsCacheRoot,
  userSkillsAbsRoot
} from '@/main/agent/skills/paths'

/**
 * 解析当前进程可用的 skills 根目录列表，供 createAgent({ skills: { paths } }) 使用。
 *
 * 同步实现，以便在同步的 createSessionAgent / createAgent 调用链中使用。
 * 同名技能由 agent 侧「先出现优先」去重。
 *
 * @returns 绝对路径列表
 */
export function resolveCreateAgentSkillPaths(): string[] {
  const paths: string[] = []

  const bundled = getBundledSkillsSourceDir()
  if (bundled) {
    paths.push(bundled)
  }

  const marketRoot = marketSkillsInstallRoot()
  if (existsSync(marketRoot)) {
    try {
      const marketDirs = readdirSync(marketRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name))
      for (const d of marketDirs) {
        paths.push(path.join(marketRoot, d.name))
      }
    } catch {
      // 忽略不可读的 market 目录
    }
  }

  const userRoot = userSkillsAbsRoot()
  const skipAtUserRoot = new Set(['market', '.cache'])
  if (existsSync(userRoot)) {
    try {
      const legacyDirs = readdirSync(userRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !skipAtUserRoot.has(d.name) && !d.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name))
      for (const d of legacyDirs) {
        paths.push(path.join(userRoot, d.name))
      }
    } catch {
      // 忽略不可读的用户技能目录
    }
  }

  return paths
}
