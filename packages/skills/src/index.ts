/**
 * @openwork/skills — 内置技能内容包入口
 *
 * 本包存放随应用分发的 SKILL.md 及配套资源；宿主（desktop 等）通过
 * getBundledSkillsDir 定位扫描根目录，或在打包时将该目录复制到 extraResources。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 返回内置 skills 扫描根目录的绝对路径（`content/`，含各技能子目录）。
 *
 * 包布局为 `packages/skills/content/<skill-name>/SKILL.md`；本入口位于 `src/index.ts`，
 * 因此 `../content` 即为技能扫描根。
 *
 * @returns skills 内容根目录绝对路径
 */
export function getBundledSkillsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'content')
}
