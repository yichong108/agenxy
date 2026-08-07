/**
 * createAgent 是包内底层工厂，由 OpenWorkerAgent 委托；宿主勿直接调用。
 * 基于 createReActAgent 的运行约定，在 send 时按 ~/.openworker 加载 Skills / MCP，
 * 并在本文件内合并系统 prompt（技能名摘要 / MCP 上下文）。
 */

import {
  type AgentComposerMode,
  type McpServerEntry,
  normalizeComposerMode
} from '@openworker/shared'
import type { CoreMessage, LanguageModel, ToolSet } from 'ai'

import {
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
import { contentToText, findLastAssistantMessage, userMessage } from './messages.js'
import { runReactLoop } from './react-loop.js'
import { loadSkillsFromPaths } from './skills/load-skills.js'
import {
  buildWorkspaceRunPrompt,
  buildWorkspaceTools,
  type WorkspacePromptExtras
} from './tools/workspace-tools.js'
import { getOpenworkerMcpConfigPath, getOpenworkerSkillsDir } from './path.js'

export type { AgentRunResult, AgentRunTavilyOptions } from './createReActAgent.js'
export { getOpenworkerDir, getOpenworkerMcpConfigPath } from './path.js'

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
   * 未传时使用 `~/.openworker/mcp.json`。
   */
  warmup: (configPath?: string) => Promise<McpWarmupServerResult[]>
  /** 关闭所有池化 MCP 子进程（设置变更或应用退出时调用） */
  dispose: () => Promise<void>
}

/**
 * createAgent 配置项。
 *
 * provider 必填；messages / local 可选（messages 默认 []，cwd 回退 process.cwd()）。
 * Skills / MCP 在 send 时按 `~/.openworker` 约定自动加载，不在 create时绑定。
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
 * Skills / MCP 由 send 内部从 `~/.openworker/skills` 与 `~/.openworker/mcp.json` 加载；
 * 可经 `tools` 传入宿主额外工具，与 skills / MCP / 工作区工具合并（同名时 tools 覆盖）。
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

/** createAgent 未传 local 时的默认值；cwd 缺省时在 send 侧回退 process.cwd() */
const DEFAULT_LOCAL: CreateAgentLocalOptions = {}

/**
 * 从 messages 提取最后一条助手文本。
 *
 * @param messages - 本轮结束后的 CoreMessage 列表
 * @returns 助手纯文本；无则空串
 */
function extractAssistantText(messages: CoreMessage[]): string {
  const last = findLastAssistantMessage(messages)
  return last ? contentToText(last.content) : ''
}

/**
 * 按 `~/.openworker` 约定加载本轮 Skills / MCP 工具与 prompt 增强片段。
 *
 * ask 模式下跳过（与历史行为一致，不暴露 skill_* / mcp_*，也不注入技能名摘要）。
 * 目录或文件不存在时加载结果为空，不抛错。
 *
 * @param composerMode - 发送模式
 * @param onTool - 工具生命周期观察回调
 * @returns 合并后的额外 ToolSet 与注入 system prompt 的 extras
 */
async function loadSkillsAndMcpTools(
  composerMode: AgentComposerMode,
  onTool: ToolOnTool
): Promise<{ tools: ToolSet; promptExtras: WorkspacePromptExtras }> {
  if (composerMode === 'ask') {
    return { tools: {}, promptExtras: {} }
  }

  const skillBundle = await loadSkillsFromPaths([getOpenworkerSkillsDir()], onTool)
  const mcpResult = await buildMcpToolsFromConfig(getOpenworkerMcpConfigPath(), onTool)

  const promptExtras: WorkspacePromptExtras = {
    ...(skillBundle.hint ? { skillHint: skillBundle.hint } : {})
  }

  if (mcpResult.servers.length > 0) {
    const enabled = mcpResult.servers.filter((s) => s.enabled && s.command.trim())
    promptExtras.mcpContextHints = mcpResult.contextHints
    promptExtras.includeMcpMeta = true
    promptExtras.enabledMcpNames = enabled.map((s) => s.name || s.id)
    promptExtras.hasDisabledMcpEntries = enabled.length === 0
  } else if (mcpResult.contextHints) {
    promptExtras.mcpContextHints = mcpResult.contextHints
  }

  return {
    tools: mergeToolSets(skillBundle.tools, mcpResult.tools),
    promptExtras
  }
}

/**
 * 创建 agent 实例 — packages/agent 的唯一入口工厂。
 *
 * skills / mcp 在 send 时从 `~/.openworker` 加载；系统 prompt 在本函数内与工作区 prompt 合并。
 * 可 `await createAgent(...)`（函数本身同步，await 无害）。
 *
 * 注意：不直接与外部耦合。同会话「运行中不可再发」由宿主按 session 互斥；
 * 不同会话各自独立 send，互不排队。
 *
 * @param options - 创建配置；provider 必填，messages / local 有默认值
 * @returns 可 send / mcp 的 agent 实例
 */
export function createAgent(options: CreateAgentOptions): Agent {
  const local = options.local ?? DEFAULT_LOCAL
  const defaultCwd = local.cwd?.trim() || process.cwd()
  const defaultProvider = options.provider
  /** 会话消息由 agent 持有；初始值来自 options.messages */
  let messages: CoreMessage[] = [...(options.messages ?? [])]

  /**
   * 发起一次 agent run：加载 skills / MCP → 合并系统 prompt → ReAct 循环。
   *
   * @param userText - 本轮用户文本
   * @param input - 可选 run 参数（不含 skills / mcp 路径配置）
   * @returns 运行结束后的 messages 与助手文本
   * @throws 消息为空、运行失败或取消时抛出
   */
  async function send(userText: string, input: AgentRunInput = {}): Promise<AgentRunResult> {
    const trimmed = userText.trim()
    if (!trimmed) {
      throw new Error('userText is empty')
    }

    const onTextDelta = input.onTextDelta ?? (() => {})
    const onThinking = input.onThinking ?? (() => {})
    const onTool = input.onTool ?? (() => {})
    const { maxSteps, invokeTimeoutMs, tools: hostTools } = input

    // 追加本轮用户消息并立即写回，保证连续 send / 失败重试时历史连贯
    const inputMessages = [...messages, userMessage(trimmed)]
    messages = inputMessages

    const composerMode = normalizeComposerMode(input.composerMode)
    const provider: LanguageModel = input.provider ?? defaultProvider
    const abortController = input.abortController ?? new AbortController()
    const root = input.workspacePath?.trim() || defaultCwd
    const terminalKey = input.terminalKey?.trim() || 'term:default'
    const tavilyApiKey = input.tavily?.apiKey?.trim() || undefined

    const { tools: extraTools, promptExtras } = await loadSkillsAndMcpTools(composerMode, onTool)

    const workspaceTools = buildWorkspaceTools({
      terminalKey,
      root,
      tavilyApiKey,
      onTool,
      mode: composerMode
    })
    const tools = mergeToolSets(workspaceTools, extraTools, hostTools ?? {})

    // 在 create-agent 内合并系统 prompt（工作区 + skills 名称摘要 + MCP 上下文）
    const runPrompt = buildWorkspaceRunPrompt(composerMode, root, tavilyApiKey, promptExtras)

    const runMessages = await runReactLoop(
      provider,
      runPrompt,
      inputMessages,
      tools,
      abortController,
      onTextDelta,
      maxSteps,
      invokeTimeoutMs,
      onThinking
    )

    const finalMessages = runMessages.length > 0 ? runMessages : inputMessages
    messages = finalMessages
    return {
      messages: finalMessages,
      result: extractAssistantText(finalMessages)
    }
  }

  const mcpApi: AgentMcp = {
    probe: (entry) => probeMcpServer(entry),
    warmup: (configPath) =>
      warmupMcpServersFromConfig((configPath?.trim() || getOpenworkerMcpConfigPath()).trim()),
    dispose: () => disposeMcpConnectionPool()
  }

  return {
    get messages() {
      return messages
    },
    set messages(next) {
      messages = [...next]
    },
    send,
    mcp: mcpApi
  }
}
