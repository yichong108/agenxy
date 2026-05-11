import { tool } from '@langchain/core/tools'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'

import { logScope } from '@/main/logger'
import type {
  AppSettings,
  McpProbeResult,
  McpServerEntry,
  McpWarmupServerResult,
  ToolTimelineEvent
} from '@/shared/ipc'

const mcpLog = logScope('mcp')

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
  if (r.isError) out = `[MCP Tool Error] ${out}`
  return out || '(empty)'
}

/**
 * 使用MCP客户端连接MCP服务器
 */
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
  const client = new Client({ name: 'agenxy', version: '0.1.0' })
  await client.connect(transport)
  try {
    return await fn(client)
  } finally {
    await client.close()
  }
}

/** 无 RPC 时关闭 stdio 子进程；新一轮 list/call 会重连 */
const MCP_POOL_IDLE_MS = 90_000

function mcpLaunchSignature(entry: McpServerEntry): string {
  const flat = flattenMcpEnvForSpawn(entry.env)
  const envPart = Object.keys(flat)
    .sort()
    .map((k) => `${k}\u0001${flat[k]}`)
    .join('\u0002')
  return JSON.stringify({
    c: entry.command.trim(),
    a: entry.args ?? [],
    w: entry.cwd?.trim() ?? '',
    e: envPart
  })
}

type PooledSlot = {
  launchKey: string
  client: Client
  idleTimer: ReturnType<typeof setTimeout> | undefined
  /** 同一 stdio 会话上串行执行 MCP 请求，避免多工具并发打乱传输 */
  exclusiveTail: Promise<unknown>
}

const pooledSlots = new Map<string, PooledSlot>()
const ensureTailByServer = new Map<string, Promise<unknown>>()

function runEnsureSerialized<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  const prev = ensureTailByServer.get(serverId) ?? Promise.resolve()
  const p = prev.then(() => fn())
  ensureTailByServer.set(
    serverId,
    p.then(
      () => {},
      () => {}
    )
  )
  return p
}

function clearIdleTimer(slot: PooledSlot): void {
  if (slot.idleTimer !== undefined) {
    clearTimeout(slot.idleTimer)
    slot.idleTimer = undefined
  }
}

async function closeSlot(serverId: string, slot: PooledSlot): Promise<void> {
  clearIdleTimer(slot)
  if (pooledSlots.get(serverId) === slot) pooledSlots.delete(serverId)
  try {
    await slot.client.close()
  } catch (e) {
    mcpLog.warn(
      `[mcp-pool] Failed to close connection ${serverId}:`,
      e instanceof Error ? e.message : e
    )
  }
}

function scheduleIdleClose(serverId: string, slot: PooledSlot): void {
  clearIdleTimer(slot)
  slot.idleTimer = setTimeout(() => {
    slot.idleTimer = undefined
    if (pooledSlots.get(serverId) !== slot) return
    void closeSlot(serverId, slot)
  }, MCP_POOL_IDLE_MS)
}

async function ensurePooledSlot(entry: McpServerEntry): Promise<PooledSlot> {
  if (!entry.command?.trim()) throw new Error('command cannot be empty')
  return runEnsureSerialized(entry.id, async () => {
    const launchKey = mcpLaunchSignature(entry)
    const existing = pooledSlots.get(entry.id)
    if (existing && existing.launchKey === launchKey) {
      clearIdleTimer(existing)
      return existing
    }
    if (existing) await closeSlot(entry.id, existing)

    const transport = new StdioClientTransport({
      command: entry.command.trim(),
      args: entry.args ?? [],
      cwd: entry.cwd?.trim() || undefined,
      env: { ...getDefaultEnvironment(), ...flattenMcpEnvForSpawn(entry.env) },
      stderr: 'pipe'
    })
    const client = new Client({ name: 'agenxy', version: '0.1.0' })
    await client.connect(transport)
    const slot: PooledSlot = {
      launchKey,
      client,
      idleTimer: undefined,
      exclusiveTail: Promise.resolve()
    }
    pooledSlots.set(entry.id, slot)
    return slot
  })
}

function runPooledExclusive<T>(slot: PooledSlot, fn: () => Promise<T>): Promise<T> {
  const run = slot.exclusiveTail.then(() => fn())
  slot.exclusiveTail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/**
 * 按 `McpServerEntry.id` 复用一条 stdio 连接；`command/args/cwd/env` 变化会丢弃旧连接并重连。
 * 空闲 `MCP_POOL_IDLE_MS` 后自动关闭子进程。探测接口仍用一次性 `withMcpClient`。
 */
async function withPooledMcpClient<T>(
  entry: McpServerEntry,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const slot = await ensurePooledSlot(entry)
  try {
    return await runPooledExclusive(slot, () => fn(slot.client))
  } finally {
    const current = pooledSlots.get(entry.id)
    if (current === slot) scheduleIdleClose(entry.id, slot)
  }
}

/** 应用退出时关闭所有池化 MCP 子进程 */
export async function disposeMcpConnectionPool(): Promise<void> {
  const snapshots = [...pooledSlots.values()]
  pooledSlots.clear()
  for (const slot of snapshots) {
    clearIdleTimer(slot)
    try {
      await slot.client.close()
    } catch {
      /* ignore */
    }
  }
}

/** 从池中移除并关闭指定 id 的 MCP（预热失败时避免留下半开连接） */
export async function evictPooledMcpServer(serverId: string): Promise<void> {
  const slot = pooledSlots.get(serverId)
  if (!slot) return
  await closeSlot(serverId, slot)
}

const PROBE_TIMEOUT_MS = 22_000

export async function probeMcpServer(entry: McpServerEntry): Promise<McpProbeResult> {
  if (!entry.command?.trim()) {
    return { ok: false, error: 'command cannot be empty' }
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
        setTimeout(
          () => reject(new Error(`Probe timeout (>${PROBE_TIMEOUT_MS}ms)`)),
          PROBE_TIMEOUT_MS
        )
      })
    ])
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message }
  }
}

/**
 * 对已启用的 MCP 逐个池化建连并 `listTools`：成功则连接留在池中供 Agent 复用（直至空闲超时）；
 * 失败则 `evict` 该 id，避免坏连接占位。
 */
export async function warmupMcpServers(settings: AppSettings): Promise<McpWarmupServerResult[]> {
  const servers = (settings.mcpServers ?? []).filter((s) => s.enabled && s.command.trim())
  const out: McpWarmupServerResult[] = []
  for (const srv of servers) {
    const run = async (): Promise<McpWarmupServerResult> => {
      try {
        const toolCount = await withPooledMcpClient(srv, async (client) => {
          const { tools } = await client.listTools()
          return (tools ?? []).length
        })
        return { id: srv.id, name: srv.name, ok: true as const, toolCount }
      } catch (e) {
        await evictPooledMcpServer(srv.id)
        const message = e instanceof Error ? e.message : String(e)
        return { id: srv.id, name: srv.name, ok: false as const, error: message }
      }
    }
    try {
      const row = await Promise.race([
        run(),
        new Promise<McpWarmupServerResult>((_, reject) => {
          setTimeout(
            () => reject(new Error(`Warmup timeout (>${PROBE_TIMEOUT_MS}ms)`)),
            PROBE_TIMEOUT_MS
          )
        })
      ])
      out.push(row)
    } catch (e) {
      await evictPooledMcpServer(srv.id)
      const message = e instanceof Error ? e.message : String(e)
      out.push({ id: srv.id, name: srv.name, ok: false, error: message })
    }
  }
  return out
}

type RunCtx = { runId: string; traceId: string }

const MAX_MCP_INSTRUCTIONS_CHARS = 12_000
const MAX_MCP_PROMPTS_LIST = 40
const MAX_MCP_TOOLS_LIST = 60
const MAX_MCP_TOOL_DESC_CHARS = 400

type McpToolListItem = { name: string; description?: string | null }

/** Collect within single connection: initialize instructions, prompts index, tools index (most servers only have tools, previously causing empty hint) */
async function gatherMcpClientHints(
  client: Client,
  srv: McpServerEntry,
  prelistedTools?: McpToolListItem[]
): Promise<string> {
  const sections: string[] = []
  const instr = client.getInstructions()?.trim()
  if (instr) {
    sections.push(
      `**Server Instructions**\n${instr.slice(0, MAX_MCP_INSTRUCTIONS_CHARS)}${instr.length > MAX_MCP_INSTRUCTIONS_CHARS ? '\n...(truncated)' : ''}`
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
          ? `\n... and ${prompts.length - MAX_MCP_PROMPTS_LIST} more not listed`
          : ''
      sections.push(
        [
          '**Server Registered Prompt Templates (index only; call getPrompt to expand content)**',
          `${lines.join('\n')}${more}`
        ].join('\n')
      )
    }
  } catch {
    // Servers without prompts capability will fail, ignore
  }
  let tools: McpToolListItem[] = prelistedTools ?? []
  if (!prelistedTools) {
    try {
      const { tools: listed } = await client.listTools()
      tools = (listed ?? []) as McpToolListItem[]
    } catch {
      tools = []
    }
  }
  if (tools.length) {
    const lines = tools.slice(0, MAX_MCP_TOOLS_LIST).map((t) => {
      const raw = t.description?.trim()
      const desc =
        raw && raw.length > MAX_MCP_TOOL_DESC_CHARS
          ? `${raw.slice(0, MAX_MCP_TOOL_DESC_CHARS)}…`
          : raw
      return `- \`${t.name}\`${desc ? ` — ${desc}` : ''}`
    })
    const more =
      tools.length > MAX_MCP_TOOLS_LIST
        ? `\n... and ${tools.length - MAX_MCP_TOOLS_LIST} more not listed`
        : ''
    sections.push(
      [
        '**Server Registered Tools (name and description; parameters use host-bound tool schema)**',
        `${lines.join('\n')}${more}`
      ].join('\n')
    )
  }
  if (!sections.length) return ''
  return `### ${srv.name}（id: ${srv.id}）\n${sections.join('\n\n')}`
}

/** Fetch individual MCP instructions / prompts / tools index when tools are not built, for injection into pure dialogue mode context */
export async function collectMcpServerContextHints(settings: AppSettings): Promise<string> {
  const servers = (settings.mcpServers ?? []).filter((s) => s.enabled && s.command.trim())
  const blocks: string[] = []
  for (const srv of servers) {
    try {
      await withPooledMcpClient(srv, async (client) => {
        const block = await gatherMcpClientHints(client, srv)
        if (block) blocks.push(block)
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      mcpLog.warn(`[mcp] Failed to collect server hints ${srv.name} (${srv.id}): ${message}`)
    }
  }
  if (!blocks.length) return ''
  return `## MCP Server Context (instructions / prompts / tools index)\n\n${blocks.join('\n\n---\n\n')}`
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

/** 为已启用的 MCP 服务器生成 LangChain 工具（池化 stdio 连接，空闲自动断开）；列举工具与后续 callTool 复用同一条连接（按服务器 id） */
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
      await withPooledMcpClient(srv, async (client) => {
        const { tools: listed } = await client.listTools()
        const hint = await gatherMcpClientHints(client, srv, listed ?? [])
        if (hint) hintBlocks.push(hint)
        let idx = 0
        for (const t of listed ?? []) {
          const mcpToolName = t.name
          const baseLc = `mcp_${safeMcpSegment(srv.id)}__${safeMcpSegment(mcpToolName)}`
          const lcName = `${baseLc}_${idx}`
          idx += 1
          const schemaHint = t.inputSchema ? truncateSchema(t.inputSchema) : ''
          const descParts = [
            t.description?.trim() || `MCP tool ${mcpToolName}`,
            `Server: ${srv.name} (stdio)`,
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
                const result = await withPooledMcpClient(srv, async (c) => {
                  return await c.callTool({
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
      mcpLog.warn(`[mcp] Skipping server ${srv.name} (${srv.id}): ${message}`)
    }
  }
  const contextHints = hintBlocks.length
    ? `## MCP Server Context (instructions / prompts / tools index)\n\n${hintBlocks.join('\n\n---\n\n')}`
    : ''
  return { tools: out, contextHints }
}
