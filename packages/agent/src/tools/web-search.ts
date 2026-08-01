const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'

/**
 * 判断 Tavily 是否已配置（入参 apiKey 或环境变量 TAVILY_API_KEY）。
 *
 * @param tavilyApiKey - 宿主注入的 API Key（如 AgentRunInput.tavily.apiKey）
 * @returns 是否可用
 */
export function isTavilyConfigured(tavilyApiKey?: string): boolean {
  return Boolean(tavilyApiKey?.trim() || process.env.TAVILY_API_KEY?.trim())
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
  const parts: string[] = ['互联网搜索（Tavily）：']
  if (typeof data.answer === 'string' && data.answer.trim()) {
    parts.push(`摘要：\n${data.answer.trim()}`, '')
  }
  if (!results.length) {
    parts.push('未返回网页结果。')
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
  parts.push('\n[说明] 以上为搜索摘要；下结论前请对照原始来源核实。')
  return parts.join('\n')
}

/**
 * 使用 Tavily Search API 联网搜索。
 *
 * apiKey 优先用参数，否则读环境变量 TAVILY_API_KEY。
 *
 * @param query - 搜索词
 * @param options - maxResults、apiKey
 * @returns 格式化搜索结果或错误说明
 */
export async function tavilyWebSearch(
  query: string,
  options?: { maxResults?: number; apiKey?: string }
): Promise<string> {
  const q = query.trim()
  if (!q) {
    return 'query 不能为空'
  }

  const key = (options?.apiKey?.trim() || process.env.TAVILY_API_KEY?.trim()) ?? ''
  if (!key) {
    return [
      '未配置 Tavily API Key，无法联网搜索。',
      '请在应用设置中填写「Tavily API Key」，或设置环境变量 TAVILY_API_KEY；可在 https://tavily.com 注册。'
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
    return `Tavily 请求失败：${(e as Error).message}`
  }

  const text = await res.text()
  let data: TavilySearchJson
  try {
    data = JSON.parse(text) as TavilySearchJson
  } catch {
    return `Tavily 响应不是有效 JSON（HTTP ${res.status}）`
  }

  if (!res.ok) {
    const detailStr =
      typeof data.detail === 'string'
        ? data.detail
        : data.detail != null
          ? JSON.stringify(data.detail).slice(0, 400)
          : ''
    const msg = (typeof data.error === 'string' && data.error) || detailStr || text.slice(0, 500)
    return `Tavily HTTP ${res.status}：${msg}`
  }

  return formatTavilyResponse(data)
}
