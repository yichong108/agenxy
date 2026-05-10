import { inspect } from 'node:util'

import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { ChatOpenAI } from '@langchain/openai'
import type { WebContents } from 'electron'
import { z } from 'zod'

import { StreamBatcher } from '@/main/agent/batcher'
import { ConcurrencyQueue } from '@/main/agent/queue'
import { buildSkillBundle } from '@/main/agent/skills/index'
import { logScope } from '@/main/logger'
import { buildMcpLangChainTools } from '@/main/mcp/mcp-runtime'
import {
  getSessionMessages,
  getSettings,
  getWorkspaceById,
  setSessionMessages,
  userDataPath
} from '@/main/store'
import {
  deleteFileTool,
  globFilesTool,
  listDirTool,
  readFileTool,
  searchWorkspace,
  writeFileTool
} from '@/main/tools/fs-tools'
import { runCommand, killCommand } from '@/main/tools/terminal'
import { isTavilyConfigured, tavilyWebSearch } from '@/main/tools/web-search'
import {
  EVENTS,
  type AgentComposerMode,
  type AppSettings,
  type ChatMessage,
  type ModelProviderId,
  type StreamEvent,
  type ToolTimelineEvent,
  getActiveProviderProfile,
  MAX_CONCURRENT_AGENT_STREAMS,
  MAX_TERMINAL_OUTPUT_CHARS,
  STREAM_FLUSH_CHARS,
  STREAM_FLUSH_MS
} from '@/shared/ipc'

const agentLog = logScope('agent')

type SessionRuntime = {
  workspaceId: string
  /** 不含 system；system 在每次请求时拼入 */
  messages: BaseMessage[]
  controller: AbortController | null
  /** 与终端 key 同会话一致 */
  terminalKey: string
}

type NamedTool = {
  name: string
  invoke: (input: unknown, config?: { signal?: AbortSignal }) => Promise<unknown>
}

const sessions = new Map<string, SessionRuntime>()
let webContents: WebContents | null = null
let agentQueue: ConcurrencyQueue | null = null
const MAX_PERSISTED_MESSAGES = 200

function makeRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function makeTraceId(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`
}

function getQueue(): ConcurrencyQueue {
  if (!agentQueue) {
    agentQueue = new ConcurrencyQueue(Math.max(1, MAX_CONCURRENT_AGENT_STREAMS))
  }
  return agentQueue
}

// send event to renderer
function emit(event: StreamEvent): void {
  if (!webContents || webContents.isDestroyed()) return
  webContents.send(EVENTS.AGENT_STREAM, event)
}

function trimPersistedMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_PERSISTED_MESSAGES) return messages
  return messages.slice(-MAX_PERSISTED_MESSAGES)
}

function getBaseMessageType(msg: BaseMessage): string {
  const maybeGetType = (msg as { getType?: () => string }).getType
  if (typeof maybeGetType === 'function') return maybeGetType.call(msg)
  const maybeInternalType = (msg as { _getType?: () => string })._getType
  if (typeof maybeInternalType === 'function') return maybeInternalType.call(msg)
  return ''
}

function toPersistedMessages(coreMessages: BaseMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const msg of coreMessages) {
    const messageType = getBaseMessageType(msg)
    if (messageType === 'human') {
      out.push({
        id: `u-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'user',
        content: contentToText(msg.content)
      })
      continue
    }
    if (messageType === 'ai') {
      const content = contentToText(msg.content)
      if (!content.trim()) continue
      out.push({
        id: `a-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'assistant',
        content
      })
      continue
    }
    // system prompt 不进入 UI 历史，避免干扰会话展示
  }
  return trimPersistedMessages(out)
}

function fromPersistedMessages(messages: ChatMessage[]): BaseMessage[] {
  const list: BaseMessage[] = []
  for (const msg of messages) {
    if (!msg.content?.trim()) continue
    if (msg.role === 'user') {
      list.push(new HumanMessage(msg.content))
      continue
    }
    if (msg.role === 'assistant') {
      list.push(new AIMessage(msg.content))
      continue
    }
    if (msg.role === 'system') {
      list.push(new SystemMessage(msg.content))
    }
  }
  return list
}

function persistSessionMessages(
  workspaceId: string,
  sessionId: string,
  coreMessages: BaseMessage[],
  opts?: { intentThinkingForLastAssistant?: string }
): void {
  const list = toPersistedMessages(coreMessages)
  const intent = opts?.intentThinkingForLastAssistant?.trim()
  if (intent) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const row = list[i]
      if (row?.role === 'assistant') {
        list[i] = { ...row, intentThinking: intent }
        break
      }
    }
  }
  setSessionMessages(workspaceId, sessionId, list)
}

function ensureOpenAiV1BaseUrl(baseUrl: string, fallback: string): string {
  const u = baseUrl.trim() || fallback
  if (!u) return fallback
  if (/\/v1\/?$/i.test(u)) return u.replace(/\/+$/, '')
  return `${u.replace(/\/+$/, '')}/v1`
}

function openAiBaseUrlForProvider(provider: ModelProviderId, rawBaseUrl: string): string {
  const deepseekDefault = 'https://api.deepseek.com/v1'
  if (provider === 'ollama') {
    const host = rawBaseUrl.trim() || 'http://127.0.0.1:11434'
    return ensureOpenAiV1BaseUrl(host, 'http://127.0.0.1:11434/v1')
  }
  return ensureOpenAiV1BaseUrl(rawBaseUrl, deepseekDefault)
}

function createLanguageModel(settings: AppSettings) {
  const profile = getActiveProviderProfile(settings)
  const isOllama = settings.provider === 'ollama'
  if (!isOllama && !profile.apiKey?.trim()) {
    throw new Error('请先在「设置」中配置 API Key')
  }
  const apiKey = profile.apiKey?.trim() || 'ollama'
  const baseURL = openAiBaseUrlForProvider(settings.provider, profile.baseUrl)
  return new ChatOpenAI({
    apiKey,
    model: profile.model,
    configuration: { baseURL },
    streaming: true,
    temperature: 0
  })
}

function buildSystemPrompt(root: string, settings: AppSettings): string {
  const web = isTavilyConfigured(settings.tavilyApiKey)
  const mcpEnabled = (settings.mcpServers ?? []).filter((s) => s.enabled && s.command.trim())
  const mcpMeta =
    '\n- **MCP 管理（元工具）**: `mcp_list_servers` 列出已配置 MCP 及脱敏后的 env；`mcp_inspect_server` 探测某台 MCP 暴露的工具列表。需要连接信息或工具名时优先调用二者，勿向用户索要已在应用中保存的密码。'
  const mcpNote =
    mcpEnabled.length > 0
      ? `${mcpMeta}\n- 已启用 MCP（stdio）服务器: ${mcpEnabled.map((s) => s.name || s.id).join('、')}。以 mcp_ 开头的工具名来自各 MCP；调用时传入 JSON 对象，键名与对应工具的 inputSchema 一致。`
      : (settings.mcpServers?.length ?? 0) > 0
        ? `${mcpMeta}\n- 当前 MCP 条目均未启用或 command 为空；用户启用后会出现 mcp_* 工具。`
        : mcpMeta
  const toolLine = web
    ? 'read_file, write_file, delete_file, list_dir, glob, search_workspace, shell, web_search（Tavily 联网）, mcp_list_servers, mcp_inspect_server'
    : 'read_file, write_file, delete_file, list_dir, glob, search_workspace, shell, mcp_list_servers, mcp_inspect_server（未配置 Tavily API Key 时无 web_search）'
  const webRule = web
    ? '- 用户询问**天气、气温、降雨、实时新闻、股价、政策**等需要站外最新信息时，必须先调用 **web_search** 再作答；不得凭记忆编造当日天气或「搜索失败」类说辞。'
    : '- 当前**未**配置 Tavily，没有 web_search：若用户要今日天气等实时信息，请明确告知在应用「设置」中填写「Tavily API Key」或配置环境变量 TAVILY_API_KEY，并可建议中国天气网、手机天气 App；不要谎称「搜索引擎坏了」或「网络搜索功能不可用」。'
  return `你是协助办公与软件开发的智能体。工作区根目录: ${root}。
- 在工具中使用**相对工作区根**的路径（如 src/index.ts），不要使用 ../ 尝试逃出工作区。
- 可调用工具: ${toolLine}，以及若干 skill_* 技能工具。${mcpNote}
- **优先使用 skill_***：当用户意图与某个 skill 工具的描述明显相关时，必须先调用该 skill 获取流程、约束或产出，再按需组合 read_file、list_dir、search_workspace、shell、mcp_* 等；不要跳过匹配的 skill 直接用通用工具猜测。
- shell 在沙盒目录（工作区根）下执行 shell 命令，等待进程结束后返回 stdout/stderr。Windows 为 cmd 风格。
- 当用户要求“查看/读取工作区文件”或“列出目录”时，优先调用 read_file/list_dir 再回答。
- 当用户明确要求删除工作区内的某个文件时，使用 delete_file（仅删普通文件，不删目录）。
- 按文件名/路径模式找文件时用 glob（如 **/*.ts）：结果包含工作区与「用户数据」目录（技能市场安装等）；read_file/write 等仍限工作区内路径。
${webRule}
- 回答简洁、可执行；修改代码前先 read/list。
- 先理解任务 → 必要时复述目标 → 再选工具。`
}

const commonPrompt = `
  当前日期时间（UTC）：${new Date().toLocaleString()}；
`

function buildAskSystemPrompt(root: string, settings: AppSettings): string {
  const web = isTavilyConfigured(settings.tavilyApiKey)
  const toolLine = web
    ? 'read_file, list_dir, glob, search_workspace, web_search（Tavily）'
    : 'read_file, list_dir, glob, search_workspace（未配置 Tavily 时无 web_search）'
  const webRule = web
    ? '- 需要站外最新信息时可调用 **web_search**；不得编造检索结果。'
    : '- 当前未配置 Tavily：若用户要实时资讯，请如实说明并建议在「设置」中配置 Tavily。'
  return `你是协助理解与讲解代码、架构与命令的助手（**Ask / 问答模式**）。工作区根目录: ${root}。
- **不得**修改工作区文件、删除文件、执行 shell、调用 skill_* 或任何 mcp_*；本模式下这些工具不可用。
- 仅可使用只读工具: ${toolLine}。路径均为相对工作区根。
- 用户若要求「直接改代码 / 运行命令 / 应用补丁」，请说明这在 Ask 模式下无法自动执行，并给出可复制片段或步骤；需要自动落地时请切换到 **Build**（关闭 Ask）。
${webRule}
- 回答清晰、可验证：需要引用仓库内容时先 read/list/search，再下结论。
- 先理解意图 → 必要时复述目标
`
}

const INTENT_SUMMARY_TIMEOUT_MS = 18_000
const INTENT_SUMMARY_MAX_CHARS = 900

function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error && (e.name === 'AbortError' || e.message.toLowerCase().includes('abort'))
  )
}

/**
 * 在 ReAct / 主对话流之前做一次简短流式「意图思考」，供 UI 先展示再进入工具循环。
 */
async function streamIntentSummary(
  settings: AppSettings,
  userText: string,
  ac: AbortController,
  intentBatcher: StreamBatcher
): Promise<string> {
  const model = createLanguageModel(settings)
  const system = new SystemMessage(
    '你是「意图思考」助手。仅根据用户的**最新消息**（可含技术词汇），用中文写 2～5 个完整句子，依次说明：\n' +
      '（1）用户想达成的大致目标或问题类型；\n' +
      '（2）若需要查阅代码/文档或执行操作，你**打算如何推进**（只概述思路，不要列举具体工具名，不要输出 Markdown 标题或代码块）。\n' +
      '语气简洁、面向用户；不要复述本段系统说明。'
  )
  const human = new HumanMessage(userText.trim() ? userText.trim() : '（空消息）')
  const deadline = Date.now() + INTENT_SUMMARY_TIMEOUT_MS
  let acc = ''
  try {
    const stream = await model.stream([system, human], { signal: ac.signal })
    for await (const chunk of stream) {
      if (Date.now() > deadline) break
      const piece = contentToText((chunk as { content?: unknown }).content)
      if (!piece) continue
      acc += piece
      intentBatcher.push(piece)
      if (acc.length >= INTENT_SUMMARY_MAX_CHARS) break
    }
  } catch (e) {
    if (isAbortError(e)) throw e
    agentLog.warn('[streamIntentSummary] failed:', e instanceof Error ? e.message : e)
  }
  return acc.trim()
}

/**
 * invoke agent with guard
 *
 * @param agent - the agent to invoke
 * @param messages - the messages to invoke the agent with
 * @param ac - the abort controller
 * @param onToken - the callback to invoke when a token is received
 * @param options - the options for the agent invocation
 * @returns the result of the agent invocation
 */
async function invokeAgentWithGuard(
  agent: ReturnType<typeof createReactAgent>,
  messages: BaseMessage[],
  ac: AbortController,
  onToken: (token: string) => void,
  options: { recursionLimit: number; timeoutMs: number }
): Promise<unknown> {
  const { recursionLimit, timeoutMs } = options
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort()
      reject(new Error(`模型-工具循环超时（>${timeoutMs}ms），已中止本次运行`))
    }, timeoutMs)
  })
  try {
    agentLog.info(`[invokeAgentWithGuard] options: ${JSON.stringify(options, null, 2)}`)
    agentLog.info(`[invokeAgentWithGuard] messages: ${JSON.stringify(messages, null, 2)}`)

    const result = await Promise.race([
      agent.invoke(
        { messages },
        {
          signal: ac.signal,
          recursionLimit,
          callbacks: [
            {
              handleLLMNewToken(token: string) {
                onToken(token)
              }
            }
          ]
        }
      ),
      timeoutPromise
    ])
    let resultStr = inspect(result, {
      depth: 8,
      maxArrayLength: 50,
      colors: false,
      breakLength: 100
    })
    const maxLog = 100_000
    if (resultStr.length > maxLog) {
      resultStr = resultStr.slice(0, maxLog) + '\n...[invokeAgentWithGuard result truncated]'
    }
    agentLog.info(`[invokeAgentWithGuard] result:\n${resultStr}`)
    return result
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/**
 * 创建工具
 */
const ASK_MODE_TOOL_NAMES = new Set([
  'read_file',
  'list_dir',
  'glob',
  'search_workspace',
  'web_search'
])

/** 工具执行器上下文 */
type ToolExecutorContext = {
  runId: string
  traceId: string
  onTool: (e: ToolTimelineEvent) => void
}

/** 简化工具定义：只需描述和执行逻辑 */
type ToolDefinition<T extends z.ZodTypeAny> = {
  name: string
  description: string
  schema: T
  execute: (input: z.infer<T>, ctx: ToolExecutorContext) => Promise<unknown>
  formatResult?: (result: unknown) => string
  truncateTo?: number
}

/** 将 ToolDefinition 包装为带生命周期追踪的 NamedTool */
function defineTool<T extends z.ZodTypeAny>(
  def: ToolDefinition<T>,
  runCtx: ToolExecutorContext
): NamedTool {
  const { name, description, schema, execute, formatResult, truncateTo } = def

  return tool(
    async (input: z.infer<T>) => {
      const id = `${name}-${Date.now()}`
      const startedAt = Date.now()
      const args =
        typeof input === 'object' && input !== null
          ? Object.values(input).join(', ')
          : String(input)

      runCtx.onTool({
        kind: 'tool',
        id,
        name,
        status: 'start',
        args,
        runId: runCtx.runId,
        traceId: runCtx.traceId,
        timestampMs: startedAt
      })

      const result = await execute(input, runCtx)
      const resultStr = formatResult ? formatResult(result) : String(result)
      const truncated = truncateTo ? resultStr.slice(0, truncateTo) : resultStr

      runCtx.onTool({
        kind: 'tool',
        id,
        name,
        status: 'end',
        result: truncated,
        runId: runCtx.runId,
        traceId: runCtx.traceId,
        timestampMs: Date.now(),
        durationMs: Date.now() - startedAt
      })

      return result
    },
    { name, description, schema }
  ) as unknown as NamedTool
}

/** 工作区基础工具 + 可选联网；Ask / Build 智能体共用 */
function buildBaseAndWebTools(
  sessionId: string,
  root: string,
  settings: AppSettings,
  runCtx: ToolExecutorContext
): { baseTools: NamedTool[]; webSearchTools: NamedTool[] } {
  const termKey = `term:${sessionId}`

  const baseToolDefs: ToolDefinition<z.ZodTypeAny>[] = [
    {
      name: 'read_file',
      description: '读取工作区内 UTF-8 文本文件，path 为相对工作区',
      schema: z.object({ path: z.string() }),
      execute: ({ path }) => readFileTool(root, path),
      truncateTo: 1_000
    },
    {
      name: 'write_file',
      description: '写入或覆盖工作区文件，自动创建父目录',
      schema: z.object({ path: z.string(), content: z.string() }),
      execute: ({ path, content }) => writeFileTool(root, path, content)
    },
    {
      name: 'delete_file',
      description: '删除工作区内单个普通文件（path 相对工作区）；不能删除目录',
      schema: z.object({ path: z.string() }),
      execute: ({ path }) => deleteFileTool(root, path)
    },
    {
      name: 'list_dir',
      description: '列出目录，path 为相对或空为根，depth 1-3',
      schema: z.object({
        path: z.string().optional(),
        depth: z.number().int().min(1).max(3).optional()
      }),
      execute: ({ path, depth }) => listDirTool(root, path || '.', { depth: depth ?? 2 }),
      truncateTo: 8_000
    },
    {
      name: 'search_workspace',
      description: '在文本类源码中按子串搜索，适合找符号',
      schema: z.object({ query: z.string() }),
      execute: ({ query }) => searchWorkspace(root, query, { maxFiles: 50 }),
      truncateTo: 8_000
    },
    {
      name: 'glob',
      description:
        '在工作区根与 Electron 用户数据目录（userData）下按同一 pattern 做 glob，列出匹配的**文件**路径（仅文件）。返回分「工作区」「用户数据」两段，用户数据路径为相对 userData 根；pattern 使用 Node 风格如 **/*.ts、skills/**/*.md；两侧均排除 node_modules/.git/dist 及 Chromium 缓存等目录',
      schema: z.object({
        pattern: z.string(),
        max_results: z.number().int().min(1).max(500).optional()
      }),
      execute: ({ pattern, max_results }) =>
        globFilesTool(root, pattern, { maxFiles: max_results, userDataRoot: userDataPath() }),
      truncateTo: 12_000
    },
    {
      name: 'shell',
      description:
        '在工作区根目录执行一条 shell 命令并等待完成，返回合并的 stdout/stderr（长输出会被截断）。用于安装依赖、构建、测试、git 等。',
      schema: z.object({ command: z.string() }),
      execute: ({ command }) => runCommand(termKey, root, command, MAX_TERMINAL_OUTPUT_CHARS),
      truncateTo: 4_000
    }
  ]

  const baseTools = baseToolDefs.map((def) => defineTool(def, runCtx))

  const webSearchTools: NamedTool[] = isTavilyConfigured(settings.tavilyApiKey)
    ? [
        defineTool(
          {
            name: 'web_search',
            description:
              '使用 Tavily 检索互联网公开网页（天气、新闻、文档等）。search_workspace 只搜工作区代码；需要站外最新信息时必须调用本工具。',
            schema: z.object({
              query: z.string(),
              max_results: z.number().int().min(1).max(20).optional()
            }),
            execute: ({ query, max_results }) =>
              tavilyWebSearch(query, { maxResults: max_results, apiKey: settings.tavilyApiKey }),
            formatResult: (r) => (typeof r === 'string' ? r : String(r)),
            truncateTo: 12_000
          },
          runCtx
        )
      ]
    : []

  return { baseTools, webSearchTools }
}

/** 智能体工具集 */
type AgentTooling = {
  tools: NamedTool[]
  skillHint: string
  mcpContextHints: string
}

/** 智能体策略接口 */
interface AgentStrategy {
  readonly name: AgentComposerMode
  prepareTools(
    sessionId: string,
    root: string,
    settings: AppSettings,
    runCtx: ToolExecutorContext
  ): Promise<AgentTooling> | AgentTooling
  buildPrompt(root: string, settings: AppSettings, tooling: AgentTooling): string
}

/** Ask 智能体策略：仅只读工作区工具 + 可选 web_search；不加载 skill / MCP */
const askAgentStrategy: AgentStrategy = {
  name: 'ask',
  prepareTools(sessionId, root, settings, runCtx) {
    const { baseTools, webSearchTools } = buildBaseAndWebTools(sessionId, root, settings, runCtx)
    const tools = [...baseTools, ...webSearchTools].filter((t) => ASK_MODE_TOOL_NAMES.has(t.name))
    return { tools, skillHint: '', mcpContextHints: '' }
  },
  buildPrompt(root, settings) {
    return [buildAskSystemPrompt(root, settings), commonPrompt].filter(Boolean).join('\n\n')
  }
}

/** Build 智能体策略：完整工作区工具 + skill_* + MCP */
const buildAgentStrategy: AgentStrategy = {
  name: 'build',
  async prepareTools(sessionId, root, settings, runCtx) {
    const termKey = `term:${sessionId}`
    const { baseTools, webSearchTools } = buildBaseAndWebTools(sessionId, root, settings, runCtx)

    const [skillBundle, mcpResult] = await Promise.all([
      buildSkillBundle({ root, termKey, settings, runCtx, onTool: runCtx.onTool }),
      buildMcpLangChainTools(settings, runCtx, runCtx.onTool)
    ])

    const tools = [...skillBundle.tools, ...baseTools, ...webSearchTools, ...mcpResult.tools]
    return {
      tools,
      skillHint: skillBundle.hint,
      mcpContextHints: mcpResult.contextHints
    }
  },
  buildPrompt(root, settings, tooling) {
    return [
      buildSystemPrompt(root, settings),
      tooling.skillHint,
      tooling.mcpContextHints,
      commonPrompt
    ]
      .filter(Boolean)
      .join('\n\n')
  }
}

/** 策略注册表 */
const agentStrategies: Record<AgentComposerMode, AgentStrategy> = {
  ask: askAgentStrategy,
  build: buildAgentStrategy
}

/** 获取智能体策略 */
function getAgentStrategy(mode: AgentComposerMode): AgentStrategy {
  const strategy = agentStrategies[mode]
  if (!strategy) {
    throw new Error(`Unknown agent mode: ${mode}`)
  }
  return strategy
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}

export function bindAgentIpc(wc: WebContents): void {
  webContents = wc
}

export function initSessionState(workspaceId: string, sessionId: string): void {
  if (!sessions.has(sessionId)) {
    const persisted = getSessionMessages(workspaceId, sessionId)
    sessions.set(sessionId, {
      workspaceId,
      messages: fromPersistedMessages(persisted),
      controller: null,
      terminalKey: `term:${sessionId}`
    })
  }
}

export function getSessionCoreMessages(sessionId: string): BaseMessage[] {
  return sessions.get(sessionId)?.messages ?? []
}

export function clearSessionState(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (s?.controller) {
    s.controller.abort()
  }
  void killCommand(s?.terminalKey ?? `term:${sessionId}`)
  sessions.delete(sessionId)
}

export function cancelRun(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (s?.controller) {
    s.controller.abort()
  }
  void killCommand(`term:${sessionId}`)
}

export async function runUserMessage(
  sessionId: string,
  userText: string,
  onQueued: (pos: number) => void,
  options?: { mode?: AgentComposerMode }
): Promise<void> {
  const composerMode: AgentComposerMode = options?.mode === 'ask' ? 'ask' : 'build'
  const settings = getSettings()
  agentLog.info(`settings: ${JSON.stringify(settings, null, 2)}, composerMode: ${composerMode}`)

  const existingSession = sessions.get(sessionId)
  if (!existingSession) {
    emit({ type: 'error', sessionId, message: '会话不存在或已失效' })
    return
  }
  const workspace = getWorkspaceById(existingSession.workspaceId)
  agentLog.info(`[runUserMessage] workspace: ${workspace?.path}`)

  const root = workspace?.path?.trim() || ''
  if (!root) {
    emit({ type: 'error', sessionId, message: '当前会话所属工作区未绑定目录，请先绑定路径' })
    return
  }
  const queue = getQueue()
  if (queue.willBlock()) {
    onQueued(queue.waiting + 1)
  }
  await queue.run(async () => {
    onQueued(0) // 0 = 已获执行权（不展示排队条）
    const session = sessions.get(sessionId)
    if (!session) {
      agentLog.error(`[runUserMessage] session not found for sessionId: ${sessionId}`)
      emit({ type: 'error', sessionId, message: '会话不存在或已失效' })
      return
    }
    const ac = new AbortController()
    const runId = makeRunId()
    const traceId = makeTraceId(sessionId, runId)
    const runStartedAt = Date.now()
    session.controller = ac

    agentLog.info(
      `[runUserMessage] run-start: ${runId}, traceId: ${traceId}, sessionId: ${sessionId}, timestampMs: ${runStartedAt}`
    )
    emit({ type: 'run-start', sessionId, runId, traceId, timestampMs: runStartedAt })

    const onTool = (e: ToolTimelineEvent) => {
      emit({
        type: 'tool',
        sessionId,
        runId,
        traceId,
        event: {
          ...e,
          runId: e.runId ?? runId,
          traceId: e.traceId ?? traceId,
          timestampMs: e.timestampMs ?? Date.now()
        }
      })
    }
    const recursionLimit = settings.maxAgentLoopSteps
    const invokeTimeoutMs = settings.agentRunTimeoutMs
    session.messages.push(new HumanMessage(userText))
    persistSessionMessages(session.workspaceId, sessionId, session.messages)

    const intentBatcher = new StreamBatcher(STREAM_FLUSH_MS, STREAM_FLUSH_CHARS, (t) => {
      emit({ type: 'intent-delta', sessionId, text: t, runId, traceId })
    })
    let intentThinking = ''
    try {
      intentThinking = await streamIntentSummary(settings, userText, ac, intentBatcher)
    } catch (e) {
      intentBatcher.flush()
      emit({ type: 'intent-end', sessionId, runId, traceId })
      throw e
    }
    intentBatcher.flush()
    emit({ type: 'intent-end', sessionId, runId, traceId })

    const batcher = new StreamBatcher(STREAM_FLUSH_MS, STREAM_FLUSH_CHARS, (t) => {
      emit({ type: 'text-delta', sessionId, text: t, runId, traceId })
    })

    try {
      let streamedChars = 0

      // 获取对应策略并执行
      const strategy = getAgentStrategy(composerMode)
      const tooling = await strategy.prepareTools(sessionId, root, settings, {
        runId,
        traceId,
        onTool
      })
      const { tools } = tooling

      const model = createLanguageModel(settings).bindTools(tools as never[])
      const runPrompt = strategy.buildPrompt(root, settings, tooling)

      agentLog.info(
        `[runUserMessage] agent=${strategy.name} runPrompt: ${JSON.stringify(runPrompt, null, 2)}`
      )

      const agent = createReactAgent({
        llm: model,
        tools: tools as never[],
        prompt: runPrompt
      })

      const onStreamToken = (token: string) => {
        streamedChars += token.length
        batcher.push(token)
      }
      const agentInvokeOpts = { recursionLimit, timeoutMs: invokeTimeoutMs }

      const result = await invokeAgentWithGuard(
        agent,
        session.messages,
        ac,
        onStreamToken,
        agentInvokeOpts
      )
      const maybeMessages = (result as { messages?: BaseMessage[] }).messages
      if (Array.isArray(maybeMessages) && maybeMessages.length > 0) {
        session.messages = maybeMessages
      }

      if (streamedChars === 0) {
        const lastAi = [...session.messages]
          .reverse()
          .find((msg) => getBaseMessageType(msg) === 'ai') as AIMessage | undefined
        const fallback = lastAi ? contentToText(lastAi.content) : ''
        if (fallback) {
          batcher.push(fallback)
        }
      }
      batcher.flush()
      persistSessionMessages(session.workspaceId, sessionId, session.messages, {
        intentThinkingForLastAssistant: intentThinking
      })
      emit({
        type: 'done',
        sessionId,
        runId,
        traceId,
        timestampMs: Date.now(),
        durationMs: Date.now() - runStartedAt
      })
    } catch (e) {
      batcher.flush()
      const message = e instanceof Error ? e.message : String(e)
      emit({
        type: 'error',
        sessionId,
        message,
        runId,
        traceId,
        timestampMs: Date.now(),
        durationMs: Date.now() - runStartedAt
      })
      onTool({
        kind: 'error',
        message,
        runId,
        traceId,
        timestampMs: Date.now(),
        durationMs: Date.now() - runStartedAt
      })
      persistSessionMessages(session.workspaceId, sessionId, session.messages, {
        intentThinkingForLastAssistant: intentThinking
      })
    } finally {
      session.controller = null
      batcher.flush()
    }
  })
}
