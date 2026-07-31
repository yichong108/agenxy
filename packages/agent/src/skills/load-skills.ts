/**
 * 从配置的目录路径加载基础 Skills（扫描 SKILL.md）。
 *
 * 这是 agent 内建的可选能力：宿主只需传入 paths，即可获得 skill_* 工具与 prompt 提示。
 * 意图筛选、市场安装、Electron 路径解析等增强由宿主自行实现。
 */

import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { defineTool, type NamedTool, type ToolExecutorContext } from '../define-tool.js'
import { agentLog } from '../logger.js'

/** 单次 run 最多加载的技能数 */
const MAX_LOADED_SKILLS = 96

/** 单个 SKILL.md 最大字节数 */
const MAX_SKILL_MD_SIZE_BYTES = 10 * 1024 * 1024

type SkillMdMeta = {
  name?: string
  description?: string
}

type SkillDefinition = {
  name: string
  description: string
  source: string
  body: string
}

/**
 * 从路径加载 skills 的结果。
 */
export type LoadedSkillsBundle = {
  tools: NamedTool[]
  /** 注入 system prompt 的技能摘要 */
  hint: string
}

/**
 * 将任意字符串规范为合法工具名（小写、下划线）。
 *
 * @param input - 原始名称（frontmatter name 或目录名）
 * @returns 规范化后的工具名；空输入时返回 `custom`
 */
export function sanitizeSkillToolName(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!normalized) return 'custom'
  return normalized
}

/**
 * 解析 SKILL.md 的 YAML frontmatter（仅 name / description）。
 *
 * @param markdown - 完整 markdown 文本
 * @returns meta 与正文；无合法 frontmatter 时返回 null
 */
export function parseSkillFrontmatter(
  markdown: string
): { meta: SkillMdMeta; body: string } | null {
  const normalized = markdown.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return null
  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) return null
  const header = normalized.slice(4, end)
  const body = normalized.slice(end + 5).trim()
  const meta: SkillMdMeta = {}
  for (const line of header.split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
    if (key === 'name') meta.name = value
    if (key === 'description') meta.description = value
  }
  return { meta, body }
}

/**
 * 递归收集目录下所有名为 skill.md 的文件。
 *
 * @param absDir - 绝对目录路径
 * @returns 按路径排序的绝对文件路径列表
 */
async function collectSkillMarkdownFiles(absDir: string): Promise<string[]> {
  const queue: string[] = [absDir]
  const out: string[] = []
  while (queue.length) {
    const current = queue.shift()
    if (!current) break
    let entries: Dirent[] = []
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(abs)
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
        out.push(abs)
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b))
}

/**
 * 同名技能去重：先出现的胜出（靠前路径优先）。
 *
 * @param defs - 技能定义列表
 * @returns 去重后的列表
 */
function dedupeFirstWins(defs: SkillDefinition[]): SkillDefinition[] {
  const byName = new Map<string, SkillDefinition>()
  for (const item of defs) {
    if (!byName.has(item.name)) byName.set(item.name, item)
  }
  return [...byName.values()]
}

/**
 * 生成注入 system prompt 的技能摘要。
 *
 * @param defs - 已加载技能
 * @returns 提示文本；无技能时为空串
 */
function makeSkillHint(defs: SkillDefinition[]): string {
  if (!defs.length) return ''
  const top = defs.slice(0, 10)
  const lines = top.map((item) => `- ${item.name}: ${item.description} (source: ${item.source})`)
  return `可用技能工具（可自动调用）：\n${lines.join('\n')}\n当用户意图与上述任一描述匹配时，必须先按上方准确名称调用对应技能工具（可传入概括用户问题的 question），再按需使用其他工具；不要跳过匹配技能而用泛化工具猜测。`
}

/**
 * 从单个根目录解析技能定义。
 *
 * @param absRoot - 技能根目录绝对路径
 * @param defs - 累积写入的定义列表
 */
async function appendDefsFromRoot(absRoot: string, defs: SkillDefinition[]): Promise<void> {
  const mdFiles = await collectSkillMarkdownFiles(absRoot)
  for (const absPath of mdFiles) {
    if (defs.length >= MAX_LOADED_SKILLS) return
    try {
      const st = await fs.stat(absPath)
      if (st.size > MAX_SKILL_MD_SIZE_BYTES) continue
      const rawMd = await fs.readFile(absPath, 'utf8')
      const parsed = parseSkillFrontmatter(rawMd)
      if (!parsed) continue
      const folderName = path.basename(path.dirname(absPath))
      const skillName = sanitizeSkillToolName(parsed.meta.name || folderName)
      const rel = path.relative(absRoot, absPath).replaceAll('\\', '/')
      const description =
        parsed.meta.description ||
        `Skill document: ${rel}. Follow skill instructions and call tools when necessary.`
      defs.push({
        name: skillName,
        description,
        source: rel,
        body: parsed.body
      })
    } catch {
      continue
    }
  }
}

/**
 * 从配置的绝对路径列表加载 Skills，并包装为 NamedTool。
 *
 * 扫描顺序即优先级：同名技能以先出现的路径为准。不包含意图筛选；
 * 宿主若需按意图过滤，应在外部筛选 paths 或过滤返回的 tools。
 *
 * @param paths - 技能根目录绝对路径列表
 * @param runCtx - 工具执行上下文（timeline）
 * @returns 工具列表与 prompt hint
 */
export async function loadSkillsFromPaths(
  paths: string[],
  runCtx: ToolExecutorContext
): Promise<LoadedSkillsBundle> {
  const cleaned = paths.map((p) => p.trim()).filter(Boolean)
  if (!cleaned.length) {
    return { tools: [], hint: '' }
  }

  const defs: SkillDefinition[] = []
  for (const absRoot of cleaned) {
    await appendDefsFromRoot(absRoot, defs)
    if (defs.length >= MAX_LOADED_SKILLS) break
  }

  const merged = dedupeFirstWins(defs)
  agentLog.info(`[loadSkillsFromPaths] loaded=${merged.length} from ${cleaned.length} path(s)`)

  const tools = merged.map((def) =>
    defineTool(
      {
        name: def.name,
        description: def.description,
        schema: z.object({ question: z.string().optional() }),
        execute: async (args) => {
          const question = typeof args.question === 'string' ? args.question.trim() : ''
          if (!question) return def.body
          return `User question: ${question}\n\nSkill document content:\n${def.body}`
        },
        truncateTo: 8_000
      },
      runCtx
    )
  )

  return {
    tools,
    hint: makeSkillHint(merged)
  }
}
