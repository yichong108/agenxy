/** 从 Plan 模式 assistant 回复中解析结构化计划（对齐 Cursor 清单） */

export type PlanChecklistItem = {
  id: string
  index: number
  title: string
  detail?: string
}

export type ParsedAgentPlan = {
  goal?: string
  steps: PlanChecklistItem[]
  notes: string[]
}

const PLAN_SECTION_RE =
  /^##\s*(计划|plan|approach|implementation\s*plan|steps)\s*$/im
const GOAL_SECTION_RE = /^##\s*(目标|goal|overview|summary)\s*$/im
const NOTES_SECTION_RE = /^##\s*(风险|待确认|risks?|open\s*questions?|notes?)\s*$/im

const CHECKBOX_LINE_RE = /^\s*[-*]\s+\[\s*[ xX]?\s*\]\s+(.+)$/
const NUMBERED_LINE_RE = /^\s*\d+[.)]\s+(.+)$/
const BULLET_LINE_RE = /^\s*[-*]\s+(?!\[)(.+)$/

function splitSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>()
  const lines = markdown.split(/\r?\n/)
  let currentKey: string | null = null
  let buf: string[] = []

  const flush = () => {
    if (currentKey) {
      sections.set(currentKey, buf.join('\n').trim())
    }
    buf = []
  }

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/)
    if (h2) {
      flush()
      currentKey = h2[1]!.trim().toLowerCase()
      continue
    }
    if (currentKey) buf.push(line)
  }
  flush()
  return sections
}

function sectionBody(markdown: string, ...keys: RegExp[]): string {
  const sections = splitSections(markdown)
  for (const [name, body] of sections) {
    if (keys.some((re) => re.test(name))) return body
  }
  return ''
}

function parseStepLine(raw: string): { title: string; detail?: string } | null {
  const line = raw.trim()
  if (!line) return null
  const emDash = line.split(/\s+[—–-]\s+/, 2)
  if (emDash.length === 2 && emDash[0]!.length > 0) {
    return { title: emDash[0]!.trim(), detail: emDash[1]!.trim() }
  }
  return { title: line }
}

function parseStepsFromBlock(block: string): PlanChecklistItem[] {
  const lines = block.split(/\r?\n/)
  const steps: PlanChecklistItem[] = []
  let pendingDetail: string[] = []

  const pushStep = (title: string, inlineDetail?: string) => {
    const detailFromPending = pendingDetail.join('\n').trim()
    pendingDetail = []
    steps.push({
      id: `step-${steps.length + 1}`,
      index: steps.length + 1,
      title,
      detail: inlineDetail || detailFromPending || undefined
    })
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const checkbox = trimmed.match(CHECKBOX_LINE_RE)
    if (checkbox) {
      const parsed = parseStepLine(checkbox[1]!)
      if (parsed) pushStep(parsed.title, parsed.detail)
      continue
    }

    const numbered = trimmed.match(NUMBERED_LINE_RE)
    if (numbered) {
      const parsed = parseStepLine(numbered[1]!)
      if (parsed) pushStep(parsed.title, parsed.detail)
      continue
    }

    const bullet = trimmed.match(BULLET_LINE_RE)
    if (bullet) {
      const parsed = parseStepLine(bullet[1]!)
      if (parsed) pushStep(parsed.title, parsed.detail)
      continue
    }

    if (/^\s{2,}/.test(line) && steps.length > 0) {
      pendingDetail.push(trimmed)
    }
  }

  if (pendingDetail.length > 0 && steps.length > 0) {
    const last = steps[steps.length - 1]!
    steps[steps.length - 1] = {
      ...last,
      detail: [last.detail, pendingDetail.join('\n')].filter(Boolean).join('\n')
    }
  }

  return steps
}

function parseNotesBlock(block: string): string[] {
  return block
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean)
}

function tryParsePlanJsonFence(markdown: string): ParsedAgentPlan | null {
  const m = markdown.match(/```(?:plan|json)\s*\n([\s\S]*?)```/i)
  if (!m) return null
  try {
    const data = JSON.parse(m[1]!) as {
      goal?: string
      steps?: Array<{ title?: string; detail?: string } | string>
      notes?: string[]
    }
    const steps: PlanChecklistItem[] = []
    for (const row of data.steps ?? []) {
      if (typeof row === 'string') {
        const p = parseStepLine(row)
        if (p) steps.push({ id: `step-${steps.length + 1}`, index: steps.length + 1, ...p })
      } else if (row?.title?.trim()) {
        steps.push({
          id: `step-${steps.length + 1}`,
          index: steps.length + 1,
          title: row.title.trim(),
          detail: row.detail?.trim() || undefined
        })
      }
    }
    if (steps.length === 0) return null
    return {
      goal: data.goal?.trim(),
      steps,
      notes: data.notes?.filter(Boolean) ?? []
    }
  } catch {
    return null
  }
}

/** 解析 Plan 模式回复；无有效步骤时返回 null */
export function parseAgentPlan(markdown: string): ParsedAgentPlan | null {
  const text = markdown.trim()
  if (!text) return null

  const fromJson = tryParsePlanJsonFence(text)
  if (fromJson) return fromJson

  const planBlock =
    sectionBody(text, PLAN_SECTION_RE) ||
    (() => {
      const idx = text.search(PLAN_SECTION_RE)
      if (idx < 0) return ''
      const after = text.slice(idx).replace(PLAN_SECTION_RE, '')
      const nextH2 = after.search(/^##\s+/m)
      return (nextH2 >= 0 ? after.slice(0, nextH2) : after).trim()
    })()

  let steps = parseStepsFromBlock(planBlock)
  if (steps.length === 0) {
    steps = parseStepsFromBlock(text)
  }

  if (steps.length === 0) return null

  const goal = sectionBody(text, GOAL_SECTION_RE) || undefined
  const notesBlock = sectionBody(text, NOTES_SECTION_RE)
  const notes = notesBlock ? parseNotesBlock(notesBlock) : []

  return { goal: goal || undefined, steps, notes }
}
