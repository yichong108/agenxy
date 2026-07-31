import {
  buildWorkspaceRunPrompt,
  buildWorkspaceTools,
  type NamedTool,
  type ToolExecutorContext,
  type WorkspacePromptExtras
} from '@agenwork/agent'
import { type AgentComposerMode, type AppSettings } from '@agenwork/shared'

import type { UserIntent } from '@/main/agent/intent/skill-tags'
import { buildSkillBundle } from '@/main/agent/skills/index'
import { userDataPath } from '@/main/store'

export type { NamedTool, ToolExecutorContext } from '@agenwork/agent'

/**
 * Agent 工具集与 prompt 片段（skills；MCP 由 createAgent.mcp.configPath 叠加）。
 */
export type AgentTooling = {
  tools: NamedTool[]
  skillHint: string
}

export type PrepareAgentToolingOptions = {
  /** Build mode: filter skills by intent (empty = load all) */
  filterIntents?: UserIntent[]
}

/**
 * 按 composer mode 组装工具与 skills。
 *
 * 工作区内置工具来自 @agenwork/agent；本函数叠加 Desktop 增强（意图筛选 skills）。
 * MCP 由 createAgent 根据 mcp.configPath 在 agent 内部叠加，勿在此重复绑定。
 *
 * @param mode - ask / build
 * @param sessionId - 会话 ID（terminal key）
 * @param root - 工作区根目录
 * @param settings - 应用设置
 * @param runCtx - 工具 timeline 回调
 * @param options - Build 模式可选意图过滤
 * @returns 工具列表与 prompt 片段
 */
export async function prepareAgentTooling(
  mode: AgentComposerMode,
  sessionId: string,
  root: string,
  settings: AppSettings,
  runCtx: ToolExecutorContext,
  options?: PrepareAgentToolingOptions
): Promise<AgentTooling> {
  const userDataRoot = userDataPath()
  const workspaceTools = buildWorkspaceTools({
    sessionId,
    root,
    settings,
    runCtx,
    userDataRoot,
    mode
  })

  if (mode === 'ask') {
    return { tools: workspaceTools, skillHint: '' }
  }

  const termKey = `term:${sessionId}`
  const filterIntents = options?.filterIntents
  const skillBundle = await buildSkillBundle(
    { root, termKey, settings, runCtx, onTool: runCtx.onTool },
    filterIntents !== undefined ? { filterIntents } : undefined
  )
  const tools = [...skillBundle.tools, ...workspaceTools]
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
  return buildWorkspaceRunPrompt(mode, root, settings, extras)
}
