import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { tool } from '@langchain/core/tools'
import { z } from 'zod'

import {
  getBundledSkillsSourceDir,
  marketSkillsInstallRoot,
  userSkillsAbsRoot
} from '@/main/agent/skills/paths'
import { mainLog } from '@/main/logger'
import { listDirTool, readFileTool, searchWorkspace, writeFileTool } from '@/main/tools/fs-tools'
import { runCommand } from '@/main/tools/terminal'
import type {
  AppSettings,
  SkillUiEntry,
  SkillsRuntimeState,
  ToolCallEvent,
  ToolTimelineEvent
} from '@/shared/ipc'
import { defaultSettings, MAX_TERMINAL_OUTPUT_CHARS } from '@/shared/ipc'

export {
  ensureUserSkillsLayout,
  getBundledSkillsSourceDir,
  marketSkillsInstallRoot,
  skillsCacheRoot,
  userSkillsAbsRoot
} from '@/main/agent/skills/paths'

/** 单次加载上限 */
const MAX_LOADED_SKILLS = 96

export const MAX_SKILL_MD_SIZE_BYTES = 10 * 1024 * 1024

type MarkdownCollectOpts = {
  /** 仅在 `current === rootAbs` 时跳过这些一级子目录 */
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
  tools: SkillTool[]
  hint: string
}

type SkillTool = {
  name: string
  invoke: (input: unknown, config?: { signal?: AbortSignal }) => Promise<unknown>
}

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

export function sanitizeToolName(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!normalized) return 'skill_custom'
  return normalized.startsWith('skill_') ? normalized : `skill_${normalized}`
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

export function makeBuiltinSkillDefinitions(ctx: SkillToolContext): SkillDefinition[] {
  const inspectSchema = z.object({
    path: z.string().optional(),
    depth: z.number().int().min(1).max(3).optional(),
    query: z.string().optional()
  })
  const writeSchema = z.object({
    path: z.string(),
    content: z.string(),
    mode: z.enum(['overwrite', 'append']).optional()
  })
  const runSchema = z.object({
    command: z.string()
  })

  return [
    {
      name: 'skill_inspect_workspace',
      description: '技能：先列目录再按需搜索代码。适合“先摸清项目结构/定位文件”的问题。',
      source: 'builtin',
      schema: inspectSchema,
      execute: async (args) => {
        const pathArg = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.'
        const depthArg =
          typeof args.depth === 'number' && Number.isFinite(args.depth) ? Math.trunc(args.depth) : 2
        const lines: string[] = []
        lines.push(`## 目录预览 (${pathArg})`)
        lines.push(await listDirTool(ctx.root, pathArg, { depth: depthArg }))
        const queryArg = typeof args.query === 'string' ? args.query.trim() : ''
        if (queryArg) {
          lines.push('')
          lines.push(`## 搜索结果 (${queryArg})`)
          lines.push(await searchWorkspace(ctx.root, queryArg, { maxFiles: 30 }))
        }
        return lines.join('\n')
      }
    },
    {
      name: 'skill_write_file',
      description: '技能：写入或追加文件内容。适合需要把方案落地到工作区文件的场景。',
      source: 'builtin',
      schema: writeSchema,
      execute: async (args) => {
        const targetPath = String(args.path || '').trim()
        const content = typeof args.content === 'string' ? args.content : ''
        if (!targetPath) throw new Error('path 不能为空')
        const mode = args.mode === 'append' ? 'append' : 'overwrite'
        if (mode === 'append') {
          let previous = ''
          try {
            previous = await readFileTool(ctx.root, targetPath)
          } catch {
            previous = ''
          }
          const merged = previous ? `${previous}\n${content}` : content
          return await writeFileTool(ctx.root, targetPath, merged)
        }
        return await writeFileTool(ctx.root, targetPath, content)
      }
    },
    {
      name: 'skill_run_terminal',
      description: '技能：在工作区根目录执行终端命令并返回输出。适合安装依赖、运行构建或测试。',
      source: 'builtin',
      schema: runSchema,
      execute: async (args) => {
        const command = String(args.command || '').trim()
        if (!command) throw new Error('command 不能为空')
        return await runCommand(ctx.termKey, ctx.root, command, MAX_TERMINAL_OUTPUT_CHARS)
      }
    }
  ]
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
        parsed.meta.description || `技能文档：${rel}。按技能说明执行对应步骤，并在必要时调用工具。`
      defs.push({
        name: skillName,
        description,
        source: rel,
        schema: z.object({ question: z.string().optional() }),
        execute: async (args) => {
          const question = typeof args.question === 'string' ? args.question.trim() : ''
          if (!question) return parsed.body
          return `用户问题: ${question}\n\n以下是技能文档内容：\n${parsed.body}`
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
        description: parsed.description || `说明技能：${sourcePrefix}/${fileName}`,
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
 * 文件类技能加载顺序：随包内置目录 → 市场安装目录（字母序）→ 用户 legacy 根（跳过 market/.cache）。
 * dedupe 策略：**先到先得**（前者优先），保证内置随包优先于市场与 legacy 同名覆盖。
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

function dedupeSkillDefinitionsFirstWins(defs: SkillDefinition[]): SkillDefinition[] {
  const byName = new Map<string, SkillDefinition>()
  for (const item of defs) {
    if (!byName.has(item.name)) byName.set(item.name, item)
  }
  return [...byName.values()]
}

function makeSkillHint(defs: SkillDefinition[]): string {
  if (!defs.length) return ''
  const top = defs.slice(0, 20)
  const lines = top.map((item) => `- ${item.name}: ${item.description} (source: ${item.source})`)
  return `可用技能工具（自动调用）:\n${lines.join('\n')}\n当用户意图与上述任一描述相关时，必须先调用对应 skill_* 工具（可传 question 概括用户诉求），再按需使用其它工具；不要在未调用匹配 skill 的情况下用通用工具替代。`
}

function toTool(def: SkillDefinition, ctx: SkillToolContext): SkillTool {
  const built = tool(
    async (rawArgs) => {
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
    },
    {
      name: def.name,
      description: def.description,
      schema: def.schema
    }
  )
  return built as unknown as SkillTool
}

export async function buildSkillBundle(ctx: SkillToolContext): Promise<SkillBundle> {
  const builtin = makeBuiltinSkillDefinitions(ctx)
  const fileSkills = await loadFileSkillDefinitions()
  const mergedDefs = [...builtin, ...fileSkills]
  const merged = dedupeSkillDefinitionsFirstWins(mergedDefs)
  const tools = merged.map((item) => toTool(item, ctx))
  return {
    tools,
    hint: makeSkillHint(merged)
  }
}

export async function validateSkillPackageLayout(
  absDir: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const mdFiles = await collectSkillMarkdownFiles(absDir)
  for (const f of mdFiles) {
    try {
      const st = await fs.stat(f)
      if (st.size > MAX_SKILL_MD_SIZE_BYTES) continue
      const rawMd = await fs.readFile(f, 'utf8')
      if (parseSkillFrontmatter(rawMd)) return { ok: true }
    } catch {
      continue
    }
  }
  let entries: Dirent[] = []
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true })
  } catch {
    return { ok: false, error: '无法读取技能包目录' }
  }
  const hasJson = entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
  if (hasJson) return { ok: true }
  return {
    ok: false,
    error: '包内未找到可用的 skill.md（含 YAML frontmatter）或根目录 JSON 技能文件'
  }
}

async function extractToolNamesFromScanRoot(scan: ScanRoot): Promise<string[]> {
  const names: string[] = []
  const defs: SkillDefinition[] = []
  await appendSkillDefsFromScanRoot(scan, defs)
  for (const d of defs) names.push(d.name)
  return names
}

/** 预览目录将会注册的 skill 工具名（安装前冲突检测） */
export async function previewPackageSkillToolNames(packageAbsDir: string): Promise<string[]> {
  const scan: ScanRoot = { absRoot: packageAbsDir, sourcePrefix: 'preview' }
  return extractToolNamesFromScanRoot(scan)
}

/** 返回当前已被文件类技能占用的工具名 + 代码内置名（可选排除某一市场目录以便覆盖安装） */
export async function collectOccupiedSkillToolNames(params: {
  excludeMarketFolderId?: string
}): Promise<Set<string>> {
  const set = new Set<string>()
  for (const d of makeBuiltinSkillDefinitions(dummySkillToolContext())) {
    set.add(d.name)
  }
  const files = await loadFileSkillDefinitions(params.excludeMarketFolderId)
  for (const d of files) set.add(d.name)
  return set
}

function dummySkillToolContext(): SkillToolContext {
  return {
    root: '',
    termKey: '',
    settings: defaultSettings,
    runCtx: { runId: '', traceId: '' },
    onTool: () => {}
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
          `技能文档：${relFile}。按技能说明执行对应步骤，并在必要时调用工具。`,
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
  const builtinCode = makeBuiltinSkillDefinitions(dummySkillToolContext()).map((d) => ({
    key: `builtin-code:${d.name}`,
    kind: 'builtin_code' as const,
    toolName: d.name,
    title: d.name,
    description: d.description,
    sourceLabel: '内置（代码）'
  }))

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

  return { builtinCode, builtinPackaged, installedMarket, legacyUser }
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
    return { ok: false, error: '路径逃逸被拒绝' }
  }
  try {
    await fs.rm(resolved, { recursive: true, force: true })
    mainLog.info('[skills-market] 已卸载市场技能:', id)
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
    return { ok: false, error: '无效的兼容技能路径' }
  }
  const segments = normalized.split('/').filter(Boolean)
  if (segments.some((s) => s === '.' || s === '..')) {
    return { ok: false, error: '无效的兼容技能路径' }
  }
  if (segments[0] === 'market' || segments[0] === '.cache') {
    return { ok: false, error: '禁止卸载保留目录下的路径' }
  }
  const abs = path.resolve(path.join(userRoot, ...segments))
  const rel = path.relative(userRoot, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: '路径逃逸被拒绝' }
  }
  if (
    rel.split(path.sep)[0] === 'market' ||
    rel.startsWith(`.cache${path.sep}`) ||
    rel === '.cache'
  ) {
    return { ok: false, error: '禁止卸载 market/.cache 下的内容（请使用市场卸载）' }
  }
  try {
    await fs.rm(abs, { recursive: true, force: true })
    mainLog.info('[skills] 已卸载兼容技能目录:', rel)
    return { ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message }
  }
}
