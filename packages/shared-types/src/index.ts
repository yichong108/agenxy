/**
 * Agenxy 共享类型定义
 *
 * 可被以下项目共享:
 * - apps/desktop (Electron 应用)
 * - apps/landing (落地页)
 * - services/* (后端服务)
 */

// ===============================
// 通用基础类型
// ===============================

/** 模型提供方 ID */
export type ModelProviderId = 'deepseek'

/** 单个模型提供方的连接信息 */
export type ProviderProfile = {
  baseUrl: string
  model: string
  apiKey: string
}

/** Langfuse 运行模式 */
export type LangfuseMode = 'cloud' | 'local'

/** Langfuse 配置 */
export type LangfuseConfig = {
  mode: LangfuseMode
  publicKey: string
  secretKey: string
  baseUrl: string
}

// ===============================
// Agent 相关类型
// ===============================

/** 主输入区发送模式 */
export type AgentComposerMode = 'build' | 'ask'

export type AgentSendOptions = {
  mode?: AgentComposerMode
}

/** MCP 服务器配置 */
export type McpServerEntry = {
  id: string
  name: string
  enabled: boolean
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, unknown>
}

/** 应用设置 */
export type AppSettings = {
  provider: ModelProviderId
  providerProfiles: Record<ModelProviderId, ProviderProfile>
  maxAgentLoopSteps: number
  agentRunTimeoutMs: number
  tavilyApiKey: string
  mcpServers: McpServerEntry[]
}

// ===============================
// 会话/消息类型
// ===============================

export type MessageRole = 'user' | 'assistant' | 'system'

export type ChatMessage = {
  id: string
  role: MessageRole
  content: string
  intentThinking?: string
}

export type SessionInfo = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

// ===============================
// 工作区类型
// ===============================

export type WorkspaceInfo = {
  id: string
  name: string
  path: string | null
  createdAt: number
  updatedAt: number
  isDefault?: boolean
}

// ===============================
// 技能市场类型
// ===============================

export type SkillsMarketCatalogItem = {
  id: string
  name: string
  description: string
  version: string
  packageUrl: string
  sha256?: string
}

// ===============================
// 默认配置
// ===============================

export const MAX_MCP_SERVERS = 24
export const MAX_CONCURRENT_AGENT_STREAMS = 3

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
  tavilyApiKey: '',
  mcpServers: []
}
