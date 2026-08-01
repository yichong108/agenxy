/**
 * Desktop agent 工厂。
 *
 * 每个会话应持有独立的 agent 实例（createSessionAgent）。
 * MCP 预热 / 探测 / dispose 使用应用级宿主（getMcpHostAgent），不参与会话 send。
 */
import { type Agent, createAgent, type CreateAgentOptions } from '@agenwork/agent'

import { getMcpConfigPath } from '@/main/store'

/**
 * 组装 Desktop 会话用 createAgent 选项。
 *
 * @param cwd - 工作区根目录（可选）
 * @returns CreateAgentOptions
 */
function buildSessionAgentOptions(cwd?: string): CreateAgentOptions {
  return {
    ...(cwd ? { local: { cwd } } : {}),
    mcp: { configPath: getMcpConfigPath() }
  }
}

/**
 * 为单个会话创建独立 agent。
 *
 * 同会话复用该实例；不同会话互不共享，避免并发 send / 状态串扰。
 * 勿在会话销毁时调用 agent.mcp.dispose（MCP 连接池为进程级）。
 *
 * @param options - cwd 等工作区相关配置
 * @returns 新的 Agent 实例
 */
export function createSessionAgent(options?: { cwd?: string }): Agent {
  return createAgent(buildSessionAgentOptions(options?.cwd?.trim() || undefined))
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
    mcpHostAgent = createAgent({ mcp: { configPath: getMcpConfigPath() } })
  }
  return mcpHostAgent
}

/**
 * 设置变更后重建 MCP 宿主：先释放连接池再新建实例。
 *
 * @returns 重建后的宿主 Agent
 */
export async function resetMcpHostAgent(): Promise<Agent> {
  await mcpHostAgent?.mcp?.dispose()
  mcpHostAgent = createAgent({ mcp: { configPath: getMcpConfigPath() } })
  return mcpHostAgent
}
