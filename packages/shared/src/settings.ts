export type ModelProviderId = 'deepseek'

/** 用户配置的 stdio MCP 服务器（与 Cursor MCP 配置形态相近） */
export type McpServerEntry = {
  id: string
  name: string
  enabled: boolean
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, unknown>
}

/** 与设置持久化、单次导入共用上限 */
export const MAX_MCP_SERVERS = 24

function newMcpEntryId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `mcp-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

function parseMcpEnvFromUnknown(envRaw: unknown): Record<string, unknown> | undefined {
  let v = envRaw
  if (typeof v === 'string' && v.trim()) {
    try {
      v = JSON.parse(v.trim()) as unknown
    } catch {
      return undefined
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const envObj: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === undefined) continue
    envObj[k] = val
  }
  return Object.keys(envObj).length > 0 ? envObj : undefined
}

function parseOneMcpServer(
  o: Record<string, unknown>,
  keyName?: string,
  defaultEnabledWhenOmitted = false
): McpServerEntry | null {
  const command = typeof o.command === 'string' ? o.command.trim() : ''
  if (!command) return null
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : newMcpEntryId()
  const nameFromField = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : ''
  const name = nameFromField || (keyName?.trim() ? keyName.trim() : id)
  const args = Array.isArray(o.args)
    ? (o.args as unknown[]).filter((a): a is string => typeof a === 'string')
    : []
  const enabled = typeof o.enabled === 'boolean' ? o.enabled : defaultEnabledWhenOmitted
  const env = parseMcpEnvFromUnknown(o.env)
  const cwd = typeof o.cwd === 'string' && o.cwd.trim() ? o.cwd.trim() : undefined
  const entry: McpServerEntry = { id, name, enabled, command, args }
  if (env) entry.env = env
  if (cwd) entry.cwd = cwd
  return entry
}

/**
 * 解析 MCP 配置 JSON，支持 Cursor 形态与数组形态。
 *
 * @param raw - 原始 JSON 值
 * @returns 解析后的 MCP 服务器列表
 */
export function parseMcpServersFromUnknown(raw: unknown): McpServerEntry[] {
  const out: McpServerEntry[] = []
  const push = (e: McpServerEntry) => {
    if (out.length >= MAX_MCP_SERVERS) return
    out.push(e)
  }

  if (raw == null) return []

  if (Array.isArray(raw)) {
    for (const x of raw) {
      if (!x || typeof x !== 'object') continue
      const e = parseOneMcpServer(x as Record<string, unknown>, undefined, false)
      if (e) push(e)
    }
    return out
  }

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const root = raw as Record<string, unknown>
    const ms = root.mcpServers
    if (ms === undefined) return []

    if (Array.isArray(ms)) {
      return parseMcpServersFromUnknown(ms)
    }

    if (typeof ms === 'object' && ms !== null && !Array.isArray(ms)) {
      for (const [key, val] of Object.entries(ms as Record<string, unknown>)) {
        if (!val || typeof val !== 'object' || Array.isArray(val)) continue
        const e = parseOneMcpServer(val as Record<string, unknown>, key, true)
        if (e) push(e)
      }
      return out
    }
  }

  return []
}

/** 单个模型提供方的连接信息（分提供方持久化） */
export type ProviderProfile = {
  baseUrl: string
  model: string
  apiKey: string
}

export type AppSettings = {
  provider: ModelProviderId
  providerProfiles: Record<ModelProviderId, ProviderProfile>
  maxAgentLoopSteps: number
  agentRunTimeoutMs: number
  toolApprovalInBuild: boolean
  tavilyApiKey: string
  mcpServers: McpServerEntry[]
}

export const defaultProviderProfiles = (): Record<ModelProviderId, ProviderProfile> => ({
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: ''
  }
})

export const defaultSettings: AppSettings = {
  provider: 'deepseek',
  providerProfiles: defaultProviderProfiles(),
  maxAgentLoopSteps: 24,
  agentRunTimeoutMs: 120_000,
  toolApprovalInBuild: true,
  tavilyApiKey: '',
  mcpServers: []
}

/** 当前选中提供方的连接配置 */
export function getActiveProviderProfile(s: AppSettings): ProviderProfile {
  return s.providerProfiles[s.provider]
}

export type SettingsFormValues = Pick<
  AppSettings,
  'maxAgentLoopSteps' | 'agentRunTimeoutMs' | 'tavilyApiKey'
> & {
  baseUrl: string
  model: string
  apiKey: string
}

export function settingsToFormValues(s: AppSettings): SettingsFormValues {
  const p = getActiveProviderProfile(s)
  return {
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: p.apiKey,
    maxAgentLoopSteps: s.maxAgentLoopSteps,
    agentRunTimeoutMs: s.agentRunTimeoutMs,
    tavilyApiKey: s.tavilyApiKey ?? ''
  }
}

export function mergeFormIntoProviderProfiles(
  profiles: Record<ModelProviderId, ProviderProfile>,
  form: SettingsFormValues
): Record<ModelProviderId, ProviderProfile> {
  const next: Record<ModelProviderId, ProviderProfile> = {
    deepseek: { ...profiles.deepseek }
  }
  next.deepseek = {
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    apiKey: (form.apiKey ?? '').trim()
  }
  return next
}

export function applySettingsForm(
  prev: AppSettings,
  form: SettingsFormValues,
  providerProfiles: Record<ModelProviderId, ProviderProfile>
): AppSettings {
  return {
    ...prev,
    provider: 'deepseek',
    providerProfiles,
    maxAgentLoopSteps: form.maxAgentLoopSteps,
    agentRunTimeoutMs: form.agentRunTimeoutMs,
    tavilyApiKey: (form.tavilyApiKey ?? '').trim()
  }
}

/** 旧版扁平 settings 字段（仅用于迁移） */
type LegacyFlatSettings = {
  apiKey?: string
  baseUrl?: string
  model?: string
}

/**
 * 将任意持久化/API 输入规范为完整 AppSettings
 *
 * 合并默认值、迁移旧版顶层 apiKey/baseUrl/model，
 * 并钳制循环步数与超时范围；忽略已废弃字段。
 *
 * @param input - 部分 settings、旧扁平字段或未知 JSON
 * @returns 规范化后的完整 AppSettings
 */
export function normalizeSettings(
  input: Partial<AppSettings> &
    LegacyFlatSettings & {
      skillsMarketCatalogUrl?: unknown
      skillsMarketCatalogRefreshHours?: unknown
      /** 旧版持久化字段，忽略 */
      maxConcurrentStreams?: unknown
      /** 已改为内置常量，忽略旧持久化 */
      streamFlushMs?: unknown
      streamFlushChars?: unknown
      maxTerminalOutputChars?: unknown
    } = {}
): AppSettings {
  const defaults = defaultSettings
  const baseProfiles = defaultProviderProfiles()
  const {
    baseUrl: legacyBaseUrl,
    model: legacyModel,
    apiKey: legacyApiKey,
    skillsMarketCatalogUrl: legacySkillsMarketCatalogUrl,
    skillsMarketCatalogRefreshHours: legacySkillsMarketCatalogRefreshHours,
    maxConcurrentStreams: _legacyMaxConcurrentStreams,
    streamFlushMs: _legacyStreamFlushMs,
    streamFlushChars: _legacyStreamFlushChars,
    maxTerminalOutputChars: _legacyMaxTerminalOutputChars,
    ...inputRest
  } = input
  void legacySkillsMarketCatalogUrl
  void legacySkillsMarketCatalogRefreshHours
  void _legacyMaxConcurrentStreams
  void _legacyStreamFlushMs
  void _legacyStreamFlushChars
  void _legacyMaxTerminalOutputChars
  const legacy: LegacyFlatSettings = {
    baseUrl: legacyBaseUrl,
    model: legacyModel,
    apiKey: legacyApiKey
  }
  const fromProfiles = inputRest.providerProfiles

  let providerProfiles: Record<ModelProviderId, ProviderProfile> = {
    deepseek: { ...baseProfiles.deepseek, ...fromProfiles?.deepseek }
  }

  const hadLegacyTopLevel =
    typeof legacy.baseUrl === 'string' ||
    typeof legacy.model === 'string' ||
    typeof legacy.apiKey === 'string'

  const looksNewProfileShape =
    fromProfiles != null && typeof fromProfiles === 'object' && fromProfiles.deepseek != null

  if (hadLegacyTopLevel && !looksNewProfileShape) {
    providerProfiles = {
      ...providerProfiles,
      deepseek: {
        ...providerProfiles.deepseek,
        baseUrl: legacy.baseUrl?.trim() || providerProfiles.deepseek.baseUrl,
        model: legacy.model?.trim() || providerProfiles.deepseek.model,
        apiKey: typeof legacy.apiKey === 'string' ? legacy.apiKey : providerProfiles.deepseek.apiKey
      }
    }
  }

  const finalizeProfile = (p: ProviderProfile): ProviderProfile => ({
    baseUrl: p.baseUrl ?? '',
    model: p.model ?? '',
    apiKey: p.apiKey ?? ''
  })
  providerProfiles = {
    deepseek: finalizeProfile(providerProfiles.deepseek)
  }

  const provider: ModelProviderId = 'deepseek'

  const merged: AppSettings = {
    ...defaults,
    ...inputRest,
    provider,
    providerProfiles,
    maxAgentLoopSteps: inputRest.maxAgentLoopSteps ?? defaults.maxAgentLoopSteps,
    agentRunTimeoutMs: inputRest.agentRunTimeoutMs ?? defaults.agentRunTimeoutMs,
    toolApprovalInBuild:
      typeof inputRest.toolApprovalInBuild === 'boolean'
        ? inputRest.toolApprovalInBuild
        : defaults.toolApprovalInBuild,
    tavilyApiKey:
      typeof inputRest.tavilyApiKey === 'string' ? inputRest.tavilyApiKey : defaults.tavilyApiKey,
    mcpServers: parseMcpServersFromUnknown(
      inputRest.mcpServers !== undefined ? inputRest.mcpServers : defaults.mcpServers
    )
  }

  return {
    ...merged,
    maxAgentLoopSteps: Math.min(64, Math.max(4, Math.floor(merged.maxAgentLoopSteps))),
    agentRunTimeoutMs: Math.min(600_000, Math.max(5_000, Math.floor(merged.agentRunTimeoutMs)))
  }
}
