import { tool } from '@langchain/core/tools'
/* eslint-disable import/no-unresolved -- @modelcontextprotocol/sdk 使用 package exports 子路径 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js'
/* eslint-enable import/no-unresolved */
import { z } from 'zod'

import type {
  AppSettings,
  McpProbeResult,
  McpServerEntry,
  ToolTimelineEvent
} from '../../shared/ipc.js'

function safeMcpSegment(s: string): string {
  const t = s.trim().replace(/[^a-zA-Z0-9_-]/g, '_')
  return t.slice(0, 48) || 'srv'
}

/** OS / stdio 子进程要求 Record<string, string>；嵌套 JSON 存盘后在启动时 stringify */
function flattenMcpEnvForSpawn(env?: Record<string, unknown>): Record<string, string> {
  if (!env) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (typeof v === 'string') out[k] = v
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
    else out[k] = JSON.stringify(v)
  }
  return out
}

function formatCallToolResult(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result).slice(0, 24_000)
  const r = result as {
    content?: unknown[]
    isError?: boolean
  }
  const parts: string[] = []
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      if (block && typeof block === 'object' && 'type' in block) {
        const b = block as { type?: string; text?: string }
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
        else parts.push(JSON.stringify(block))
      } else {
        parts.push(String(block))
      }
    }
  }
  let out = parts.join('\n').slice(0, 24_000)
  if (r.isError) out = `[MCP 工具错误] ${out}`
  return out || '(empty)'
}

async function withMcpClient<T>(
  entry: McpServerEntry,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const transport = new StdioClientTransport({
    command: entry.command.trim(),
    args: entry.args ?? [],
    cwd: entry.cwd?.trim() || undefined,
    env: { ...getDefaultEnvironment(), ...flattenMcpEnvForSpawn(entry.env) },
    stderr: 'pipe'
  })
  const client = new Client({ name: 'agent-weave', version: '0.1.0' })
  await client.connect(transport)
  try {
    return await fn(client)
  } finally {
    await client.close()
  }
}

const PROBE_TIMEOUT_MS = 22_000

export async function probeMcpServer(entry: McpServerEntry): Promise<McpProbeResult> {
  if (!entry.command?.trim()) {
    return { ok: false, error: 'command 不能为空' }
  }
  const run = async (): Promise<McpProbeResult> => {
    return await withMcpClient(entry, async (client) => {
      const { tools } = await client.listTools()
      const list = (tools ?? []).map((t) => ({
        name: t.name,
        description: typeof t.description === 'string' ? t.description : undefined
      }))
      return { ok: true, tools: list }
    })
  }
  try {
    return await Promise.race([
      run(),
      new Promise<McpProbeResult>((_, reject) => {
        setTimeout(() => reject(new Error(`探测超时（>${PROBE_TIMEOUT_MS}ms）`)), PROBE_TIMEOUT_MS)
      })
    ])
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message }
  }
}

type RunCtx = { runId: string; traceId: string }

const MAX_MCP_INSTRUCTIONS_CHARS = 12_000
const MAX_MCP_PROMPTS_LIST = 40

/** 单次连接内收集 MCP 在 initialize 中给出的 instructions，以及 prompts 列表（名称与说明），供拼入系统提示 */
async function gatherMcpClientHints(client: Client, srv: McpServerEntry): Promise<string> {
  const sections: string[] = []
  const instr = client.getInstructions()?.trim()
  if (instr) {
    sections.push(
      `**服务端指令（instructions）**\n${instr.slice(0, MAX_MCP_INSTRUCTIONS_CHARS)}${instr.length > MAX_MCP_INSTRUCTIONS_CHARS ? '\n…(已截断)' : ''}`
    )
  }
  try {
    const { prompts } = await client.listPrompts()
    if (prompts?.length) {
      const lines = prompts.slice(0, MAX_MCP_PROMPTS_LIST).map((p) => {
        const desc = p.description?.trim()
        return `- \`${p.name}\`${desc ? ` — ${desc}` : ''}`
      })
      const more =
        prompts.length > MAX_MCP_PROMPTS_LIST
          ? `\n… 另有 ${prompts.length - MAX_MCP_PROMPTS_LIST} 个未列出`
          : ''
      sections.push(
        [
          '**服务端注册的提示模板（仅索引；展开内容需宿主调用 getPrompt）**',
          `${lines.join('\n')}${more}`
        ].join('\n')
      )
    }
  } catch {
    // 未实现 prompts 能力的服务器会失败，忽略即可
  }
  if (!sections.length) return ''
  return `### ${srv.name}（id: ${srv.id}）\n${sections.join('\n\n')}`
}

/** 在未构建工具时单独拉取各 MCP 的 instructions / prompts 索引，供纯对话模式注入上下文 */
export async function collectMcpServerContextHints(settings: AppSettings): Promise<string> {
  const servers = (settings.mcpServers ?? []).filter((s) => s.enabled && s.command.trim())
  const blocks: string[] = []
  for (const srv of servers) {
    try {
      await withMcpClient(srv, async (client) => {
        const block = await gatherMcpClientHints(client, srv)
        if (block) blocks.push(block)
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.warn(`[mcp] 收集服务端提示失败 ${srv.name} (${srv.id}): ${message}`)
    }
  }
  if (!blocks.length) return ''
  return `## MCP 服务端上下文（initialize instructions / prompts 索引）\n\n${blocks.join('\n\n---\n\n')}`
}

function truncateSchema(schema: unknown, max = 1800): string {
  try {
    const s = JSON.stringify(schema)
    if (s.length <= max) return s
    return `${s.slice(0, max)}…`
  } catch {
    return ''
  }
}

/** 为已启用的 MCP 服务器生成 LangChain 工具（每次调用会拉起子进程连接）；同一次连接内附带服务端 instructions / prompts 索引文本 */
export async function buildMcpLangChainTools(
  settings: AppSettings,
  runCtx: RunCtx,
  onTool: (e: ToolTimelineEvent) => void
): Promise<{ tools: ReturnType<typeof tool>[]; contextHints: string }> {
  const servers = (settings.mcpServers ?? []).filter((s) => s.enabled && s.command.trim())
  const out: ReturnType<typeof tool>[] = [] as ReturnType<typeof tool>[]
  const hintBlocks: string[] = []
  for (const srv of servers) {
    try {
      await withMcpClient(srv, async (client) => {
        const hint = await gatherMcpClientHints(client, srv)
        if (hint) hintBlocks.push(hint)
        const { tools: listed } = await client.listTools()
        let idx = 0
        for (const t of listed ?? []) {
          const mcpToolName = t.name
          const baseLc = `mcp_${safeMcpSegment(srv.id)}__${safeMcpSegment(mcpToolName)}`
          const lcName = `${baseLc}_${idx}`
          idx += 1
          const schemaHint = t.inputSchema ? truncateSchema(t.inputSchema) : ''
          const descParts = [
            t.description?.trim() || `MCP 工具 ${mcpToolName}`,
            `服务器: ${srv.name}（stdio）`,
            schemaHint ? `inputSchema: ${schemaHint}` : ''
          ].filter(Boolean)

          const wrapped = tool(
            async (input: Record<string, unknown>) => {
              const id = `mcp-${Date.now()}`
              const startedAt = Date.now()
              const argStr = JSON.stringify(input).slice(0, 2_000)
              onTool({
                kind: 'tool',
                id,
                name: lcName,
                status: 'start',
                args: argStr,
                runId: runCtx.runId,
                traceId: runCtx.traceId,
                timestampMs: startedAt
              })
              try {
                const result = await withMcpClient(srv, async (client) => {
                  return await client.callTool({
                    name: mcpToolName,
                    arguments: input
                  })
                })
                const text = formatCallToolResult(result)
                onTool({
                  kind: 'tool',
                  id,
                  name: lcName,
                  status: 'end',
                  result: text.slice(0, 12_000),
                  runId: runCtx.runId,
                  traceId: runCtx.traceId,
                  timestampMs: Date.now(),
                  durationMs: Date.now() - startedAt
                })
                return text
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                onTool({
                  kind: 'tool',
                  id,
                  name: lcName,
                  status: 'end',
                  result: message,
                  runId: runCtx.runId,
                  traceId: runCtx.traceId,
                  timestampMs: Date.now(),
                  durationMs: Date.now() - startedAt
                })
                throw err
              }
            },
            {
              name: lcName,
              description: descParts.join('\n'),
              schema: z.object({}).passthrough()
            }
          )
          out.push(wrapped as ReturnType<typeof tool>)
        }
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.warn(`[mcp] 跳过服务器 ${srv.name} (${srv.id}): ${message}`)
    }
  }
  const contextHints = hintBlocks.length
    ? `## MCP 服务端上下文（initialize instructions / prompts 索引）\n\n${hintBlocks.join('\n\n---\n\n')}`
    : ''
  return { tools: out, contextHints }
}
