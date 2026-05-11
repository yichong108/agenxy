const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'

/** Consider Tavily configured if either settings or env var TAVILY_API_KEY has value */
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
  const parts: string[] = ['Internet search (Tavily):']
  if (typeof data.answer === 'string' && data.answer.trim()) {
    parts.push(`Summary:\n${data.answer.trim()}`, '')
  }
  if (!results.length) {
    parts.push('No web pages returned.')
    return parts.join('\n')
  }
  const blocks = results.map((r, i) => {
    const title = (r.title ?? '').trim() || '(no title)'
    const url = (r.url ?? '').trim()
    const text = (r.content ?? '').trim()
    const head = `${i + 1}. ${title}`
    const body = [url ? `   ${url}` : '', text ? `   ${text}` : ''].filter(Boolean).join('\n')
    return body ? `${head}\n${body}` : head
  })
  parts.push(blocks.join('\n\n'))
  parts.push('\n[Note] Above is search summary; please verify with original sources before drawing conclusions.')
  return parts.join('\n')
}

/**
 * Use Tavily Search API (https://tavily.com) for internet search.
 * apiKey priority: parameter first, else read from env var TAVILY_API_KEY (for local debugging).
 */
export async function tavilyWebSearch(
  query: string,
  options?: { maxResults?: number; apiKey?: string }
): Promise<string> {
  const q = query.trim()
  if (!q) {
    return 'query is empty'
  }

  const key = (options?.apiKey?.trim() || process.env.TAVILY_API_KEY?.trim()) ?? ''
  if (!key) {
    return [
      'Tavily API Key not configured, cannot perform internet search.',
      'Please fill in "Tavily API Key" in app Settings, or set environment variable TAVILY_API_KEY; register at https://tavily.com .'
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
    return `Tavily request failed: ${(e as Error).message}`
  }

  const text = await res.text()
  let data: TavilySearchJson
  try {
    data = JSON.parse(text) as TavilySearchJson
  } catch {
    return `Tavily response is not valid JSON (HTTP ${res.status})`
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
