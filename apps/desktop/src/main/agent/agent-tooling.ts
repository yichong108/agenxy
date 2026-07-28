import {
  defineTool,
  HITL_EXEMPT_TOOL_NAMES,
  type NamedTool,
  type ToolExecutorContext,
  type UserIntent
} from '@agenxy/agent'
import { type AgentComposerMode, type AppSettings, MAX_TERMINAL_OUTPUT_CHARS } from '@agenxy/shared'
import { z } from 'zod'

import { buildSkillBundle } from '@/main/agent/skills/index'
import { buildMcpTools } from '@/main/mcp/mcp-runtime'
import { userDataPath } from '@/main/store'
import {
  deleteFileTool,
  globFilesTool,
  listDirTool,
  readFileTool,
  searchWorkspace,
  writeFileTool
} from '@/main/tools/fs-tools'
import { GREP_TOOL_DESCRIPTION, grepWorkspace } from '@/main/tools/grep'
import { runCommand } from '@/main/tools/terminal'
import { isTavilyConfigured, tavilyWebSearch } from '@/main/tools/web-search'

export type { NamedTool, ToolExecutorContext } from '@agenxy/agent'

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

const commonPrompt = `
  当前日期时间（UTC）：${new Date().toLocaleString()}；
`

type ToolDefinition<T extends z.ZodTypeAny> = {
  name: string
  description: string
  schema: T
  execute: (input: z.infer<T>, ctx: ToolExecutorContext) => Promise<unknown>
  formatResult?: (result: unknown) => string
  truncateTo?: number
}

function buildBaseAndWebTools(
  sessionId: string,
  root: string,
  settings: AppSettings,
  runCtx: ToolExecutorContext
): { baseTools: NamedTool[]; webSearchTools: NamedTool[] } {
  const termKey = `term:${sessionId}`

  const baseToolDefs: ToolDefinition<z.ZodTypeAny>[] = [
    {
      name: 'read_file',
      description: '读取工作区内 UTF-8 文本文件，路径相对于工作区根目录',
      schema: z.object({ path: z.string() }),
      execute: ({ path }) => readFileTool(root, path),
      truncateTo: 1_000
    },
    {
      name: 'write_file',
      description: '写入或覆盖工作区文件，自动创建父目录',
      schema: z.object({ path: z.string(), content: z.string() }),
      execute: ({ path, content }) => writeFileTool(root, path, content)
    },
    {
      name: 'delete_file',
      description: '删除工作区内单个普通文件（相对路径）；不能删除目录',
      schema: z.object({ path: z.string() }),
      execute: ({ path }) => deleteFileTool(root, path)
    },
    {
      name: 'list_dir',
      description: '列出目录，路径相对或空表示根目录，深度 1–3',
      schema: z.object({
        path: z.string().optional(),
        depth: z.number().int().min(1).max(3).optional()
      }),
      execute: ({ path, depth }) => listDirTool(root, path || '.', { depth: depth ?? 2 }),
      truncateTo: 8_000
    },
    {
      name: 'grep',
      description: GREP_TOOL_DESCRIPTION,
      schema: z
        .object({
          pattern: z.string(),
          path: z.string().optional(),
          glob: z.string().optional(),
          type: z.string().optional(),
          output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
          multiline: z.boolean().optional(),
          head_limit: z.number().int().min(1).max(2000).optional()
        })
        .extend({
          '-i': z.boolean().optional(),
          '-A': z.number().int().min(0).max(10).optional(),
          '-B': z.number().int().min(0).max(10).optional(),
          '-C': z.number().int().min(0).max(10).optional()
        }),
      execute: (args) => grepWorkspace(root, args),
      truncateTo: 12_000
    },
    {
      name: 'search_workspace',
      description: '在文本文件中做简单子串搜索（无正则）。需要正则、glob 或匹配上下文时用 grep。',
      schema: z.object({ query: z.string() }),
      execute: ({ query }) => searchWorkspace(root, query, { maxFiles: 50 }),
      truncateTo: 8_000
    },
    {
      name: 'glob',
      description:
        '按模式在工作区根目录与 Electron userData 下 glob 匹配文件。仅返回文件路径（不含目录），分「工作区」与「用户数据」两段；用户数据路径相对 userData 根。模式为 Node 风格如 **/*.ts；两侧均排除 node_modules/.git/dist 及 Chromium 缓存目录',
      schema: z.object({
        pattern: z.string(),
        max_results: z.number().int().min(1).max(500).optional()
      }),
      execute: ({ pattern, max_results }) =>
        globFilesTool(root, pattern, { maxFiles: max_results, userDataRoot: userDataPath() }),
      truncateTo: 12_000
    },
    {
      name: 'shell',
      description:
        '在工作区根目录执行 shell 命令并等待结束，返回合并的 stdout/stderr（过长会截断）。用于安装依赖、构建、测试、git 等。',
      schema: z.object({ command: z.string() }),
      execute: ({ command }) => runCommand(termKey, root, command, MAX_TERMINAL_OUTPUT_CHARS),
      truncateTo: 4_000
    }
  ]

  const baseTools = baseToolDefs.map((def) => defineTool(def, runCtx))

  const webSearchTools: NamedTool[] = isTavilyConfigured(settings.tavilyApiKey)
    ? [
        defineTool(
          {
            name: 'web_search',
            description:
              '用 Tavily 搜索公开网页（天气、新闻、文档等）。search_workspace 只搜工作区代码；需要外部信息时调用本工具。',
            schema: z.object({
              query: z.string(),
              max_results: z.number().int().min(1).max(20).optional()
            }),
            execute: ({ query, max_results }) =>
              tavilyWebSearch(query, { maxResults: max_results, apiKey: settings.tavilyApiKey }),
            formatResult: (r) => (typeof r === 'string' ? r : String(r)),
            truncateTo: 12_000
          },
          runCtx
        )
      ]
    : []

  return { baseTools, webSearchTools }
}

function buildSystemPrompt(root: string, settings: AppSettings): string {
  const web = isTavilyConfigured(settings.tavilyApiKey)
  const mcpEnabled = (settings.mcpServers ?? []).filter((s) => s.enabled && s.command.trim())
  const mcpMeta =
    '\n- **MCP 管理（元工具）**：`mcp_list_servers` 列出已配置的 MCP（环境变量已脱敏）；`mcp_inspect_server` 探测指定 MCP 暴露的工具。需要连接信息或工具名时优先使用；不要向用户索要应用中已保存的密码。'
  const mcpNote =
    mcpEnabled.length > 0
      ? `${mcpMeta}\n- 已启用的 MCP（stdio）服务：${mcpEnabled.map((s) => s.name || s.id).join(', ')}。以 mcp_ 开头的工具来自各 MCP；调用时传入 JSON，键名需符合该工具的 inputSchema。`
      : (settings.mcpServers?.length ?? 0) > 0
        ? `${mcpMeta}\n- 当前 MCP 条目未启用或 command 为空；用户启用后才会出现 mcp_* 工具。`
        : mcpMeta
  const toolLine = web
    ? 'read_file、write_file、delete_file、list_dir、glob、grep、search_workspace、shell、web_search（Tavily 联网搜索）、mcp_list_servers、mcp_inspect_server'
    : 'read_file、write_file、delete_file、list_dir、glob、grep、search_workspace、shell、mcp_list_servers、mcp_inspect_server（未配置 Tavily API Key 时无 web_search）'
  const webRule = web
    ? '- 用户询问**天气、气温、降雨、实时新闻、股价、政策**等需要外部信息时，必须先调用 **web_search** 再回答；不要编造天气或声称「搜索失败」。\n- 若用户**拒绝**某次工具调用（结果含已拒绝/未执行），**本轮不得再次调用该工具**；用中文简要说明并给出替代方案（如请用户提供城市/地区，或说明可在设置中调整审批）。'
    : '- 未配置 Tavily，**web_search 不可用**：若用户需要今日天气等实时信息，明确告知在应用设置中填写「Tavily API Key」或配置环境变量 TAVILY_API_KEY；可建议天气网站/App；不要声称「搜索引擎坏了」或「无法联网」。'
  return `你是协助办公与软件开发的智能体。工作区根目录：${root}。
- 工具中使用**相对于工作区根目录**的路径（如 src/index.ts）；不要用 ../ 逃出工作区。
- 可用工具：${toolLine}，以及各类 skill_* 工具。${mcpNote}
- **优先 skill_***：用户意图明显匹配某 skill 工具描述时，必须先调用该 skill 获取流程/约束/输出，再按需使用 read_file、list_dir、grep、search_workspace、shell、mcp_*；不要跳过匹配的技能而用泛化工具猜测。
- shell 在工作区根目录沙箱中执行命令并等待结束，返回 stdout/stderr；Windows 使用 cmd 风格。
- 用户要「查看/读取工作区文件」或「列目录」时，优先 read_file/list_dir 再回答。
- 用户明确要求删除工作区中的文件时，使用 delete_file（仅普通文件，不含目录）。
- 用 glob 按文件名/路径模式搜索（如 **/*.ts）：结果含工作区与「用户数据」目录（用户技能包等）；read_file/write 仍仅限工作区路径。
${webRule}
- 回复简洁可执行；改代码前先 read/list。
- 先理解任务 → 必要时复述目标 → 再选工具。`
}

function buildAskSystemPrompt(root: string, settings: AppSettings): string {
  const web = isTavilyConfigured(settings.tavilyApiKey)
  const toolLine = web
    ? 'read_file、list_dir、glob、grep、search_workspace、web_search（Tavily）'
    : 'read_file、list_dir、glob、grep、search_workspace（未配置 Tavily 时无 web_search）'
  const webRule = web
    ? '- 需要外部信息时调用 **web_search**；不要编造搜索结果。'
    : '- 未配置 Tavily：若用户需要实时信息，如实说明并建议在设置中配置 Tavily。'
  return `你是帮助理解代码、架构与命令的助手（**问答模式**）。工作区根目录：${root}。
- **禁止**修改工作区文件、删除文件、执行 shell、调用 skill_* 或 mcp_*；本模式下这些工具不可用。
- 仅只读工具：${toolLine}。路径均相对于工作区根目录。
- 若用户要求「直接改代码 / 跑命令 / 打补丁」，说明问答模式不能自动执行，给出可复制片段或步骤；要自动应用请切换到 **构建模式**。
${webRule}
- 回复清晰可验证：下结论前先 read/list/search 仓库内容。
- 先理解意图 → 必要时复述目标
`
}

function buildPlanSystemPrompt(root: string, settings: AppSettings): string {
  const web = isTavilyConfigured(settings.tavilyApiKey)
  const toolLine = web
    ? 'read_file、list_dir、glob、grep、search_workspace、web_search（Tavily）'
    : 'read_file、list_dir、glob、grep、search_workspace（未配置 Tavily 时无 web_search）'
  const webRule = web
    ? '- 需要外部文档或 API 时调用 **web_search**；不要编造搜索结果。'
    : '- 未配置 Tavily：在需要实时网页数据时注明。'
  return `你是本工作区（${root}）的 **计划模式** 架构师。只读探索并输出供 UI 展示的 **清单式计划** —— 尚未执行任何修改。
- **禁止**改文件、删文件、跑 shell、调用 skill_* / mcp_*；仅只读工具：${toolLine}。
- **禁止**声称已改代码或已执行命令；不要让用户点击「执行」或自动运行。
- 充分探索（read/list/search），使步骤基于真实路径与符号。

**最终 Markdown 必须采用以下 ## 标题**：

## 目标
用一小段话复述用户需求。

## 计划
- [ ] 第一条可执行步骤 —— 已知时写明文件路径
- [ ] 第二条步骤
（每个实施步骤一行 \`- [ ]\`；本区块渲染为清单）

## 风险与待确认
- 风险或待确认项（若无则省略整节）

规则：
- ## 计划 下每条实施步骤必须是 \`- [ ]\`（不用编号列表，不要纯段落）。
- 步骤标题简短；补充说明写在同行破折号后。
${webRule}`
}

/**
 * 按 composer mode 组装工具、skills 与 MCP。
 *
 * @param mode - ask / plan / build
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
  const { baseTools, webSearchTools } = buildBaseAndWebTools(sessionId, root, settings, runCtx)

  if (mode === 'ask' || mode === 'plan') {
    const tools = [...baseTools, ...webSearchTools].filter((t) =>
      HITL_EXEMPT_TOOL_NAMES.has(t.name)
    )
    return { tools, skillHint: '', mcpContextHints: '' }
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
  const tools = [...skillBundle.tools, ...baseTools, ...webSearchTools, ...mcpResult.tools]
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
  if (mode === 'ask') {
    return [buildAskSystemPrompt(root, settings), commonPrompt].filter(Boolean).join('\n\n')
  }
  if (mode === 'plan') {
    return [buildPlanSystemPrompt(root, settings), commonPrompt].filter(Boolean).join('\n\n')
  }
  return [
    buildSystemPrompt(root, settings),
    tooling.skillHint,
    tooling.mcpContextHints,
    commonPrompt
  ]
    .filter(Boolean)
    .join('\n\n')
}
