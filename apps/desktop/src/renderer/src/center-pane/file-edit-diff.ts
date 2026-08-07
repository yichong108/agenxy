/**
 * 从 write_file / delete_file 工具事件解析 diff 载荷，并用 jsdiff 计算行级变更。
 *
 * 新事件：args 为 `{ path, content }`，result 为 `{ path, before, after, created }`。
 * 旧事件：args 可能为 `{ summary: "path, content..." }`，result 为 `已写入：path`。
 */

import { diffLines } from 'diff'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import scss from 'highlight.js/lib/languages/scss'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

/** 单行 diff 类型 */
export type FileDiffLineKind = 'add' | 'del' | 'ctx'

/** 统一 diff 中的一行 */
export type FileDiffLine = {
  kind: FileDiffLineKind
  text: string
  /** 旧文件行号（1-based；新增行无） */
  oldLine?: number
  /** 新文件行号（1-based；删除行无） */
  newLine?: number
}

/** 编辑文件展开所需的 diff 视图模型 */
export type FileEditDiffView = {
  path: string
  before: string
  after: string
  created: boolean
  deleted: boolean
  lines: FileDiffLine[]
}

/** 展开区最多渲染的 diff 行数 */
const MAX_RENDER_DIFF_LINES = 400

let hljsReady = false

/**
 * 惰性注册 diff 常用语言（避免重复 register）。
 */
function ensureHljsLanguages(): void {
  if (hljsReady) return
  hljs.registerLanguage('javascript', javascript)
  hljs.registerLanguage('typescript', typescript)
  hljs.registerLanguage('json', json)
  hljs.registerLanguage('xml', xml)
  hljs.registerLanguage('html', xml)
  hljs.registerLanguage('css', css)
  hljs.registerLanguage('scss', scss)
  hljs.registerLanguage('markdown', markdown)
  hljs.registerLanguage('bash', bash)
  hljs.registerLanguage('shell', bash)
  hljs.registerLanguage('python', python)
  hljs.registerLanguage('yaml', yaml)
  hljs.registerLanguage('sql', sql)
  hljsReady = true
}

/**
 * 尝试将字符串解析为 JSON 对象。
 *
 * @param raw - 原始字符串
 * @returns 对象或 null
 */
function tryParseObject(raw?: string): Record<string, unknown> | null {
  if (!raw?.trim()) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * 读取对象中的字符串字段。
 *
 * @param obj - 对象
 * @param key - 字段名
 */
function strField(obj: Record<string, unknown> | null, key: string): string | undefined {
  if (!obj) return undefined
  const value = obj[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * 解析旧版 `Object.values(...).join(', ')` 经 summary 包裹后的载荷。
 *
 * @param summary - summary 字段
 */
function parseLegacyWriteSummary(summary: string): { path?: string; content?: string } {
  const idx = summary.indexOf(', ')
  if (idx <= 0) {
    const trimmed = summary.trim()
    return trimmed ? { path: trimmed } : {}
  }
  return {
    path: summary.slice(0, idx).trim() || undefined,
    content: summary.slice(idx + 2)
  }
}

/**
 * 从「已写入：path」类纯文本结果中提取路径。
 *
 * @param result - 工具结果文本
 */
function parseWrittenPath(result: string): string | undefined {
  const m = /^(?:已写入|已删除)[:：]\s*(.+)$/.exec(result.trim())
  const path = m?.[1]?.trim()
  return path || undefined
}

/**
 * 用 jsdiff `diffLines` 计算行级 unified diff。
 *
 * @param before - 旧内容
 * @param after - 新内容
 * @returns diff 行列表
 */
export function computeLineDiff(before: string, after: string): FileDiffLine[] {
  if (before === '' && after === '') return []

  const changes = diffLines(before, after)
  const lines: FileDiffLine[] = []
  let oldLine = 1
  let newLine = 1

  for (const change of changes) {
    // jsdiff 在非末段通常以 \n 结尾；去掉该分隔符再按行展开
    const raw = change.value
    const chunk = raw.endsWith('\n') ? raw.slice(0, -1) : raw
    const chunkLines = chunk === '' && raw === '\n' ? [''] : chunk.split('\n')

    // 空变更段跳过（例如两侧皆空）
    if (chunkLines.length === 1 && chunkLines[0] === '' && !change.added && !change.removed) {
      if (raw.includes('\n')) {
        // 仅换行的 context：仍计一行空行
      } else {
        continue
      }
    }

    for (const text of chunkLines) {
      if (change.added) {
        lines.push({ kind: 'add', text, newLine })
        newLine += 1
      } else if (change.removed) {
        lines.push({ kind: 'del', text, oldLine })
        oldLine += 1
      } else {
        lines.push({ kind: 'ctx', text, oldLine, newLine })
        oldLine += 1
        newLine += 1
      }
    }
  }

  return lines
}

/**
 * 从工具事件解析编辑 diff 视图模型；无法识别时返回 null。
 *
 * @param name - 工具名
 * @param args - TOOL_CALL_ARGS 累积字符串
 * @param result - TOOL_CALL_RESULT 内容
 */
export function resolveFileEditDiff(
  name: string,
  args?: string,
  result?: string
): FileEditDiffView | null {
  if (name !== 'write_file' && name !== 'delete_file') return null

  const argsObj = tryParseObject(args)
  const resultObj = tryParseObject(result)

  let path =
    strField(resultObj, 'path') ||
    strField(argsObj, 'path') ||
    (result ? parseWrittenPath(result) : undefined)

  let before = strField(resultObj, 'before')
  let after = strField(resultObj, 'after') ?? strField(argsObj, 'content')
  let created =
    typeof resultObj?.created === 'boolean' ? resultObj.created : before == null || before === ''

  if ((!path || after == null) && argsObj && typeof argsObj.summary === 'string') {
    const legacy = parseLegacyWriteSummary(argsObj.summary)
    path = path || legacy.path
    if (after == null && legacy.content != null) after = legacy.content
    if (before == null) {
      before = ''
      created = true
    }
  }

  if (name === 'delete_file') {
    const deletePath = path || strField(argsObj, 'path')
    if (!deletePath) return null
    const deletedBefore = before ?? ''
    const lines = computeLineDiff(deletedBefore, '').slice(0, MAX_RENDER_DIFF_LINES)
    return {
      path: deletePath,
      before: deletedBefore,
      after: '',
      created: false,
      deleted: true,
      lines
    }
  }

  if (after == null) return null

  const beforeText = before ?? ''
  const afterText = after
  const allLines = computeLineDiff(beforeText, afterText)
  const truncated = allLines.length > MAX_RENDER_DIFF_LINES
  const lines = truncated ? allLines.slice(0, MAX_RENDER_DIFF_LINES) : allLines
  if (truncated) {
    lines.push({
      kind: 'ctx',
      text: `…[diff 已截断：共 ${allLines.length} 行，仅展示前 ${MAX_RENDER_DIFF_LINES} 行]`
    })
  }

  return {
    path: path || '（未知路径）',
    before: beforeText,
    after: afterText,
    created: Boolean(created && beforeText === ''),
    deleted: false,
    lines
  }
}

/** 扩展名 → highlight.js 语言 id */
const EXT_TO_LANG: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'css',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  py: 'python',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql'
}

/**
 * 根据文件路径猜测 highlight.js 语言。
 *
 * @param filePath - 相对或绝对路径
 * @returns 语言 id；无法识别时返回 undefined
 */
export function guessHighlightLanguage(filePath: string): string | undefined {
  const base = filePath.split(/[/\\]/).pop() || filePath
  const dot = base.lastIndexOf('.')
  if (dot < 0) return undefined
  const ext = base.slice(dot + 1).toLowerCase()
  return EXT_TO_LANG[ext]
}

/**
 * HTML 转义，用于无法高亮时的纯文本回退。
 *
 * @param text - 原始文本
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 将 highlight.js 生成的 HTML 按换行拆成行，并在行界正确闭合/重开 span。
 *
 * @param html - highlight 后的 HTML（可含嵌套 span）
 * @returns 与源码行一一对应的 HTML 片段
 */
function splitHighlightedHtml(html: string): string[] {
  const lines: string[] = ['']
  const stack: string[] = []
  const tagRe = /<\/?span\b[^>]*>/gi
  let lastIndex = 0

  const appendText = (text: string) => {
    if (!text) return
    const parts = text.split('\n')
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) {
        for (let s = stack.length - 1; s >= 0; s -= 1) {
          lines[lines.length - 1] += '</span>'
        }
        lines.push(stack.join(''))
      }
      lines[lines.length - 1] += parts[i]
    }
  }

  let match: RegExpExecArray | null
  while ((match = tagRe.exec(html))) {
    appendText(html.slice(lastIndex, match.index))
    const tag = match[0]
    if (tag.startsWith('</')) {
      stack.pop()
      lines[lines.length - 1] += tag
    } else {
      stack.push(tag)
      lines[lines.length - 1] += tag
    }
    lastIndex = match.index + tag.length
  }
  appendText(html.slice(lastIndex))
  return lines
}

/**
 * 将源码按行做语法高亮，返回与行对齐的 HTML 片段数组。
 *
 * @param code - 完整文件文本
 * @param language - highlight.js 语言 id
 * @returns 每行 HTML（已转义或含 hljs span）
 */
export function highlightCodeLines(code: string, language?: string): string[] {
  if (code === '') return []
  const plain = code.split('\n').map(escapeHtml)
  if (!language) return plain

  ensureHljsLanguages()
  if (!hljs.getLanguage(language)) return plain

  try {
    const { value } = hljs.highlight(code, { language, ignoreIllegals: true })
    const parts = splitHighlightedHtml(value)
    if (parts.length !== plain.length) return plain
    return parts
  } catch {
    return plain
  }
}

/**
 * 取 diff 行应展示的行号（单列：删除用旧号，其余用新号）。
 *
 * @param line - diff 行
 */
export function displayLineNumber(line: FileDiffLine): number | undefined {
  if (line.kind === 'del') return line.oldLine
  return line.newLine ?? line.oldLine
}
