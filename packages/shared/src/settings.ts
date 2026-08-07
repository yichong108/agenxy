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

/** Desktop 会话使用的 Agent 实现类型 */
export type AgentType = 'openworker' | 'cursor'

/** 规范化 agentType，非法值回退为 openworker */
export function normalizeAgentType(value: unknown): AgentType {
  if (value === 'cursor') return 'cursor'
  return 'openworker'
}

export type AppSettings = {
  provider: ModelProviderId
  providerProfiles: Record<ModelProviderId, ProviderProfile>
  /** 会话 Agent 实现：openworker（ReAct）或 cursor（SDK local） */
  agentType: AgentType
  agentRunTimeoutMs: number
  tavilyApiKey: string
  /** Cursor SDK API Key（agentType=cursor 时使用） */
  cursorApiKey: string
  /** Cursor 模型 ID，默认 composer-2.5 */
  cursorModel: string
  mcpServers: McpServerEntry[]
}

/** ReAct 最大工具调用轮次（内置常量，不对外暴露为用户设置） */
export const MAX_AGENT_LOOP_STEPS = 24

export const defaultProviderProfiles = (): Record<ModelProviderId, ProviderProfile> => ({
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: ''
  }
})

export const DEFAULT_CURSOR_MODEL = 'composer-2.5'

export const defaultSettings: AppSettings = {
  provider: 'deepseek',
  providerProfiles: defaultProviderProfiles(),
  agentType: 'openworker',
  agentRunTimeoutMs: 600_000,
  tavilyApiKey: '',
  cursorApiKey: '',
  cursorModel: DEFAULT_CURSOR_MODEL,
  mcpServers: []
}

/** 当前选中提供方的连接配置 */
export function getActiveProviderProfile(s: AppSettings): ProviderProfile {
  return s.providerProfiles[s.provider]
}

export type SettingsFormValues = Pick<
  AppSettings,
  'agentRunTimeoutMs' | 'tavilyApiKey' | 'agentType' | 'cursorApiKey' | 'cursorModel'
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
    agentType: normalizeAgentType(s.agentType),
    agentRunTimeoutMs: s.agentRunTimeoutMs,
    tavilyApiKey: s.tavilyApiKey ?? '',
    cursorApiKey: s.cursorApiKey ?? '',
    cursorModel: (s.cursorModel ?? '').trim() || DEFAULT_CURSOR_MODEL
  }
}

export function mergeFormIntoProviderProfiles(
  profiles: Record<ModelProviderId, ProviderProfile>,
  form: SettingsFormValues
): Record<ModelProviderId, ProviderProfile> {
  const next: Record<ModelProviderId, ProviderProfile> = {
    deepseek: { ...profiles.deepseek }
  }
  // 表单切换 Agent 类型时，未挂载字段可能为 undefined，回退已有 profile
  next.deepseek = {
    baseUrl: (form.baseUrl ?? profiles.deepseek?.baseUrl ?? '').trim(),
    model: (form.model ?? profiles.deepseek?.model ?? '').trim(),
    apiKey: (form.apiKey ?? profiles.deepseek?.apiKey ?? '').trim()
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
    agentType: normalizeAgentType(form.agentType),
    agentRunTimeoutMs: form.agentRunTimeoutMs ?? prev.agentRunTimeoutMs,
    // 未挂载的表单项可能为 undefined，保留上一份设置
    tavilyApiKey: (form.tavilyApiKey ?? prev.tavilyApiKey ?? '').trim(),
    cursorApiKey: (form.cursorApiKey ?? prev.cursorApiKey ?? '').trim(),
    cursorModel: (form.cursorModel ?? prev.cursorModel ?? '').trim() || DEFAULT_CURSOR_MODEL
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
 * 并钳制超时范围；忽略已废弃字段。
 *
 * @param input - 部分 settings、旧扁平字段或未知 JSON
 * @returns 规范化后的完整 AppSettings
 */
export function normalizeSettings(
  input: Partial<AppSettings> &
    LegacyFlatSettings & {
      /** 旧版持久化字段，忽略 */
      maxConcurrentStreams?: unknown
      /** 已改为内置常量，忽略旧持久化 */
      maxAgentLoopSteps?: unknown
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
    maxConcurrentStreams: _legacyMaxConcurrentStreams,
    maxAgentLoopSteps: _legacyMaxAgentLoopSteps,
    streamFlushMs: _legacyStreamFlushMs,
    streamFlushChars: _legacyStreamFlushChars,
    maxTerminalOutputChars: _legacyMaxTerminalOutputChars,
    ...inputRest
  } = input
  void _legacyMaxConcurrentStreams
  void _legacyMaxAgentLoopSteps
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

  // 忽略已废弃的 toolApprovalInBuild（HITL 已移除）
  const { toolApprovalInBuild: _legacyToolApprovalInBuild, ...inputWithoutLegacy } =
    inputRest as typeof inputRest & {
      toolApprovalInBuild?: unknown
    }
  void _legacyToolApprovalInBuild

  const merged: AppSettings = {
    ...defaults,
    ...inputWithoutLegacy,
    provider,
    providerProfiles,
    agentType: normalizeAgentType(inputWithoutLegacy.agentType),
    agentRunTimeoutMs: inputWithoutLegacy.agentRunTimeoutMs ?? defaults.agentRunTimeoutMs,
    tavilyApiKey:
      typeof inputWithoutLegacy.tavilyApiKey === 'string'
        ? inputWithoutLegacy.tavilyApiKey
        : defaults.tavilyApiKey,
    cursorApiKey:
      typeof inputWithoutLegacy.cursorApiKey === 'string'
        ? inputWithoutLegacy.cursorApiKey
        : defaults.cursorApiKey,
    cursorModel:
      typeof inputWithoutLegacy.cursorModel === 'string' && inputWithoutLegacy.cursorModel.trim()
        ? inputWithoutLegacy.cursorModel.trim()
        : defaults.cursorModel,
    mcpServers: parseMcpServersFromUnknown(
      inputWithoutLegacy.mcpServers !== undefined
        ? inputWithoutLegacy.mcpServers
        : defaults.mcpServers
    )
  }

  return {
    ...merged,
    agentRunTimeoutMs: Math.min(600_000, Math.max(5_000, Math.floor(merged.agentRunTimeoutMs)))
  }
}
