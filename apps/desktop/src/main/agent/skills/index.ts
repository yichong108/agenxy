import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { type NamedTool, shouldLoadSkill, type UserIntent } from '@agenwork/agent'
import { z } from 'zod'

import {
  getBundledSkillsSourceDir,
  marketSkillsInstallRoot,
  userSkillsAbsRoot
} from '@/main/agent/skills/paths'
import { mainLog } from '@/main/logger'
import type {
  AppSettings,
  SkillsRuntimeState,
  SkillUiEntry,
  ToolCallEvent,
  ToolTimelineEvent
} from '@/shared/ipc'

export {
  ensureUserSkillsLayout,
  getBundledSkillsSourceDir,
  marketSkillsInstallRoot,
  skillsCacheRoot,
  userSkillsAbsRoot
} from '@/main/agent/skills/paths'

/** Max loaded skills per session */
const MAX_LOADED_SKILLS = 96

export const MAX_SKILL_MD_SIZE_BYTES = 10 * 1024 * 1024

export type { SkillTagEntry } from '@agenwork/agent'
export { SKILLS_WITH_TAGS } from '@agenwork/agent'

type MarkdownCollectOpts = {
  /** Only skip these top-level subdirectories when `current === rootAbs` */
  rootAbs: string
  skipDirNamesAtRoot: Set<string>
}

type RunContext = {
  runId: string
  traceId: string
}

type SkillToolContext = {
  root: string
  termKey: string
  settings: AppSettings
  runCtx: RunContext
  onTool: (e: ToolTimelineEvent) => void
}

type SkillBundle = {
  tools: NamedTool[]
  hint: string
}

type SkillTool = NamedTool

type SkillDefinition = {
  name: string
  description: string
  source: string
  schema: z.AnyZodObject
  execute: (args: Record<string, unknown>) => Promise<string>
}

type WorkspaceSkillJson = {
  id?: string
  name?: string
  description?: string
  type?: 'instruction' | 'command' | 'write_file'
  prompt?: string
  command?: string
  path?: string
  content?: string
}

type SkillMdMeta = {
  name?: string
  description?: string
}

type ScanRoot = {
  absRoot: string
  sourcePrefix: string
  markdownCollect?: MarkdownCollectOpts
}

/** Normalize to a valid tool name; does not add a skill_ prefix unless present in the source. */
export function sanitizeToolName(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!normalized) return 'custom'
  return normalized
}

function applyTemplate(raw: string, question: string): string {
  return raw.replaceAll('{{question}}', question)
}

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

async function collectSkillMarkdownFiles(
  absDir: string,
  markdownCollect?: MarkdownCollectOpts
): Promise<string[]> {
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
        if (
          markdownCollect &&
          current === markdownCollect.rootAbs &&
          markdownCollect.skipDirNamesAtRoot.has(entry.name)
        ) {
          continue
        }
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

function makeToolEventStart(name: string, args: unknown, runCtx: RunContext): ToolCallEvent {
  return {
    kind: 'tool',
    id: `${name}-${Date.now()}`,
    name,
    status: 'start',
    args: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    runId: runCtx.runId,
    traceId: runCtx.traceId,
    timestampMs: Date.now(),
    durationMs: 0
  }
}

async function buildSkillScanRoots(excludeMarketFolderId?: string): Promise<ScanRoot[]> {
  const roots: ScanRoot[] = []
  const bundled = getBundledSkillsSourceDir()
  if (bundled) {
    roots.push({ absRoot: bundled, sourcePrefix: 'skills/bundled' })
  }

  const marketRoot = marketSkillsInstallRoot()
  let marketDirs: Dirent[] = []
  try {
    marketDirs = await fs.readdir(marketRoot, { withFileTypes: true })
  } catch {
    marketDirs = []
  }
  const sorted = marketDirs
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const d of sorted) {
    if (excludeMarketFolderId && d.name === excludeMarketFolderId) continue
    roots.push({
      absRoot: path.join(marketRoot, d.name),
      sourcePrefix: `skills/market/${d.name}`
    })
  }

  const userRoot = userSkillsAbsRoot()
  roots.push({
    absRoot: userRoot,
    sourcePrefix: 'skills/legacy',
    markdownCollect: {
      rootAbs: userRoot,
      skipDirNamesAtRoot: new Set(['market', '.cache'])
    }
  })

  return roots
}

async function appendSkillDefsFromScanRoot(scan: ScanRoot, defs: SkillDefinition[]): Promise<void> {
  const { absRoot: absDir, sourcePrefix, markdownCollect } = scan

  const mdFiles = await collectSkillMarkdownFiles(absDir, markdownCollect)
  for (const absPath of mdFiles) {
    if (defs.length >= MAX_LOADED_SKILLS) return
    try {
      const st = await fs.stat(absPath)
      if (st.size > MAX_SKILL_MD_SIZE_BYTES) {
        continue
      }
      const rawMd = await fs.readFile(absPath, 'utf8')
      const parsed = parseSkillFrontmatter(rawMd)
      if (!parsed) {
        continue
      }
      const rel = path.join(sourcePrefix, path.relative(absDir, absPath)).replaceAll('\\', '/')
      const folderName = path.basename(path.dirname(absPath))
      const skillName = sanitizeToolName(parsed.meta.name || folderName)
      const description =
        parsed.meta.description ||
        `Skill document: ${rel}. Follow skill instructions and call tools when necessary.`
      defs.push({
        name: skillName,
        description,
        source: rel,
        schema: z.object({ question: z.string().optional() }),
        execute: async (args) => {
          const question = typeof args.question === 'string' ? args.question.trim() : ''
          if (!question) return parsed.body
          return `User question: ${question}\n\nSkill document content:\n${parsed.body}`
        }
      })
    } catch {
      continue
    }
  }

  let entries: Dirent[] = []
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true })
  } catch {
    return
  }
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
  for (const fileName of jsonFiles) {
    if (defs.length >= MAX_LOADED_SKILLS) return
    const absPath = path.join(absDir, fileName)
    try {
      const raw = await fs.readFile(absPath, 'utf8')
      const parsed = JSON.parse(raw) as WorkspaceSkillJson
      const skillName = sanitizeToolName(
        parsed.name || parsed.id || path.basename(fileName, '.json')
      )
      defs.push({
        name: skillName,
        description: parsed.description || `技能描述：${sourcePrefix}/${fileName}`,
        source: `${sourcePrefix}/${fileName}`,
        schema: z.object({ question: z.string().optional() }),
        execute: async (args) => {
          const question = typeof args.question === 'string' ? args.question : ''
          const prompt = parsed.prompt || ''
          if (!question) return prompt
          return applyTemplate(prompt, question)
        }
      })
    } catch {
      continue
    }
  }
}

/**
 * File skill loading order: bundled built-in directory → market install directories (alphabetical) → user legacy root (skip market/.cache).
 * Deduplication: **first wins** (earlier takes priority), ensuring built-in bundled takes precedence over market and legacy with same name.
 */
async function loadFileSkillDefinitions(
  excludeMarketFolderId?: string
): Promise<SkillDefinition[]> {
  const defs: SkillDefinition[] = []
  const roots = await buildSkillScanRoots(excludeMarketFolderId)
  for (const root of roots) {
    await appendSkillDefsFromScanRoot(root, defs)
    if (defs.length >= MAX_LOADED_SKILLS) break
  }
  return dedupeSkillDefinitionsFirstWins(defs)
}

/**
 * 函数名里的 FirstWins 就是「同名时先出现的胜出」。顺序上：结果里各条目的相对顺序，大致等于每个 name 第一次出现时在原数组里的顺序（Map 的迭代顺序与插入顺序一致）。
 * @param defs
 */
function dedupeSkillDefinitionsFirstWins(defs: SkillDefinition[]): SkillDefinition[] {
  const byName = new Map<string, SkillDefinition>()
  for (const item of defs) {
    if (!byName.has(item.name)) byName.set(item.name, item)
  }
  return [...byName.values()]
}

function makeSkillHint(defs: SkillDefinition[]): string {
  if (!defs.length) return ''
  const top = defs.slice(0, 10)
  const lines = top.map((item) => `- ${item.name}: ${item.description} (source: ${item.source})`)
  return `可用技能工具（可自动调用）：\n${lines.join('\n')}\n当用户意图与上述任一描述匹配时，必须先按上方准确名称调用对应技能工具（可传入概括用户问题的 question），再按需使用其他工具；不要跳过匹配技能而用泛化工具猜测。`
}

function toTool(def: SkillDefinition, ctx: SkillToolContext): SkillTool {
  return {
    name: def.name,
    description: def.description,
    schema: def.schema,
    invoke: async (rawArgs: unknown) => {
      const started = makeToolEventStart(def.name, rawArgs, ctx.runCtx)
      ctx.onTool(started)
      const startTime = started.timestampMs || Date.now()
      try {
        const args =
          typeof rawArgs === 'string'
            ? ({ question: rawArgs } as Record<string, unknown>)
            : ((rawArgs ?? {}) as Record<string, unknown>)
        const output = await def.execute(args)
        ctx.onTool({
          kind: 'tool',
          id: started.id,
          name: def.name,
          status: 'end',
          result: output.slice(0, 2_000),
          runId: ctx.runCtx.runId,
          traceId: ctx.runCtx.traceId,
          timestampMs: Date.now(),
          durationMs: Date.now() - startTime
        })
        return output
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.onTool({
          kind: 'error',
          message: `[${def.name}] ${message}`,
          runId: ctx.runCtx.runId,
          traceId: ctx.runCtx.traceId,
          timestampMs: Date.now(),
          durationMs: Date.now() - startTime
        })
        ctx.onTool({
          kind: 'tool',
          id: started.id,
          name: def.name,
          status: 'end',
          result: message,
          runId: ctx.runCtx.runId,
          traceId: ctx.runCtx.traceId,
          timestampMs: Date.now(),
          durationMs: Date.now() - startTime
        })
        throw error
      }
    }
  }
}

export type BuildSkillBundleOptions = {
  /** Filter skills by intent, empty array means load all skills */
  filterIntents?: UserIntent[]
}

export async function buildSkillBundle(
  ctx: SkillToolContext,
  options?: BuildSkillBundleOptions
): Promise<SkillBundle> {
  const filterIntents = options?.filterIntents ?? []
  const fileSkills = await loadFileSkillDefinitions()
  let mergedDefs = [...fileSkills]

  mergedDefs = mergedDefs.filter((def) => shouldLoadSkill(def.name, filterIntents))
  mainLog.info(
    `[buildSkillBundle] Filtered skills by intents [${filterIntents.join(', ')}]: ${mergedDefs.length} skills loaded`
  )

  const merged = dedupeSkillDefinitionsFirstWins(mergedDefs)
  const tools = merged.map((item) => toTool(item, ctx))
  return {
    tools,
    hint: makeSkillHint(merged)
  }
}

async function mdEntriesForUi(scan: ScanRoot): Promise<SkillUiEntry[]> {
  const out: SkillUiEntry[] = []
  const mdFiles = await collectSkillMarkdownFiles(scan.absRoot, scan.markdownCollect)
  for (const absPath of mdFiles) {
    try {
      const st = await fs.stat(absPath)
      if (st.size > MAX_SKILL_MD_SIZE_BYTES) continue
      const rawMd = await fs.readFile(absPath, 'utf8')
      const parsed = parseSkillFrontmatter(rawMd)
      if (!parsed) continue
      const folderName = path.basename(path.dirname(absPath))
      const toolName = sanitizeToolName(parsed.meta.name || folderName)
      const relFile = path
        .join(scan.sourcePrefix, path.relative(scan.absRoot, absPath))
        .replaceAll('\\', '/')
      out.push({
        key: `${scan.sourcePrefix}:${relFile}`,
        kind: scan.sourcePrefix.startsWith('skills/market/')
          ? 'market'
          : scan.sourcePrefix === 'skills/bundled'
            ? 'builtin_packaged'
            : 'legacy',
        toolName,
        title: parsed.meta.name || folderName,
        description:
          parsed.meta.description ||
          `Skill document: ${relFile}. Follow skill instructions and call tools when necessary.`,
        sourceLabel: relFile,
        marketFolderId: scan.sourcePrefix.startsWith('skills/market/')
          ? scan.sourcePrefix.replace(/^skills\/market\//, '')
          : undefined,
        legacyFolderRelative:
          scan.sourcePrefix === 'skills/legacy'
            ? (() => {
                const relDir = path
                  .relative(userSkillsAbsRoot(), path.dirname(absPath))
                  .replaceAll('\\', '/')
                return relDir && relDir !== '.' ? relDir : undefined
              })()
            : undefined
      })
    } catch {
      continue
    }
  }

  let entries: Dirent[] = []
  try {
    entries = await fs.readdir(scan.absRoot, { withFileTypes: true })
  } catch {
    entries = []
  }
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
  for (const fileName of jsonFiles) {
    const absPath = path.join(scan.absRoot, fileName)
    try {
      const raw = await fs.readFile(absPath, 'utf8')
      const parsed = JSON.parse(raw) as WorkspaceSkillJson
      const toolName = sanitizeToolName(
        parsed.name || parsed.id || path.basename(fileName, '.json')
      )
      const relFile = `${scan.sourcePrefix}/${fileName}`
      let legacyRelJson: string | undefined
      if (scan.sourcePrefix === 'skills/legacy') {
        const parentDir = path.dirname(absPath)
        const relDir = path.relative(userSkillsAbsRoot(), parentDir).replaceAll('\\', '/')
        legacyRelJson = relDir && relDir !== '.' ? relDir : undefined
      }
      out.push({
        key: `${scan.sourcePrefix}:json:${fileName}`,
        kind: scan.sourcePrefix.startsWith('skills/market/')
          ? 'market'
          : scan.sourcePrefix === 'skills/bundled'
            ? 'builtin_packaged'
            : 'legacy',
        toolName,
        title: parsed.name || parsed.id || fileName,
        description: parsed.description || `JSON 技能：${relFile}`,
        sourceLabel: relFile,
        marketFolderId: scan.sourcePrefix.startsWith('skills/market/')
          ? scan.sourcePrefix.replace(/^skills\/market\//, '')
          : undefined,
        legacyFolderRelative: legacyRelJson
      })
    } catch {
      continue
    }
  }

  return out
}

export async function gatherSkillsRuntimeState(): Promise<SkillsRuntimeState> {
  const builtinPackaged: SkillUiEntry[] = []
  const installedMarket: SkillUiEntry[] = []
  const legacyUser: SkillUiEntry[] = []

  const roots = await buildSkillScanRoots()
  for (const root of roots) {
    const rows = await mdEntriesForUi(root)
    for (const row of rows) {
      if (row.kind === 'builtin_packaged') builtinPackaged.push(row)
      else if (row.kind === 'market') installedMarket.push(row)
      else if (row.kind === 'legacy') legacyUser.push(row)
    }
  }

  return { builtinCode: [], builtinPackaged, installedMarket, legacyUser }
}

export async function uninstallMarketSkillFolder(
  folderId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = folderId.trim()
  if (!id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
    return { ok: false, error: '无效的卸载目标' }
  }
  if (id.startsWith('.')) {
    return { ok: false, error: '无效的卸载目标' }
  }
  const abs = path.join(marketSkillsInstallRoot(), id)
  const resolved = path.resolve(abs)
  const rootResolved = path.resolve(marketSkillsInstallRoot())
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    return { ok: false, error: '禁止路径逃逸' }
  }
  try {
    await fs.rm(resolved, { recursive: true, force: true })
    mainLog.info('[skills] Uninstalled market skill:', id)
    return { ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message }
  }
}

export async function uninstallLegacySkillFolder(
  legacyFolderRelative: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const userRoot = path.resolve(userSkillsAbsRoot())
  const normalized = legacyFolderRelative.replace(/\\/g, '/').trim()
  if (!normalized || normalized.includes('..')) {
    return { ok: false, error: '无效的旧版技能路径' }
  }
  const segments = normalized.split('/').filter(Boolean)
  if (segments.some((s) => s === '.' || s === '..')) {
    return { ok: false, error: '无效的旧版技能路径' }
  }
  if (segments[0] === 'market' || segments[0] === '.cache') {
    return { ok: false, error: '不能从保留目录卸载' }
  }
  const abs = path.resolve(path.join(userRoot, ...segments))
  const rel = path.relative(userRoot, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: '禁止路径逃逸' }
  }
  if (
    rel.split(path.sep)[0] === 'market' ||
    rel.startsWith(`.cache${path.sep}`) ||
    rel === '.cache'
  ) {
    return {
      ok: false,
      error: '不能卸载 market/.cache 内容（请使用市场卸载）'
    }
  }
  try {
    await fs.rm(abs, { recursive: true, force: true })
    mainLog.info('[skills] Uninstalled legacy skill directory:', rel)
    return { ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message }
  }
}
