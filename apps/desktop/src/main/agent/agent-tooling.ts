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
import { buildMcpTools } from '@/main/mcp/mcp-runtime'
import { userDataPath } from '@/main/store'

export type { NamedTool, ToolExecutorContext } from '@agenwork/agent'

/**
 * Agent 工具集与 prompt 片段（skills / MCP hints）。
 */
export type AgentTooling = {
  tools: NamedTool[]
  skillHint: string
  mcpContextHints: string
}

export type PrepareAgentToolingOptions = {
  /** Build mode: filter skills by intent (empty = load all) */
  filterIntents?: UserIntent[]
}

/**
 * 按 composer mode 组装工具、skills 与 MCP。
 *
 * 工作区内置工具来自 @agenwork/agent；本函数叠加 Desktop 增强（意图筛选 skills、MCP）。
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
    return { tools: workspaceTools, skillHint: '', mcpContextHints: '' }
  }

  const termKey = `term:${sessionId}`
  const filterIntents = options?.filterIntents
  const [skillBundle, mcpResult] = await Promise.all([
    buildSkillBundle(
      { root, termKey, settings, runCtx, onTool: runCtx.onTool },
      filterIntents !== undefined ? { filterIntents } : undefined
    ),
    buildMcpTools(settings, runCtx, runCtx.onTool)
  ])
  const tools = [...skillBundle.tools, ...workspaceTools, ...mcpResult.tools]
  return {
    tools,
    skillHint: skillBundle.hint,
    mcpContextHints: mcpResult.contextHints
  }
}

/**
 * 根据 mode 与 tooling 组装 ReAct system prompt。
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
    mcpContextHints: tooling.mcpContextHints,
    includeMcpMeta: true,
    enabledMcpNames: mcpEnabled.map((s) => s.name || s.id),
    hasDisabledMcpEntries: (settings.mcpServers?.length ?? 0) > 0 && mcpEnabled.length === 0,
    hasUserDataGlob: true
  }
  return buildWorkspaceRunPrompt(mode, root, settings, extras)
}
