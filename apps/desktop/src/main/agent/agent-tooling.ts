import {
  buildWorkspaceRunPrompt,
  buildWorkspaceTools,
  mergeToolSets,
  type ToolOnTool,
  type ToolSet,
  type WorkspacePromptExtras
} from '@agenwork/agent'
import { type AgentComposerMode, type AppSettings } from '@agenwork/shared'

import { buildSkillBundle } from '@/main/agent/skills/index'
import { userDataPath } from '@/main/store'
import type { ToolTimelineEvent } from '@/shared/ipc'

export type { ToolOnTool, ToolSet } from '@agenwork/agent'

/**
 * Agent 工具集与 prompt 片段（skills；MCP 由 createAgent.mcp.configPath 叠加）。
 */
export type AgentTooling = {
  tools: ToolSet
  skillHint: string
}

/**
 * 按 composer mode 组装工具与 skills。
 *
 * 工作区内置工具来自 @agenwork/agent；本函数叠加 Desktop skills。
 * MCP 由 createAgent 根据 mcp.configPath 在 agent 内部叠加，勿在此重复绑定。
 *
 * @param mode - ask / build
 * @param terminalKey - Shell 隔离键（由宿主从 session 派生）
 * @param root - 工作区根目录
 * @param settings - 应用设置
 * @param onTool - 工具生命周期观察回调
 * @returns 工具 ToolSet 与 prompt 片段
 */
export async function prepareAgentTooling(
  mode: AgentComposerMode,
  terminalKey: string,
  root: string,
  settings: AppSettings,
  onTool: ToolOnTool
): Promise<AgentTooling> {
  const userDataRoot = userDataPath()
  const termKey = terminalKey.trim() || 'term:default'
  const workspaceTools = buildWorkspaceTools({
    terminalKey: termKey,
    root,
    tavilyApiKey: settings.tavilyApiKey,
    onTool,
    userDataRoot,
    mode
  })

  if (mode === 'ask') {
    return { tools: workspaceTools, skillHint: '' }
  }

  /** Desktop skills 使用 ToolTimelineEvent；仅将 tool 调用观察回传给 agent onTool */
  const onSkillTool = (e: ToolTimelineEvent) => {
    if (e.kind !== 'tool') return
    onTool({
      id: e.id,
      name: e.name,
      status: e.status,
      args: e.args,
      result: e.result,
      timestampMs: e.timestampMs,
      durationMs: e.durationMs
    })
  }
  const skillBundle = await buildSkillBundle({
    root,
    termKey,
    settings,
    runCtx: {},
    onTool: onSkillTool
  })
  const tools = mergeToolSets(skillBundle.tools, workspaceTools)
  return {
    tools,
    skillHint: skillBundle.hint
  }
}

/**
 * 根据 mode 与 tooling 组装 ReAct system prompt。
 *
 * MCP 元信息仍从 settings.mcpServers 读取（与 mcp.json 由 store 同步）；
 * MCP 工具上下文提示由 createAgent 在叠加 MCP 时追加。
 *
 * @param mode - composer mode
 * @param root - 工作区根
 * @param settings - 应用设置
 * @param tooling - prepareAgentTooling 结果
 * @returns 完整 system prompt 字符串
 */
export function buildAgentRunPrompt(
  mode: AgentComposerMode,
  root: string,
  settings: AppSettings,
  tooling: AgentTooling
): string {
  const mcpEnabled = (settings.mcpServers ?? []).filter((s) => s.enabled && s.command.trim())
  const extras: WorkspacePromptExtras = {
    skillHint: tooling.skillHint,
    includeMcpMeta: true,
    enabledMcpNames: mcpEnabled.map((s) => s.name || s.id),
    hasDisabledMcpEntries: (settings.mcpServers?.length ?? 0) > 0 && mcpEnabled.length === 0,
    hasUserDataGlob: true
  }
  return buildWorkspaceRunPrompt(mode, root, settings.tavilyApiKey, extras)
}
