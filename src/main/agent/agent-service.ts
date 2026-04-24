import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { streamText, tool, type CoreMessage, type TextStreamPart } from 'ai'
import type { WebContents } from 'electron'
import { z } from 'zod'
import { StreamBatcher } from './batcher.js'
import { ConcurrencyQueue } from './queue.js'
import { getSettings, getWorkspace } from '../store.js'
import { listDirTool, readFileTool, searchWorkspace, writeFileTool } from '../tools/fs-tools.js'
import { runCommand, killCommand } from '../tools/terminal.js'
import { EVENTS, type AppSettings, type StreamEvent, type ToolTimelineEvent } from '../../shared/ipc.js'

type SessionRuntime = {
  /** 不含 system；system 在每次请求时拼入 */
  coreMessages: CoreMessage[]
  controller: AbortController | null
  /** 与终端 key 同会话一致 */
  terminalKey: string
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
  if (settings.provider === 'anthropic') {
    const a = createAnthropic({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl?.trim() || undefined
    })
    return a(settings.model)
  }
  const o = createOpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseUrl?.trim() || 'https://api.openai.com/v1'
  })
  return o(settings.model)
}

function buildSystemPrompt(root: string): string {
  return `你是协助办公与软件开发的智能体。工作区根目录: ${root}。
- 在工具中使用**相对工作区根**的路径（如 src/index.ts），不要使用 ../ 尝试逃出工作区。
- 可调用工具: read_file, write_file, list_dir, search_workspace, run_terminal。
- run_terminal 在沙盒目录（工作区根）下执行 shell 命令。Windows 为 cmd 风格。
- 回答简洁、可执行；修改代码前先 read/list。`
}

function makeTools(
  sessionId: string,
  root: string,
  settings: AppSettings,
  onTool: (e: ToolTimelineEvent) => void
) {
  const termKey = `term:${sessionId}`
  return {
    read_file: tool({
      description: '读取工作区内 UTF-8 文本文件，path 为相对工作区',
      parameters: z.object({ path: z.string() }),
      execute: async ({ path: p }) => {
        const id = `read-${Date.now()}`
        onTool({ kind: 'tool', id, name: 'read_file', status: 'start', args: p })
        const r = await readFileTool(root, p)
        onTool({ kind: 'tool', id, name: 'read_file', status: 'end', result: r.slice(0, 8_000) })
        return r
      }
    }),
    write_file: tool({
      description: '写入或覆盖工作区文件，自动创建父目录',
      parameters: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path: p, content }) => {
        const id = `w-${Date.now()}`
        onTool({ kind: 'tool', id, name: 'write_file', status: 'start', args: p })
        const r = await writeFileTool(root, p, content)
        onTool({ kind: 'tool', id, name: 'write_file', status: 'end', result: r })
        return r
      }
    }),
    list_dir: tool({
      description: '列出目录，path 为相对或空为根，depth 1-3',
      parameters: z.object({ path: z.string().optional(), depth: z.number().int().min(1).max(3).optional() }),
      execute: async ({ path: p, depth }) => {
        const id = `ls-${Date.now()}`
        onTool({ kind: 'tool', id, name: 'list_dir', status: 'start', args: p || '.' })
        const r = await listDirTool(root, p || '.', { depth: depth ?? 2 })
        onTool({ kind: 'tool', id, name: 'list_dir', status: 'end', result: r.slice(0, 8_000) })
        return r
      }
    }),
    search_workspace: tool({
      description: '在文本类源码中按子串搜索，适合找符号',
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const id = `find-${Date.now()}`
        onTool({ kind: 'tool', id, name: 'search_workspace', status: 'start', args: query })
        const r = await searchWorkspace(root, query, { maxFiles: 50 })
        onTool({ kind: 'tool', id, name: 'search_workspace', status: 'end', result: r.slice(0, 8_000) })
        return r
      }
    }),
    run_terminal: tool({
      description: '在工作区根目录执行一条 shell 命令',
      parameters: z.object({ command: z.string() }),
      execute: async ({ command }, { abortSignal }) => {
        const id = `sh-${Date.now()}`
        onTool({ kind: 'tool', id, name: 'run_terminal', status: 'start', args: command })
        if (abortSignal?.aborted) {
          onTool({ kind: 'tool', id, name: 'run_terminal', status: 'end', result: '已取消' })
          return '已取消'
        }
        const r = await runCommand(termKey, root, command, settings.maxTerminalOutputChars)
        onTool({ kind: 'tool', id, name: 'run_terminal', status: 'end', result: r.slice(0, 4_000) })
        return r
      }
    })
  } as const
}

function responseMessageToCore(m: { id: string; role: 'assistant' | 'tool'; content: unknown }): CoreMessage {
  const { id: _i, ...rest } = m as { id: string } & CoreMessage
  return rest as CoreMessage
}

export function bindAgentIpc(wc: WebContents): void {
  webContents = wc
}

export function initSessionState(sessionId: string): void {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      coreMessages: [],
      controller: null,
      terminalKey: `term:${sessionId}`
    })
  }
}

export function getSessionCoreMessages(sessionId: string): CoreMessage[] {
  return sessions.get(sessionId)?.coreMessages ?? []
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
      coreMessages: [],
      controller: null,
      terminalKey: `term:${sessionId}`
    }
    sessions.set(sessionId, session)
    const ac = new AbortController()
    session.controller = ac
    emit({ type: 'run-start', sessionId })
    const batcher = new StreamBatcher(settings.streamFlushMs, settings.streamFlushChars, (t) => {
      emit({ type: 'text-delta', sessionId, text: t })
    })
    const toolNotified = new Set<string>()
    const onTool = (e: ToolTimelineEvent) => {
      emit({ type: 'tool', sessionId, event: e })
    }
    const tools = makeTools(sessionId, root, settings, onTool)
    session.coreMessages.push({ role: 'user', content: userText })
    const system = buildSystemPrompt(root)
    const model = createLanguageModel(settings)
    const messages: CoreMessage[] = [{ role: 'system', content: system }, ...session.coreMessages]
    try {
      const result = streamText({
        model,
        tools,
        maxSteps: 16,
        messages,
        abortSignal: ac.signal
      })
      for await (const part of result.fullStream) {
        if (ac.signal.aborted) break
        const p = part as TextStreamPart<typeof tools>
        if (p.type === 'text-delta') {
          batcher.push(p.textDelta)
        } else if (p.type === 'tool-call' && 'toolName' in p) {
          const id = (p as { toolCallId: string; toolName: string }).toolCallId
          if (!toolNotified.has(id)) {
            toolNotified.add(id)
            onTool({
              kind: 'tool',
              id,
              name: (p as { toolName: string }).toolName,
              status: 'start',
              args: '…'
            })
          }
        } else if (p.type === 'error') {
          onTool({ kind: 'error', message: String((p as { error: unknown }).error) })
        }
      }
      batcher.flush()
      const allSteps = await result.steps
      for (const st of allSteps) {
        for (const m of st.response.messages) {
          session.coreMessages.push(
            responseMessageToCore(m as { id: string; role: 'assistant' | 'tool'; content: unknown })
          )
        }
      }
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