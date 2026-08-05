/**
 * Desktop agent 工厂。
 *
 * 每个会话应持有独立的 OpenWorkerAgent 实例（createSessionOpenWorkerAgent）。
 * MCP 预热 / 探测 / dispose 使用应用级 OpenWorkerAgent 宿主（getMcpHostAgent），不参与会话 run。
 * Skills / MCP 工具绑定在 run 时按轮由底层加载。
 *
 * 会话消息一律使用 AG-UI Message（经 initialMessages / agent.messages）。
 * 禁止在 Desktop 直接调用 createAgent。
 */
import { type CreateAgentOptions, OpenWorkerAgent } from '@openworker/agent'
import type { Message } from '@ag-ui/client'
import type { LanguageModel } from 'ai'

/**
 * 创建时占位模型：会话实际对话模型由 run 的 provider 覆盖；
 * MCP 宿主不发起 run，仅需满足底层 createAgent 必填约束。
 */
const PLACEHOLDER_PROVIDER = { modelId: 'desktop-placeholder' } as LanguageModel

/**
 * 组装 Desktop 会话用底层 agent 选项（不含消息；历史由 AG-UI initialMessages 承载）。
 *
 * @param cwd - 工作区根目录（可选）
 * @returns CreateAgentOptions
 */
function buildSessionAgentOptions(cwd?: string): CreateAgentOptions {
  return {
    provider: PLACEHOLDER_PROVIDER,
    ...(cwd ? { local: { cwd } } : {})
  }
}

/**
 * 为单个会话创建独立 OpenWorkerAgent（AG-UI AbstractAgent）。
 *
 * 同会话复用该实例；不同会话互不共享，避免并发 run / 状态串扰。
 * 勿在会话销毁时调用 sessionAgent.mcp.dispose（MCP 连接池为进程级，由 mcpHost 管理）。
 *
 * @param options - cwd / messages（AG-UI）/ threadId 等工作区与会话相关配置
 * @returns 新的 OpenWorkerAgent 实例
 */
export function createSessionOpenWorkerAgent(options?: {
  cwd?: string
  messages?: Message[]
  threadId?: string
}): OpenWorkerAgent {
  const cwd = options?.cwd?.trim() || undefined
  return new OpenWorkerAgent({
    agentId: 'openworker-desktop',
    description: 'Openworker desktop session agent',
    ...(options?.threadId ? { threadId: options.threadId } : {}),
    ...(options?.messages ? { initialMessages: options.messages } : {}),
    agent: buildSessionAgentOptions(cwd)
  })
}

/** 应用级 MCP 宿主（warmup / probe / dispose），不用于会话 run */
let mcpHostAgent: OpenWorkerAgent | undefined

/**
 * 获取（或惰性创建）应用级 MCP 宿主 OpenWorkerAgent。
 *
 * @returns 带 mcp 能力的 OpenWorkerAgent
 */
export function getMcpHostAgent(): OpenWorkerAgent {
  if (!mcpHostAgent) {
    mcpHostAgent = new OpenWorkerAgent({
      agentId: 'openworker-mcp-host',
      description: 'Openworker desktop MCP host',
      agent: { provider: PLACEHOLDER_PROVIDER }
    })
  }
  return mcpHostAgent
}

/**
 * 设置变更后重建 MCP 宿主：先释放连接池再新建实例。
 *
 * @returns 重建后的宿主 OpenWorkerAgent
 */
export async function resetMcpHostAgent(): Promise<OpenWorkerAgent> {
  await mcpHostAgent?.dispose()
  mcpHostAgent = new OpenWorkerAgent({
    agentId: 'openworker-mcp-host',
    description: 'Openworker desktop MCP host',
    agent: { provider: PLACEHOLDER_PROVIDER }
  })
  return mcpHostAgent
}
