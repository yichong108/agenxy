/**
 * createAgent 是 agent 的唯一入口工厂。
 * 它负责创建 agent 实例，并提供 send 方法，用于发起一次 agent run。
 */

import {
  type AgentComposerMode,
  type McpServerEntry,
  normalizeComposerMode,
  type StreamEvent,
} from "@agenwork/shared";
import type { CoreMessage, LanguageModel, ToolSet } from "ai";

import type { PreparedTooling } from "./run-types.js";
import {
  mergeToolSets,
  type ToolObservation,
  type ToolOnTool,
} from "./define-tool.js";
import {
  buildMcpToolsFromConfig,
  disposeMcpConnectionPool,
  probeMcpServer,
  warmupMcpServersFromConfig,
} from "./mcp/mcp-runtime.js";
import type { McpProbeResult, McpWarmupServerResult } from "./mcp/types.js";
import { runReactLoop } from "./react-loop.js";
import { loadSkillsFromPaths } from "./skills/load-skills.js";
import {
  buildWorkspaceRunPrompt,
  buildWorkspaceTools,
  type WorkspacePromptExtras,
} from "./tools/workspace-tools.js";

/**
 * 按模式组装本轮可用工具与 system prompt 的依赖函数。
 */
type PrepareToolingFn = (args: {
  composerMode: AgentComposerMode;
  /** Shell 命令隔离键（宿主提供） */
  terminalKey: string;
  root: string;
  /** Tavily API Key（可选） */
  tavilyApiKey?: string;
  /** 工具生命周期观察回调 */
  onTool: ToolOnTool;
  signal?: AbortSignal;
  emit: (event: StreamEvent) => void;
  provider?: LanguageModel;
}) => Promise<PreparedTooling>;

/**
 * createAgent 本地运行环境配置。
 */
export type CreateAgentLocalOptions = {
  /** 工作区根目录；send 时若未指定 workspacePath 则使用此值 */
  cwd?: string;
};

/**
 * createAgent Skills 配置：仅声明扫描路径，由 agent 实现基础加载。
 */
export type CreateAgentSkillsOptions = {
  /** 技能根目录绝对路径列表；递归扫描 SKILL.md，同名时靠前路径优先 */
  paths: string[];
};

/**
 * createAgent MCP 配置：传入配置文件路径，由 agent 内部加载并绑定 MCP 工具。
 *
 * 配置文件支持 Cursor 形态与本应用数组形态。
 * 提供 configPath 后，agent 会在 build 模式叠加 MCP 工具。
 */
export type CreateAgentMcpOptions = {
  /** MCP 配置文件绝对路径 */
  configPath: string;
};

/**
 * 单次 run 的 Tavily 联网搜索配置。
 *
 * 由宿主从应用设置等注入；未传或无有效 key 时，仍可读环境变量 TAVILY_API_KEY。
 */
export type AgentRunTavilyOptions = {
  /** Tavily API Key */
  apiKey?: string;
};

/**
 * Agent 上的 MCP 宿主能力（探测 / 预热 / 释放连接池）。
 *
 * 仅在创建时传入 `mcp.configPath` 时挂载；实现细节不单独从包根导出。
 */
export type AgentMcp = {
  /** 一次性探测单个 MCP 服务器（不入池） */
  probe: (entry: McpServerEntry) => Promise<McpProbeResult>;
  /** 按 configPath 预热已启用的 MCP（池化建连） */
  warmup: () => Promise<McpWarmupServerResult[]>;
  /** 关闭所有池化 MCP 子进程（设置变更或应用退出时调用） */
  dispose: () => Promise<void>;
};

/** createAgent 未传 local 时的默认值；cwd 缺省时在 send 侧回退 process.cwd() */
const DEFAULT_LOCAL: CreateAgentLocalOptions = {};

/**
 * createAgent 配置项。
 *
 * provider 必填；local 可选（默认空对象，cwd 回退 process.cwd()）。
 * 其余未传时使用内置默认（工作区工具）。
 * 配置 skills.paths 后，默认 tooling 会叠加这些路径下的技能工具。
 * 配置 mcp.configPath 后，agent 会从该文件加载 MCP 并绑定工具。
 *
 * @example
 * ```ts
 * const agent = await createAgent({
 *   provider: model,
 *   local: { cwd: process.cwd() },
 *   skills: { paths: ['/path/to/skills'] },
 *   mcp: { configPath: '/path/to/mcp.json' }
 * })
 * ```
 */
export type CreateAgentOptions = {
  /** AI SDK LanguageModel；创建时必填，send 未传 provider 时作为本轮对话模型 */
  provider: LanguageModel;
  /** 本地运行环境；可选，默认 {}，cwd 缺省时回退 process.cwd() */
  local?: CreateAgentLocalOptions;
  /** Skills 扫描路径；由默认 tooling 加载并叠加技能工具 */
  skills?: CreateAgentSkillsOptions;
  /**
   * MCP 配置文件路径；由 agent 内部实现连接池与工具绑定，
   * 并自动叠加 MCP 工具与上下文提示。
   */
  mcp?: CreateAgentMcpOptions;
};

/**
 * 单次 agent run 的输入。
 *
 * 宿主回调（onTextDelta / onTool / onEmit）直接挂在入参上，不再嵌套 callbacks。
 * 工具时间线（ToolTimelineEvent）由宿主在 onTool 中自行映射与收集。
 */
export type AgentRunInput = {
  /**
   * 发送模式；可选，默认 build（非法值亦回退 build）。
   */
  composerMode?: AgentComposerMode;
  messages: CoreMessage[];
  /**
   * 本轮已解析的聊天模型。
   * 可选；未传时回退 createAgent 时注入的 provider。
   */
  provider?: LanguageModel;
  /**
   * 取消控制器；可选，未传时内部新建 AbortController。
   * 宿主若需外部取消（如 Stop），应自行传入并持有引用。
   */
  abortController?: AbortController;
  /**
   * 本轮工作区根目录绝对路径。
   * 优先于 createAgent local.cwd；均未提供时回退 process.cwd()。
   */
  workspacePath?: string;
  /**
   * Shell 命令隔离键。
   * 由宿主派生（如 `term:${sessionId}`）；缺省为 `term:default`。
   * sessionId / runId / traceId 不进入 agent，由宿主在回调外维护。
   */
  terminalKey?: string;
  /**
   * Tavily 联网搜索配置。
   * 由宿主注入；未配置有效 key 且无环境变量时不注册 web_search。
   */
  tavily?: AgentRunTavilyOptions;
  /** 流式文本增量回调 */
  onTextDelta: (text: string) => void;
  /** 工具观察回调；宿主可在此映射与收集工具时间线 */
  onTool: (event: ToolObservation) => void;
  /** 向宿主推送 StreamEvent（如错误、状态） */
  onEmit: (event: StreamEvent) => void;
  /** 最大工具调用轮次；缺省时使用 MAX_AGENT_LOOP_STEPS */
  maxSteps?: number;
  /** 循环超时（毫秒）；缺省时使用 defaultSettings.agentRunTimeoutMs */
  invokeTimeoutMs?: number;
};

/**
 * 单次 agent run 的结果。
 */
export type AgentRunResult = {
  messages: CoreMessage[];
};

/**
 * createAgent 返回的 agent 实例。
 */
export type Agent = {
  /** 发起一次 run；同会话互斥由宿主保证，不同会话可并行 */
  send: (input: AgentRunInput) => Promise<AgentRunResult>;
  /** MCP 宿主侧能力；未配置 mcp.configPath 时为 undefined */
  mcp?: AgentMcp;
};

/**
 * 创建 agent 实例 — packages/agent 的唯一入口工厂。
 *
 * 必填 provider；local 可选（默认 {}，cwd 回退 process.cwd()）。
 * 工具与 prompt 由内置默认 tooling 组装。
 * 可选 skills.paths 提供基础 Skills；mcp.configPath 由 agent 内部实现 MCP。
 * 可 `await createAgent(...)`（函数本身同步，await 无害）。
 *
 * 注意：不直接与外部耦合。同会话「运行中不可再发」由宿主按 session 互斥；
 * 不同会话各自独立 send，互不排队。
 *
 * @param options - 创建配置；provider 必填，local 有默认值
 * @returns 可 send 的 agent 实例
 */
export function createAgent(options: CreateAgentOptions): Agent {
  const local = options.local ?? DEFAULT_LOCAL;
  const defaultCwd = local.cwd?.trim() || process.cwd();
  const defaultProvider = options.provider;
  const skillPaths = (options.skills?.paths ?? [])
    .map((p) => p.trim())
    .filter(Boolean);
  const mcpConfigPath = options.mcp?.configPath?.trim() || undefined;

  /**
   * 组装本轮工具与 system prompt：工作区内置工具 + 可选 skills + 可选 MCP。
   *
   * 闭包捕获 createAgent 时的 skillPaths / mcpConfigPath，避免额外工厂函数。
   */
  const prepareTooling: PrepareToolingFn = async ({
    composerMode,
    terminalKey,
    root,
    tavilyApiKey,
    onTool,
  }) => {
    const workspaceTools = buildWorkspaceTools({
      terminalKey,
      root,
      tavilyApiKey,
      onTool,
      mode: composerMode,
    });

    if (composerMode === "ask") {
      return {
        tools: workspaceTools,
        runPrompt: buildWorkspaceRunPrompt(composerMode, root, tavilyApiKey),
      };
    }

    const skillBundle = skillPaths.length
      ? await loadSkillsFromPaths(skillPaths, onTool)
      : { tools: {}, hint: "" };

    let mcpExtras: WorkspacePromptExtras = {};
    let mcpTools: ToolSet = {};
    if (mcpConfigPath) {
      const mcpResult = await buildMcpToolsFromConfig(mcpConfigPath, onTool);
      mcpTools = mcpResult.tools;
      const enabled = mcpResult.servers.filter(
        (s) => s.enabled && s.command.trim(),
      );
      mcpExtras = {
        mcpContextHints: mcpResult.contextHints,
        includeMcpMeta: true,
        enabledMcpNames: enabled.map((s) => s.name || s.id),
        hasDisabledMcpEntries:
          mcpResult.servers.length > 0 && enabled.length === 0,
      };
    }

    return {
      tools: mergeToolSets(skillBundle.tools, workspaceTools, mcpTools),
      runPrompt: buildWorkspaceRunPrompt(composerMode, root, tavilyApiKey, {
        skillHint: skillBundle.hint,
        ...mcpExtras,
      }),
    };
  };

  /**
   * 发起一次 agent run：组装本轮工具与 prompt，再执行 ReAct 循环。
   *
   * 调用方须已将本轮用户消息写入 messages；消息持久化由宿主负责。
   * 工作区路径由 input.workspacePath 提供，缺省回退 local.cwd / process.cwd()。
   *
   * @param input - 单次 run 的输入（含可选 workspacePath）
   * @returns 运行结束后的 messages
   */
  async function send(input: AgentRunInput): Promise<AgentRunResult> {
    const {
      messages,
      onTextDelta,
      onTool,
      onEmit,
      maxSteps,
      invokeTimeoutMs,
    } = input;

    // 发送模式：未传或非法值时默认 build
    const composerMode = normalizeComposerMode(input.composerMode);
    // 本轮模型：send 入参优先，否则使用 createAgent 注入的 provider
    const provider = input.provider ?? defaultProvider;
    // 取消控制器：未传时内部新建（外部无法 abort，仅满足信号链路）
    const abortController = input.abortController ?? new AbortController();
    // 工作区路径：本轮 send 入参优先，其次 createAgent local.cwd（已含默认）
    const root = input.workspacePath?.trim() || defaultCwd;
    // Shell 隔离键由宿主提供；agent 不使用 sessionId
    const terminalKey = input.terminalKey?.trim() || "term:default";
    const tavilyApiKey = input.tavily?.apiKey?.trim() || undefined;

    const tooling = await prepareTooling({
      composerMode,
      terminalKey,
      root,
      tavilyApiKey,
      onTool,
      signal: abortController.signal,
      emit: onEmit,
      provider,
    });

    const runMessages = await runReactLoop(
      provider,
      tooling.runPrompt,
      messages,
      tooling.tools,
      abortController,
      onTextDelta,
      maxSteps,
      invokeTimeoutMs,
    );

    return {
      messages: runMessages.length > 0 ? runMessages : messages,
    };
  }

  const mcp: AgentMcp | undefined = mcpConfigPath
    ? {
        probe: (entry) => probeMcpServer(entry),
        warmup: () => warmupMcpServersFromConfig(mcpConfigPath),
        dispose: () => disposeMcpConnectionPool(),
      }
    : undefined;

  return {
    send,
    ...(mcp ? { mcp } : {}),
  };
}
