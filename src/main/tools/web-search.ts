const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'

/** 设置项或环境变量 TAVILY_API_KEY 任一有值即视为已配置联网检索 */
export function isTavilyConfigured(tavilyApiKeyFromSettings?: string): boolean {
  return Boolean(tavilyApiKeyFromSettings?.trim() || process.env.TAVILY_API_KEY?.trim())
}

type TavilyResult = {
  title?: string
  url?: string
  content?: string
}

type TavilySearchJson = {
  error?: string
  detail?: unknown
  answer?: string
  results?: TavilyResult[]
}

function formatTavilyResponse(data: TavilySearchJson): string {
  const err = typeof data.error === 'string' ? data.error.trim() : ''
  if (err) {
    return `Tavily: ${err}`
  }
  const results = data.results ?? []
  const parts: string[] = ['联网检索（Tavily）:']
  if (typeof data.answer === 'string' && data.answer.trim()) {
    parts.push(`摘要:\n${data.answer.trim()}`, '')
  }
  if (!results.length) {
    parts.push('未返回网页条目。')
    return parts.join('\n')
  }
  const blocks = results.map((r, i) => {
    const title = (r.title ?? '').trim() || '（无标题）'
    const url = (r.url ?? '').trim()
    const text = (r.content ?? '').trim()
    const head = `${i + 1}. ${title}`
    const body = [url ? `   ${url}` : '', text ? `   ${text}` : ''].filter(Boolean).join('\n')
    return body ? `${head}\n${body}` : head
  })
  parts.push(blocks.join('\n\n'))
  parts.push('\n[说明] 以上为检索摘要，请核对原始来源后再作结论。')
  return parts.join('\n')
}

/**
 * 使用 Tavily Search API（https://tavily.com）联网检索。
 * apiKey 优先使用参数，否则读环境变量 TAVILY_API_KEY（便于本地调试）。
 */
export async function tavilyWebSearch(
  query: string,
  options?: { maxResults?: number; apiKey?: string }
): Promise<string> {
  const q = query.trim()
  if (!q) {
    return 'query 为空'
  }

  const key = (options?.apiKey?.trim() || process.env.TAVILY_API_KEY?.trim()) ?? ''
  if (!key) {
    return [
      '未配置 Tavily API Key，无法执行联网搜索。',
      '请在应用「设置」中填写「Tavily API Key」，或设置环境变量 TAVILY_API_KEY；注册见 https://tavily.com 。'
    ].join('\n')
  }

  const maxResults = Math.min(Math.max(options?.maxResults ?? 5, 1), 20)

  let res: Response
  try {
    res = await fetch(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query: q,
        max_results: maxResults
      }),
      signal: AbortSignal.timeout(45_000)
    })
  } catch (e) {
    return `Tavily 请求失败: ${(e as Error).message}`
  }

  const text = await res.text()
  let data: TavilySearchJson
  try {
    data = JSON.parse(text) as TavilySearchJson
  } catch {
    return `Tavily 响应非 JSON（HTTP ${res.status}）`
  }

  if (!res.ok) {
    const detailStr =
      typeof data.detail === 'string'
        ? data.detail
        : data.detail != null
          ? JSON.stringify(data.detail).slice(0, 400)
          : ''
    const msg = (typeof data.error === 'string' && data.error) || detailStr || text.slice(0, 500)
    return `Tavily HTTP ${res.status}: ${msg}`
  }

  return formatTavilyResponse(data)
}
