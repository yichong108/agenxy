import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { listSkillsFromPaths, loadSkillsFromPaths } from '../src/skills/load-skills.js'

const tempDirs: string[] = []

/**
 * 创建临时技能目录并写入 SKILL.md。
 */
async function makeSkillRoot(
  entries: Array<{ folder: string; name: string; description: string; body?: string }>
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-skills-'))
  tempDirs.push(root)
  for (const entry of entries) {
    const dir = path.join(root, entry.folder)
    await fs.mkdir(dir, { recursive: true })
    const md = `---\nname: ${entry.name}\ndescription: ${entry.description}\n---\n\n${entry.body ?? '# Skill'}\n`
    await fs.writeFile(path.join(dir, 'SKILL.md'), md, 'utf8')
  }
  return root
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('listSkillsFromPaths', () => {
  it('lists skill metadata without requiring tools', async () => {
    const root = await makeSkillRoot([
      { folder: 'code-review', name: 'code_review', description: 'Review code' },
      { folder: 'bug-fix', name: 'bug_fix', description: 'Fix bugs' }
    ])
    const list = await listSkillsFromPaths([root])
    expect(list.map((x) => x.name).sort()).toEqual(['bug_fix', 'code_review'])
    expect(list.find((x) => x.name === 'code_review')?.description).toBe('Review code')
  })

  it('dedupes by name with first path winning', async () => {
    const first = await makeSkillRoot([{ folder: 'a', name: 'shared', description: 'from first' }])
    const second = await makeSkillRoot([
      { folder: 'b', name: 'shared', description: 'from second' }
    ])
    const list = await listSkillsFromPaths([first, second])
    expect(list).toHaveLength(1)
    expect(list[0]?.description).toBe('from first')
  })

  it('returns empty array for missing paths', async () => {
    const list = await listSkillsFromPaths([path.join(os.tmpdir(), 'ow-missing-skills-dir')])
    expect(list).toEqual([])
  })
})

describe('loadSkillsFromPaths', () => {
  it('registers tools with matching names from listSkillsFromPaths', async () => {
    const root = await makeSkillRoot([
      { folder: 'code-review', name: 'code_review', description: 'Review code', body: 'Do review' }
    ])
    const listed = await listSkillsFromPaths([root])
    const loaded = await loadSkillsFromPaths([root], () => undefined)
    expect(Object.keys(loaded.tools).sort()).toEqual(listed.map((x) => x.name).sort())
    expect(loaded.hint).toContain('/code_review')
  })
})
