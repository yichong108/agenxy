import { mainLog } from '@/main/logger'
import {
  clawhubSkillsPageSchema,
  skillsMarketCatalogPayloadSchema,
  type ClawhubSkillListItem,
  type ClawhubSkillsPage
} from '@/main/skills-market/catalog-schema'
import type {
  SkillsCatalogFetchResult,
  SkillsMarketCatalog,
  SkillsMarketCatalogItem
} from '@/shared/ipc'

const CLAWHUB_SKILLS_LIST_URL = 'https://clawhub.ai/api/v1/skills'
const CLAWHUB_DOWNLOAD_ORIGIN = 'https://clawhub.ai'

const MAX_PAGE_BYTES = 2 * 1024 * 1024
const PAGE_LIMIT = 200
const MAX_PAGES = 3
const DEFAULT_FETCH_TIMEOUT_MS = 20_000

const CATALOG_ITEM_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/

function clawhubItemToCatalogItem(raw: ClawhubSkillListItem): SkillsMarketCatalogItem | null {
  const slug = raw.slug.trim()
  if (!slug || !CATALOG_ITEM_ID_RE.test(slug)) return null
  const version =
    raw.latestVersion?.version?.trim() ||
    (raw.tags?.latest != null ? String(raw.tags.latest).trim() : '')
  if (!version) return null
  const name = (raw.displayName?.trim() || slug).slice(0, 200)
  const description = (raw.summary ?? '').slice(0, 8000)
  const params = new URLSearchParams({ slug, version })
  const packageUrl = `${CLAWHUB_DOWNLOAD_ORIGIN}/api/v1/download?${params.toString()}`
  return { id: slug, name, description, version, packageUrl }
}

async function fetchClawhubSkillsPage(opts: {
  cursor?: string
  timeoutMs: number
}): Promise<ClawhubSkillsPage> {
  const url = new URL(CLAWHUB_SKILLS_LIST_URL)
  url.searchParams.set('limit', String(PAGE_LIMIT))
  if (opts.cursor) url.searchParams.set('cursor', opts.cursor)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }

    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_PAGE_BYTES) {
      throw new Error(`ClawHub 单页响应超过 ${MAX_PAGE_BYTES} 字节上限`)
    }

    let json: unknown
    try {
      json = JSON.parse(buf.toString('utf8')) as unknown
    } catch {
      throw new Error('ClawHub 响应不是合法 JSON')
    }

    const parsed = clawhubSkillsPageSchema.safeParse(json)
    if (!parsed.success) {
      mainLog.warn('[skills-market] ClawHub 列表 zod 校验失败', parsed.error.flatten())
      throw new Error('ClawHub 列表字段不符合预期')
    }

    return parsed.data
  } finally {
    clearTimeout(timer)
  }
}

async function fetchCatalogFromClawhub(timeoutMs: number): Promise<SkillsMarketCatalog> {
  const collected: SkillsMarketCatalogItem[] = []
  let cursor: string | undefined
  let pageIndex = 0

  while (pageIndex < MAX_PAGES) {
    const page = await fetchClawhubSkillsPage({ cursor, timeoutMs })

    for (const row of page.items) {
      const mapped = clawhubItemToCatalogItem(row)
      if (mapped) collected.push(mapped)
    }

    if (!page.nextCursor || page.items.length === 0) break
    if (pageIndex >= MAX_PAGES - 1 && page.nextCursor) {
      mainLog.warn('[skills-market] ClawHub 列表分页已达上限，条目可能不完整')
    }
    cursor = page.nextCursor
    pageIndex += 1
  }

  const validated = skillsMarketCatalogPayloadSchema.safeParse({
    items: collected
  })
  if (!validated.success) {
    mainLog.warn('[skills-market] 归一化 catalog zod 校验失败', validated.error.flatten())
    throw new Error('归一化后的 catalog 字段不符合预期')
  }

  return { items: validated.data.items }
}

/** 从 ClawHub 实时拉取技能列表（无本地磁盘缓存） */
export async function fetchSkillsCatalog(params?: {
  timeoutMs?: number
}): Promise<SkillsCatalogFetchResult> {
  const timeoutMs = params?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  try {
    const catalog = await fetchCatalogFromClawhub(timeoutMs)
    return { ok: true, catalog }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    mainLog.warn('[skills-market] 拉取 catalog 失败:', message)
    return { ok: false, error: message }
  }
}
