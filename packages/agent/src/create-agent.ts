/**
 * createAgent 是 agent 的唯一入口工厂。
 * 基于 createReActAgent，在 send 时按约定从 ~/.openwork 加载 Skills / MCP。
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
import { getOpenworkMcpConfigPath, getOpenworkSkillsPath } from './openwork-paths.js'
import { loadSkillsFromPaths } from './skills/load-skills.js'

export type { AgentRunResult, AgentRunTavilyOptions } from './createReActAgent.js'
export {
  getOpenworkDir,
  getOpenworkMcpConfigPath,
  getOpenworkSkillsPath
} from './openwork-paths.js'

/**
 * createAgent 本地运行环境配置。
 */
export type CreateAgentLocalOptions = CreateReActAgentLocalOptions

/**
 * Agent 上的 MCP 宿主能力（探测 / 预热 / 释放连接池）。
 *
 * 与 send 内部按约定加载 MCP 独立：工具绑定在 send 内完成；本对象供宿主管理连接池。
 * 实现细节不单独从包根导出。
 */
export type AgentMcp = {
  /** 一次性探测单个 MCP 服务器（不入池） */
  probe: (entry: McpServerEntry) => Promise<McpProbeResult>
  /**
   * 按 configPath 预热已启用的 MCP（池化建连）。
   * 未传时使用 `~/.openwork/mcp.json`。
   */
  warmup: (configPath?: string) => Promise<McpWarmupServerResult[]>
  /** 关闭所有池化 MCP 子进程（设置变更或应用退出时调用） */
  dispose: () => Promise<void>
}

/**
 * createAgent 配置项。
 *
 * provider 必填；messages / local 可选（messages 默认 []，cwd 回退 process.cwd()）。
 * Skills / MCP 在 send 时按 `~/.openwork` 约定自动加载，不在创建时绑定。
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   provider: model,
 *   messages: history,
 *   local: { cwd: process.cwd() }
 * })
 * await agent.send('hi', { composerMode: 'build' })
 * ```
 */
export type CreateAgentOptions = CreateReActAgentOptions

/**
 * 单次 agent run 的可选参数（send 的第二参）。
 *
 * 调用形态：`send(userText, options?)`。
 * 会话历史由 createAgent / agent.messages 持有；send 内部追加 userText 并写回。
 * Skills / MCP 由 send 内部从 `~/.openwork/skills` 与 `~/.openwork/mcp.json` 加载；
 * 可经 `tools` 传入宿主额外工具，与 skills / MCP 合并后交给 createReActAgent（同名时 tools 覆盖）。
 */
export type AgentRunInput = ReActAgentRunInput

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
  /** MCP 宿主侧能力（probe / warmup / dispose）；与 send 内部 MCP 加载独立 */
  mcp: AgentMcp
}

/**
 * 按 `~/.openwork` 约定加载本轮 Skills / MCP 工具。
 *
 * ask 模式下跳过（与历史行为一致，不暴露 skill_* / mcp_*）。
 * 目录或文件不存在时加载结果为空，不抛错。
 *
 * @param composerMode - 发送模式
 * @param onTool - 工具生命周期观察回调
 * @returns 合并后的额外 ToolSet；无可叠加工具时为空对象
 */
async function loadSkillsAndMcpTools(
  composerMode: AgentComposerMode,
  onTool: ToolOnTool
): Promise<ToolSet> {
  if (composerMode === 'ask') {
    return {}
  }

  const skillBundle = await loadSkillsFromPaths([getOpenworkSkillsPath()], onTool)
  const mcpResult = await buildMcpToolsFromConfig(getOpenworkMcpConfigPath(), onTool)

  return mergeToolSets(skillBundle.tools, mcpResult.tools)
}

/**
 * 创建 agent 实例 — packages/agent 的唯一入口工厂。
 *
 * 内部委托 createReActAgent；skills / mcp 在 send 时从 `~/.openwork` 加载并经其 tools 入参传入。
 * 可 `await createAgent(...)`（函数本身同步，await 无害）。
 *
 * 注意：不直接与外部耦合。同会话「运行中不可再发」由宿主按 session 互斥；
 * 不同会话各自独立 send，互不排队。
 *
 * @param options - 创建配置；provider 必填，messages / local 有默认值
 * @returns 可 send / mcp 的 agent 实例
 */
export function createAgent(options: CreateAgentOptions): Agent {
  const inner = createReActAgent(options)

  /**
   * 发起一次 agent run：从 ~/.openwork 加载 skills / MCP → 委托 createReActAgent.send。
   *
   * @param userText - 本轮用户文本
   * @param input - 可选 run 参数（不含 skills / mcp）
   * @returns 运行结束后的 messages 与助手文本
   * @throws 消息为空、运行失败或取消时抛出
   */
  async function send(userText: string, input: AgentRunInput = {}): Promise<AgentRunResult> {
    const trimmed = userText.trim()
    if (!trimmed) {
      throw new Error('userText is empty')
    }

    const { tools: hostTools, ...rest } = input
    const onTool = input.onTool ?? (() => {})
    const composerMode = normalizeComposerMode(input.composerMode)

    const extraTools = await loadSkillsAndMcpTools(composerMode, onTool)
    const tools = mergeToolSets(extraTools, hostTools ?? {})
    const hasTools = Object.keys(tools).length > 0

    return inner.send(trimmed, {
      ...rest,
      ...(hasTools ? { tools } : {})
    })
  }

  const mcpApi: AgentMcp = {
    probe: (entry) => probeMcpServer(entry),
    warmup: (configPath) =>
      warmupMcpServersFromConfig((configPath?.trim() || getOpenworkMcpConfigPath()).trim()),
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
    mcp: mcpApi
  }
}
