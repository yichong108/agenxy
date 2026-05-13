import { inspect } from 'node:util'

import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { ChatOpenAI } from '@langchain/openai'
import type { CallbackHandler } from '@langfuse/langchain'
import type { WebContents } from 'electron'
import { z } from 'zod'

import { StreamBatcher } from '@/main/agent/batcher'
import { classifyIntent, type UserIntent } from '@/main/agent/intent-classifier'
import { ConcurrencyQueue } from '@/main/agent/queue'
import { buildSkillBundle } from '@/main/agent/skills/index'
import { createLangfuseCallbackHandler, flushLangfuseTracing } from '@/main/langfuse'
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

export const agentLog = logScope('agent')

type SessionRuntime = {
  workspaceId: string
  /** System prompt is not included; it's appended at each request */
  messages: BaseMessage[]
  controller: AbortController | null
  /** Consistent with terminal key for the session */
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
    // system prompt doesn't enter UI history to avoid interfering with session display
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
  const toolLine = web
    ? 'read_file, write_file, delete_file, list_dir, glob, search_workspace, shell, web_search (Tavily internet search), mcp_list_servers, mcp_inspect_server'
    : 'read_file, write_file, delete_file, list_dir, glob, search_workspace, shell, mcp_list_servers, mcp_inspect_server (no web_search without Tavily API Key)'
  const webRule = web
    ? '- When users ask about **weather, temperature, rainfall, real-time news, stock prices, policies**, etc. requiring external info, you MUST call **web_search** first before answering; do not make up current weather or claim "search failed".'
    : '- Tavily is **not** configured, web_search unavailable: If users request real-time info like today\'s weather, clearly inform them to set "Tavily API Key" in app Settings or configure TAVILY_API_KEY environment variable; suggest weather websites or apps; do not claim "search engine is broken" or "internet search unavailable".'
  return `You are an intelligent agent assisting with office work and software development. Workspace root: ${root}.
- Use **relative paths from workspace root** in tools (e.g., src/index.ts); do not use ../ to escape the workspace.
- Available tools: ${toolLine}, and various skill_* tools.${mcpNote}
- **Prioritize skill_***: When user intent clearly matches a skill tool's description, you MUST call that skill first to get workflow/constraints/output, then use read_file, list_dir, search_workspace, shell, mcp_* as needed; do not skip matching skills and guess with generic tools.
- shell executes commands in the sandbox directory (workspace root), waits for completion, returns stdout/stderr. Windows uses cmd style.
- When users ask to "view/read workspace files" or "list directory", prefer read_file/list_dir before answering.
- When users explicitly request to delete a file in the workspace, use delete_file (for regular files only, not directories).
- Use glob for filename/path pattern search (e.g., **/*.ts): results include workspace and "user data" directories (skill market installs, etc.); read_file/write remain limited to workspace paths.
${webRule}
- Keep responses concise and actionable; read/list before modifying code.
- Understand task first → restate goal if needed → then select tools.`
}

const commonPrompt = `
  Current date/time (UTC): ${new Date().toLocaleString()};
`

function buildAskSystemPrompt(root: string, settings: AppSettings): string {
  const web = isTavilyConfigured(settings.tavilyApiKey)
  const toolLine = web
    ? 'read_file, list_dir, glob, search_workspace, web_search (Tavily)'
    : 'read_file, list_dir, glob, search_workspace (no web_search without Tavily)'
  const webRule = web
    ? '- Call **web_search** when external info is needed; do not fabricate search results.'
    : '- Tavily is not configured: If users need real-time info, be honest and suggest configuring Tavily in Settings.'
  return `You are an assistant for understanding and explaining code, architecture, and commands (**Ask / Q&A Mode**). Workspace root: ${root}.
- **DO NOT** modify workspace files, delete files, execute shell, or call skill_* or mcp_*; these tools are unavailable in this mode.
- Read-only tools only: ${toolLine}. All paths are relative to workspace root.
- If users request "directly modify code / run commands / apply patches", explain that Ask mode cannot auto-execute and provide copyable snippets or steps; to auto-apply, switch to **Build** (turn off Ask).
${webRule}
- Keep responses clear and verifiable: read/list/search repo content first before drawing conclusions.
- Understand intent first → restate goal if needed
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
  options: {
    recursionLimit: number
    timeoutMs: number
    langfuseHandler?: CallbackHandler | null
  }
): Promise<unknown> {
  const { recursionLimit, timeoutMs, langfuseHandler } = options
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort()
      reject(new Error(`Model-tool loop timeout (>${timeoutMs}ms), run aborted`))
    }, timeoutMs)
  })
  try {
    agentLog.info(`[invokeAgentWithGuard] options: ${JSON.stringify(options, null, 2)}`)
    agentLog.info(
      `[invokeAgentWithGuard] langfuseHandler: ${langfuseHandler ? '已传递' : '未传递'}`
    )

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
            },
            ...(langfuseHandler ? [langfuseHandler] : [])
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
 * Create tools
 */
const ASK_MODE_TOOL_NAMES = new Set([
  'read_file',
  'list_dir',
  'glob',
  'search_workspace',
  'web_search'
])

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

/** Workspace base tools + optional web search; shared by Ask/Build agents */
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
      description: 'Read UTF-8 text file in workspace, path is relative to workspace root',
      schema: z.object({ path: z.string() }),
      execute: ({ path }) => readFileTool(root, path),
      truncateTo: 1_000
    },
    {
      name: 'write_file',
      description: 'Write or overwrite workspace file, auto-creates parent directories',
      schema: z.object({ path: z.string(), content: z.string() }),
      execute: ({ path, content }) => writeFileTool(root, path, content)
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
      name: 'search_workspace',
      description: 'Search by substring in text source files, good for finding symbols',
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

  const baseTools = baseToolDefs.map((def) => defineTool(def, runCtx))

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

/** Agent strategy interface */
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

/** Ask agent strategy: read-only workspace tools + optional web_search; no skill/MCP loading */
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

/** Build agent strategy: full workspace tools + skill_* + MCP */
type BuildAgentStrategyOptions = {
  /** Filter skills by intent */
  filterIntents?: UserIntent[]
}

const buildAgentStrategy: AgentStrategy & { options?: BuildAgentStrategyOptions } = {
  name: 'build',
  options: {},
  async prepareTools(sessionId, root, settings, runCtx) {
    const termKey = `term:${sessionId}`
    const { baseTools, webSearchTools } = buildBaseAndWebTools(sessionId, root, settings, runCtx)

    const filterIntents = this.options?.filterIntents
    const [skillBundle, mcpResult] = await Promise.all([
      buildSkillBundle(
        { root, termKey, settings, runCtx, onTool: runCtx.onTool },
        filterIntents ? { filterIntents } : undefined
      ),
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

/** Strategy registry */
const agentStrategies: Record<AgentComposerMode, AgentStrategy> = {
  ask: askAgentStrategy,
  build: buildAgentStrategy
}

/** Get agent strategy */
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
      intentThinking = await streamIntentSummary(
        settings,
        userText,
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
            userText,
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

      // Get corresponding strategy and execute (pass intent filtering in Build mode)
      const strategy = getAgentStrategy(composerMode)

      // If Build strategy, set intent filtering options
      if (composerMode === 'build' && 'options' in strategy) {
        strategy.options = { filterIntents: detectedIntents }
      }

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
      const agentInvokeOpts = {
        recursionLimit,
        timeoutMs: invokeTimeoutMs,
        langfuseHandler
      }

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
      // Agent 运行结束后 flush Langfuse 数据（确保追踪数据被及时发送）
      void flushLangfuseTracing()
    }
  })
}
