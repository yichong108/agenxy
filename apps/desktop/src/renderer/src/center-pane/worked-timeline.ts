/**
 * 将扁平 ToolTimelineEvent 归并为 Cursor 风格 Worked 树（展示层聚合）。
 *
 * 层级：Worked(L1) → Thought / Explored / Edit / MCP(L2) → 原子工具(L3，仅 Explored 内)。
 * - 连续 thinking 合并为一条 Thought
 * - 连续探索工具（含其间 shell）合并为 Explored（对齐真实 Cursor）
 * - edit / mcp 仍为 Worked 下兄弟节点
 */
import type { ToolCallEvent, ToolErrorEvent, ToolTimelineEvent } from '@/shared/ipc'

/** 只读探索类工具名 */
const EXPLORE_TOOL_NAMES = new Set(['read_file', 'list_dir', 'glob', 'grep', 'web_search'])

/** 可并入 Explored 的工具（探索 + 其间的 shell，对齐 Cursor「Explored 1 search, ran 1 command」） */
const EXPLORED_GROUP_TOOL_NAMES = new Set([...EXPLORE_TOOL_NAMES, 'shell'])

/** 编辑类工具名 */
const EDIT_TOOL_NAMES = new Set(['write_file', 'delete_file'])

/** 短思考：标题用「略作思考」，不展开正文（对齐 Cursor Thought briefly） */
const BRIEF_THOUGHT_MAX_CHARS = 48
const BRIEF_THOUGHT_MAX_MS = 2000

/** Worked 下的二级子节点 */
export type WorkedChild =
  | {
      kind: 'thought'
      id: string
      text: string
      durationMs?: number
      timestampMs?: number
    }
  | {
      kind: 'explored'
      id: string
      tools: ToolCallEvent[]
    }
  | {
      kind: 'shell'
      id: string
      event: ToolCallEvent
    }
  | {
      kind: 'edit'
      id: string
      event: ToolCallEvent
    }
  | {
      kind: 'mcp'
      id: string
      event: ToolCallEvent
    }
  | {
      kind: 'tool'
      id: string
      event: ToolCallEvent
    }
  | {
      kind: 'error'
      id: string
      event: ToolErrorEvent
    }

/** Worked 过程树：本轮所有中间步骤的归并结果 */
export type WorkedNode = {
  /** L2 节点数（合并后的 Thought / Explored / Shell…） */
  stepCount: number
  children: WorkedChild[]
}

/**
 * 判断工具是否为只读探索类。
 *
 * @param name - 工具名
 */
export function isExploreToolName(name: string): boolean {
  return EXPLORE_TOOL_NAMES.has(name)
}

/**
 * 判断工具是否可并入 Explored 组（探索类或 shell）。
 *
 * @param name - 工具名
 */
export function isExploredGroupToolName(name: string): boolean {
  return EXPLORED_GROUP_TOOL_NAMES.has(name)
}

/**
 * 判断工具是否为编辑类。
 *
 * @param name - 工具名
 */
export function isEditToolName(name: string): boolean {
  return EDIT_TOOL_NAMES.has(name)
}

/**
 * 判断工具是否为 MCP（命名约定 `mcp_*`）。
 *
 * @param name - 工具名
 */
export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp_')
}

/**
 * 判断思考是否应展示为「略作思考」（无正文块）。
 *
 * 对齐 Cursor「Thought briefly」：短耗时或短正文；有明确较长耗时时展示完整思考。
 *
 * @param thought - Thought 节点
 */
export function isBriefThought(thought: Extract<WorkedChild, { kind: 'thought' }>): boolean {
  const text = thought.text.trim()
  if (!text) return true
  if (thought.durationMs != null && thought.durationMs >= BRIEF_THOUGHT_MAX_MS) return false
  return text.length <= BRIEF_THOUGHT_MAX_CHARS
}

/**
 * Thought 标题文案（对齐 Cursor：Thought for 3s / Thought briefly）。
 *
 * @param thought - Thought 节点
 */
export function formatThoughtTitle(thought: Extract<WorkedChild, { kind: 'thought' }>): string {
  if (isBriefThought(thought)) return '略作思考'
  if (thought.durationMs != null && thought.durationMs > 0) {
    return `思考 · ${formatDurationCompactZh(thought.durationMs)}`
  }
  return '思考'
}

/**
 * Explored 摘要标题（对齐 Cursor：Explored 1 search, ran 1 command）。
 *
 * @param tools - Explored 内原子工具
 */
export function formatExploredTitle(tools: ToolCallEvent[]): string {
  let searches = 0
  let reads = 0
  let lists = 0
  let commands = 0
  let others = 0

  for (const tool of tools) {
    switch (tool.name) {
      case 'web_search':
      case 'grep':
      case 'glob':
        searches += 1
        break
      case 'read_file':
        reads += 1
        break
      case 'list_dir':
        lists += 1
        break
      case 'shell':
        commands += 1
        break
      default:
        others += 1
    }
  }

  const parts: string[] = []
  if (searches > 0) parts.push(`${searches} 次搜索`)
  if (reads > 0) parts.push(`读取 ${reads} 个文件`)
  if (lists > 0) parts.push(`列出 ${lists} 个目录`)
  if (commands > 0) parts.push(`运行 ${commands} 条命令`)
  if (others > 0) parts.push(`${others} 步`)

  if (parts.length === 0) return '已探索'
  return `已探索 · ${parts.join('，')}`
}

/**
 * 尝试解析工具 args JSON；失败时返回空对象。
 *
 * @param args - 工具参数原始字符串
 */
function parseToolArgs(args?: string): Record<string, unknown> {
  if (!args?.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(args)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore malformed args
  }
  return {}
}

/**
 * 读取 args 中的字符串字段。
 *
 * @param args - 已解析参数
 * @param key - 字段名
 */
function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 紧凑中文耗时（用于 Thought 标题；秒为整数） */
function formatDurationCompactZh(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒'
  const sec = Math.max(1, Math.round(ms / 1000))
  if (sec < 60) return `${sec} 秒`
  const m = Math.floor(sec / 60)
  const rs = sec % 60
  return rs > 0 ? `${m} 分 ${rs} 秒` : `${m} 分`
}

/**
 * 生成 Explored 内原子工具的一行标题（L3 文案）。
 *
 * @param event - 工具调用事件
 */
export function formatAtomicToolTitle(event: ToolCallEvent): string {
  const args = parseToolArgs(event.args)
  switch (event.name) {
    case 'grep': {
      const pattern = argString(args, 'pattern')
      return pattern ? `搜索了 \`${pattern}\`` : '搜索'
    }
    case 'read_file': {
      const path = argString(args, 'path')
      return path ? `读取 \`${path}\`` : '读取文件'
    }
    case 'list_dir': {
      const path = argString(args, 'path')
      return path ? `列出 \`${path}\`` : '列出目录'
    }
    case 'glob': {
      const pattern = argString(args, 'pattern')
      return pattern ? `匹配 \`${pattern}\`` : '匹配文件'
    }
    case 'web_search': {
      const query = argString(args, 'query')
      return query ? `联网搜索 ${query}` : '联网搜索'
    }
    case 'shell': {
      const command = argString(args, 'command')
      if (!command) return '运行命令'
      // 尝试从注释/语义取短标题；否则截断命令
      const short = command.length > 72 ? `${command.slice(0, 72)}…` : command
      return `运行命令 ${short}`
    }
    default:
      return event.name
  }
}

/**
 * 生成孤立 Shell（未并入 Explored）的二级标题。
 *
 * @param event - shell 工具事件
 */
export function formatShellTitle(event: ToolCallEvent): string {
  return formatAtomicToolTitle(event)
}

/**
 * 从工具 result 中解析文件路径（结构化 JSON 或「已写入：path」文案）。
 *
 * @param result - 工具结果字符串
 */
function pathFromToolResult(result?: string): string | undefined {
  if (!result?.trim()) return undefined
  try {
    const parsed: unknown = JSON.parse(result)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const path = (parsed as Record<string, unknown>).path
      if (typeof path === 'string' && path.trim()) return path.trim()
    }
  } catch {
    // ignore
  }
  const m = /^(?:已写入|已删除)[:：]\s*(.+)$/.exec(result.trim())
  return m?.[1]?.trim() || undefined
}

/**
 * 生成 Edit 二级节点标题。
 *
 * @param event - write_file / delete_file 事件
 */
export function formatEditTitle(event: ToolCallEvent): string {
  const path = argString(parseToolArgs(event.args), 'path') || pathFromToolResult(event.result)
  if (event.name === 'delete_file') {
    return path ? `删除了 ${path}` : '删除文件'
  }
  return path ? `编辑了 ${path}` : '编辑文件'
}

/**
 * 生成 MCP 二级节点标题。
 *
 * @param event - mcp_* 工具事件
 */
export function formatMcpTitle(event: ToolCallEvent): string {
  const sep = event.name.indexOf('__')
  const toolPart = sep >= 0 ? event.name.slice(sep + 2) : ''
  return toolPart ? `MCP · ${toolPart}` : `MCP · ${event.name}`
}

/**
 * 从扁平时间线估算耗时（历史消息无 live RunStats 时使用）。
 *
 * @param events - 扁平时间线
 * @returns 毫秒；无法估算时返回 undefined
 */
export function estimateTimelineDurationMs(events: ToolTimelineEvent[]): number | undefined {
  const times = events
    .map((e) => e.timestampMs)
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
  if (times.length >= 2) {
    return Math.max(0, Math.max(...times) - Math.min(...times))
  }
  let sum = 0
  for (const event of events) {
    if (typeof event.durationMs === 'number' && event.durationMs > 0) {
      sum += event.durationMs
    }
  }
  return sum > 0 ? sum : undefined
}

/**
 * 冲刷 Explored 缓冲区：纯 shell 拆成独立 Shell 节点，其余（含 shell+搜索）合成 Explored。
 *
 * @param buffer - 待冲刷工具
 * @param exploreSeq - 当前 Explored 序号（引用递增）
 */
function flushExploredBuffer(buffer: ToolCallEvent[], exploreSeq: { n: number }): WorkedChild[] {
  if (buffer.length === 0) return []
  const onlyShell = buffer.every((t) => t.name === 'shell')
  if (onlyShell) {
    return buffer.map((event) => ({ kind: 'shell' as const, id: event.id, event }))
  }
  exploreSeq.n += 1
  return [
    {
      kind: 'explored',
      id: `explored-${exploreSeq.n}-${buffer[0]!.id}`,
      tools: buffer
    }
  ]
}

/**
 * 将扁平时间线归并为 Worked 树。
 *
 * - 连续 thinking → 合并为一条 Thought（正文换行拼接，耗时累加）
 * - 连续 explore/shell → Explored（纯 shell 除外）
 * - edit / mcp / 其它工具 → Worked 兄弟节点
 *
 * @param events - 扁平 ToolTimelineEvent（含 thinking）
 * @returns Worked 节点；无步骤时 children 为空
 */
export function groupWorkedTimeline(events: ToolTimelineEvent[]): WorkedNode {
  const children: WorkedChild[] = []
  let exploreBuffer: ToolCallEvent[] = []
  const exploreSeq = { n: 0 }

  const flushExplored = () => {
    const flushed = flushExploredBuffer(exploreBuffer, exploreSeq)
    exploreBuffer = []
    children.push(...flushed)
  }

  for (const event of events) {
    if (event.kind === 'thinking') {
      flushExplored()
      const last = children[children.length - 1]
      if (last?.kind === 'thought') {
        // 连续思考合并为一条（避免「思考 × N」刷屏）
        const nextText = event.text.trim()
        if (nextText) {
          last.text = last.text.trim() ? `${last.text.trim()}\n${nextText}` : nextText
        }
        if (event.durationMs != null && event.durationMs > 0) {
          last.durationMs = (last.durationMs ?? 0) + event.durationMs
        }
        if (event.timestampMs != null) {
          last.timestampMs = event.timestampMs
        }
        continue
      }
      children.push({
        kind: 'thought',
        id: event.id,
        text: event.text,
        durationMs: event.durationMs,
        timestampMs: event.timestampMs
      })
      continue
    }

    if (event.kind === 'error') {
      flushExplored()
      children.push({
        kind: 'error',
        id: `error-${children.length}-${event.timestampMs ?? children.length}`,
        event
      })
      continue
    }

    if (isExploredGroupToolName(event.name)) {
      exploreBuffer.push(event)
      continue
    }

    flushExplored()
    if (isEditToolName(event.name)) {
      children.push({ kind: 'edit', id: event.id, event })
    } else if (isMcpToolName(event.name)) {
      children.push({ kind: 'mcp', id: event.id, event })
    } else {
      children.push({ kind: 'tool', id: event.id, event })
    }
  }

  flushExplored()
  return { stepCount: children.length, children }
}
