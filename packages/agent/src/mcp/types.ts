/**
 * MCP 探测 / 预热结果类型（宿主 UI 与 agent 共用）。
 */

/** 探测到的单个工具摘要 */
export type McpProbeToolInfo = {
  name: string
  description?: string
}

/** 单次 MCP 服务器探测结果（一次性连接，不入池） */
export type McpProbeResult = { ok: true; tools: McpProbeToolInfo[] } | { ok: false; error: string }

/** 单台 MCP 池化预热成功 */
export type McpWarmupServerOk = {
  id: string
  name: string
  ok: true
  toolCount: number
}

/** 单台 MCP 池化预热失败 */
export type McpWarmupServerErr = {
  id: string
  name: string
  ok: false
  error: string
}

/** 单台 MCP 池化预热结果 */
export type McpWarmupServerResult = McpWarmupServerOk | McpWarmupServerErr
