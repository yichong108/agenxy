import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { ChatOpenAI } from '@langchain/openai'
import type { WebContents } from 'electron'
import { z } from 'zod'

import {
  EVENTS,
  type AppSettings,
  type ChatMessage,
  type ModelProviderId,
  type StreamEvent,
  type ToolTimelineEvent,
  getActiveProviderProfile
} from '@/shared/ipc'
import { logScope } from '@/main/logger'
import { buildMcpLangChainTools, collectMcpServerContextHints } from '@/main/mcp/mcp-runtime'
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

import { StreamBatcher } from '@/main/agent/batcher'
import { ConcurrencyQueue } from '@/main/agent/queue'
import { buildSkillBundle } from '@/main/agent/skills/index'

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

function getQueue(settings: AppSettings): ConcurrencyQueue {
  if (!agentQueue) {
    agentQueue = new ConcurrencyQueue(Math.max(1, settings.maxConcurrentStreams))
  }
  return agentQueue
}

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
  coreMessages: BaseMessage[]
): void {
  setSessionMessages(workspaceId, sessionId, toPersistedMessages(coreMessages))
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
- 回答简洁、可执行；修改代码前先 read/list。`
}

type FileToolHint =
  | { type: 'read'; pathHint: string }
  | { type: 'list'; pathHint: string; depthHint?: number }

function parseFileToolHint(text: string): FileToolHint | null {
  const raw = text.trim()
  if (!raw) return null

  const readSlash = raw.match(/^\/(?:read|cat)\s+(.+)$/i)
  if (readSlash?.[1]) {
    return { type: 'read', pathHint: readSlash[1].trim() }
  }
  const listSlash = raw.match(/^\/(?:ls|list)\s*([^\s]+)?(?:\s+(\d+))?$/i)
  if (listSlash) {
    const maybeDepth = listSlash[2] ? Number.parseInt(listSlash[2], 10) : undefined
    return {
      type: 'list',
      pathHint: (listSlash[1] || '.').trim(),
      depthHint: Number.isFinite(maybeDepth) ? maybeDepth : undefined
    }
  }

  const readZh = raw.match(/^(?:查看|读取)(?:工作区)?(?:文件)?[:：\s]+(.+)$/)
  if (readZh?.[1]) {
    return { type: 'read', pathHint: readZh[1].trim() }
  }
  const listZh = raw.match(/^(?:列出|查看)(?:工作区)?(?:目录|文件夹)?[:：\s]+(.+)$/)
  if (listZh?.[1]) {
    return { type: 'list', pathHint: listZh[1].trim() }
  }
  const listRootZh = raw.match(/^(?:列出|查看)(?:工作区)?(?:目录|文件夹)$/)
  if (listRootZh) {
    return { type: 'list', pathHint: '.' }
  }
  return null
}

/** 无原生 tool calling 时的纯对话流式（不调用 bindTools，避免 Ollama 返回 does not support tools） */
async function invokeChatOnlyStream(
  settings: AppSettings,
  session: SessionRuntime,
  root: string,
  skillHint: string,
  mcpContextHints: string,
  ac: AbortController,
  batcher: StreamBatcher,
  timeoutMs: number
): Promise<number> {
  const model = createLanguageModel(settings)
  const webHint =
    ' 若用户要天气、新闻等实时信息：如实说明当前为「纯对话模式」无法调用工具；请其（1）在「设置」填写 Tavily API Key（或环境变量 TAVILY_API_KEY），（2）使用 DeepSeek 或对 Ollama 打开「启用工作区工具」。'
  const chatNotice =
    '【运行模式】当前未启用工作区工具（模型不支持 function calling 或未在设置中打开）：不得调用 read_file、write_file、delete_file、list_dir、glob、search_workspace、shell、web_search、任何 skill_* 及任何 mcp_* 工具；请用纯文本协助用户（可做步骤说明、命令示例与代码片段）。' +
    ' 勿编造「网络搜索不可用」「搜索引擎故障」等理由；应如实说明是未开启工具或未配置 Tavily。' +
    webHint
  const systemText = [buildSystemPrompt(root, settings), skillHint, mcpContextHints, chatNotice]
    .filter(Boolean)
    .join('\n\n')
  const llmMessages = [new SystemMessage(systemText), ...session.messages]
  let streamedChars = 0
  let full = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort()
      reject(new Error(`对话生成超时（>${timeoutMs}ms），已中止`))
    }, timeoutMs)
  })
  try {
    await Promise.race([
      (async () => {
        const stream = await model.stream(llmMessages, { signal: ac.signal })
        for await (const chunk of stream) {
          const piece = contentToText((chunk as { content?: unknown }).content)
          if (piece) {
            full += piece
            streamedChars += piece.length
            batcher.push(piece)
          }
        }
      })(),
      timeoutPromise
    ])
    if (full.trim()) {
      session.messages.push(new AIMessage(full))
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
  return streamedChars
}

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
    return await Promise.race([
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
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/**
 * 创建工具
 */
async function makeTools(
  sessionId: string,
  root: string,
  settings: AppSettings,
  runCtx: { runId: string; traceId: string },
  onTool: (e: ToolTimelineEvent) => void
) {
  const termKey = `term:${sessionId}`
  const baseTools = [
    tool(
      async ({ path: p }) => {
        const id = `read-${Date.now()}`
        const startedAt = Date.now()
        onTool({
          kind: 'tool',
          id,
          name: 'read_file',
          status: 'start',
          args: p,
          runId: runCtx.runId,
          traceId: runCtx.traceId,
          timestampMs: startedAt
        })
        const r = await readFileTool(root, p)
        onTool({
          kind: 'tool',
          id,
          name: 'read_file',
          status: 'end',
          result: r.slice(0, 1_000),
          runId: runCtx.runId,
          traceId: runCtx.traceId,
          timestampMs: Date.now(),
          durationMs: Date.now() - startedAt
        })
        return r
      },
      {
        name: 'read_file',
        description: '读取工作区内 UTF-8 文本文件，path 为相对工作区',
        schema: z.object({ path: z.string() })
      }
    ),
    tool(
      async ({ path: p, content }) => {
        const id = `w-${Date.now()}`
        const startedAt = Date.now()
        onTool({
          kind: 'tool',
          id,
          name: 'write_file',
          status: 'start',
          args: p,
          runId: runCtx.runId,
          traceId: runCtx.traceId,
          timestampMs: startedAt
        })
        const r = await writeFileTool(root, p, content)
        onTool({
          kind: 'tool',
          id,
          name: 'write_file',
          status: 'end',
          result: r,
          runId: runCtx.runId,
          traceId: runCtx.traceId,
          timestampMs: Date.now(),
          durationMs: Date.now() - startedAt
        })
        return r
      },
      {
        name: 'write_file',
        description: '写入或覆盖工作区文件，自动创建父目录',
        schema: z.object({ path: z.string(), content: z.string() })
      }
    ),
    tool(
      async ({ path: p }) => {
        const id = `del-${Date.now()}`
        const startedAt = Date.now()
        onTool({
          kind: 'tool',
          id,
          name: 'delete_file',
          status: 'start',
          args: p,
          runId: runCtx.runId,
          traceId: runCtx.traceId,
          timestampMs: startedAt
        })
        const r = await deleteFileTool(root, p)
        onTool({
          kind: 'tool',
          id,
          name: 'delete_file',
          status: 'end',
          result: r,
          runId: runCtx.runId,
          traceId: runCtx.traceId,
          timestampMs: Date.now(),
          durationMs: Date.now() - startedAt
        })
        return r
      },
      {
        name: 'delete_file',
        description: '删除工作区内单个普通文件（path 相对工作区）；不能删除目录',
        schema: z.object({ path: z.string() })
      }
    ),
    tool(
      async ({ path: p, depth }) => {
        const id = `ls-${Date.now()}`
        const startedAt = Date.now()
        onTool({
          kind: 'tool',
          id,
          name: 'list_dir',
          status: 'start',
          args: p || '.',
          runId: runCtx.runId,
          traceId: runCtx.traceId,
          timestampMs: startedAt
        })
        const r = await listDirTool(root, p || '.', { depth: depth ?? 2 })
        onTool({
          kind: 'tool',
          id,
          name: 'list_dir',
          status: 'end',
          result: r.slice(0, 8_000),
          runId: runCtx.runId,
          traceId: runCtx.traceId,
          timestampMs: Date.now(),
          durationMs: Date.now() - startedAt
        })
        return r
      },
      {
        name: 'list_dir',
        description: '列出目录，path 为相对或空为根，depth 1-3',
        schema: z.object({
          path: z.string().optional(),
          depth: z.number().int().min(1).max(3).optional()
        })
      }
    ),
    tool(
      async ({ query }) => {
        const id = `find-${Date.now()}`
        const startedAt = Date.now()
        onTool({
          kind: 'tool',
          id,
          name: 'search_workspace',
          status: 'start',
          args: query,
          runId: runCtx.runId,
          traceId: runCtx.traceId,
          timestampMs: startedAt
        })
        const r = await searchWorkspace(root, query, { maxFiles: 50 })
        onTool({
          kind: 'tool',
          id,
          name: 'search_workspace',
          status: 'end',
          result: r.slice(0, 8_000),
          runId: runCtx.runId,
          traceId: runCtx.traceId,
          timestampMs: Date.now(),
          durationMs: Date.now() - startedAt
        })
        return r
      },
      {
        name: 'search_workspace',
        description: '在文本类源码中按子串搜索，适合找符号',
        schema: z.object({ query: z.string() })
      }
    ),
    tool(
      async ({ pattern, max_results }) => {
        const id = `glob-${Date.now()}`
        const startedAt = Date.now()
        const arg = `${pattern}${max_results != null ? ` max=${max_results}` : ''}`
        onTool({
          kind: 'tool',
          id,
          name: 'glob',
          status: 'start',
          args: arg,
          runId: runCtx.runId,
          traceId: runCtx.traceId,
          timestampMs: startedAt
        })
        const r = await globFilesTool(root, pattern, {
          maxFiles: max_results,
          userDataRoot: userDataPath()
        })
        onTool({
          kind: 'tool',
          id,
          name: 'glob',
          status: 'end',
          result: r.slice(0, 12_000),
          runId: runCtx.runId,
          traceId: runCtx.traceId,
          timestampMs: Date.now(),
          durationMs: Date.now() - startedAt
        })
        return r
      },
      {
        name: 'glob',
        description:
          '在工作区根与 Electron 用户数据目录（userData）下按同一 pattern 做 glob，列出匹配的**文件**路径（仅文件）。返回分「工作区」「用户数据」两段，用户数据路径为相对 userData 根；pattern 使用 Node 风格如 **/*.ts、skills/**/*.md；两侧均排除 node_modules/.git/dist 及 Chromium 缓存等目录',
        schema: z.object({
          pattern: z.string(),
          max_results: z.number().int().min(1).max(500).optional()
        })
      }
    ),
    tool(
      async ({ command }) => {
        const id = `sh-${Date.now()}`
        const startedAt = Date.now()
        onTool({
          kind: 'tool',
          id,
          name: 'shell',
          status: 'start',
          args: command,
          runId: runCtx.runId,
          traceId: runCtx.traceId,
          timestampMs: startedAt
        })
        const r = await runCommand(termKey, root, command, settings.maxTerminalOutputChars)
        onTool({
          kind: 'tool',
          id,
          name: 'shell',
          status: 'end',
          result: r.slice(0, 4_000),
          runId: runCtx.runId,
          traceId: runCtx.traceId,
          timestampMs: Date.now(),
          durationMs: Date.now() - startedAt
        })
        return r
      },
      {
        name: 'shell',
        description:
          '在工作区根目录执行一条 shell 命令并等待完成，返回合并的 stdout/stderr（长输出会被截断）。用于安装依赖、构建、测试、git 等。',
        schema: z.object({ command: z.string() })
      }
    )
  ]
  const webSearchTools = isTavilyConfigured(settings.tavilyApiKey)
    ? [
        tool(
          async ({ query, max_results }) => {
            const id = `web-${Date.now()}`
            const startedAt = Date.now()
            const arg =
              max_results != null && max_results !== 5 ? `${query} (max=${max_results})` : query
            onTool({
              kind: 'tool',
              id,
              name: 'web_search',
              status: 'start',
              args: arg,
              runId: runCtx.runId,
              traceId: runCtx.traceId,
              timestampMs: startedAt
            })
            const r = await tavilyWebSearch(query, {
              maxResults: max_results,
              apiKey: settings.tavilyApiKey
            })
            onTool({
              kind: 'tool',
              id,
              name: 'web_search',
              status: 'end',
              result: r.slice(0, 12_000),
              runId: runCtx.runId,
              traceId: runCtx.traceId,
              timestampMs: Date.now(),
              durationMs: Date.now() - startedAt
            })
            return r
          },
          {
            name: 'web_search',
            description:
              '使用 Tavily 检索互联网公开网页（天气、新闻、文档等）。search_workspace 只搜工作区代码；需要站外最新信息时必须调用本工具。',
            schema: z.object({
              query: z.string(),
              max_results: z.number().int().min(1).max(20).optional()
            })
          }
        )
      ]
    : []
  const skillBundle = await buildSkillBundle({
    root,
    termKey,
    settings,
    runCtx,
    onTool
  })
  const { tools: mcpTools, contextHints: mcpContextHints } = await buildMcpLangChainTools(
    settings,
    runCtx,
    onTool
  )
  const tools = [
    ...skillBundle.tools,
    ...baseTools,
    ...webSearchTools,
    ...mcpTools
  ] as unknown as NamedTool[]
  const byName = new Map<string, NamedTool>(tools.map((x) => [x.name, x as NamedTool]))
  return { tools, byName, skillHint: skillBundle.hint, mcpContextHints }
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
  onQueued: (pos: number) => void
): Promise<void> {
  const settings = getSettings()
  const existingSession = sessions.get(sessionId)
  if (!existingSession) {
    emit({ type: 'error', sessionId, message: '会话不存在或已失效' })
    return
  }
  const workspace = getWorkspaceById(existingSession.workspaceId)
  const root = workspace?.path?.trim() || ''
  if (!root) {
    emit({ type: 'error', sessionId, message: '当前会话所属工作区未绑定目录，请先绑定路径' })
    return
  }
  const queue = getQueue(settings)
  if (queue.willBlock()) {
    onQueued(queue.waiting + 1)
  }
  await queue.run(async () => {
    onQueued(0) // 0 = 已获执行权（不展示排队条）
    const session = sessions.get(sessionId)
    if (!session) {
      emit({ type: 'error', sessionId, message: '会话不存在或已失效' })
      return
    }
    const ac = new AbortController()
    const runId = makeRunId()
    const traceId = makeTraceId(sessionId, runId)
    const runStartedAt = Date.now()
    session.controller = ac

    emit({ type: 'run-start', sessionId, runId, traceId, timestampMs: runStartedAt })

    const onTool = (e: ToolTimelineEvent) => {
      if (e.kind === 'tool' && e.status === 'start') {
        hasToolCall = true
      }
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
    const fileToolHint = parseFileToolHint(userText)
    const mustUseToolFirst = !!fileToolHint
    let hasToolCall = false
    const recursionLimit = settings.maxAgentLoopSteps
    const invokeTimeoutMs = settings.agentRunTimeoutMs
    const batcher = new StreamBatcher(settings.streamFlushMs, settings.streamFlushChars, (t) => {
      emit({ type: 'text-delta', sessionId, text: t, runId, traceId })
    })
    const profile = getActiveProviderProfile(settings)
    session.messages.push(new HumanMessage(userText))
    persistSessionMessages(session.workspaceId, sessionId, session.messages)

    try {
      let streamedChars = 0

      if (!profile.enableTools) {
        const noopTool: (e: ToolTimelineEvent) => void = () => {}
        const [skillBundle, mcpContextHints] = await Promise.all([
          buildSkillBundle({
            root,
            termKey: session.terminalKey,
            settings,
            runCtx: { runId, traceId },
            onTool: noopTool
          }),
          collectMcpServerContextHints(settings)
        ])
        streamedChars = await invokeChatOnlyStream(
          settings,
          session,
          root,
          skillBundle.hint,
          mcpContextHints,
          ac,
          batcher,
          invokeTimeoutMs
        )
      } else {
        const { tools, skillHint, mcpContextHints } = await makeTools(
          sessionId,
          root,
          settings,
          { runId, traceId },
          onTool
        )

        const model = createLanguageModel(settings).bindTools(tools as never[])
        const baseSystem = buildSystemPrompt(root, settings)
        const fileToolInstruction =
          mustUseToolFirst && fileToolHint
            ? fileToolHint.type === 'read'
              ? `当前用户请求属于文件读取。你必须先调用 read_file 工具后再给最终回答。可参考路径: ${fileToolHint.pathHint}`
              : `当前用户请求属于目录查看。你必须先调用 list_dir 工具后再给最终回答。可参考路径: ${fileToolHint.pathHint}，可参考 depth: ${fileToolHint.depthHint ?? 2}`
            : ''
        const runPrompt = [baseSystem, skillHint, mcpContextHints, fileToolInstruction]
          .filter(Boolean)
          .join('\n\n')

        agentLog.debug('runPrompt', runPrompt)

        // 创建Agent
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
        if (mustUseToolFirst && !hasToolCall) {
          session.messages.push(
            new HumanMessage(
              fileToolHint?.type === 'read'
                ? `请先调用 read_file 读取文件后再回答。参考路径: ${fileToolHint.pathHint}`
                : `请先调用 list_dir 列出目录后再回答。参考路径: ${fileToolHint?.pathHint ?? '.'}`
            )
          )
          const retryResult = await invokeAgentWithGuard(
            agent,
            session.messages,
            ac,
            onStreamToken,
            agentInvokeOpts
          )
          const retryMessages = (retryResult as { messages?: BaseMessage[] }).messages
          if (Array.isArray(retryMessages) && retryMessages.length > 0) {
            session.messages = retryMessages
          }
        }
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
      persistSessionMessages(session.workspaceId, sessionId, session.messages)
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
      persistSessionMessages(session.workspaceId, sessionId, session.messages)
    } finally {
      session.controller = null
      batcher.flush()
    }
  })
}

/** 重建队列并发上限时调用 */
export function resetQueue(): void {
  agentQueue = null
}
