/**
 * createAgent 是 agent 的唯一入口工厂。
 * 它负责创建 agent 实例，并提供 send 方法，用于发起一次 agent run。
 */

import {
  type AgentComposerMode,
  type McpServerEntry,
  normalizeComposerMode,
  type StreamEvent,
} from "@luneto/shared";
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
import {
  contentToText,
  findLastAssistantMessage,
  userMessage,
} from "./messages.js";
import { runReactLoop } from "./react-loop.js";
import { isAbortError } from "./run-utils.js";
import { loadSkillsFromPaths } from "./skills/load-skills.js";
import {
  buildWorkspaceRunPrompt,
  buildWorkspaceTools,
  type WorkspacePromptExtras,
} from "./tools/workspace-tools.js";

/**
 * 将捕获的异常映射为 wait 状态。
 *
 * 超时归为 error；AbortError / 用户取消归为 cancelled。
 *
 * @param error - send 捕获的异常
 * @param signal - 本轮 AbortSignal
 * @returns error 或 cancelled
 */
function resolveWaitFailureStatus(
  error: unknown,
  signal: AbortSignal,
): "error" | "cancelled" {
  if (error instanceof Error && /timeout/i.test(error.message)) {
    return "error";
  }
  if (isAbortError(error) || signal.aborted) {
    return "cancelled";
  }
  return "error";
}

/**
 * 从 messages 提取最后一条助手文本。
 *
 * @param messages - 本轮结束后的 CoreMessage 列表
 * @returns 助手纯文本；无则空串
 */
function extractAssistantText(messages: CoreMessage[]): string {
  const last = findLastAssistantMessage(messages);
  return last ? contentToText(last.content) : "";
}

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
 * provider 必填；messages / local 可选（messages 默认 []，cwd 回退 process.cwd()）。
 * 其余未传时使用内置默认（工作区工具）。
 * 配置 skills.paths 后，默认 tooling 会叠加这些路径下的技能工具。
 * 配置 mcp.configPath 后，agent 会从该文件加载 MCP 并绑定工具。
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   provider: model,
 *   messages: history,
 *   local: { cwd: process.cwd() },
 *   skills: { paths: ['/path/to/skills'] },
 *   mcp: { configPath: '/path/to/mcp.json' }
 * })
 * ```
 */
export type CreateAgentOptions = {
  /** AI SDK LanguageModel；创建时必填，send 未传 provider 时作为本轮对话模型 */
  provider: LanguageModel;
  /**
   * 会话消息初始值；由 agent 持有。
   * 可选，默认 []。send 会追加本轮用户消息并在结束后写回完整轨迹，以支持连续 send。
   */
  messages?: CoreMessage[];
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
 * 单次 agent run 的可选参数（send 的第二参）。
 *
 * 调用形态：`send(userText, options?)`。
 * 会话历史由 createAgent / agent.messages 持有；send 内部追加 userText 并写回。
 * 回调均为可选，未传时使用空操作。
 * 工具时间线（ToolTimelineEvent）由宿主在 onTool 中自行映射与收集。
 */
export type AgentRunInput = {
  /**
   * 发送模式；可选，默认 build（非法值亦回退 build）。
   */
  composerMode?: AgentComposerMode;
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
  /** 流式文本增量回调；可选 */
  onTextDelta?: (text: string) => void;
  /** 工具观察回调；可选，宿主可在此映射与收集工具时间线 */
  onTool?: (event: ToolObservation) => void;
  /** 向宿主推送 StreamEvent（如错误、状态）；可选 */
  onEmit?: (event: StreamEvent) => void;
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
 * agent.wait() 的终态状态。
 */
export type AgentWaitStatus = "finished" | "error" | "cancelled";

/**
 * agent.wait() 的返回值：本轮 run 的摘要终态。
 *
 * @example
 * ```ts
 * void agent.send('hi', { onTextDelta, onTool, onEmit })
 * const result = await agent.wait()
 * console.log(result.status) // "finished" | "error" | "cancelled"
 * console.log(result.result) // 最终助手文本
 * console.log(result.error)  // 失败时有
 * // 连续 send：历史已在 agent.messages 中
 * await agent.send('继续', {})
 * ```
 */
export type AgentWaitResult = {
  /** 本轮终态 */
  status: AgentWaitStatus;
  /** 最终助手文本；失败/取消时可能为空 */
  result: string;
  /** 失败或取消时的错误；成功时为 undefined */
  error?: unknown;
};

/**
 * createAgent 返回的 agent 实例。
 */
export type Agent = {
  /**
   * 当前会话消息；创建时来自 CreateAgentOptions.messages。
   * send 会追加本轮用户消息，成功后写回含助手回复的完整轨迹，可直接再 send。
   */
  messages: CoreMessage[];
  /**
   * 发起一次 run：`send(userText, options?)`。
   * 内部更新 messages；同会话互斥由宿主保证，不同会话可并行。
   */
  send: (userText: string, input?: AgentRunInput) => Promise<AgentRunResult>;
  /**
   * 等待当前（或最近一次）run 结束，返回摘要终态。
   * 未调用过 send 时抛出错误。
   */
  wait: () => Promise<AgentWaitResult>;
  /** MCP 宿主侧能力；未配置 mcp.configPath 时为 undefined */
  mcp?: AgentMcp;
};

/**
 * 创建 agent 实例 — packages/agent 的唯一入口工厂。
 *
 * 必填 provider；messages / local 可选（messages 默认 []，cwd 回退 process.cwd()）。
 * 工具与 prompt 由内置默认 tooling 组装。
 * 可选 skills.paths 提供基础 Skills；mcp.configPath 由 agent 内部实现 MCP。
 * 可 `await createAgent(...)`（函数本身同步，await 无害）。
 *
 * 注意：不直接与外部耦合。同会话「运行中不可再发」由宿主按 session 互斥；
 * 不同会话各自独立 send，互不排队。
 *
 * @param options - 创建配置；provider 必填，messages / local 有默认值
 * @returns 可 send / wait 的 agent 实例
 */
export function createAgent(options: CreateAgentOptions): Agent {
  const local = options.local ?? DEFAULT_LOCAL;
  const defaultCwd = local.cwd?.trim() || process.cwd();
  const defaultProvider = options.provider;
  /** 会话消息由 agent 持有；初始值来自 options.messages */
  let messages: CoreMessage[] = [...(options.messages ?? [])];
  const skillPaths = (options.skills?.paths ?? [])
    .map((p) => p.trim())
    .filter(Boolean);
  const mcpConfigPath = options.mcp?.configPath?.trim() || undefined;

  /** 当前进行中的 wait Promise；无进行中 run 时为 null */
  let inflightWait: Promise<AgentWaitResult> | null = null;
  /** 最近一次已结束 run 的 wait 结果，供重复 wait() */
  let lastWaitResult: AgentWaitResult | null = null;

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
   * 发起一次 agent run：追加用户消息 → 组装工具与 prompt → ReAct 循环。
   *
   * 调用：`send(userText, options?)`。内部将 userText 追加到 agent.messages，
   * 成功后写回完整轨迹，因此可连续多次 send。
   * 消息持久化仍由宿主负责。失败时 wait 得 status，send 仍会 rethrow；
   * 已追加的用户消息会保留在 agent.messages（便于重试或展示）。
   *
   * @param userText - 本轮用户文本
   * @param input - 可选 run 参数（回调、模式、超时等）
   * @returns 运行结束后的 messages
   * @throws 消息为空、运行失败或取消时抛出（wait 仍可拿到对应 status）
   */
  async function send(
    userText: string,
    input: AgentRunInput = {},
  ): Promise<AgentRunResult> {
    const trimmed = userText.trim();
    if (!trimmed) {
      throw new Error("userText is empty");
    }

    const onTextDelta = input.onTextDelta ?? (() => {});
    const onTool = input.onTool ?? (() => {});
    const onEmit = input.onEmit ?? (() => {});
    const { maxSteps, invokeTimeoutMs } = input;

    // 追加本轮用户消息并立即写回，保证连续 send / 失败重试时历史连贯
    const inputMessages = [...messages, userMessage(trimmed)];
    messages = inputMessages;

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

    let settleWait!: (value: AgentWaitResult) => void;
    const waitPromise = new Promise<AgentWaitResult>((resolve) => {
      settleWait = resolve;
    });
    inflightWait = waitPromise;

    try {
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
        inputMessages,
        tooling.tools,
        abortController,
        onTextDelta,
        maxSteps,
        invokeTimeoutMs,
      );

      const finalMessages =
        runMessages.length > 0 ? runMessages : inputMessages;
      // 写回完整轨迹，供下一次 send 直接续聊
      messages = finalMessages;
      const waitResult: AgentWaitResult = {
        status: "finished",
        result: extractAssistantText(finalMessages),
      };
      lastWaitResult = waitResult;
      settleWait(waitResult);
      return { messages: finalMessages };
    } catch (error) {
      const waitResult: AgentWaitResult = {
        status: resolveWaitFailureStatus(error, abortController.signal),
        result: "",
        error,
      };
      lastWaitResult = waitResult;
      settleWait(waitResult);
      throw error;
    } finally {
      if (inflightWait === waitPromise) {
        inflightWait = null;
      }
    }
  }

  /**
   * 等待当前进行中的 run，或返回最近一次 run 的终态。
   *
   * @returns 含 status / result / error 的摘要
   * @throws 尚未调用过 send 时抛出
   */
  async function wait(): Promise<AgentWaitResult> {
    if (inflightWait) {
      return inflightWait;
    }
    if (lastWaitResult) {
      return lastWaitResult;
    }
    throw new Error("No agent run to wait for; call send() first");
  }

  const mcp: AgentMcp | undefined = mcpConfigPath
    ? {
        probe: (entry) => probeMcpServer(entry),
        warmup: () => warmupMcpServersFromConfig(mcpConfigPath),
        dispose: () => disposeMcpConnectionPool(),
      }
    : undefined;

  return {
    get messages() {
      return messages;
    },
    set messages(next: CoreMessage[]) {
      messages = [...next];
    },
    send,
    wait,
    ...(mcp ? { mcp } : {}),
  };
}
