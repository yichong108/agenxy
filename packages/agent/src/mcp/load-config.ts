/**
 * MCP 配置文件读写 — 支持 Cursor 形态与本应用数组形态。
 */

import { promises as fs, writeFileSync } from 'node:fs'

import { type McpServerEntry, parseMcpServersFromUnknown } from '@openworker/shared'

/**
 * 从配置文件路径加载 MCP 服务器列表。
 *
 * 文件不存在时返回空数组；解析失败则抛出。
 * 支持：
 * - `{ "mcpServers": { "name": { "command", "args", ... } } }`（Cursor）
 * - `{ "mcpServers": [ { "id", "name", "command", ... } ] }`（本应用）
 * - 根级服务器数组
 *
 * @param configPath - MCP 配置文件绝对路径
 * @returns 解析后的服务器条目
 * @throws {Error} 文件存在但 JSON 非法或读取失败（ENOENT 除外）
 */
export async function loadMcpServersFromConfig(configPath: string): Promise<McpServerEntry[]> {
  const trimmed = configPath.trim()
  if (!trimmed) return []

  let rawText: string
  try {
    rawText = await fs.readFile(trimmed, 'utf8')
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err?.code === 'ENOENT') return []
    throw e
  }

  const text = rawText.trim()
  if (!text) return []

  const parsed = JSON.parse(text) as unknown
  if (Array.isArray(parsed)) {
    return parseMcpServersFromUnknown(parsed)
  }
  return parseMcpServersFromUnknown(parsed)
}

/**
 * 将 MCP 服务器列表写入配置文件（本应用数组形态，保留 id/enabled）。
 *
 * @param configPath - 目标文件绝对路径
 * @param servers - 要持久化的服务器列表
 */
export async function writeMcpConfigFile(
  configPath: string,
  servers: McpServerEntry[]
): Promise<void> {
  const trimmed = configPath.trim()
  if (!trimmed) throw new Error('mcp configPath cannot be empty')
  const payload = {
    mcpServers: servers
  }
  await fs.writeFile(trimmed, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

/**
 * 同步写入 MCP 配置文件（Electron 主进程设置落盘用）。
 *
 * @param configPath - 目标文件绝对路径
 * @param servers - 要持久化的服务器列表
 */
export function writeMcpConfigFileSync(configPath: string, servers: McpServerEntry[]): void {
  const trimmed = configPath.trim()
  if (!trimmed) throw new Error('mcp configPath cannot be empty')
  const payload = {
    mcpServers: servers
  }
  writeFileSync(trimmed, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}
