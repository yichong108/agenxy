/**
 * Desktop 技能路径解析 — 供用户布局管理使用。
 *
 * createAgent.send 已改为扫描 `~/.openwork/skills`；本模块仍负责 bundled / userData 布局。
 * 加载与工具组装由 @openwork/agent 的 loadSkillsFromPaths 完成。
 */
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { getBundledSkillsSourceDir, userSkillsAbsRoot } from '@/main/agent/skills/paths'

export {
  ensureUserSkillsLayout,
  getBundledSkillsSourceDir,
  skillsCacheRoot,
  userSkillsAbsRoot
} from '@/main/agent/skills/paths'

/**
 * 解析当前进程可用的 skills 根目录列表（bundled / userData）。
 *
 * 同步实现。同名技能由 agent 侧「先出现优先」去重。
 * 注意：createAgent.send 不再接收此列表，改为扫描 ~/.openwork/skills。
 *
 * @returns 绝对路径列表
 */
export function resolveCreateAgentSkillPaths(): string[] {
  const paths: string[] = []

  const bundled = getBundledSkillsSourceDir()
  if (bundled) {
    paths.push(bundled)
  }

  const userRoot = userSkillsAbsRoot()
  // 跳过历史遗留的 market 目录与缓存目录，避免被当作技能根
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
