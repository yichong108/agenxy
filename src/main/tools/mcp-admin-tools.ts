import { tool } from '@langchain/core/tools'
import { z } from 'zod'

import type { AppSettings, McpServerEntry, ToolTimelineEvent } from '../../shared/ipc.js'
import { probeMcpServer } from '../mcp/mcp-runtime.js'

/** 不向模型暴露取值的 env 键（仍会在结果中占位，便于知晓「已配置」） */
function isSensitiveEnvKey(key: string): boolean {
  const u = key.toUpperCase()
  if (/PASSWORD|PASSWD|SECRET|PRIVATE_KEY|API_KEY|BEARER|AUTHORIZATION|CREDENTIAL/i.test(u)) {
    return true
  }
  if (/_TOKEN$/i.test(u) && !/_TIMEOUT$/i.test(u)) return true
  return false
}

function envForModel(env?: Record<string, unknown>): Record<string, string> {
  if (!env) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (isSensitiveEnvKey(k)) {
      out[k] = '[已在本机配置，不向模型暴露]'
      continue
    }
    const raw = typeof v === 'string' ? v : JSON.stringify(v)
    out[k] = raw.length > 280 ? `${raw.slice(0, 280)}…` : raw
  }
  return out
}

function summarizeServer(s: McpServerEntry) {
  return {
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    command: s.command,
    args: s.args ?? [],
    cwd: s.cwd ?? null,
    env: envForModel(s.env)
  }
}

function findServerEntry(servers: McpServerEntry[], server_id: string): McpServerEntry | undefined {
  const q = server_id.trim()
  if (!q) return undefined
  return servers.find((x) => x.id === q) ?? servers.find((x) => x.name === q)
}

export function buildMcpAdminTools(
  settings: AppSettings,
  runCtx: { runId: string; traceId: string },
  onTool: (e: ToolTimelineEvent) => void
) {
  const meta = { runId: runCtx.runId, traceId: runCtx.traceId }

  return [
    tool(
      async () => {
        const id = `mcp-list-${Date.now()}`
        const startedAt = Date.now()
        onTool({
          kind: 'tool',
          id,
          name: 'mcp_list_servers',
          status: 'start',
          runId: meta.runId,
          traceId: meta.traceId,
          timestampMs: startedAt
        })
        const servers = (settings.mcpServers ?? []).map(summarizeServer)
        const payload = {
          servers,
          note: '密码、Token 等敏感 env 已脱敏。实际连接由本应用在启动 MCP 子进程时注入；不要向用户重复索要已在应用中配置过的口令。'
        }
        const text = JSON.stringify(payload, null, 2)
        onTool({
          kind: 'tool',
          id,
          name: 'mcp_list_servers',
          status: 'end',
          result: text.slice(0, 8_000),
          runId: meta.runId,
          traceId: meta.traceId,
          timestampMs: Date.now(),
          durationMs: Date.now() - startedAt
        })
        return text
      },
      {
        name: 'mcp_list_servers',
        description:
          '列出本应用已配置的 MCP（stdio）服务器：id、名称、是否启用、command、args、cwd、环境变量（敏感值已脱敏）。当需要了解「有哪些 MCP」「数据库主机/库名等非口令信息」或回答用户关于 MCP 配置的问题时，应优先调用本工具，勿凭空虚构。',
        schema: z.object({})
      }
    ),
    tool(
      async ({ server_id }) => {
        const id = `mcp-inspect-${Date.now()}`
        const startedAt = Date.now()
        onTool({
          kind: 'tool',
          id,
          name: 'mcp_inspect_server',
          status: 'start',
          args: server_id,
          runId: meta.runId,
          traceId: meta.traceId,
          timestampMs: startedAt
        })
        const rows = settings.mcpServers ?? []
        const entry = findServerEntry(rows, server_id)
        if (!entry) {
          const err = JSON.stringify(
            {
              ok: false,
              error: '未找到该服务器。请先用 mcp_list_servers 查看 id 或 name。',
              server_id
            },
            null,
            2
          )
          onTool({
            kind: 'tool',
            id,
            name: 'mcp_inspect_server',
            status: 'end',
            result: err,
            runId: meta.runId,
            traceId: meta.traceId,
            timestampMs: Date.now(),
            durationMs: Date.now() - startedAt
          })
          return err
        }
        if (!entry.command?.trim()) {
          const err = JSON.stringify({ ok: false, error: '该条目 command 为空，无法探测' }, null, 2)
          onTool({
            kind: 'tool',
            id,
            name: 'mcp_inspect_server',
            status: 'end',
            result: err,
            runId: meta.runId,
            traceId: meta.traceId,
            timestampMs: Date.now(),
            durationMs: Date.now() - startedAt
          })
          return err
        }
        const r = await probeMcpServer(entry)
        const text = JSON.stringify(
          r.ok
            ? { ok: true, server: entry.name, tools: r.tools }
            : { ok: false, server: entry.name, error: r.error },
          null,
          2
        )
        onTool({
          kind: 'tool',
          id,
          name: 'mcp_inspect_server',
          status: 'end',
          result: text.slice(0, 12_000),
          runId: meta.runId,
          traceId: meta.traceId,
          timestampMs: Date.now(),
          durationMs: Date.now() - startedAt
        })
        return text
      },
      {
        name: 'mcp_inspect_server',
        description:
          '拉起指定 MCP 子进程并列出其提供的工具名与说明（与界面「测试」类似，不执行具体 MCP 工具）。server_id 为 mcp_list_servers 返回的 id，或与配置完全一致的 name。',
        schema: z.object({
          server_id: z.string().describe('MCP 服务器配置 id 或 name')
        })
      }
    )
  ]
}
