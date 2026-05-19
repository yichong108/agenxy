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
    throw new Error('Please configure API Key in Settings first')
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
    '\n- **MCP Management (Meta Tools)**: `mcp_list_servers` lists configured MCPs with sanitized env; `mcp_inspect_server` probes a specific MCP for exposed tools. Prioritize these when connection info or tool names are needed; do not ask users for passwords already saved in the app.'
  const mcpNote =
    mcpEnabled.length > 0
      ? `${mcpMeta}\n- Enabled MCP (stdio) servers: ${mcpEnabled.map((s) => s.name || s.id).join(', ')}. Tools starting with mcp_ are from each MCP; pass JSON objects when calling, with keys matching the tool's inputSchema.`
      : (settings.mcpServers?.length ?? 0) > 0
        ? `${mcpMeta}\n- Current MCP entries are not enabled or have empty command; mcp_* tools will appear after user enables them.`
        : mcpMeta
  const memoryTools =
    settings.memoryEnabled !== false
      ? ', user_memory_list, user_memory_add, user_memory_update, user_memory_delete'
      : ''
  const toolLine = web
    ? `read_file, write_file, delete_file, list_dir, glob, grep, search_workspace, shell, web_search (Tavily internet search), mcp_list_servers, mcp_inspect_server${memoryTools}`
    : `read_file, write_file, delete_file, list_dir, glob, grep, search_workspace, shell, mcp_list_servers, mcp_inspect_server (no web_search without Tavily API Key)${memoryTools}`
  const webRule = web
    ? '- When users ask about **weather, temperature, rainfall, real-time news, stock prices, policies**, etc. requiring external info, you MUST call **web_search** first before answering; do not make up current weather or claim "search failed".\n- If the user **rejects** a tool call (tool result says rejected / not executed), do **not** call that tool again in the same turn; acknowledge in the user\'s language and offer alternatives (e.g. ask for city/region, or suggest configuring approval).'
    : '- Tavily is **not** configured, web_search unavailable: If users request real-time info like today\'s weather, clearly inform them to set "Tavily API Key" in app Settings or configure TAVILY_API_KEY environment variable; suggest weather websites or apps; do not claim "search engine is broken" or "internet search unavailable".'
  return `You are an intelligent agent assisting with office work and software development. Workspace root: ${root}.
- Use **relative paths from workspace root** in tools (e.g., src/index.ts); do not use ../ to escape the workspace.
- Available tools: ${toolLine}, and various skill_* tools.${mcpNote}
- **Prioritize skill_***: When user intent clearly matches a skill tool's description, you MUST call that skill first to get workflow/constraints/output, then use read_file, list_dir, grep, search_workspace, shell, mcp_* as needed; do not skip matching skills and guess with generic tools.
- shell executes commands in the sandbox directory (workspace root), waits for completion, returns stdout/stderr. Windows uses cmd style.
- When users ask to "view/read workspace files" or "list directory", prefer read_file/list_dir before answering.
- When users explicitly request to delete a file in the workspace, use delete_file (for regular files only, not directories).
- Use glob for filename/path pattern search (e.g., **/*.ts): results include workspace and "user data" directories (skill market installs, etc.); read_file/write remain limited to workspace paths.
${webRule}
- **User long-term memory** lives in the app (Settings → 用户记忆), not in workspace files. When the user shares durable preferences or asks you to remember/forget something, use **user_memory_add** / **user_memory_update** / **user_memory_delete** (or rely on post-turn auto-extract). **Never** create or edit \`.claude-memory.json\`, \`.cursor-memory.json\`, or other ad-hoc memory JSON in the workspace.
- Keep responses concise and actionable; read/list before modifying code.
- Understand task first → restate goal if needed → then select tools.`
}

const commonPrompt = `
  Current date/time (UTC): ${new Date().toLocaleString()};
`

/** 持久化用户消息时优先使用该展示文案（Plan 执行等场景） */
export const AGENXY_USER_DISPLAY_KW = 'agenxy_user_display'

function buildAgentMessageWithPlan(userText: string, planContext: string): string {
  const userPart = userText.trim() || '（用户未附加说明，请严格按计划步骤实施。）'
  return [
    'The user confirmed the following plan from **Plan mode** and switched to **Build** to implement it.',
    'Follow the plan unless the user message clearly revises, narrows, or reorders scope.',
    '',
    '--- Plan ---',
    planContext.trim(),
    '--- End plan ---',
    '',
    'User message:',
    userPart
  ].join('\n')
}

function buildAskSystemPrompt(root: string, settings: AppSettings): string {
  const web = isTavilyConfigured(settings.tavilyApiKey)
  const memoryTools =
    settings.memoryEnabled !== false ? ', user_memory_list (read global user memories only)' : ''
  const toolLine = web
    ? `read_file, list_dir, glob, grep, search_workspace, web_search (Tavily)${memoryTools}`
    : `read_file, list_dir, glob, grep, search_workspace (no web_search without Tavily)${memoryTools}`
  const webRule = web
    ? '- Call **web_search** when external info is needed; do not fabricate search results.'
    : '- Tavily is not configured: If users need real-time info, be honest and suggest configuring Tavily in Settings.'
  return `You are an assistant for understanding and explaining code, architecture, and commands (**Ask / Q&A Mode**). Workspace root: ${root}.
- **DO NOT** modify workspace files, delete files, execute shell, or call skill_* or mcp_*; these tools are unavailable in this mode.
- Read-only tools only: ${toolLine}. All paths are relative to workspace root.
- If users request "directly modify code / run commands / apply patches", explain that Ask mode cannot auto-execute and provide copyable snippets or steps; to auto-apply, switch to **Build** (turn off Ask).
${webRule}
- User preferences are in app global memory (user_memory_list when enabled), not workspace JSON files. Do not suggest writing \`.claude-memory.json\` or similar.
- Keep responses clear and verifiable: read/list/search repo content first before drawing conclusions.
- Understand intent first → restate goal if needed
`
}

function buildPlanSystemPrompt(root: string, settings: AppSettings): string {
  const web = isTavilyConfigured(settings.tavilyApiKey)
  const toolLine = web
    ? 'read_file, list_dir, glob, grep, search_workspace, web_search (Tavily)'
    : 'read_file, list_dir, glob, grep, search_workspace (no web_search without Tavily)'
  const webRule = web
    ? '- Call **web_search** when external docs or APIs are needed; do not fabricate search results.'
    : '- Tavily is not configured: note when real-time web data would help.'
  return `You are a **Plan Mode** architect for this workspace (${root}). Explore read-only and output a **checklist plan** for the UI — nothing has been executed yet.
- **DO NOT** modify files, delete files, run shell, or call skill_* / mcp_*; only read-only tools: ${toolLine}.
- **DO NOT** claim you already changed code or ran commands. Do NOT tell the user to click "execute" or auto-run anything.
- Explore enough (read/list/search) to ground steps in real paths and symbols.

**Required final Markdown shape** (use these exact ## headings; labels may be Chinese or English):

## 目标
One short paragraph restating the user request.

## 计划
- [ ] First actionable step — include file paths when known
- [ ] Second step
(add one \`- [ ]\` line per implementation step; this section is rendered as a Cursor-style checklist)

## 风险与待确认
- Bullet risks or open questions (omit entire section if none)

Rules:
- Every implementation step MUST be \`- [ ]\` under ## 计划 (not numbered lists, not prose-only).
- Keep step titles short; put extra detail after an em dash on the same line.
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
    'You are an "intent thinking" assistant. Based only on the user\'s **latest message** (may contain technical terms), write 2-5 complete sentences in English explaining:\n' +
      "(1) The user's general goal or problem type;\n" +
      '(2) If code/docs review or operations are needed, how you **plan to proceed** (outline approach only, do not list specific tool names, no Markdown headers or code blocks).\n' +
      'Keep tone concise and user-facing; do not repeat these system instructions.'
  )
  const human = new HumanMessage(userText.trim() ? userText.trim() : '(empty message)')
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
    'You are a "next step planning" assistant. The coding agent just finished one tool call and will continue the same user task.\n' +
      'Based on the user goal and the tool output, write 1-3 short complete sentences in English describing what you will do **next** (high-level outline only; do not name specific tool functions; no Markdown headers or code blocks).\n' +
      'If the output looks empty, failed, or unexpected, briefly say how you will recover. Keep tone concise and user-facing.'
  )
  const human = new HumanMessage(
    [
      `User message:\n${userText.trim() || '(empty message)'}`,
      `Tool completed: ${ctx.toolName}`,
      ctx.args ? `Arguments: ${ctx.args}` : '',
      ctx.result ? `Output (truncated):\n${ctx.result.slice(0, 700)}` : ''
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
      description:
        'List global user long-term memories stored in the app (cross-workspace). Not stored in workspace files.',
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
        'Add a durable user preference or fact to global app memory. Use when the user asks to remember something; do not write .claude-memory.json in the workspace.',
      schema: z.object({ content: z.string() }),
      execute: async ({ content }) => userMemoryAdd(content, sessionId)
    },
    {
      name: 'user_memory_update',
      description: 'Update an existing global memory by id (from user_memory_list).',
      schema: z.object({ id: z.string(), content: z.string() }),
      execute: async ({ id, content }) => userMemoryUpdate(id, content)
    },
    {
      name: 'user_memory_delete',
      description: 'Delete a global memory by id when the user asks to forget it.',
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
      description: 'Read UTF-8 text file in workspace, path is relative to workspace root',
      schema: z.object({ path: z.string() }),
      execute: ({ path }) => readFileTool(root, path),
      truncateTo: 1_000
    },
    {
      name: 'write_file',
      description: 'Write or overwrite workspace file, auto-creates parent directories',
      schema: z.object({ path: z.string(), content: z.string() }),
      execute: ({ path, content }) =>
        isReservedMemoryFilePath(path)
          ? Promise.resolve(`Rejected: ${MEMORY_FILE_GUARD_MESSAGE}`)
          : writeFileTool(root, path, content)
    },
    {
      name: 'delete_file',
      description:
        'Delete a single regular file in workspace (path relative to workspace); cannot delete directories',
      schema: z.object({ path: z.string() }),
      execute: ({ path }) => deleteFileTool(root, path)
    },
    {
      name: 'list_dir',
      description: 'List directory, path is relative or empty for root, depth 1-3',
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
      description:
        'Simple substring search in text files (no regex). Use grep when you need regex, glob, or match context.',
      schema: z.object({ query: z.string() }),
      execute: ({ query }) => searchWorkspace(root, query, { maxFiles: 50 }),
      truncateTo: 8_000
    },
    {
      name: 'glob',
      description:
        'Glob for files matching pattern under workspace root and Electron userData directory. Returns file paths only (no directories), split into "Workspace" and "User Data" sections; user data paths are relative to userData root. Pattern uses Node style like **/*.ts, skills/**/*.md; excludes node_modules/.git/dist and Chromium cache directories on both sides',
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
        'Execute a shell command in workspace root directory and wait for completion, returns combined stdout/stderr (long output truncated). Used for installing dependencies, building, testing, git, etc.',
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
              'Use Tavily to search public web pages (weather, news, docs, etc.). search_workspace only searches workspace code; call this tool when external info is needed.',
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
  cancelAllHitlWaiters('Run cancelled')
  void killCommand(`term:${sessionId}`)
}

export function resumeAgentHitl(
  sessionId: string,
  hitlId: string,
  decision: HitlUserDecision
): { ok: true } | { ok: false; error: string } {
  const s = sessions.get(sessionId)
  if (!s?.pendingHitl || s.pendingHitl.hitlId !== hitlId) {
    return { ok: false, error: 'No pending tool approval for this session' }
  }
  s.pendingHitl = undefined
  const submitted = submitHitlDecision(hitlId, decision)
  if (!submitted) {
    return { ok: false, error: 'Approval request expired or already resolved' }
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
    emit({ type: 'error', sessionId, message: 'Empty message' })
    return
  }
  const settings = getSettings()
  agentLog.info(`settings: ${JSON.stringify(settings, null, 2)}, composerMode: ${composerMode}`)

  const existingSession = sessions.get(sessionId)
  if (!existingSession) {
    emit({ type: 'error', sessionId, message: 'Session does not exist or has expired' })
    return
  }
  const workspace = getWorkspaceById(existingSession.workspaceId)
  agentLog.info(`[runUserMessage] workspace: ${workspace?.path}`)

  const root = workspace?.path?.trim() || ''
  if (!root) {
    emit({
      type: 'error',
      sessionId,
      message: 'Current session workspace not bound to directory, please bind path first'
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
      emit({ type: 'error', sessionId, message: 'Session does not exist or has expired' })
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
