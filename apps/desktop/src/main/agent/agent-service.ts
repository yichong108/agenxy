import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { ChatOpenAI } from '@langchain/openai'
import type { CallbackHandler } from '@langfuse/langchain'
import type { WebContents } from 'electron'
import { z } from 'zod'

import { StreamBatcher } from '@/main/agent/batcher'
import {
  AGENXY_INTERNAL_KW,
  agentCheckpointer,
  buildRejectionStateMessages,
  extractPendingToolCalls,
  formatToolArgs,
  HITL_EXEMPT_TOOL_NAMES,
  isPausedBeforeTools,
  partitionPendingToolCalls,
  isRejectedToolResult,
  makeHitlId,
  submitHitlDecision,
  cancelAllHitlWaiters,
  TOOL_REJECTED_RESULT,
  waitForHitlDecision,
  type PendingToolCall,
  type HitlUserDecision
} from '@/main/agent/hitl'
import { classifyIntent, type UserIntent } from '@/main/agent/intent-classifier'
import { ConcurrencyQueue } from '@/main/agent/queue'
import { buildSkillBundle } from '@/main/agent/skills/index'
import { createLangfuseCallbackHandler, flushLangfuseTracing } from '@/main/langfuse'
import { logScope } from '@/main/logger'
import { buildMcpLangChainTools } from '@/main/mcp/mcp-runtime'
import { extractMemoriesAfterRun } from '@/main/memory/memory-extractor'
import { isReservedMemoryFilePath, MEMORY_FILE_GUARD_MESSAGE } from '@/main/memory/memory-path-guard'
import { buildMemoryPromptBlock } from '@/main/memory/memory-service'
import {
  userMemoryAdd,
  userMemoryDelete,
  userMemoryList,
  userMemoryUpdate
} from '@/main/memory/memory-tools'
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
import { GREP_TOOL_DESCRIPTION, grepWorkspace } from '@/main/tools/grep'
import { runCommand, killCommand } from '@/main/tools/terminal'
import { isTavilyConfigured, tavilyWebSearch } from '@/main/tools/web-search'
import {
  EVENTS,
  normalizeComposerMode,
  type AgentComposerMode,
  type AgentSendOptions,
  type AppSettings,
  type ChatMessage,
  type ModelProviderId,
  type StreamEvent,
  type ToolCallEvent,
  type ToolTimelineEvent,
  getActiveProviderProfile,
  MAX_CONCURRENT_AGENT_STREAMS,
  MAX_TERMINAL_OUTPUT_CHARS,
  STREAM_FLUSH_CHARS,
  STREAM_FLUSH_MS
} from '@/shared/ipc'

export const agentLog = logScope('agent')

type SessionRuntime = {
  workspaceId: string
  /** System prompt is not included; it's appended at each request */
  messages: BaseMessage[]
  controller: AbortController | null
  /** Consistent with terminal key for the session */
  terminalKey: string
  /** Active LangGraph HITL wait (tool approval before tools node) */
  pendingHitl?: {
    hitlId: string
    toolCalls: PendingToolCall[]
  }
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

function isInternalGraphMessage(msg: BaseMessage): boolean {
  const kw = (msg as { additional_kwargs?: Record<string, unknown> }).additional_kwargs
  return kw?.[AGENXY_INTERNAL_KW] === true
}

function toPersistedMessages(coreMessages: BaseMessage[]): ChatMessage[] {
  const visible: BaseMessage[] = []
  for (const msg of coreMessages) {
    const messageType = getBaseMessageType(msg)
    if (messageType === 'system' || isInternalGraphMessage(msg)) continue
    visible.push(msg)
  }

  let lastAiIndex = -1
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    if (getBaseMessageType(visible[i]) === 'ai') {
      lastAiIndex = i
      break
    }
  }

  const out: ChatMessage[] = []
  for (let i = 0; i < visible.length; i += 1) {
    const msg = visible[i]!
    const messageType = getBaseMessageType(msg)
    if (messageType === 'human') {
      const kw = (msg as { additional_kwargs?: Record<string, unknown> }).additional_kwargs
      const display =
        typeof kw?.[AGENXY_USER_DISPLAY_KW] === 'string'
          ? (kw[AGENXY_USER_DISPLAY_KW] as string)
          : contentToText(msg.content)
      out.push({
        id: `u-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'user',
        content: display
      })
      continue
    }
    if (messageType === 'ai') {
      if (i !== lastAiIndex) continue
      const content = contentToText(msg.content)
      if (!content.trim()) continue
      out.push({
        id: `a-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'assistant',
        content
      })
    }
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
  opts?: {
    intentThinkingForLastAssistant?: string
    toolEventsForLastAssistant?: ToolTimelineEvent[]
  }
): void {
  const list = toPersistedMessages(coreMessages)
  const intent = opts?.intentThinkingForLastAssistant?.trim()
  const toolEvents = opts?.toolEventsForLastAssistant
  if (intent || (toolEvents && toolEvents.length > 0)) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const row = list[i]
      if (row?.role === 'assistant') {
        list[i] = {
          ...row,
          ...(intent ? { intentThinking: intent } : {}),
          ...(toolEvents && toolEvents.length > 0 ? { toolEvents } : {})
        }
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

function openAiBaseUrlForProvider(_provider: ModelProviderId, rawBaseUrl: string): string {
  const deepseekDefault = 'https://api.deepseek.com/v1'
  return ensureOpenAiV1BaseUrl(rawBaseUrl, deepseekDefault)
}

function createLanguageModel(settings: AppSettings) {
  const profile = getActiveProviderProfile(settings)
  if (!profile.apiKey?.trim()) {
    throw new Error('请先在设置中配置 API Key')
  }
  const apiKey = profile.apiKey.trim()
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
    '\n- **MCP 管理（元工具）**：`mcp_list_servers` 列出已配置的 MCP（环境变量已脱敏）；`mcp_inspect_server` 探测指定 MCP 暴露的工具。需要连接信息或工具名时优先使用；不要向用户索要应用中已保存的密码。'
  const mcpNote =
    mcpEnabled.length > 0
      ? `${mcpMeta}\n- 已启用的 MCP（stdio）服务：${mcpEnabled.map((s) => s.name || s.id).join(', ')}。以 mcp_ 开头的工具来自各 MCP；调用时传入 JSON，键名需符合该工具的 inputSchema。`
      : (settings.mcpServers?.length ?? 0) > 0
        ? `${mcpMeta}\n- 当前 MCP 条目未启用或 command 为空；用户启用后才会出现 mcp_* 工具。`
        : mcpMeta
  const memoryTools =
    settings.memoryEnabled !== false
      ? '、user_memory_list、user_memory_add、user_memory_update、user_memory_delete'
      : ''
  const toolLine = web
    ? `read_file、write_file、delete_file、list_dir、glob、grep、search_workspace、shell、web_search（Tavily 联网搜索）、mcp_list_servers、mcp_inspect_server${memoryTools}`
    : `read_file、write_file、delete_file、list_dir、glob、grep、search_workspace、shell、mcp_list_servers、mcp_inspect_server（未配置 Tavily API Key 时无 web_search）${memoryTools}`
  const webRule = web
    ? '- 用户询问**天气、气温、降雨、实时新闻、股价、政策**等需要外部信息时，必须先调用 **web_search** 再回答；不要编造天气或声称「搜索失败」。\n- 若用户**拒绝**某次工具调用（结果含已拒绝/未执行），**本轮不得再次调用该工具**；用中文简要说明并给出替代方案（如请用户提供城市/地区，或说明可在设置中调整审批）。'
    : '- 未配置 Tavily，**web_search 不可用**：若用户需要今日天气等实时信息，明确告知在应用设置中填写「Tavily API Key」或配置环境变量 TAVILY_API_KEY；可建议天气网站/App；不要声称「搜索引擎坏了」或「无法联网」。'
  return `你是协助办公与软件开发的智能体。工作区根目录：${root}。
- 工具中使用**相对于工作区根目录**的路径（如 src/index.ts）；不要用 ../ 逃出工作区。
- 可用工具：${toolLine}，以及各类 skill_* 工具。${mcpNote}
- **优先 skill_***：用户意图明显匹配某 skill 工具描述时，必须先调用该 skill 获取流程/约束/输出，再按需使用 read_file、list_dir、grep、search_workspace、shell、mcp_*；不要跳过匹配的技能而用泛化工具猜测。
- shell 在工作区根目录沙箱中执行命令并等待结束，返回 stdout/stderr；Windows 使用 cmd 风格。
- 用户要「查看/读取工作区文件」或「列目录」时，优先 read_file/list_dir 再回答。
- 用户明确要求删除工作区中的文件时，使用 delete_file（仅普通文件，不含目录）。
- 用 glob 按文件名/路径模式搜索（如 **/*.ts）：结果含工作区与「用户数据」目录（技能市场安装等）；read_file/write 仍仅限工作区路径。
${webRule}
- **用户长期记忆**保存在应用内（设置 → 用户记忆），不在工作区文件中。用户分享持久偏好或要求记住/忘记时，使用 **user_memory_add** / **user_memory_update** / **user_memory_delete**（或依赖回合结束后的自动提取）。**禁止**在工作区创建或编辑 \`.claude-memory.json\`、\`.cursor-memory.json\` 等临时记忆 JSON。
- 回复简洁可执行；改代码前先 read/list。
- 先理解任务 → 必要时复述目标 → 再选工具。`
}

const commonPrompt = `
  当前日期时间（UTC）：${new Date().toLocaleString()}；
`

/** 持久化用户消息时优先使用该展示文案（Plan 执行等场景） */
export const AGENXY_USER_DISPLAY_KW = 'agenxy_user_display'

function buildAgentMessageWithPlan(userText: string, planContext: string): string {
  const userPart = userText.trim() || '（用户未附加说明，请严格按计划步骤实施。）'
  return [
    '用户已确认以下 **计划模式** 中的计划，并切换到 **构建模式** 实施。',
    '除非用户消息明确修订、缩小或重排范围，否则按计划执行。',
    '',
    '--- 计划 ---',
    planContext.trim(),
    '--- 计划结束 ---',
    '',
    '用户消息：',
    userPart
  ].join('\n')
}

function buildAskSystemPrompt(root: string, settings: AppSettings): string {
  const web = isTavilyConfigured(settings.tavilyApiKey)
  const memoryTools =
    settings.memoryEnabled !== false ? '、user_memory_list（仅读取全局用户记忆）' : ''
  const toolLine = web
    ? `read_file、list_dir、glob、grep、search_workspace、web_search（Tavily）${memoryTools}`
    : `read_file、list_dir、glob、grep、search_workspace（未配置 Tavily 时无 web_search）${memoryTools}`
  const webRule = web
    ? '- 需要外部信息时调用 **web_search**；不要编造搜索结果。'
    : '- 未配置 Tavily：若用户需要实时信息，如实说明并建议在设置中配置 Tavily。'
  return `你是帮助理解代码、架构与命令的助手（**问答模式**）。工作区根目录：${root}。
- **禁止**修改工作区文件、删除文件、执行 shell、调用 skill_* 或 mcp_*；本模式下这些工具不可用。
- 仅只读工具：${toolLine}。路径均相对于工作区根目录。
- 若用户要求「直接改代码 / 跑命令 / 打补丁」，说明问答模式不能自动执行，给出可复制片段或步骤；要自动应用请切换到 **构建模式**。
${webRule}
- 用户偏好保存在应用全局记忆（启用时可用 user_memory_list），不在工作区 JSON。不要建议写入 \`.claude-memory.json\` 等文件。
- 回复清晰可验证：下结论前先 read/list/search 仓库内容。
- 先理解意图 → 必要时复述目标
`
}

function buildPlanSystemPrompt(root: string, settings: AppSettings): string {
  const web = isTavilyConfigured(settings.tavilyApiKey)
  const toolLine = web
    ? 'read_file、list_dir、glob、grep、search_workspace、web_search（Tavily）'
    : 'read_file、list_dir、glob、grep、search_workspace（未配置 Tavily 时无 web_search）'
  const webRule = web
    ? '- 需要外部文档或 API 时调用 **web_search**；不要编造搜索结果。'
    : '- 未配置 Tavily：在需要实时网页数据时注明。'
  return `你是本工作区（${root}）的 **计划模式** 架构师。只读探索并输出供 UI 展示的 **清单式计划** —— 尚未执行任何修改。
- **禁止**改文件、删文件、跑 shell、调用 skill_* / mcp_*；仅只读工具：${toolLine}。
- **禁止**声称已改代码或已执行命令；不要让用户点击「执行」或自动运行。
- 充分探索（read/list/search），使步骤基于真实路径与符号。

**最终 Markdown 必须采用以下 ## 标题**：

## 目标
用一小段话复述用户需求。

## 计划
- [ ] 第一条可执行步骤 —— 已知时写明文件路径
- [ ] 第二条步骤
（每个实施步骤一行 \`- [ ]\`；本区块渲染为清单）

## 风险与待确认
- 风险或待确认项（若无则省略整节）

规则：
- ## 计划 下每条实施步骤必须是 \`- [ ]\`（不用编号列表，不要纯段落）。
- 步骤标题简短；补充说明写在同行破折号后。
${webRule}`
}

const INTENT_SUMMARY_TIMEOUT_MS = 18_000
const INTENT_SUMMARY_MAX_CHARS = 900
const PLAN_STEP_TIMEOUT_MS = 14_000
const PLAN_STEP_MAX_CHARS = 480
const MAX_PLAN_STEPS_PER_RUN = 16

function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error && (e.name === 'AbortError' || e.message.toLowerCase().includes('abort'))
  )
}

/**
 * Short streaming "intent thinking" before ReAct/main dialogue loop,
 * displayed in UI before entering tool loop.
 */
async function streamIntentSummary(
  settings: AppSettings,
  userText: string,
  ac: AbortController,
  intentBatcher: StreamBatcher,
  langfuseHandler?: CallbackHandler | null
): Promise<string> {
  const model = createLanguageModel(settings)
  const system = new SystemMessage(
    '你是「意图思考」助手。仅根据用户**最新一条消息**（可含技术术语），用**中文**写 2–5 句完整话说明：\n' +
      '（1）用户的大致目标或问题类型；\n' +
      '（2）若需查阅代码/文档或执行操作，你**打算如何推进**（只写思路概要，不要列具体工具名，不要 Markdown 标题或代码块）。\n' +
      '语气简洁、面向用户；不要复述本系统说明。'
  )
  const human = new HumanMessage(userText.trim() ? userText.trim() : '（空消息）')
  const deadline = Date.now() + INTENT_SUMMARY_TIMEOUT_MS
  let acc = ''
  try {
    const stream = await model.stream([system, human], {
      signal: ac.signal,
      ...(langfuseHandler ? { callbacks: [langfuseHandler] } : {})
    })
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

type PlanAfterToolContext = {
  toolName: string
  args?: string
  result?: string
}

/**
 * After a tool returns, stream a short "next step" plan (Cursor-style) before the ReAct loop continues.
 */
async function streamPlanAfterTool(
  settings: AppSettings,
  userText: string,
  ctx: PlanAfterToolContext,
  ac: AbortController,
  planBatcher: StreamBatcher,
  langfuseHandler?: CallbackHandler | null
): Promise<string> {
  const model = createLanguageModel(settings)
  const system = new SystemMessage(
    '你是「下一步计划」助手。编码智能体刚完成一次工具调用，将继续处理同一用户任务。\n' +
      '根据用户目标与工具输出，用**中文**写 1–3 句简短完整话描述**接下来**要做什么（仅高层概要；不要写具体工具函数名；不要 Markdown 标题或代码块）。\n' +
      '若输出为空、失败或异常，简要说明如何补救。语气简洁、面向用户。'
  )
  const human = new HumanMessage(
    [
      `用户消息：\n${userText.trim() || '（空消息）'}`,
      `已完成工具：${ctx.toolName}`,
      ctx.args ? `参数：${ctx.args}` : '',
      ctx.result ? `输出（已截断）：\n${ctx.result.slice(0, 700)}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
  )
  const deadline = Date.now() + PLAN_STEP_TIMEOUT_MS
  let acc = ''
  try {
    const stream = await model.stream([system, human], {
      signal: ac.signal,
      ...(langfuseHandler ? { callbacks: [langfuseHandler] } : {})
    })
    for await (const chunk of stream) {
      if (Date.now() > deadline) break
      const piece = contentToText((chunk as { content?: unknown }).content)
      if (!piece) continue
      acc += piece
      planBatcher.push(piece)
      if (acc.length >= PLAN_STEP_MAX_CHARS) break
    }
  } catch (e) {
    if (isAbortError(e)) throw e
    agentLog.warn('[streamPlanAfterTool] failed:', e instanceof Error ? e.message : e)
  }
  return acc.trim()
}

type ReactAgentRunContext = {
  sessionId: string
  runId: string
  traceId: string
  threadId: string
  hitlEnabled: boolean
  toolsByName: Map<string, NamedTool>
  onPendingHitl: (hitlId: string, toolCalls: PendingToolCall[]) => void
  emitHitlRequired: (hitlId: string, toolCalls: PendingToolCall[]) => void
  onToolsRejected?: (toolCalls: PendingToolCall[]) => void
}

async function executePendingToolCalls(
  pending: PendingToolCall[],
  toolsByName: Map<string, NamedTool>
): Promise<ToolMessage[]> {
  const out: ToolMessage[] = []
  for (const tc of pending) {
    const impl = toolsByName.get(tc.name)
    if (!impl) {
      out.push(
        new ToolMessage({
          content: `Tool not found: ${tc.name}`,
          tool_call_id: tc.id,
          name: tc.name,
          status: 'error'
        })
      )
      continue
    }
    try {
      const result = await impl.invoke(tc.args)
      const content = typeof result === 'string' ? result : JSON.stringify(result)
      out.push(
        new ToolMessage({
          content,
          tool_call_id: tc.id,
          name: tc.name
        })
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      out.push(
        new ToolMessage({
          content: message,
          tool_call_id: tc.id,
          name: tc.name,
          status: 'error'
        })
      )
    }
  }
  return out
}

/**
 * Run ReAct agent with timeout guard; optional LangGraph interruptBefore tools + Command.resume loop.
 */
async function runReactAgentWithGuard(
  agent: ReturnType<typeof createReactAgent>,
  messages: BaseMessage[],
  ac: AbortController,
  onToken: (token: string) => void,
  options: {
    recursionLimit: number
    timeoutMs: number
    langfuseHandler?: CallbackHandler | null
  },
  runCtx: ReactAgentRunContext
): Promise<BaseMessage[]> {
  const { recursionLimit, timeoutMs, langfuseHandler } = options
  const graphConfig = {
    configurable: { thread_id: runCtx.threadId },
    signal: ac.signal,
    recursionLimit,
    callbacks: [
      {
        handleLLMNewToken(token: string) {
          onToken(token)
        }
      },
      ...(langfuseHandler ? [langfuseHandler] : [])
    ]
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort()
      reject(new Error(`Model-tool loop timeout (>${timeoutMs}ms), run aborted`))
    }, timeoutMs)
  })

  let input: { messages: BaseMessage[] } | null = { messages }
  let hitlRound = 0
  const graphStateConfig = { configurable: { thread_id: runCtx.threadId } }

  try {
    agentLog.info(
      `[runReactAgentWithGuard] thread=${runCtx.threadId} hitl=${runCtx.hitlEnabled} recursionLimit=${recursionLimit}`
    )

    while (true) {
      const result = await Promise.race([agent.invoke(input, graphConfig), timeoutPromise])
      const state = await agent.getState(graphStateConfig)
      const stateMessages = (state.values?.messages ?? []) as BaseMessage[]

      if (!runCtx.hitlEnabled || !isPausedBeforeTools(state.next)) {
        if (stateMessages.length > 0) return stateMessages
        const fallback = (result as { messages?: BaseMessage[] })?.messages
        return Array.isArray(fallback) && fallback.length > 0 ? fallback : stateMessages
      }

      const pending = extractPendingToolCalls(stateMessages)
      if (pending.length === 0) {
        agentLog.warn('[runReactAgentWithGuard] interrupt before tools but no tool_calls in state')
        return stateMessages
      }

      const { approvalRequired, autoExecute } = partitionPendingToolCalls(pending)
      if (approvalRequired.length === 0) {
        agentLog.info(
          `[runReactAgentWithGuard] read-only tools only (${autoExecute.map((t) => t.name).join(', ')}), skip HITL`
        )
        input = null
        continue
      }

      const hitlId = makeHitlId(runCtx.runId, hitlRound++)
      runCtx.onPendingHitl(hitlId, approvalRequired)
      runCtx.emitHitlRequired(hitlId, approvalRequired)

      const decision = await waitForHitlDecision(hitlId, ac.signal)
      agentLog.info(`[runReactAgentWithGuard] hitl decision=${decision} hitlId=${hitlId}`)

      if (decision === 'reject') {
        const autoResults =
          autoExecute.length > 0
            ? await executePendingToolCalls(autoExecute, runCtx.toolsByName)
            : []
        await agent.updateState(graphStateConfig, {
          messages: [...autoResults, ...buildRejectionStateMessages(approvalRequired)]
        })
        runCtx.onToolsRejected?.(approvalRequired)
      }

      // Approve: null continues into tools node. Reject: null after synthetic tool results above.
      input = null
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Create tools
 */
/** Tool executor context */
type ToolExecutorContext = {
  runId: string
  traceId: string
  onTool: (e: ToolTimelineEvent) => void
}

/** Simplified tool definition: just need description and execution logic */
type ToolDefinition<T extends z.ZodTypeAny> = {
  name: string
  description: string
  schema: T
  execute: (input: z.infer<T>, ctx: ToolExecutorContext) => Promise<unknown>
  formatResult?: (result: unknown) => string
  truncateTo?: number
}

/** Wrap ToolDefinition with lifecycle tracking as NamedTool */
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

function buildUserMemoryToolDefs(
  sessionId: string,
  settings: AppSettings,
  allowWrite: boolean
): ToolDefinition<z.ZodTypeAny>[] {
  if (settings.memoryEnabled === false) return []
  const defs: ToolDefinition<z.ZodTypeAny>[] = [
    {
      name: 'user_memory_list',
      description: '列出应用内保存的全局用户长期记忆（跨工作区），不在工作区文件中。',
      schema: z.object({}),
      execute: async () => userMemoryList(),
      truncateTo: 4_000
    }
  ]
  if (!allowWrite) return defs
  defs.push(
    {
      name: 'user_memory_add',
      description:
        '将用户偏好或事实写入应用全局记忆。用户要求记住时使用；不要在工作区写 .claude-memory.json。',
      schema: z.object({ content: z.string() }),
      execute: async ({ content }) => userMemoryAdd(content, sessionId)
    },
    {
      name: 'user_memory_update',
      description: '按 id（来自 user_memory_list）更新已有全局记忆。',
      schema: z.object({ id: z.string(), content: z.string() }),
      execute: async ({ id, content }) => userMemoryUpdate(id, content)
    },
    {
      name: 'user_memory_delete',
      description: '用户要求忘记时，按 id 删除全局记忆。',
      schema: z.object({ id: z.string() }),
      execute: async ({ id }) => userMemoryDelete(id)
    }
  )
  return defs
}

/** Workspace base tools + optional web search; shared by Ask/Build agents */
function buildBaseAndWebTools(
  sessionId: string,
  root: string,
  settings: AppSettings,
  runCtx: ToolExecutorContext,
  opts?: { memoryWrite?: boolean }
): { baseTools: NamedTool[]; webSearchTools: NamedTool[] } {
  const termKey = `term:${sessionId}`

  const baseToolDefs: ToolDefinition<z.ZodTypeAny>[] = [
    {
      name: 'read_file',
      description: '读取工作区内 UTF-8 文本文件，路径相对于工作区根目录',
      schema: z.object({ path: z.string() }),
      execute: ({ path }) => readFileTool(root, path),
      truncateTo: 1_000
    },
    {
      name: 'write_file',
      description: '写入或覆盖工作区文件，自动创建父目录',
      schema: z.object({ path: z.string(), content: z.string() }),
      execute: ({ path, content }) =>
        isReservedMemoryFilePath(path)
          ? Promise.resolve(`已拒绝：${MEMORY_FILE_GUARD_MESSAGE}`)
          : writeFileTool(root, path, content)
    },
    {
      name: 'delete_file',
      description: '删除工作区内单个普通文件（相对路径）；不能删除目录',
      schema: z.object({ path: z.string() }),
      execute: ({ path }) => deleteFileTool(root, path)
    },
    {
      name: 'list_dir',
      description: '列出目录，路径相对或空表示根目录，深度 1–3',
      schema: z.object({
        path: z.string().optional(),
        depth: z.number().int().min(1).max(3).optional()
      }),
      execute: ({ path, depth }) => listDirTool(root, path || '.', { depth: depth ?? 2 }),
      truncateTo: 8_000
    },
    {
      name: 'grep',
      description: GREP_TOOL_DESCRIPTION,
      schema: z
        .object({
          pattern: z.string(),
          path: z.string().optional(),
          glob: z.string().optional(),
          type: z.string().optional(),
          output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
          multiline: z.boolean().optional(),
          head_limit: z.number().int().min(1).max(2000).optional()
        })
        .extend({
          '-i': z.boolean().optional(),
          '-A': z.number().int().min(0).max(10).optional(),
          '-B': z.number().int().min(0).max(10).optional(),
          '-C': z.number().int().min(0).max(10).optional()
        }),
      execute: (args) => grepWorkspace(root, args),
      truncateTo: 12_000
    },
    {
      name: 'search_workspace',
      description: '在文本文件中做简单子串搜索（无正则）。需要正则、glob 或匹配上下文时用 grep。',
      schema: z.object({ query: z.string() }),
      execute: ({ query }) => searchWorkspace(root, query, { maxFiles: 50 }),
      truncateTo: 8_000
    },
    {
      name: 'glob',
      description:
        '按模式在工作区根目录与 Electron userData 下 glob 匹配文件。仅返回文件路径（不含目录），分「工作区」与「用户数据」两段；用户数据路径相对 userData 根。模式为 Node 风格如 **/*.ts；两侧均排除 node_modules/.git/dist 及 Chromium 缓存目录',
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
        '在工作区根目录执行 shell 命令并等待结束，返回合并的 stdout/stderr（过长会截断）。用于安装依赖、构建、测试、git 等。',
      schema: z.object({ command: z.string() }),
      execute: ({ command }) => runCommand(termKey, root, command, MAX_TERMINAL_OUTPUT_CHARS),
      truncateTo: 4_000
    }
  ]

  const memoryToolDefs = buildUserMemoryToolDefs(sessionId, settings, opts?.memoryWrite !== false)
  const baseTools = [...baseToolDefs, ...memoryToolDefs].map((def) => defineTool(def, runCtx))

  const webSearchTools: NamedTool[] = isTavilyConfigured(settings.tavilyApiKey)
    ? [
        defineTool(
          {
            name: 'web_search',
            description:
              '用 Tavily 搜索公开网页（天气、新闻、文档等）。search_workspace 只搜工作区代码；需要外部信息时调用本工具。',
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

/** Agent tooling set */
type AgentTooling = {
  tools: NamedTool[]
  skillHint: string
  mcpContextHints: string
}

type PrepareAgentToolingOptions = {
  /** Build mode: filter skills by intent (empty = load all) */
  filterIntents?: UserIntent[]
}

/** Assemble tools/skills/MCP for the composer mode (single ReAct agent, mode selects capabilities). */
async function prepareAgentTooling(
  mode: AgentComposerMode,
  sessionId: string,
  root: string,
  settings: AppSettings,
  runCtx: ToolExecutorContext,
  options?: PrepareAgentToolingOptions
): Promise<AgentTooling> {
  const memoryWrite = mode === 'build'
  const { baseTools, webSearchTools } = buildBaseAndWebTools(sessionId, root, settings, runCtx, {
    memoryWrite
  })

  if (mode === 'ask' || mode === 'plan') {
    const tools = [...baseTools, ...webSearchTools].filter((t) =>
      HITL_EXEMPT_TOOL_NAMES.has(t.name)
    )
    return { tools, skillHint: '', mcpContextHints: '' }
  }

  const termKey = `term:${sessionId}`
  const filterIntents = options?.filterIntents
  const [skillBundle, mcpResult] = await Promise.all([
    buildSkillBundle(
      { root, termKey, settings, runCtx, onTool: runCtx.onTool },
      filterIntents !== undefined ? { filterIntents } : undefined
    ),
    buildMcpLangChainTools(settings, runCtx, runCtx.onTool)
  ])
  const tools = [...skillBundle.tools, ...baseTools, ...webSearchTools, ...mcpResult.tools]
  return {
    tools,
    skillHint: skillBundle.hint,
    mcpContextHints: mcpResult.contextHints
  }
}

function buildAgentRunPrompt(
  mode: AgentComposerMode,
  root: string,
  settings: AppSettings,
  tooling: AgentTooling
): string {
  const memoryBlock = buildMemoryPromptBlock(settings)
  if (mode === 'ask') {
    return [buildAskSystemPrompt(root, settings), memoryBlock, commonPrompt]
      .filter(Boolean)
      .join('\n\n')
  }
  if (mode === 'plan') {
    return [buildPlanSystemPrompt(root, settings), memoryBlock, commonPrompt]
      .filter(Boolean)
      .join('\n\n')
  }
  return [
    buildSystemPrompt(root, settings),
    tooling.skillHint,
    tooling.mcpContextHints,
    memoryBlock,
    commonPrompt
  ]
    .filter(Boolean)
    .join('\n\n')
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
  if (s) {
    s.pendingHitl = undefined
  }
  cancelAllHitlWaiters('运行已取消')
  void killCommand(`term:${sessionId}`)
}

export function resumeAgentHitl(
  sessionId: string,
  hitlId: string,
  decision: HitlUserDecision
): { ok: true } | { ok: false; error: string } {
  const s = sessions.get(sessionId)
  if (!s?.pendingHitl || s.pendingHitl.hitlId !== hitlId) {
    return { ok: false, error: '当前会话没有待审批的工具调用' }
  }
  s.pendingHitl = undefined
  const submitted = submitHitlDecision(hitlId, decision)
  if (!submitted) {
    return { ok: false, error: '审批请求已过期或已处理' }
  }
  return { ok: true }
}

export async function runUserMessage(
  sessionId: string,
  userText: string,
  onQueued: (pos: number) => void,
  options?: AgentSendOptions
): Promise<void> {
  const composerMode = normalizeComposerMode(options?.mode)
  const planContext = options?.planContext?.trim()
  const userDisplayText =
    options?.userDisplayText?.trim() ||
    userText.trim() ||
    (planContext ? '执行计划' : '')
  const agentUserText = planContext
    ? buildAgentMessageWithPlan(userText, planContext)
    : userText.trim()
  if (!agentUserText) {
    emit({ type: 'error', sessionId, message: '消息为空' })
    return
  }
  const settings = getSettings()
  agentLog.info(`settings: ${JSON.stringify(settings, null, 2)}, composerMode: ${composerMode}`)

  const existingSession = sessions.get(sessionId)
  if (!existingSession) {
    emit({ type: 'error', sessionId, message: '会话不存在或已过期' })
    return
  }
  const workspace = getWorkspaceById(existingSession.workspaceId)
  agentLog.info(`[runUserMessage] workspace: ${workspace?.path}`)

  const root = workspace?.path?.trim() || ''
  if (!root) {
    emit({
      type: 'error',
      sessionId,
      message: '当前会话未绑定工作区目录，请先绑定路径'
    })
    return
  }
  const queue = getQueue()
  if (queue.willBlock()) {
    onQueued(queue.waiting + 1)
  }
  await queue.run(async () => {
    onQueued(0) // 0 = obtained execution right (no queue bar displayed)
    const session = sessions.get(sessionId)
    if (!session) {
      agentLog.error(`[runUserMessage] session not found for sessionId: ${sessionId}`)
      emit({ type: 'error', sessionId, message: '会话不存在或已过期' })
      return
    }
    const ac = new AbortController()
    const runId = makeRunId()
    const traceId = makeTraceId(sessionId, runId)
    const runStartedAt = Date.now()
    session.controller = ac

    const langfuseHandler = createLangfuseCallbackHandler({
      sessionId,
      tags: ['agenxy', composerMode],
      traceMetadata: {
        run_id: runId,
        trace_id: traceId,
        workspace_id: session.workspaceId
      }
    })
    agentLog.info(`[runUserMessage] langfuseHandler: ${langfuseHandler ? '已创建' : '未创建'}`)

    agentLog.info(
      `[runUserMessage] run-start: ${runId}, traceId: ${traceId}, sessionId: ${sessionId}, timestampMs: ${runStartedAt}`
    )
    emit({ type: 'run-start', sessionId, runId, traceId, timestampMs: runStartedAt })

    const runToolEvents: ToolTimelineEvent[] = []
    let planStepsThisRun = 0
    let planChain: Promise<void> = Promise.resolve()

    const emitTool = (e: ToolTimelineEvent) => {
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

    type ToolEndedCall = ToolCallEvent & { status: 'end' }

    const schedulePlanAfterTool = (ended: ToolEndedCall) => {
      if (ac.signal.aborted) return
      if (composerMode === 'plan') return
      if (planStepsThisRun >= MAX_PLAN_STEPS_PER_RUN) return
      planStepsThisRun += 1
      const stepId = `plan-${ended.id}`
      const startedAt = Date.now()

      planChain = planChain
        .then(async () => {
          if (ac.signal.aborted) return
          emit({
            type: 'plan-step-start',
            sessionId,
            runId,
            traceId,
            stepId,
            afterToolId: ended.id,
            toolName: ended.name
          })

          const planRecord = {
            kind: 'plan' as const,
            id: stepId,
            afterToolId: ended.id,
            toolName: ended.name,
            status: 'streaming' as const,
            text: '',
            runId,
            traceId,
            timestampMs: startedAt
          }
          runToolEvents.push(planRecord)

          const planBatcher = new StreamBatcher(STREAM_FLUSH_MS, STREAM_FLUSH_CHARS, (t) => {
            emit({ type: 'plan-delta', sessionId, stepId, text: t, runId, traceId })
            const idx = runToolEvents.findIndex((x) => x.kind === 'plan' && x.id === stepId)
            if (idx >= 0) {
              const row = runToolEvents[idx]
              if (row?.kind === 'plan') {
                runToolEvents[idx] = { ...row, text: row.text + t }
              }
            }
          })

          let text = ''
          try {
            text = await streamPlanAfterTool(
              settings,
              userText,
              { toolName: ended.name, args: ended.args, result: ended.result },
              ac,
              planBatcher,
              langfuseHandler
            )
          } catch (e) {
            planBatcher.flush()
            if (isAbortError(e)) throw e
            throw e
          }
          planBatcher.flush()

          const idx = runToolEvents.findIndex((x) => x.kind === 'plan' && x.id === stepId)
          if (idx >= 0) {
            const prev = runToolEvents[idx]
            const prevText = prev?.kind === 'plan' ? prev.text : ''
            runToolEvents[idx] = {
              kind: 'plan',
              id: stepId,
              afterToolId: ended.id,
              toolName: ended.name,
              status: 'end',
              text: text || prevText,
              runId,
              traceId,
              timestampMs: startedAt,
              durationMs: Date.now() - startedAt
            }
          }
          emit({ type: 'plan-step-end', sessionId, stepId, runId, traceId })
        })
        .catch((e) => {
          if (isAbortError(e)) return
          agentLog.warn(
            '[schedulePlanAfterTool] failed:',
            e instanceof Error ? e.message : e
          )
        })
    }

    const onTool = (e: ToolTimelineEvent) => {
      runToolEvents.push(e)
      emitTool(e)
      if (e.kind === 'tool' && e.status === 'end' && !isRejectedToolResult(e.result)) {
        schedulePlanAfterTool(e as ToolEndedCall)
      }
    }
    const recursionLimit = settings.maxAgentLoopSteps
    const invokeTimeoutMs = settings.agentRunTimeoutMs
    session.messages.push(
      new HumanMessage({
        content: agentUserText,
        additional_kwargs: planContext
          ? { [AGENXY_USER_DISPLAY_KW]: userDisplayText }
          : {}
      })
    )
    persistSessionMessages(session.workspaceId, sessionId, session.messages)

    const intentBatcher = new StreamBatcher(STREAM_FLUSH_MS, STREAM_FLUSH_CHARS, (t) => {
      emit({ type: 'intent-delta', sessionId, text: t, runId, traceId })
    })
    let intentThinking = ''
    try {
      intentThinking = await streamIntentSummary(
        settings,
        userDisplayText || agentUserText,
        ac,
        intentBatcher,
        langfuseHandler
      )
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

      // Intent classification: use LLM for intent classification in Build mode
      let detectedIntents: UserIntent[] = []
      if (composerMode === 'build') {
        try {
          const classification = await classifyIntent(
            userDisplayText || agentUserText,
            settings,
            ac.signal,
            langfuseHandler
          )
          if (classification.intent !== 'general' && classification.confidence > 0.6) {
            detectedIntents = [classification.intent]
          }
          agentLog.info(
            `[runUserMessage] Intent classified: ${classification.intent} (confidence: ${classification.confidence.toFixed(2)})`
          )
        } catch (e) {
          if (isAbortError(e)) throw e
          agentLog.warn('[runUserMessage] Intent classification failed:', e)
          // Notify UI when intent classification fails
          const message = e instanceof Error ? e.message : String(e)
          emit({
            type: 'intent-classified',
            sessionId,
            runId,
            traceId,
            intent: 'general',
            skillNames: [],
            error: message
          })
        }
      }
      agentLog.info(`[runUserMessage] detectedIntents: ${JSON.stringify(detectedIntents, null, 2)}`)

      const tooling = await prepareAgentTooling(
        composerMode,
        sessionId,
        root,
        settings,
        { runId, traceId, onTool },
        composerMode === 'build' ? { filterIntents: detectedIntents } : undefined
      )
      const { tools } = tooling

      const model = createLanguageModel(settings).bindTools(tools as never[])
      const runPrompt = buildAgentRunPrompt(composerMode, root, settings, tooling)

      agentLog.info(
        `[runUserMessage] mode=${composerMode} runPrompt: ${JSON.stringify(runPrompt, null, 2)}`
      )

      const hitlEnabled =
        composerMode === 'build' && settings.toolApprovalInBuild !== false
      const threadId = `${sessionId}:${runId}`

      const toolsByName = new Map(tools.map((t) => [t.name, t]))

      const agent = createReactAgent({
        llm: model,
        tools: tools as never[],
        prompt: runPrompt,
        // All modes need a checkpointer: runReactAgentWithGuard reads graph state after invoke.
        checkpointer: agentCheckpointer,
        ...(hitlEnabled ? { interruptBefore: ['tools'] as const } : {})
      })

      const onStreamToken = (token: string) => {
        streamedChars += token.length
        batcher.push(token)
      }
      const agentInvokeOpts = {
        recursionLimit,
        timeoutMs: invokeTimeoutMs,
        langfuseHandler
      }

      const runMessages = await Promise.all([
        runReactAgentWithGuard(
          agent,
          session.messages,
          ac,
          onStreamToken,
          agentInvokeOpts,
          {
            sessionId,
            runId,
            traceId,
            threadId,
            hitlEnabled,
            toolsByName,
            onPendingHitl: (hitlId, toolCalls) => {
              session.pendingHitl = { hitlId, toolCalls }
            },
            emitHitlRequired: (hitlId, toolCalls) => {
              streamedChars = 0
              emit({ type: 'stream-reset', sessionId, runId, traceId })
              emit({
                type: 'hitl-required',
                sessionId,
                runId,
                traceId,
                hitlId,
                toolCalls: toolCalls.map((t) => ({
                  id: t.id,
                  name: t.name,
                  args: formatToolArgs(t.args)
                }))
              })
            },
            onToolsRejected: (toolCalls) => {
              streamedChars = 0
              emit({ type: 'stream-reset', sessionId, runId, traceId })
              const now = Date.now()
              for (const tc of toolCalls) {
                onTool({
                  kind: 'tool',
                  id: tc.id,
                  name: tc.name,
                  status: 'start',
                  args: formatToolArgs(tc.args),
                  runId,
                  traceId,
                  timestampMs: now
                })
                onTool({
                  kind: 'tool',
                  id: tc.id,
                  name: tc.name,
                  status: 'end',
                  result: TOOL_REJECTED_RESULT,
                  runId,
                  traceId,
                  timestampMs: now,
                  durationMs: 0
                })
              }
            }
          }
        ),
        planChain
      ]).then(([msgs]) => msgs)

      if (runMessages.length > 0) {
        session.messages = runMessages
      }
      session.pendingHitl = undefined

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
        intentThinkingForLastAssistant: intentThinking,
        toolEventsForLastAssistant: runToolEvents
      })
      emit({
        type: 'done',
        sessionId,
        runId,
        traceId,
        timestampMs: Date.now(),
        durationMs: Date.now() - runStartedAt
      })

      const lastAi = [...session.messages]
        .reverse()
        .find((msg) => getBaseMessageType(msg) === 'ai') as AIMessage | undefined
      const assistantForMemory = lastAi ? contentToText(lastAi.content) : ''
      void extractMemoriesAfterRun({
        sessionId,
        userText: userDisplayText || agentUserText,
        assistantText: assistantForMemory
      }).catch((err) => {
        agentLog.warn('[runUserMessage] memory extract:', err instanceof Error ? err.message : err)
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
        intentThinkingForLastAssistant: intentThinking,
        toolEventsForLastAssistant: runToolEvents
      })
    } finally {
      session.controller = null
      session.pendingHitl = undefined
      batcher.flush()
      // Agent 运行结束后 flush Langfuse 数据（确保追踪数据被及时发送）
      void flushLangfuseTracing()
    }
  })
}
