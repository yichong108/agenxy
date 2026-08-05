import type { SkillListItem } from '@/shared/ipc'

/**
 * 输入框中活跃的 `/` 技能触发 token。
 *
 * 对齐 Cursor：仅在行首或空白后的 `/` 生效，避免匹配路径片段（如 `src/foo`）。
 */
export type SlashSkillToken = {
  /** `/` 在全文中的起始下标 */
  start: number
  /** 光标位置（token 结束下标） */
  end: number
  /** `/` 之后的过滤查询（不含 `/`） */
  query: string
}

/**
 * 从光标位置解析当前是否处于 `/技能` 触发态。
 *
 * 规则：
 * - `/` 必须位于文本开头、或紧跟空白/换行之后
 * - query 不允许包含空白或额外 `/`（空白表示 token 已结束）
 *
 * @param text - 输入框全文
 * @param cursor - 光标位置（0..text.length）
 * @returns 活跃 token；不在触发态时返回 null
 */
export function findActiveSlashSkillToken(text: string, cursor: number): SlashSkillToken | null {
  if (cursor < 1 || cursor > text.length) return null
  const before = text.slice(0, cursor)
  const match = /(?:^|[\s\n])(\/([^\s/]*))$/.exec(before)
  if (!match) return null
  const token = match[1]
  const query = match[2] ?? ''
  const start = cursor - token.length
  return { start, end: cursor, query }
}

/**
 * 按 query 过滤技能列表（名称与描述子串匹配，大小写不敏感）。
 *
 * @param skills - 完整技能列表
 * @param query - `/` 后的过滤串
 * @returns 过滤后的列表（保持原顺序）
 */
export function filterSkillsByQuery(skills: SkillListItem[], query: string): SkillListItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return skills
  return skills.filter((item) => {
    const name = item.name.toLowerCase()
    const desc = item.description.toLowerCase()
    return name.includes(q) || desc.includes(q)
  })
}

/**
 * 将活跃 `/query` 替换为 `/skillName `（末尾空格便于继续输入）。
 *
 * @param text - 当前输入全文
 * @param token - 活跃的斜杠 token
 * @param skillName - 选中的技能名
 * @returns 替换后的全文与新光标位置
 */
export function applySkillSlashSelection(
  text: string,
  token: SlashSkillToken,
  skillName: string
): { nextText: string; nextCursor: number } {
  const insertion = `/${skillName} `
  const nextText = text.slice(0, token.start) + insertion + text.slice(token.end)
  const nextCursor = token.start + insertion.length
  return { nextText, nextCursor }
}

/**
 * 读取 antd TextArea 底层 textarea（兼容 InputRef 形态差异）。
 *
 * @param inputRef - antd Input/TextArea ref 的 current
 * @returns HTMLTextAreaElement 或 null
 */
export function getComposerTextarea(
  inputRef: {
    input?: HTMLInputElement | null
    resizableTextArea?: { textArea?: HTMLTextAreaElement } | null
    nativeElement?: HTMLElement | null
  } | null
): HTMLTextAreaElement | null {
  if (!inputRef) return null
  const fromResizable = inputRef.resizableTextArea?.textArea
  if (fromResizable) return fromResizable
  if (inputRef.input instanceof HTMLTextAreaElement) return inputRef.input
  const native = inputRef.nativeElement
  if (native instanceof HTMLTextAreaElement) return native
  const nested = native?.querySelector?.('textarea')
  return nested instanceof HTMLTextAreaElement ? nested : null
}
