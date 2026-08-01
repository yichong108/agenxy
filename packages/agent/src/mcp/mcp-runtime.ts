/**
 * MCP stdio 连接池与 Agent 工具绑定。
 *
 * 按 `McpServerEntry.id` 复用连接；配置变更时重连；空闲后自动关闭。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport
} from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerEntry } from '@agenwork/shared'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

import { type ToolExecutorContext } from '../define-tool.js'
import { agentLog } from '../logger.js'
import { loadMcpServersFromConfig } from './load-config.js'
import type { McpProbeResult, McpWarmupServerResult } from './types.js'

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
 * 使用一次性 MCP 客户端连接服务器并执行回调。
 *
 * @param entry - MCP 服务器配置
 * @param fn - 连接成功后的操作
 * @returns 回调返回值
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
  const client = new Client({ name: 'agenwork', version: '0.1.0' })
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
    agentLog.warn(
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
    const client = new Client({ name: 'agenwork', version: '0.1.0' })
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
 *
 * @param entry - MCP 服务器配置
 * @param fn - 在池化客户端上执行的操作
 * @returns 回调返回值
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

/**
 * 应用退出时关闭所有池化 MCP 子进程。
 */
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

/**
 * 从池中移除并关闭指定 id 的 MCP（预热失败时避免留下半开连接）。
 *
 * @param serverId - 服务器条目 id
 */
export async function evictPooledMcpServer(serverId: string): Promise<void> {
  const slot = pooledSlots.get(serverId)
  if (!slot) return
  await closeSlot(serverId, slot)
}

const PROBE_TIMEOUT_MS = 22_000

/**
 * 一次性探测 MCP 服务器（列出工具），不入连接池。
 *
 * @param entry - MCP 服务器配置
 * @returns 探测结果
 */
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
 *
 * @param servers - MCP 服务器列表（通常来自配置文件）
 * @returns 各服务器预热结果
 */
export async function warmupMcpServers(
  servers: McpServerEntry[]
): Promise<McpWarmupServerResult[]> {
  const enabled = servers.filter((s) => s.enabled && s.command.trim())
  const out: McpWarmupServerResult[] = []
  for (const srv of enabled) {
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

/**
 * 从配置文件加载服务器并执行预热。
 *
 * @param configPath - MCP 配置文件路径
 * @returns 各服务器预热结果
 */
export async function warmupMcpServersFromConfig(
  configPath: string
): Promise<McpWarmupServerResult[]> {
  const servers = await loadMcpServersFromConfig(configPath)
  return warmupMcpServers(servers)
}

const MAX_MCP_INSTRUCTIONS_CHARS = 12_000
const MAX_MCP_PROMPTS_LIST = 40
const MAX_MCP_TOOLS_LIST = 60
const MAX_MCP_TOOL_DESC_CHARS = 400

type McpToolListItem = { name: string; description?: string | null }

/** 在单次连接内收集 instructions / prompts / tools 索引 */
async function gatherMcpClientHints(
  client: Client,
  srv: McpServerEntry,
  prelistedTools?: McpToolListItem[]
): Promise<string> {
  const sections: string[] = []
  const instr = client.getInstructions()?.trim()
  if (instr) {
    sections.push(
      `**服务器说明**\n${instr.slice(0, MAX_MCP_INSTRUCTIONS_CHARS)}${instr.length > MAX_MCP_INSTRUCTIONS_CHARS ? '\n…（已截断）' : ''}`
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
          ? `\n…另有 ${prompts.length - MAX_MCP_PROMPTS_LIST} 项未列出`
          : ''
      sections.push(
        [
          '**服务器已注册的 Prompt 模板（仅索引；调用 getPrompt 展开内容）**',
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
        ? `\n…另有 ${tools.length - MAX_MCP_TOOLS_LIST} 项未列出`
        : ''
    sections.push(
      [
        '**服务器已注册的工具（名称与描述；参数以宿主绑定工具的 schema 为准）**',
        `${lines.join('\n')}${more}`
      ].join('\n')
    )
  }
  if (!sections.length) return ''
  return `### ${srv.name}（id: ${srv.id}）\n${sections.join('\n\n')}`
}

/**
 * 收集已启用 MCP 的 instructions / prompts / tools 索引，注入对话上下文。
 *
 * @param servers - MCP 服务器列表
 * @returns 合并后的 markdown 提示；无内容时为空串
 */
export async function collectMcpServerContextHints(servers: McpServerEntry[]): Promise<string> {
  const enabled = servers.filter((s) => s.enabled && s.command.trim())
  const blocks: string[] = []
  for (const srv of enabled) {
    try {
      await withPooledMcpClient(srv, async (client) => {
        const block = await gatherMcpClientHints(client, srv)
        if (block) blocks.push(block)
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      agentLog.warn(`[mcp] Failed to collect server hints ${srv.name} (${srv.id}): ${message}`)
    }
  }
  if (!blocks.length) return ''
  return `## MCP 服务器上下文（说明 / prompt / 工具索引）\n\n${blocks.join('\n\n---\n\n')}`
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

/** buildMcpTools 的返回值 */
export type BuildMcpToolsResult = {
  tools: ToolSet
  contextHints: string
  /** 参与构建的完整服务器列表（含未启用），供 prompt 元信息使用 */
  servers: McpServerEntry[]
}

/**
 * 为已启用的 MCP 服务器生成 Agent 工具（池化 stdio 连接，空闲自动断开）。
 *
 * @param servers - MCP 服务器列表
 * @param runCtx - 工具 timeline 上下文
 * @returns ToolSet、上下文提示与原始服务器列表
 */
export async function buildMcpTools(
  servers: McpServerEntry[],
  runCtx: ToolExecutorContext
): Promise<BuildMcpToolsResult> {
  const enabled = servers.filter((s) => s.enabled && s.command.trim())
  const out: ToolSet = {}
  const hintBlocks: string[] = []
  const onTool = runCtx.onTool

  for (const srv of enabled) {
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
            t.description?.trim() || `MCP 工具 ${mcpToolName}`,
            `服务器：${srv.name}（stdio）`,
            schemaHint ? `inputSchema：${schemaHint}` : ''
          ].filter(Boolean)

          out[lcName] = tool({
            description: descParts.join('\n'),
            parameters: z.object({}).passthrough(),
            execute: async (input) => {
              const args = (typeof input === 'object' && input !== null ? input : {}) as Record<
                string,
                unknown
              >
              const id = `mcp-${Date.now()}`
              const startedAt = Date.now()
              const argStr = JSON.stringify(args).slice(0, 2_000)
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
                    arguments: args
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
            }
          })
        }
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      agentLog.warn(`[mcp] Skipping server ${srv.name} (${srv.id}): ${message}`)
    }
  }
  const contextHints = hintBlocks.length
    ? `## MCP 服务器上下文（说明 / prompt / 工具索引）\n\n${hintBlocks.join('\n\n---\n\n')}`
    : ''
  return { tools: out, contextHints, servers }
}

/**
 * 从配置文件加载 MCP 并生成 Agent 工具。
 *
 * @param configPath - MCP 配置文件路径
 * @param runCtx - 工具 timeline 上下文
 * @returns 工具列表、上下文提示与服务器列表
 */
export async function buildMcpToolsFromConfig(
  configPath: string,
  runCtx: ToolExecutorContext
): Promise<BuildMcpToolsResult> {
  const servers = await loadMcpServersFromConfig(configPath)
  return buildMcpTools(servers, runCtx)
}

/** @deprecated 使用 buildMcpTools */
export const buildMcpLangChainTools = buildMcpTools
