import { type AgentComposerMode, MAX_TERMINAL_OUTPUT_CHARS } from '@openworker/shared'
import type { ToolSet } from 'ai'
import { z } from 'zod'

import { defineTool, filterToolSet, mergeToolSets, type ToolOnTool } from '../define-tool.js'
import {
  deleteFileTool,
  globFilesTool,
  listDirTool,
  readFileTool,
  writeFileTool,
  type WriteFileToolResult
} from './fs-tools.js'
import { GREP_TOOL_DESCRIPTION, grepWorkspace } from './grep.js'
import { runCommand } from './terminal.js'
import { isTavilyConfigured, tavilyWebSearch } from './web-search.js'
import { getOpenworkerMcpConfigPath, getOpenworkerSkillsDir } from '../path.js'

/** Ask 模式允许的只读工具名 */
const ASK_MODE_ALLOWED_TOOL_NAMES = new Set(['read_file', 'list_dir', 'glob', 'grep', 'web_search'])

type ToolDefinition<T extends z.ZodTypeAny> = {
  name: string
  description: string
  parameters: T
  execute: (input: z.infer<T>, onTool: ToolOnTool) => Promise<unknown>
  formatResult?: (result: unknown) => string
  toModelResult?: (result: unknown) => unknown
  truncateTo?: number
}

/**
 * 判断未知值是否为 write_file 结构化结果。
 *
 * @param value - execute 返回值
 */
function isWriteFileToolResult(value: unknown): value is WriteFileToolResult {
  if (!value || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  return (
    typeof o.path === 'string' &&
    typeof o.before === 'string' &&
    typeof o.after === 'string' &&
    typeof o.created === 'boolean'
  )
}

/**
 * 组装工作区基础工具（fs / grep / shell / 可选 web_search）的选项。
 */
export type BuildWorkspaceToolsOptions = {
  /** Shell 命令隔离键（由宿主提供；agent 不感知 sessionId） */
  terminalKey: string
  root: string
  /** Tavily API Key；未配置时不注册 web_search（仍可读环境变量） */
  tavilyApiKey?: string
  /** 工具生命周期观察回调 */
  onTool: ToolOnTool
  /** 可选第二根目录（如 Electron userData），供 glob 搜索 */
  userDataRoot?: string | null
  /**
   * ask：仅只读工具；build（默认）：含写文件与 shell。
   * 未传则返回完整工具集。
   */
  mode?: AgentComposerMode
}

/**
 * 构建工作区内置工具列表。
 *
 * 这是 agent 内建能力：读写文件、搜索、shell、可选联网搜索。
 * MCP 由 send 内部从 ~/.openworker/mcp.json 叠加；意图筛选由宿主增强。
 *
 * @param options - 终端键、工作区、Tavily 与观察回调
 * @returns AI SDK ToolSet
 */
export function buildWorkspaceTools(options: BuildWorkspaceToolsOptions): ToolSet {
  const { terminalKey, root, tavilyApiKey, onTool, userDataRoot, mode } = options
  const termKey = terminalKey.trim() || 'term:default'

  const baseToolDefs: ToolDefinition<z.ZodTypeAny>[] = [
    {
      name: 'read_file',
      description: '读取工作区内 UTF-8 文本文件，路径相对于工作区根目录',
      parameters: z.object({ path: z.string() }),
      execute: ({ path }) => readFileTool(root, path),
      truncateTo: 1_000
    },
    {
      name: 'write_file',
      description: '写入或覆盖工作区文件，自动创建父目录',
      parameters: z.object({ path: z.string(), content: z.string() }),
      execute: ({ path, content }) => writeFileTool(root, path, content),
      /** 时间线携带 before/after，供聊天展开渲染 diff */
      formatResult: (result) =>
        JSON.stringify(
          isWriteFileToolResult(result)
            ? result
            : { path: '', before: '', after: '', created: true }
        ),
      /** 模型上下文只保留短摘要，避免前后全文膨胀 */
      toModelResult: (result) =>
        isWriteFileToolResult(result) ? `已写入：${result.path}` : '已写入'
    },
    {
      name: 'delete_file',
      description: '删除工作区内单个普通文件（相对路径）；不能删除目录',
      parameters: z.object({ path: z.string() }),
      execute: ({ path }) => deleteFileTool(root, path)
    },
    {
      name: 'list_dir',
      description: '列出目录，路径相对或空表示根目录，深度 1–3',
      parameters: z.object({
        path: z.string().optional(),
        depth: z.number().int().min(1).max(3).optional()
      }),
      execute: ({ path, depth }) => listDirTool(root, path || '.', { depth: depth ?? 2 }),
      truncateTo: 8_000
    },
    {
      name: 'grep',
      description: GREP_TOOL_DESCRIPTION,
      parameters: z
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
      name: 'glob',
      description: userDataRoot
        ? '按模式在工作区根目录与用户数据根下 glob 匹配文件。仅返回文件路径（不含目录），分「工作区」与「用户数据」两段；模式为 Node 风格如 **/*.ts；两侧均排除 node_modules/.git/dist 及缓存目录'
        : '按模式在工作区根目录下 glob 匹配文件。仅返回文件路径；模式为 Node 风格如 **/*.ts；排除 node_modules/.git/dist 等',
      parameters: z.object({
        pattern: z.string(),
        max_results: z.number().int().min(1).max(500).optional()
      }),
      execute: ({ pattern, max_results }) =>
        globFilesTool(root, pattern, { maxFiles: max_results, userDataRoot }),
      truncateTo: 12_000
    },
    {
      name: 'shell',
      description:
        '在工作区根目录执行 shell 命令并等待结束，返回合并的 stdout/stderr（过长会截断）。用于安装依赖、构建、测试、git 等。',
      parameters: z.object({ command: z.string() }),
      execute: ({ command }) => runCommand(termKey, root, command, MAX_TERMINAL_OUTPUT_CHARS),
      truncateTo: 4_000
    }
  ]

  const baseTools = mergeToolSets(...baseToolDefs.map((def) => defineTool(def, onTool)))

  const webSearchTools: ToolSet = isTavilyConfigured(tavilyApiKey)
    ? defineTool(
        {
          name: 'web_search',
          description:
            '用 Tavily 搜索公开网页（天气、新闻、文档等）。工作区内代码搜索请用 grep；需要外部信息时调用本工具。',
          parameters: z.object({
            query: z.string(),
            max_results: z.number().int().min(1).max(20).optional()
          }),
          execute: ({ query, max_results }) =>
            tavilyWebSearch(query, { maxResults: max_results, apiKey: tavilyApiKey }),
          formatResult: (r) => (typeof r === 'string' ? r : String(r)),
          truncateTo: 12_000
        },
        onTool
      )
    : {}

  const tools = mergeToolSets(baseTools, webSearchTools)
  if (mode === 'ask') {
    return filterToolSet(tools, (name) => ASK_MODE_ALLOWED_TOOL_NAMES.has(name))
  }
  return tools
}

/**
 * 组装工作区 system prompt 时的可选增强片段（由宿主注入）。
 */
export type WorkspacePromptExtras = {
  /** skills 摘要 */
  skillHint?: string
  /** MCP 上下文提示 */
  mcpContextHints?: string
  /** 是否在 prompt 中声明 MCP 元工具 */
  includeMcpMeta?: boolean
  /** 已启用的 MCP 名称 */
  enabledMcpNames?: string[]
  /** 是否存在未启用的 MCP 条目 */
  hasDisabledMcpEntries?: boolean
  /** glob 是否覆盖第二根目录（用户数据） */
  hasUserDataGlob?: boolean
}

/**
 * 面向聊天渲染的 Markdown 回复规范（对齐 Cursor 类助手的可读性习惯）。
 *
 * 约束加粗与 checkbox 的滥用，并用短示例锚定输出形态。
 */
function buildMarkdownReplyStylePrompt(): string {
  return `## 回复 Markdown 格式（必须遵守）
面向聊天界面渲染，风格接近 Cursor：干净、可读、少装饰。

规则：
- **正文默认不加粗**。不要整句/整段加粗；\`**加粗**\` 仅用于极少数关键术语或短标签（每段最多 1～2 处）。
- **不要用任务列表 checkbox**（禁止 \`- [ ]\` / \`- [x]\`）。普通要点用 \`- \` 无序列表。
- 标题少用：需要分层时最多用 \`##\` / \`###\`；短回答可直接段落 + 列表，不必强行加标题。
- 路径、标识符、命令、文件名用行内代码；多行代码用围栏代码块并标注语言（如 \`\`\`ts）。
- 表格仅在对比多列结构化信息时使用；不要用表格做普通说明。
- 少用分隔线 \`---\` 与装饰性符号；不要堆叠 emoji。

示例（请按此密度与语气输出）：

已定位问题：\`WorkspaceCenterPane.scss\` 里表格外边框与单元格边框叠在一起，看起来偏粗。

改动建议：
- 去掉表格容器外边框，只保留单元格分隔线
- 用容器 \`border-radius: 6px\` + \`overflow: hidden\` 做圆角

\`\`\`scss
.app-message-markdown-table-wrap {
  border: 1px solid var(--aw-color-border);
  border-radius: 6px;
  overflow: hidden;
}
\`\`\`

若需自动改文件，切换到构建模式即可。`
}

/**
 * 根据 composer mode 组装工作区 ReAct system prompt。
 *
 * @param mode - ask / build
 * @param root - 工作区根目录
 * @param tavilyApiKey - 可选 Tavily API Key（影响 web_search 相关提示）
 * @param extras - 宿主增强片段（skills / MCP）
 * @returns 完整 system prompt
 */
export function buildWorkspaceRunPrompt(
  mode: AgentComposerMode,
  root: string,
  tavilyApiKey?: string,
  extras?: WorkspacePromptExtras
): string {
  // Node 侧无浏览器地理定位；用系统时区作为本地上下文
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'
  const skillsPath = getOpenworkerSkillsDir()
  const common = [
    `当前日期时间：${new Date().toLocaleString()}；时区：${timeZone}；`,
    `内置 skills 文件夹路径：${skillsPath}；`,
    `mcp 配置文件路径：${getOpenworkerMcpConfigPath()}；`,
    `工作区根目录：${root}；`
  ].join('\n')
  if (mode === 'ask') {
    return [common, buildAskSystemPrompt(root, tavilyApiKey)].filter(Boolean).join('\n\n')
  }
  return [
    common,
    buildBuildSystemPrompt(root, tavilyApiKey, extras),
    extras?.skillHint,
    extras?.mcpContextHints
  ]
    .filter(Boolean)
    .join('\n\n')
}

function buildBuildSystemPrompt(
  root: string,
  tavilyApiKey?: string,
  extras?: WorkspacePromptExtras
): string {
  const web = isTavilyConfigured(tavilyApiKey)
  const includeMcp = Boolean(extras?.includeMcpMeta)
  const mcpMeta = includeMcp
    ? '\n- **MCP 管理（元工具）**：`mcp_list_servers` 列出已配置的 MCP（环境变量已脱敏）；`mcp_inspect_server` 探测指定 MCP 暴露的工具。需要连接信息或工具名时优先使用；不要向用户索要应用中已保存的密码。'
    : ''

  let mcpNote = ''
  if (includeMcp) {
    const names = extras?.enabledMcpNames ?? []
    if (names.length > 0) {
      mcpNote = `${mcpMeta}\n- 已启用的 MCP（stdio）服务：${names.join(', ')}。以 mcp_ 开头的工具来自各 MCP；调用时传入 JSON，键名需符合该工具的 inputSchema。`
    } else if (extras?.hasDisabledMcpEntries) {
      mcpNote = `${mcpMeta}\n- 当前 MCP 条目未启用或 command 为空；用户启用后才会出现 mcp_* 工具。`
    } else {
      mcpNote = mcpMeta
    }
  }

  const mcpToolNames = includeMcp ? '、mcp_list_servers、mcp_inspect_server' : ''
  const toolLine = web
    ? `read_file、write_file、delete_file、list_dir、glob、grep、shell、web_search（Tavily 联网搜索）${mcpToolNames}`
    : `read_file、write_file、delete_file、list_dir、glob、grep、shell${mcpToolNames}（未配置 Tavily API Key 时无 web_search）`

  const webRule = web
    ? '- 用户询问**天气、气温、降雨、实时新闻、股价、政策**等需要外部信息时，必须先调用 **web_search** 再回答；不要编造天气或声称「搜索失败」。'
    : '- 未配置 Tavily，**web_search 不可用**：若用户需要今日天气等实时信息，明确告知在应用设置中填写「Tavily API Key」或配置环境变量 TAVILY_API_KEY；可建议天气网站/App；不要声称「搜索引擎坏了」或「无法联网」。'

  const followTools = includeMcp
    ? 'read_file、list_dir、grep、shell、mcp_*'
    : 'read_file、list_dir、grep、shell'
  const skillRule =
    '- **优先 skill_***：用户意图明显匹配某 skill 工具描述时，必须先调用该 skill 获取流程/约束/输出，再按需使用 ' +
    followTools +
    '；不要跳过匹配的技能而用泛化工具猜测。'

  const globNote = extras?.hasUserDataGlob
    ? '：结果含工作区与「用户数据」目录（用户技能包等）；read_file/write 仍仅限工作区路径'
    : ''

  return `你是协助办公与软件开发的智能体。
- 工具中使用**相对于工作区根目录**的路径（如 src/index.ts）；不要用 ../ 逃出工作区。
- 可用工具：${toolLine}，以及各类 skill_* 工具。${mcpNote}
${skillRule}
- shell 在工作区根目录沙箱中执行命令并等待结束，返回 stdout/stderr；Windows 使用 cmd 风格。
- 用户要「查看/读取工作区文件」或「列目录」时，优先 read_file/list_dir 再回答。
- 用户明确要求删除工作区中的文件时，使用 delete_file（仅普通文件，不含目录）。
- 用 glob 按文件名/路径模式搜索（如 **/*.ts）${globNote}。
${webRule}
- 回复简洁可执行；改代码前先 read/list。
- 先理解任务 → 必要时复述目标 → 再选工具。

${buildMarkdownReplyStylePrompt()}`
}

function buildAskSystemPrompt(root: string, tavilyApiKey?: string): string {
  const web = isTavilyConfigured(tavilyApiKey)
  const toolLine = web
    ? 'read_file、list_dir、glob、grep、web_search（Tavily）'
    : 'read_file、list_dir、glob、grep（未配置 Tavily 时无 web_search）'
  const webRule = web
    ? '- 需要外部信息时调用 **web_search**；不要编造搜索结果。'
    : '- 未配置 Tavily：若用户需要实时信息，如实说明并建议在设置中配置 Tavily。'
  return `你是帮助理解代码、架构与命令的助手（问答模式）。
- 禁止修改工作区文件、删除文件、执行 shell、调用 skill_* 或 mcp_*；本模式下这些工具不可用。
- 仅只读工具：${toolLine}。路径均相对于工作区根目录。
- 若用户要求「直接改代码 / 跑命令 / 打补丁」，说明问答模式不能自动执行，给出可复制片段或步骤；要自动应用请切换到构建模式。
${webRule}
- 回复清晰可验证：下结论前先 read/list/grep 仓库内容。
- 先理解意图 → 必要时复述目标

${buildMarkdownReplyStylePrompt()}
`
}
