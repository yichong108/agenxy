/**
 * Desktop agent 工厂。
 *
 * 每个会话应持有独立的 OpenWorkerAgent 实例（createSessionOpenWorkerAgent）。
 * MCP 预热 / 探测 / dispose 使用应用级宿主（getMcpHostAgent），不参与会话 run。
 * Skills / MCP 工具绑定在 send 时按轮传入。
 */
import {
  type Agent,
  type CoreMessage,
  createAgent,
  type CreateAgentOptions
} from '@openworker/agent'
import { OpenWorkerAgent } from '@openworker/openworker-agent'
import type { LanguageModel } from 'ai'

/**
 * 创建时占位模型：会话实际对话模型由 send 的 provider 覆盖；
 * MCP 宿主不发起 send，仅需满足 createAgent 必填约束。
 */
const PLACEHOLDER_PROVIDER = { modelId: 'desktop-placeholder' } as LanguageModel

/**
 * 组装 Desktop 会话用 createAgent 选项。
 *
 * @param cwd - 工作区根目录（可选）
 * @param messages - 会话初始消息（可选）
 * @returns CreateAgentOptions
 */
function buildSessionAgentOptions(cwd?: string, messages?: CoreMessage[]): CreateAgentOptions {
  return {
    provider: PLACEHOLDER_PROVIDER,
    ...(messages ? { messages } : {}),
    ...(cwd ? { local: { cwd } } : {})
  }
}

/**
 * 为单个会话创建独立 OpenWorkerAgent（AG-UI AbstractAgent）。
 *
 * 同会话复用该实例；不同会话互不共享，避免并发 run / 状态串扰。
 * 勿在会话销毁时调用 getAgent().mcp.dispose（MCP 连接池为进程级）。
 *
 * @param options - cwd / messages / threadId 等工作区与会话相关配置
 * @returns 新的 OpenWorkerAgent 实例
 */
export function createSessionOpenWorkerAgent(options?: {
  cwd?: string
  messages?: CoreMessage[]
  threadId?: string
}): OpenWorkerAgent {
  const cwd = options?.cwd?.trim() || undefined
  return new OpenWorkerAgent({
    agentId: 'openworker-desktop',
    description: 'Openworker desktop session agent',
    ...(options?.threadId ? { threadId: options.threadId } : {}),
    agent: buildSessionAgentOptions(cwd, options?.messages)
  })
}

/**
 * @deprecated 请使用 createSessionOpenWorkerAgent；保留供临时兼容。
 *
 * @param options - cwd / messages
 * @returns 新的 Agent 实例
 */
export function createSessionAgent(options?: { cwd?: string; messages?: CoreMessage[] }): Agent {
  return createAgent(buildSessionAgentOptions(options?.cwd?.trim() || undefined, options?.messages))
}

/** 应用级 MCP 宿主（warmup / probe / dispose），不用于会话 send */
let mcpHostAgent: Agent | undefined

/**
 * 获取（或惰性创建）应用级 MCP 宿主 agent。
 *
 * @returns 带 mcp 能力的 Agent
 */
export function getMcpHostAgent(): Agent {
  if (!mcpHostAgent) {
    mcpHostAgent = createAgent({
      provider: PLACEHOLDER_PROVIDER
    })
  }
  return mcpHostAgent
}

/**
 * 设置变更后重建 MCP 宿主：先释放连接池再新建实例。
 *
 * @returns 重建后的宿主 Agent
 */
export async function resetMcpHostAgent(): Promise<Agent> {
  await mcpHostAgent?.mcp.dispose()
  mcpHostAgent = createAgent({
    provider: PLACEHOLDER_PROVIDER
  })
  return mcpHostAgent
}
