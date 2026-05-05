import type { SkillsMarketCatalogItem } from '@/shared/ipc'
import {
  clawhubSkillsPageSchema,
  type ClawhubSkillListItem,
  type ClawhubSkillsPage
} from '@/shared/skills-market/catalog-schema'

const CLAWHUB_SKILLS_LIST_URL = 'https://clawhub.ai/api/v1/skills'
const CLAWHUB_DOWNLOAD_ORIGIN = 'https://clawhub.ai'

const MAX_PAGE_BYTES = 2 * 1024 * 1024
const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 200
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
  limit: number
  timeoutMs: number
}): Promise<ClawhubSkillsPage> {
  const url = new URL(CLAWHUB_SKILLS_LIST_URL)
  url.searchParams.set('limit', String(opts.limit))
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

    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > MAX_PAGE_BYTES) {
      throw new Error(`ClawHub 单页响应超过 ${MAX_PAGE_BYTES} 字节上限`)
    }

    let json: unknown
    try {
      json = JSON.parse(new TextDecoder('utf8').decode(buf)) as unknown
    } catch {
      throw new Error('ClawHub 响应不是合法 JSON')
    }

    const parsed = clawhubSkillsPageSchema.safeParse(json)
    if (!parsed.success) {
      console.warn('[skills-market] ClawHub 列表 zod 校验失败', parsed.error.flatten())
      throw new Error('ClawHub 列表字段不符合预期')
    }

    return parsed.data
  } finally {
    clearTimeout(timer)
  }
}

export type SkillsCatalogPageFetchResult =
  | { ok: true; items: SkillsMarketCatalogItem[]; nextCursor: string | null }
  | { ok: false; error: string }

/**
 * 渲染进程直连 ClawHub 拉取一页技能列表（cursor 分页）。
 */
export async function fetchSkillsCatalogPage(params?: {
  cursor?: string | null
  limit?: number
  timeoutMs?: number
}): Promise<SkillsCatalogPageFetchResult> {
  const timeoutMs = params?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const rawLimit = params?.limit ?? DEFAULT_PAGE_LIMIT
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(rawLimit)))
  const cursorRaw = params?.cursor
  const cursor = typeof cursorRaw === 'string' && cursorRaw.trim() ? cursorRaw.trim() : undefined

  try {
    const page = await fetchClawhubSkillsPage({ cursor, limit, timeoutMs })
    const collected: SkillsMarketCatalogItem[] = []
    for (const row of page.items) {
      const mapped = clawhubItemToCatalogItem(row)
      if (mapped) collected.push(mapped)
    }
    const next = page.nextCursor && page.nextCursor.trim() ? page.nextCursor.trim() : null
    return { ok: true, items: collected, nextCursor: next }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.warn('[skills-market] 拉取 catalog 页失败:', message)
    return { ok: false, error: message }
  }
}
