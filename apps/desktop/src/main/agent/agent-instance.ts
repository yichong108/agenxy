/**
 * Desktop agent 工厂。
 *
 * 只负责把设置中的 agentType / 凭据传给 UniAgent；不在此判断用哪个后端。
 */
import { UniAgent } from '@openworker/uni-agent'
import { normalizeAgentType, type AgentType } from '@openworker/shared'
import type { Message } from '@ag-ui/client'

import { getSettings } from '@/main/store'

/** 会话级 AG-UI Agent */
export type SessionAguiAgent = UniAgent

/**
 * 读取当前设置中的 Agent 类型。
 *
 * @returns openworker | cursor
 */
export function getConfiguredAgentType(): AgentType {
  return normalizeAgentType(getSettings().agentType)
}

/**
 * 为单个会话创建独立 UniAgent。
 *
 * @param options - cwd / messages / threadId / agentType
 * @returns 新的 UniAgent
 */
export function createSessionAgent(options?: {
  cwd?: string
  messages?: Message[]
  threadId?: string
  agentType?: AgentType
}): UniAgent {
  const settings = getSettings()
  const agentType = options?.agentType ?? getConfiguredAgentType()
  const cwd = options?.cwd?.trim() || undefined

  return new UniAgent({
    agentType,
    role: 'session',
    agentId: 'openworker-desktop',
    description: 'Openworker desktop session agent',
    cwd,
    cursorApiKey: settings.cursorApiKey,
    cursorModel: settings.cursorModel,
    ...(options?.threadId ? { threadId: options.threadId } : {}),
    ...(options?.messages ? { initialMessages: options.messages } : {})
  })
}

/**
 * @deprecated 使用 createSessionAgent
 */
export function createSessionOpenWorkerAgent(options?: {
  cwd?: string
  messages?: Message[]
  threadId?: string
}): UniAgent {
  return createSessionAgent({ ...options, agentType: 'openworker' })
}

/** 应用级 MCP 宿主（warmup / probe / dispose），不用于会话 run */
let mcpHostAgent: UniAgent | undefined

/**
 * 获取（或惰性创建）应用级 MCP 宿主 UniAgent。
 *
 * @returns role=mcp-host 的 UniAgent
 */
export function getMcpHostAgent(): UniAgent {
  if (!mcpHostAgent) {
    mcpHostAgent = new UniAgent({
      agentType: 'openworker',
      role: 'mcp-host',
      agentId: 'openworker-mcp-host',
      description: 'Openworker desktop MCP host'
    })
  }
  return mcpHostAgent
}

/**
 * 设置变更后重建 MCP 宿主：先 dispose 再新建。
 *
 * @returns 重建后的 MCP 宿主 UniAgent
 */
export async function resetMcpHostAgent(): Promise<UniAgent> {
  if (mcpHostAgent) {
    await mcpHostAgent.dispose()
  }
  mcpHostAgent = new UniAgent({
    agentType: 'openworker',
    role: 'mcp-host',
    agentId: 'openworker-mcp-host',
    description: 'Openworker desktop MCP host'
  })
  return mcpHostAgent
}
