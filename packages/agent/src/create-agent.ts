/**
 * createAgent 是 agent 的唯一入口工厂。
 * 它负责创建 agent 实例，并提供 send 方法，用于发起一次 agent run。
 */

import {
  type AgentComposerMode,
  type AppSettings,
  type McpServerEntry,
  type StreamEvent,
} from "@agenwork/shared";
import type { CoreMessage, LanguageModel, ToolSet } from "ai";

import type { RunMeta } from "./run-types.js";
import { mergeToolSets, type ToolObservation } from "./define-tool.js";
import {
  buildMcpToolsFromConfig,
  disposeMcpConnectionPool,
  probeMcpServer,
  warmupMcpServersFromConfig,
} from "./mcp/mcp-runtime.js";
import type { McpProbeResult, McpWarmupServerResult } from "./mcp/types.js";
import { runWorkflow, type PrepareToolingFn } from "./run-workflow.js";
import { loadSkillsFromPaths } from "./skills/load-skills.js";
import {
  buildWorkspaceRunPrompt,
  buildWorkspaceTools,
  type WorkspacePromptExtras,
} from "./tools/workspace-tools.js";

/**
 * createAgent 本地运行环境配置。
 */
export type CreateAgentLocalOptions = {
  /** 工作区根目录；send 时若未指定 runMeta.root 则使用此值 */
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

/**
 * createAgent 配置项。
 *
 * 最简用法只需 provider 与 local.cwd；其余未传时使用内置默认（工作区工具）。
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
  /** AI SDK LanguageModel；可选注入，供 tooling 等使用；对话模型由 send 的 provider 传入 */
  provider?: LanguageModel;
  /** 本地运行环境 */
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
 * 单次 run 的宿主回调：流式输出、工具观察与持久化。
 *
 * 工具时间线（ToolTimelineEvent）由宿主在 onTool 中自行映射与收集。
 */
export type AgentRunCallbacks = {
  onTextDelta: (text: string) => void;
  onTool: (event: ToolObservation) => void;
  emit: (event: StreamEvent) => void;
};

/**
 * 单次 agent run 的输入。
 */
export type AgentRunInput = {
  composerMode: AgentComposerMode;
  messages: CoreMessage[];
  /** 本轮已解析的聊天模型（由宿主传入，send 内不再 resolve） */
  provider: LanguageModel;
  abortController: AbortController;
  settings: AppSettings;
  runMeta: RunMeta;
  callbacks: AgentRunCallbacks;
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
 * 创建默认 tooling：工作区内置工具 + 可选 skills.paths + 可选 MCP。
 *
 * @param skillPaths - createAgent 配置的技能路径
 * @param mcpConfigPath - 可选 MCP 配置文件路径
 * @returns prepareTooling 实现
 */
function createDefaultPrepareTooling(
  skillPaths: string[],
  mcpConfigPath?: string,
): PrepareToolingFn {
  return async ({ composerMode, sessionId, root, settings, runCtx }) => {
    const workspaceTools = buildWorkspaceTools({
      sessionId,
      root,
      settings,
      runCtx,
      mode: composerMode,
    });

    if (composerMode === "ask") {
      return {
        tools: workspaceTools,
        runPrompt: buildWorkspaceRunPrompt(composerMode, root, settings),
      };
    }

    const skillBundle = skillPaths.length
      ? await loadSkillsFromPaths(skillPaths, runCtx)
      : { tools: {}, hint: "" };

    let mcpExtras: WorkspacePromptExtras = {};
    let mcpTools: ToolSet = {};
    if (mcpConfigPath) {
      const mcpResult = await buildMcpToolsFromConfig(mcpConfigPath, runCtx);
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
      runPrompt: buildWorkspaceRunPrompt(composerMode, root, settings, {
        skillHint: skillBundle.hint,
        ...mcpExtras,
      }),
    };
  };
}

/**
 * 创建 agent 实例 — packages/agent 的唯一入口工厂。
 *
 * 最简入参为 provider + local.cwd；工具与 prompt 由内置默认 tooling 组装。
 * 可选 skills.paths 提供基础 Skills；mcp.configPath 由 agent 内部实现 MCP。
 * 可 `await createAgent(...)`（函数本身同步，await 无害）。
 *
 * 注意：不直接与外部耦合。同会话「运行中不可再发」由宿主按 session 互斥；
 * 不同会话各自独立 send，互不排队。
 *
 * @param options - 创建配置；均可选，空对象即使用全部默认
 * @returns 可 send 的 agent 实例
 */
export function createAgent(options: CreateAgentOptions = {}): Agent {
  const defaultCwd = options.local?.cwd?.trim() || undefined;
  const skillPaths = (options.skills?.paths ?? [])
    .map((p) => p.trim())
    .filter(Boolean);
  const mcpConfigPath = options.mcp?.configPath?.trim() || undefined;

  const prepareTooling = createDefaultPrepareTooling(skillPaths, mcpConfigPath);

  /**
   * 发起一次 agent run
   *
   * @param input - 单次 run 的输入
   * @returns 单次 run 的结果
   */
  async function send(input: AgentRunInput): Promise<AgentRunResult> {
    const {
      composerMode,
      messages,
      provider,
      abortController,
      settings,
      callbacks,
      maxSteps,
      invokeTimeoutMs,
    } = input;

    const root = input.runMeta.root?.trim() || defaultCwd || process.cwd();
    const runMeta: RunMeta = { ...input.runMeta, root };

    const workflowResult = await runWorkflow(
      composerMode,
      runMeta,
      messages,
      settings,
      callbacks.onTool,
      callbacks.emit,
      abortController,
      (token) => callbacks.onTextDelta(token),
      prepareTooling,
      provider,
      maxSteps,
      invokeTimeoutMs,
    );

    return {
      messages: workflowResult.messages,
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
