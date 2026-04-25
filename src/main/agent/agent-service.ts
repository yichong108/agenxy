import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { ChatOpenAI } from '@langchain/openai'
import type { WebContents } from 'electron'
import { z } from 'zod'

import {
  EVENTS,
  type AppSettings,
  type StreamEvent,
  type ToolTimelineEvent
} from '../../shared/ipc.js'
import { getSettings, getWorkspace } from '../store.js'
import { listDirTool, readFileTool, searchWorkspace, writeFileTool } from '../tools/fs-tools.js'
import { runCommand, killCommand } from '../tools/terminal.js'

import { StreamBatcher } from './batcher.js'
import { ConcurrencyQueue } from './queue.js'

type SessionRuntime = {
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

function createLanguageModel(settings: AppSettings) {
  if (!settings.apiKey?.trim()) {
    throw new Error('请先在「设置」中配置 API Key')
  }
  const defaultBaseURL = 'https://api.deepseek.com/v1'
  return new ChatOpenAI({
    apiKey: settings.apiKey,
    model: settings.model,
    configuration: {
      baseURL: settings.baseUrl?.trim() || defaultBaseURL
    },
    streaming: true,
    temperature: 0
  })
}

function buildSystemPrompt(root: string): string {
  return `你是协助办公与软件开发的智能体。工作区根目录: ${root}。
- 在工具中使用**相对工作区根**的路径（如 src/index.ts），不要使用 ../ 尝试逃出工作区。
- 可调用工具: read_file, write_file, list_dir, search_workspace, run_terminal。
- run_terminal 在沙盒目录（工作区根）下执行 shell 命令。Windows 为 cmd 风格。
- 当用户要求“查看/读取工作区文件”或“列出目录”时，优先调用 read_file/list_dir 再回答。
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

function makeTools(
  sessionId: string,
  root: string,
  settings: AppSettings,
  onTool: (e: ToolTimelineEvent) => void
) {
  const termKey = `term:${sessionId}`
  const tools = [
    tool(
      async ({ path: p }) => {
        const id = `read-${Date.now()}`
        onTool({ kind: 'tool', id, name: 'read_file', status: 'start', args: p })
        const r = await readFileTool(root, p)
        onTool({ kind: 'tool', id, name: 'read_file', status: 'end', result: r.slice(0, 1_000) })
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
        onTool({ kind: 'tool', id, name: 'write_file', status: 'start', args: p })
        const r = await writeFileTool(root, p, content)
        onTool({ kind: 'tool', id, name: 'write_file', status: 'end', result: r })
        return r
      },
      {
        name: 'write_file',
        description: '写入或覆盖工作区文件，自动创建父目录',
        schema: z.object({ path: z.string(), content: z.string() })
      }
    ),
    tool(
      async ({ path: p, depth }) => {
        const id = `ls-${Date.now()}`
        onTool({ kind: 'tool', id, name: 'list_dir', status: 'start', args: p || '.' })
        const r = await listDirTool(root, p || '.', { depth: depth ?? 2 })
        onTool({ kind: 'tool', id, name: 'list_dir', status: 'end', result: r.slice(0, 8_000) })
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
        onTool({ kind: 'tool', id, name: 'search_workspace', status: 'start', args: query })
        const r = await searchWorkspace(root, query, { maxFiles: 50 })
        onTool({
          kind: 'tool',
          id,
          name: 'search_workspace',
          status: 'end',
          result: r.slice(0, 8_000)
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
      async ({ command }) => {
        const id = `sh-${Date.now()}`
        onTool({ kind: 'tool', id, name: 'run_terminal', status: 'start', args: command })
        const r = await runCommand(termKey, root, command, settings.maxTerminalOutputChars)
        onTool({ kind: 'tool', id, name: 'run_terminal', status: 'end', result: r.slice(0, 4_000) })
        return r
      },
      {
        name: 'run_terminal',
        description: '在工作区根目录执行一条 shell 命令',
        schema: z.object({ command: z.string() })
      }
    )
  ]
  const byName = new Map<string, NamedTool>(tools.map((x) => [x.name, x as NamedTool]))
  return { tools, byName }
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

export function initSessionState(sessionId: string): void {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      messages: [],
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
  const root = getWorkspace()
  if (!root) {
    emit({ type: 'error', sessionId, message: '未选择工作区' })
    return
  }
  const queue = getQueue(settings)
  if (queue.willBlock()) {
    onQueued(queue.waiting + 1)
  }
  await queue.run(async () => {
    onQueued(0) // 0 = 已获执行权（不展示排队条）
    const session = sessions.get(sessionId) ?? {
      messages: [],
      controller: null,
      terminalKey: `term:${sessionId}`
    }
    sessions.set(sessionId, session)
    const ac = new AbortController()
    session.controller = ac
    emit({ type: 'run-start', sessionId })
    const onTool = (e: ToolTimelineEvent) => {
      emit({ type: 'tool', sessionId, event: e })
    }
    const fileToolHint = parseFileToolHint(userText)
    const mustUseToolFirst = !!fileToolHint
    let hasToolCall = false
    const batcher = new StreamBatcher(settings.streamFlushMs, settings.streamFlushChars, (t) => {
      emit({ type: 'text-delta', sessionId, text: t })
    })
    const { tools, byName } = makeTools(sessionId, root, settings, onTool)
    const model = createLanguageModel(settings).bindTools(tools)
    session.messages.push(new HumanMessage(userText))
    const system = buildSystemPrompt(root)
    try {
      for (let step = 0; step < 16; step += 1) {
        if (ac.signal.aborted) break
        const suppressStream = mustUseToolFirst && !hasToolCall
        const forceToolSystem =
          mustUseToolFirst && !hasToolCall
            ? new SystemMessage(
                fileToolHint?.type === 'read'
                  ? `当前用户请求属于文件读取。你必须先调用 read_file 工具后再给最终回答。可参考路径: ${fileToolHint.pathHint}`
                  : `当前用户请求属于目录查看。你必须先调用 list_dir 工具后再给最终回答。可参考路径: ${fileToolHint?.pathHint ?? '.'}，可参考 depth: ${fileToolHint?.depthHint ?? 2}`
              )
            : null
        let streamedChars = 0
        const response = await model.invoke(
          [
            new SystemMessage(system),
            ...(forceToolSystem ? [forceToolSystem] : []),
            ...session.messages
          ],
          {
            signal: ac.signal,
            callbacks: [
              {
                handleLLMNewToken(token: string) {
                  if (suppressStream) return
                  streamedChars += token.length
                  batcher.push(token)
                }
              }
            ]
          }
        )
        session.messages.push(response)
        const toolCalls = (response as AIMessage).tool_calls ?? []
        if (!toolCalls.length) {
          if (mustUseToolFirst && !hasToolCall) {
            session.messages.push(
              new HumanMessage(
                fileToolHint?.type === 'read'
                  ? `请先调用 read_file 读取文件后再回答。参考路径: ${fileToolHint.pathHint}`
                  : `请先调用 list_dir 列出目录后再回答。参考路径: ${fileToolHint?.pathHint ?? '.'}`
              )
            )
            continue
          }
          const text = contentToText(response.content)
          if (text && streamedChars === 0) {
            batcher.push(text)
          }
          break
        }
        hasToolCall = true
        for (const call of toolCalls) {
          const callId = call.id || `tc-${Date.now()}`
          const toolName = call.name
          const toolArgs = JSON.stringify(call.args ?? {})
          onTool({ kind: 'tool', id: callId, name: toolName, status: 'start', args: toolArgs })
          const targetTool = byName.get(toolName)
          if (!targetTool) {
            const notFound = `未找到工具: ${toolName}`
            onTool({ kind: 'error', message: notFound })
            onTool({ kind: 'tool', id: callId, name: toolName, status: 'end', result: notFound })
            session.messages.push(new ToolMessage({ tool_call_id: callId, content: notFound }))
            continue
          }
          try {
            const toolResult = await targetTool.invoke(call.args ?? {}, { signal: ac.signal })
            const toolText =
              typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
            onTool({
              kind: 'tool',
              id: callId,
              name: toolName,
              status: 'end',
              result: toolText.slice(0, 1_000)
            })
            session.messages.push(new ToolMessage({ tool_call_id: callId, content: toolText }))
          } catch (toolErr) {
            const toolMessage = toolErr instanceof Error ? toolErr.message : String(toolErr)
            onTool({ kind: 'error', message: toolMessage })
            onTool({ kind: 'tool', id: callId, name: toolName, status: 'end', result: toolMessage })
            session.messages.push(new ToolMessage({ tool_call_id: callId, content: toolMessage }))
          }
        }
      }
      batcher.flush()
      emit({ type: 'done', sessionId })
    } catch (e) {
      batcher.flush()
      const message = e instanceof Error ? e.message : String(e)
      emit({ type: 'error', sessionId, message })
      onTool({ kind: 'error', message })
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
