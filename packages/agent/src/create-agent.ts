/**
 * createAgent 是 agent 的唯一入口工厂。
 * 基于 createReActAgent，在 send 时按轮叠加 Skills / MCP。
 */

import {
  type AgentComposerMode,
  type McpServerEntry,
  normalizeComposerMode
} from '@openwork/shared'
import type { CoreMessage, ToolSet } from 'ai'

import {
  createReActAgent,
  type AgentRunInput as ReActAgentRunInput,
  type AgentRunResult,
  type AgentWaitResult,
  type CreateReActAgentLocalOptions,
  type CreateReActAgentOptions
} from './createReActAgent.js'
import { mergeToolSets, type ToolOnTool } from './define-tool.js'
import {
  buildMcpToolsFromConfig,
  disposeMcpConnectionPool,
  probeMcpServer,
  warmupMcpServersFromConfig
} from './mcp/mcp-runtime.js'
import type { McpProbeResult, McpWarmupServerResult } from './mcp/types.js'
import { isAbortError } from './run-utils.js'
import { loadSkillsFromPaths } from './skills/load-skills.js'

export type {
  AgentRunResult,
  AgentRunTavilyOptions,
  AgentWaitResult,
  AgentWaitStatus
} from './createReActAgent.js'

/**
 * createAgent 本地运行环境配置。
 */
export type CreateAgentLocalOptions = CreateReActAgentLocalOptions

/**
 * 单次 run 的 Skills 配置：仅声明扫描路径，由 agent 实现基础加载。
 */
export type AgentRunSkillsOptions = {
  /** 技能根目录绝对路径列表；递归扫描 SKILL.md，同名时靠前路径优先 */
  paths: string[]
}

/**
 * 单次 run 的 MCP 配置：传入配置文件路径，由 agent 内部加载并绑定 MCP 工具。
 *
 * 配置文件支持 Cursor 形态与本应用数组形态。
 * 提供 configPath 后，agent 会在 build 模式叠加 MCP 工具。
 */
export type AgentRunMcpOptions = {
  /** MCP 配置文件绝对路径 */
  configPath: string
}

/**
 * Agent 上的 MCP 宿主能力（探测 / 预热 / 释放连接池）。
 *
 * 与 send 的 mcp 入参独立：工具绑定按轮传入；本对象供宿主管理连接池。
 * 实现细节不单独从包根导出。
 */
export type AgentMcp = {
  /** 一次性探测单个 MCP 服务器（不入池） */
  probe: (entry: McpServerEntry) => Promise<McpProbeResult>
  /** 按 configPath 预热已启用的 MCP（池化建连） */
  warmup: (configPath: string) => Promise<McpWarmupServerResult[]>
  /** 关闭所有池化 MCP 子进程（设置变更或应用退出时调用） */
  dispose: () => Promise<void>
}

/**
 * createAgent 配置项。
 *
 * provider 必填；messages / local 可选（messages 默认 []，cwd 回退 process.cwd()）。
 * Skills / MCP 在 send 时按轮传入，不在创建时绑定。
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   provider: model,
 *   messages: history,
 *   local: { cwd: process.cwd() }
 * })
 * await agent.send('hi', {
 *   skills: { paths: ['/path/to/skills'] },
 *   mcp: { configPath: '/path/to/mcp.json' }
 * })
 * ```
 */
export type CreateAgentOptions = CreateReActAgentOptions

/**
 * 单次 agent run 的可选参数（send 的第二参）。
 *
 * 调用形态：`send(userText, options?)`。
 * 在 createReActAgent 的 run 入参之上，增加本轮 skills / mcp。
 * 会话历史由 createAgent / agent.messages 持有；send 内部追加 userText 并写回。
 */
export type AgentRunInput = Omit<ReActAgentRunInput, 'tools'> & {
  /** Skills 扫描路径；本轮 tooling 加载并叠加技能工具 */
  skills?: AgentRunSkillsOptions
  /**
   * MCP 配置文件路径；本轮由 agent 内部实现连接池与工具绑定，
   * 并自动叠加 MCP 工具。
   */
  mcp?: AgentRunMcpOptions
}

/**
 * createAgent 返回的 agent 实例。
 */
export type Agent = {
  /**
   * 当前会话消息；创建时来自 CreateAgentOptions.messages。
   * send 会追加本轮用户消息，成功后写回含助手回复的完整轨迹，可直接再 send。
   */
  messages: CoreMessage[]
  /**
   * 发起一次 run：`send(userText, options?)`。
   * 内部更新 messages；同会话互斥由宿主保证，不同会话可并行。
   */
  send: (userText: string, input?: AgentRunInput) => Promise<AgentRunResult>
  /**
   * 等待当前（或最近一次）run 结束，返回摘要终态。
   * 未调用过 send 时抛出错误。
   */
  wait: () => Promise<AgentWaitResult>
  /** MCP 宿主侧能力（probe / warmup / dispose）；与 send 的 mcp 入参独立 */
  mcp: AgentMcp
}

/**
 * 按本轮 skills / mcp 配置加载额外工具。
 *
 * ask 模式下跳过（与历史行为一致，不暴露 skill_* / mcp_*）。
 *
 * @param composerMode - 发送模式
 * @param skills - 本轮 skills 配置
 * @param mcp - 本轮 mcp 配置
 * @param onTool - 工具生命周期观察回调
 * @returns 合并后的额外 ToolSet；无可叠加工具时为空对象
 */
async function loadSkillsAndMcpTools(
  composerMode: AgentComposerMode,
  skills: AgentRunSkillsOptions | undefined,
  mcp: AgentRunMcpOptions | undefined,
  onTool: ToolOnTool
): Promise<ToolSet> {
  if (composerMode === 'ask') {
    return {}
  }

  const skillPaths = (skills?.paths ?? []).map((p) => p.trim()).filter(Boolean)
  const mcpConfigPath = mcp?.configPath?.trim() || undefined

  const skillBundle = skillPaths.length
    ? await loadSkillsFromPaths(skillPaths, onTool)
    : { tools: {} as ToolSet }

  let mcpTools: ToolSet = {}
  if (mcpConfigPath) {
    const mcpResult = await buildMcpToolsFromConfig(mcpConfigPath, onTool)
    mcpTools = mcpResult.tools
  }

  return mergeToolSets(skillBundle.tools, mcpTools)
}

/**
 * 将捕获的异常映射为 wait 状态。
 *
 * 用于 skills/MCP 预加载阶段失败（此时尚未进入 createReActAgent.send）。
 *
 * @param error - send 捕获的异常
 * @param signal - 本轮 AbortSignal（若有）
 * @returns error 或 cancelled
 */
function resolveWaitFailureStatus(error: unknown, signal?: AbortSignal): 'error' | 'cancelled' {
  if (error instanceof Error && /timeout/i.test(error.message)) {
    return 'error'
  }
  if (isAbortError(error) || signal?.aborted) {
    return 'cancelled'
  }
  return 'error'
}

/**
 * 创建 agent 实例 — packages/agent 的唯一入口工厂。
 *
 * 内部委托 createReActAgent；skills / mcp 在 send 时加载并经其 tools 入参传入。
 * 可 `await createAgent(...)`（函数本身同步，await 无害）。
 *
 * 注意：不直接与外部耦合。同会话「运行中不可再发」由宿主按 session 互斥；
 * 不同会话各自独立 send，互不排队。
 *
 * @param options - 创建配置；provider 必填，messages / local 有默认值
 * @returns 可 send / wait / mcp 的 agent 实例
 */
export function createAgent(options: CreateAgentOptions): Agent {
  const inner = createReActAgent(options)

  /** 当前进行中的 wait Promise；覆盖 skills 预加载到 inner.send 的全程 */
  let inflightWait: Promise<AgentWaitResult> | null = null
  /** 最近一次已结束 run 的 wait 结果，供重复 wait() */
  let lastWaitResult: AgentWaitResult | null = null

  /**
   * 发起一次 agent run：加载本轮 skills / MCP → 委托 createReActAgent.send。
   *
   * 同步挂起 wait Promise，保证并发 `wait()` 在 skills 预加载阶段也可等待。
   *
   * @param userText - 本轮用户文本
   * @param input - 可选 run 参数（含 skills / mcp）
   * @returns 运行结束后的 messages
   * @throws 消息为空、运行失败或取消时抛出（wait 仍可拿到对应 status）
   */
  async function send(userText: string, input: AgentRunInput = {}): Promise<AgentRunResult> {
    const trimmed = userText.trim()
    if (!trimmed) {
      throw new Error('userText is empty')
    }

    const { skills, mcp, ...reactInput } = input
    const onTool = input.onTool ?? (() => {})
    const composerMode = normalizeComposerMode(input.composerMode)
    const abortController = input.abortController

    let settleWait!: (value: AgentWaitResult) => void
    const waitPromise = new Promise<AgentWaitResult>((resolve) => {
      settleWait = resolve
    })
    inflightWait = waitPromise

    try {
      const extraTools = await loadSkillsAndMcpTools(composerMode, skills, mcp, onTool)
      const tools = Object.keys(extraTools).length > 0 ? extraTools : undefined

      const result = await inner.send(trimmed, {
        ...reactInput,
        ...(tools ? { tools } : {})
      })

      const waitResult = await inner.wait()
      lastWaitResult = waitResult
      settleWait(waitResult)
      return result
    } catch (error) {
      let waitResult: AgentWaitResult
      try {
        waitResult = await inner.wait()
      } catch {
        waitResult = {
          status: resolveWaitFailureStatus(error, abortController?.signal),
          result: '',
          error
        }
      }
      lastWaitResult = waitResult
      settleWait(waitResult)
      throw error
    } finally {
      if (inflightWait === waitPromise) {
        inflightWait = null
      }
    }
  }

  /**
   * 等待当前进行中的 run，或返回最近一次 run 的终态。
   *
   * @returns 含 status / result / error 的摘要
   * @throws 尚未调用过 send 时抛出
   */
  async function wait(): Promise<AgentWaitResult> {
    if (inflightWait) {
      return inflightWait
    }
    if (lastWaitResult) {
      return lastWaitResult
    }
    return inner.wait()
  }

  const mcpApi: AgentMcp = {
    probe: (entry) => probeMcpServer(entry),
    warmup: (configPath) => warmupMcpServersFromConfig(configPath.trim()),
    dispose: () => disposeMcpConnectionPool()
  }

  return {
    get messages() {
      return inner.messages
    },
    set messages(next) {
      inner.messages = next
    },
    send,
    wait,
    mcp: mcpApi
  }
}
