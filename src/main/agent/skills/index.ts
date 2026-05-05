import { existsSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { tool } from '@langchain/core/tools'
import { app } from 'electron'
import { z } from 'zod'

import { mainLog } from '@/main/logger'
import { userDataPath } from '@/main/store'
import { listDirTool, readFileTool, searchWorkspace, writeFileTool } from '@/main/tools/fs-tools'
import { runCommand } from '@/main/tools/terminal'
import type { AppSettings, ToolCallEvent, ToolTimelineEvent } from '@/shared/ipc'

/** 单次加载上限 */
const MAX_LOADED_SKILLS = 96

/** 用户技能目录绝对路径：`Electron userData/.agent-weave/skills` */
export function userSkillsAbsRoot(): string {
  return path.join(userDataPath(), '.agent-weave', 'skills')
}

/** 用于首次填充用户目录的内置 skills 源路径（打包：`resources/skills`；开发：`src/skills`） */
function bundledSkillsSourceDir(): string | null {
  const absRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'skills')
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../src/skills')
  if (!existsSync(absRoot)) return null
  return absRoot
}

async function directoryIsEmpty(absDir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(absDir)
    return entries.length === 0
  } catch {
    return true
  }
}

/**
 * 保证用户技能目录存在；若为空则从内置目录复制一份（仅首次或用户清空后）。
 * 之后运行时只从用户数据目录读取 skills，便于用户自行增删改。
 */
export async function ensureUserSkillsSeeded(): Promise<void> {
  const userRoot = userSkillsAbsRoot()
  await fs.mkdir(userRoot, { recursive: true })
  if (!(await directoryIsEmpty(userRoot))) return
  const bundled = bundledSkillsSourceDir()
  if (!bundled) {
    mainLog.info('[skills] 用户技能目录为空且无内置种子，跳过复制')
    return
  }
  try {
    await fs.cp(bundled, userRoot, { recursive: true })
    mainLog.info('[skills] 已将内置技能种子复制到用户目录:', userRoot)
  } catch (e) {
    mainLog.error('[skills] 复制内置技能到用户目录失败', e)
  }
}

function userInstalledSkillsRoot(): { absRoot: string; sourcePrefix: string } {
  return {
    absRoot: userSkillsAbsRoot(),
    sourcePrefix: '.agent-weave/skills'
  }
}

/** 仅从用户数据目录扫描技能 */
function allSkillScanRoots(): { absRoot: string; sourcePrefix: string }[] {
  return [userInstalledSkillsRoot()]
}
const MAX_SKILL_MD_SIZE_BYTES = 10 * 1024 * 1024

type RunContext = {
  runId: string
  traceId: string
}

// 技能工具上下文
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
  // 技能来源: 文档路径
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

function sanitizeToolName(input: string): string {
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

function parseSkillFrontmatter(markdown: string): { meta: SkillMdMeta; body: string } | null {
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
 * 收集工作区技能文档绝对路径
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

function makeBuiltinSkillDefinitions(ctx: SkillToolContext): SkillDefinition[] {
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
        return await runCommand(ctx.termKey, ctx.root, command, ctx.settings.maxTerminalOutputChars)
      }
    }
  ]
}

/**
 * 从用户数据目录加载技能定义（不读取当前工作区目录）
 */
async function loadBundledAndUserSkillDefs(): Promise<SkillDefinition[]> {
  const defs: SkillDefinition[] = []
  const scanRoots = allSkillScanRoots()

  for (const { absRoot: absDir, sourcePrefix } of scanRoots) {
    /*
    markdown格式技能定义加载
    */
    const mdFiles = await collectSkillMarkdownFiles(absDir)
    for (const absPath of mdFiles) {
      if (defs.length >= MAX_LOADED_SKILLS) return defs
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
          `技能文档：${rel}。按技能说明执行对应步骤，并在必要时调用工具。`
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

    /*
    json格式技能定义加载
    */
    let entries: Dirent[] = []
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      continue
    }
    const jsonFiles = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
    for (const fileName of jsonFiles) {
      if (defs.length >= MAX_LOADED_SKILLS) return defs
      const absPath = path.join(absDir, fileName)
      try {
        const raw = await fs.readFile(absPath, 'utf8')
        const parsed = JSON.parse(raw) as WorkspaceSkillJson
        const skillName = sanitizeToolName(
          parsed.name || parsed.id || path.basename(fileName, '.json')
        )
        // TODO: type解析
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
  return defs
}

function dedupeSkillDefinitions(defs: SkillDefinition[]): SkillDefinition[] {
  const byName = new Map<string, SkillDefinition>()
  for (const item of defs) {
    byName.set(item.name, item)
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
  const fileSkills = await loadBundledAndUserSkillDefs()
  const merged = dedupeSkillDefinitions([...builtin, ...fileSkills])
  const tools = merged.map((item) => toTool(item, ctx))
  return {
    tools,
    hint: makeSkillHint(merged)
  }
}
