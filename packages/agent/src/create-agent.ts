/**
 * createAgent 是 agent 的唯一入口工厂。
 * 它负责创建 agent 实例，并提供 send 方法，用于发起一次 agent run。
 */

import {
  type AgentComposerMode,
  type AppSettings,
  type McpServerEntry,
  type StreamEvent,
  type ToolTimelineEvent,
} from "@agenwork/shared";
import type { LanguageModel } from "ai";

import type {
  ReactRunBridge,
  RunMeta,
  WorkflowRunContext,
} from "./run-types.js";
import {
  buildMcpToolsFromConfig,
  disposeMcpConnectionPool,
  probeMcpServer,
  warmupMcpServersFromConfig,
} from "./mcp/mcp-runtime.js";
import type { McpProbeResult, McpWarmupServerResult } from "./mcp/types.js";
import {
  type AgentMessage,
  contentToText,
  findLastAiMessage,
} from "./messages.js";
import { runWorkflow, type WorkflowDeps } from "./run-workflow.js";
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
 *
 * 更复杂的 skills 组装（如按来源合并、市场安装）应由宿主在 prepareTooling 中自行完成。
 */
export type CreateAgentSkillsOptions = {
  /** 技能根目录绝对路径列表；递归扫描 SKILL.md，同名时靠前路径优先 */
  paths: string[];
};

/**
 * createAgent MCP 配置：传入配置文件路径，由 agent 内部加载并绑定 MCP 工具。
 *
 * 配置文件支持 Cursor 形态与本应用数组形态。
 * 无论是否注入 prepareTooling，只要提供 configPath，agent 都会在 build 模式叠加 MCP 工具。
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
 * 配置 mcp.configPath 后，agent 会从该文件加载 MCP 并绑定工具（含自定义 prepareTooling 时）。
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
  /** AI SDK LanguageModel；未传则在 send 时从 settings 解析 */
  provider?: LanguageModel;
  /** 本地运行环境 */
  local?: CreateAgentLocalOptions;
  /**
   * Skills 扫描路径；仅在未注入 prepareTooling 时由默认 tooling 使用。
   * 宿主注入 prepareTooling 时自行决定如何加载 skills。
   */
  skills?: CreateAgentSkillsOptions;
  /**
   * MCP 配置文件路径；由 agent 内部实现连接池与工具绑定。
   * 注入 prepareTooling 时仍会自动叠加 MCP 工具与上下文提示。
   */
  mcp?: CreateAgentMcpOptions;
  /** 工具与 prompt 组装；未传则使用工作区内置工具 + skills.paths（若有） */
  prepareTooling?: WorkflowDeps["prepareTooling"];
};

/**
 * 单次 run 的宿主回调：流式输出、timeline 与持久化。
 */
export type AgentRunCallbacks = {
  onTextDelta: (text: string) => void;
  onTool: (event: ToolTimelineEvent) => void;
  emit: (event: StreamEvent) => void;
  persistMessages: (messages: AgentMessage[]) => void;
};

/**
 * 单次 agent run 的输入。
 */
export type AgentRunInput = {
  composerMode: AgentComposerMode;
  messages: AgentMessage[];
  abortController: AbortController;
  settings: AppSettings;
  runMeta: RunMeta;
  callbacks: AgentRunCallbacks;
  recursionLimit: number;
  invokeTimeoutMs: number;
};

/**
 * 单次 agent run 的结果。
 */
export type AgentRunResult = {
  messages: AgentMessage[];
  toolEvents: ToolTimelineEvent[];
  streamedChars: number;
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
 * 将 MCP 工具与上下文提示合并进已有 prepareTooling 结果。
 *
 * @param base - 宿主或默认 prepareTooling
 * @param mcpConfigPath - MCP 配置文件路径
 * @returns 叠加 MCP 后的 prepareTooling
 */
function wrapPrepareToolingWithMcp(
  base: NonNullable<CreateAgentOptions["prepareTooling"]>,
  mcpConfigPath: string,
): NonNullable<CreateAgentOptions["prepareTooling"]> {
  return async (args) => {
    const prepared = await base(args);
    if (args.composerMode === "ask") return prepared;

    const mcpResult = await buildMcpToolsFromConfig(mcpConfigPath, args.runCtx);
    if (!mcpResult.tools.length && !mcpResult.contextHints) return prepared;

    return {
      tools: [...prepared.tools, ...mcpResult.tools],
      runPrompt: mcpResult.contextHints
        ? `${prepared.runPrompt}\n\n${mcpResult.contextHints}`
        : prepared.runPrompt,
    };
  };
}

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
): NonNullable<CreateAgentOptions["prepareTooling"]> {
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
      : { tools: [], hint: "" };

    let mcpExtras: WorkspacePromptExtras = {};
    let mcpTools: typeof workspaceTools = [];
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
      tools: [...skillBundle.tools, ...workspaceTools, ...mcpTools],
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
 * 最简入参为 provider + local.cwd；prepareTooling 等未传时使用默认。
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

  const basePrepare =
    options.prepareTooling ??
    createDefaultPrepareTooling(skillPaths, mcpConfigPath);

  // 宿主注入 prepareTooling 时，默认 tooling 不会跑；仍需按 configPath 叠加 MCP
  const prepareTooling =
    options.prepareTooling && mcpConfigPath
      ? wrapPrepareToolingWithMcp(options.prepareTooling, mcpConfigPath)
      : basePrepare;

  const deps: WorkflowDeps = {
    prepareTooling,
    provider: options.provider,
  };

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
      abortController,
      settings,
      callbacks,
      recursionLimit,
      invokeTimeoutMs,
    } = input;

    const root = input.runMeta.root?.trim() || defaultCwd || process.cwd();
    const runMeta: RunMeta = { ...input.runMeta, root };

    const runToolEvents: ToolTimelineEvent[] = [];
    const streamedCharsRef = { current: 0 };

    const reactBridge: ReactRunBridge = {
      abortController,
      recursionLimit,
      invokeTimeoutMs,
      streamedCharsRef,
      pushStreamToken: (token) => callbacks.onTextDelta(token),
    };

    const runContext: WorkflowRunContext = {
      settings,
      signal: abortController.signal,
      onTool: (e) => {
        runToolEvents.push(e);
        callbacks.onTool(e);
      },
      emit: callbacks.emit,
      runToolEvents,
      reactBridge,
      provider: options.provider,
    };

    const workflowResult = await runWorkflow(
      {
        composerMode,
        messages,
        runMeta,
        runContext,
        initRunCallbacks: {
          persistMessages: callbacks.persistMessages,
        },
        signal: abortController.signal,
      },
      deps,
    );

    // 如果流式文本为空，则尝试 fallback 到最后一轮 AI 消息。
    // 因为流式文本为空，说明用户没有输入，或者输入了但是没有触发流式输出。
    // 这时候尝试 fallback 到最后一轮 AI 消息，可能能得到一些有价值的内容。
    // 当然，如果流式文本不为空，则不进行 fallback。
    // 这里 fallback 到最后一轮 AI 消息，而不是第一轮 AI 消息，是因为第一轮 AI 消息可能是系统提示词，不是用户输入。
    // 当然，如果最后一轮 AI 消息也没有内容，则不进行 fallback。
    // fallback是为了什么？避免用户输入了但是没有触发流式输出，导致用户没有收到任何内容。
    if (streamedCharsRef.current === 0) {
      const lastAi = findLastAiMessage(workflowResult.messages);
      const fallback = lastAi ? contentToText(lastAi.content) : "";
      if (fallback) {
        callbacks.onTextDelta(fallback);
      }
    }

    return {
      messages: workflowResult.messages,
      toolEvents: workflowResult.toolEvents,
      streamedChars: streamedCharsRef.current,
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
