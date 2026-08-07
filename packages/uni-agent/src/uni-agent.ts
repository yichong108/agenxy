/**
 * UniAgent — 统一 AG-UI AbstractAgent。
 *
 * 宿主传入 agentType 与统一配置；由本类内部选择 OpenWorker / Cursor 后端。
 */

import {
  AbstractAgent,
  type AgentConfig,
  type BaseEvent,
  type RunAgentInput,
  type RunAgentParameters
} from '@ag-ui/client'
import { OpenWorkerAgent, type AgentMcp, type OpenWorkerAgentRunDefaults } from '@openworker/agent'
import { CursorAgent, type CursorAgentRunDefaults } from '@openworker/cursor-agent'
import { normalizeAgentType, type AgentType } from '@openworker/shared'
import type { LanguageModel } from 'ai'
import { Observable } from 'rxjs'

/** 统一 run 转发参数（宿主可始终传齐，本类按 agentType 裁剪） */
export type UniAgentRunDefaults = OpenWorkerAgentRunDefaults & CursorAgentRunDefaults

/**
 * UniAgent 配置：AG-UI AgentConfig + agentType + 统一后端字段。
 *
 * 宿主不必按类型分支组装 openworker/cursor 子对象；本类内部选用。
 */
export type UniAgentConfig = AgentConfig & {
  /** 后端类型：openworker（ReAct）或 cursor（SDK local） */
  agentType: AgentType
  /**
   * 角色：
   * - session（默认）：会话对话；dispose 仅释放 Cursor SDK，不动 MCP 池
   * - mcp-host：MCP 预热/探测宿主；dispose 会释放 MCP 连接池
   */
  role?: 'session' | 'mcp-host'
  /** 工作区根目录（两种后端共用） */
  cwd?: string
  /** OpenWorker：对话模型（可在 create 占位，run 时经 forwardedProps.provider 覆盖） */
  provider?: LanguageModel | null
  /** Cursor API Key */
  cursorApiKey?: string
  /** Cursor 模型 ID，默认 composer-2.5 */
  cursorModel?: string
  runDefaults?: UniAgentRunDefaults
}

/** 宿主组装本轮 run 参数时的统一输入（不必按 agentType 分支） */
export type UniAgentRunInput = {
  composerMode?: OpenWorkerAgentRunDefaults['composerMode']
  abortController?: AbortController
  workspacePath?: string
  terminalKey?: string
  provider?: LanguageModel | null
  tavilyApiKey?: string
  maxSteps?: number
  invokeTimeoutMs?: number
}

/** 创建时占位模型 */
const PLACEHOLDER_PROVIDER = { modelId: 'uni-agent-placeholder' } as LanguageModel

type BackendAgent = OpenWorkerAgent | CursorAgent

/** Cursor 后端不管理 OpenWorker MCP 池时的空实现 */
const EMPTY_CURSOR_MCP: AgentMcp = {
  async probe() {
    return { ok: false, error: 'Cursor backend does not manage OpenWorker MCP servers' }
  },
  async warmup() {
    return []
  },
  async dispose() {
    /* no-op */
  }
}

/**
 * 在 AG-UI structuredClone 前剥离不可克隆字段（provider / abortController）。
 *
 * @param forwarded - 原始 forwardedProps
 * @returns cloneable 与 extras
 */
function detachNonCloneableForwardedProps(forwarded: unknown): {
  cloneable: Record<string, unknown>
  extras: Record<string, unknown>
} {
  if (!forwarded || typeof forwarded !== 'object') {
    return { cloneable: {}, extras: {} }
  }

  const cloneable = { ...(forwarded as Record<string, unknown>) }
  const extras: Record<string, unknown> = {}

  if ('provider' in cloneable && cloneable.provider != null) {
    extras.provider = cloneable.provider
    delete cloneable.provider
  }

  if (cloneable.abortController instanceof AbortController) {
    extras.abortController = cloneable.abortController
    delete cloneable.abortController
  } else if ('abortController' in cloneable) {
    delete cloneable.abortController
  }

  return { cloneable, extras }
}

/**
 * 统一 AG-UI Agent：实现 AbstractAgent 协议，内部按 agentType 委托后端。
 *
 * 宿主契约：
 * - `run(input): Observable<BaseEvent>`
 * - `runAgent()` / `subscribe()` / `abortRun()` / `clone()` / `dispose()`
 * - `buildRunForwardedProps()` / `assertReady()` — 避免宿主按类型分支
 */
export class UniAgent extends AbstractAgent {
  /** CopilotKit Runtime 可能注入的 per-request headers */
  public headers?: Record<string, string>

  private readonly config: UniAgentConfig
  private readonly backend: BackendAgent
  private readonly role: 'session' | 'mcp-host'
  private pendingForwardedExtras: Record<string, unknown> = {}

  /**
   * 创建统一 AG-UI Agent。
   *
   * @param config - 必须含 agentType；其余字段统一传入，由本类选用
   */
  constructor(config: UniAgentConfig) {
    const {
      agentType: _t,
      role,
      cwd: _cwd,
      provider: _p,
      cursorApiKey: _k,
      cursorModel: _m,
      runDefaults: _rd,
      ...agui
    } = config
    super(agui)
    this.config = config
    this.role = role ?? 'session'
    this.backend = this.createBackend(config)
  }

  /**
   * 当前后端类型（构造时传入的 agentType）。
   */
  public get agentType(): AgentType {
    return normalizeAgentType(this.config.agentType)
  }

  /**
   * MCP 宿主能力（probe / warmup / dispose）。
   *
   * openworker 为真实连接池；cursor 返回空实现。
   */
  public get mcp(): AgentMcp {
    if (this.backend instanceof OpenWorkerAgent) {
      return this.backend.mcp
    }
    return EMPTY_CURSOR_MCP
  }

  /**
   * 校验当前后端是否具备开跑条件（密钥等）。
   *
   * 宿主应调用本方法替代自行 `if (agentType === ...)` 预检。
   *
   * @param options - 本轮可用的 provider（openworker 时）
   * @throws 缺少必要凭据时抛出 Error
   */
  public assertReady(options?: { provider?: LanguageModel | null }): void {
    if (this.agentType === 'cursor') {
      if (!this.config.cursorApiKey?.trim()) {
        throw new Error('请先在设置中配置 Cursor API Key')
      }
      return
    }
    const provider = options?.provider ?? this.config.provider
    if (!provider) {
      throw new Error('请先在设置中配置 API Key')
    }
  }

  /**
   * 按当前 agentType 裁剪本轮 forwardedProps。
   *
   * 宿主始终传入统一字段即可，无需按类型组装两套对象。
   *
   * @param input - 统一 run 参数
   * @returns 可交给 runAgent({ forwardedProps }) 的对象
   */
  public buildRunForwardedProps(input: UniAgentRunInput): UniAgentRunDefaults {
    const base = {
      composerMode: input.composerMode,
      abortController: input.abortController,
      workspacePath: input.workspacePath
    }

    if (this.agentType === 'cursor') {
      return base
    }

    return {
      ...base,
      provider: input.provider ?? this.config.provider ?? undefined,
      terminalKey: input.terminalKey,
      tavily: input.tavilyApiKey != null ? { apiKey: input.tavilyApiKey } : undefined,
      maxSteps: input.maxSteps,
      invokeTimeoutMs: input.invokeTimeoutMs
    }
  }

  /**
   * 克隆当前 UniAgent（新后端实例，复制 AG-UI 消息与 state）。
   *
   * @returns 新的 UniAgent
   */
  public clone(): UniAgent {
    const cloned = new UniAgent({
      ...this.config,
      threadId: this.threadId,
      initialMessages: structuredClone(this.messages),
      initialState: structuredClone(this.state)
    })
    if (this.headers) {
      cloned.headers = { ...this.headers }
    }
    return cloned
  }

  /**
   * 取消当前进行中的 run。
   */
  public abortRun(): void {
    this.backend.abortRun()
    super.abortRun()
  }

  /**
   * 释放后端资源。
   *
   * - session + cursor：释放 Cursor SDK
   * - mcp-host：释放 OpenWorker MCP 连接池
   * - session + openworker：no-op（避免误清进程级 MCP 池）
   */
  public async dispose(): Promise<void> {
    if (this.role === 'mcp-host') {
      await this.backend.dispose()
      return
    }
    if (this.backend instanceof CursorAgent) {
      await this.backend.dispose()
    }
  }

  /**
   * 组装 RunAgentInput：剥离不可克隆的 forwardedProps。
   *
   * @param parameters - runAgent 入参
   * @returns 可安全克隆的 RunAgentInput
   */
  protected prepareRunAgentInput(parameters?: RunAgentParameters): RunAgentInput {
    const { cloneable, extras } = detachNonCloneableForwardedProps(parameters?.forwardedProps)
    this.pendingForwardedExtras = extras
    return super.prepareRunAgentInput({
      ...parameters,
      forwardedProps: cloneable
    })
  }

  /**
   * 按 AG-UI 协议执行一轮：将外层 messages 灌入后端后委托 `run`。
   *
   * 本轮 assistant 正文由外层 AbstractAgent.apply 根据事件流累加到 this.messages；
   * 结束后不要用 backend.messages 回写覆盖。
   *
   * @param input - AG-UI RunAgentInput
   * @returns BaseEvent 流
   */
  public run(input: RunAgentInput): Observable<BaseEvent> {
    this.backend.messages = [...this.messages]

    const mergedForwarded = {
      ...this.pendingForwardedExtras,
      ...(input.forwardedProps && typeof input.forwardedProps === 'object'
        ? (input.forwardedProps as Record<string, unknown>)
        : {})
    }

    const backendInput: RunAgentInput = {
      ...input,
      messages: this.backend.messages,
      forwardedProps: this.trimForwardedPropsForBackend(mergedForwarded)
    }

    return new Observable<BaseEvent>((subscriber) => {
      const subscription = this.backend.run(backendInput).subscribe({
        next: (event) => {
          if (!subscriber.closed) subscriber.next(event)
        },
        error: (err) => {
          // 外层 AbstractAgent.apply 已根据 TEXT_MESSAGE_* 更新 this.messages；
          // 后端并不维护完整 AG-UI messages，禁止用 backend.messages 覆盖以免冲掉本轮正文。
          this.pendingForwardedExtras = {}
          if (!subscriber.closed) subscriber.error(err)
        },
        complete: () => {
          this.pendingForwardedExtras = {}
          if (!subscriber.closed) subscriber.complete()
        }
      })

      return () => {
        subscription.unsubscribe()
        this.pendingForwardedExtras = {}
      }
    })
  }

  /**
   * 按 agentType 裁剪传给后端的 forwardedProps。
   *
   * @param forwarded - 合并后的 forwardedProps
   * @returns 后端可用的子集
   */
  private trimForwardedPropsForBackend(
    forwarded: Record<string, unknown>
  ): Record<string, unknown> {
    if (this.agentType === 'cursor') {
      const out: Record<string, unknown> = {}
      if (forwarded.composerMode != null) out.composerMode = forwarded.composerMode
      if (forwarded.abortController != null) out.abortController = forwarded.abortController
      if (forwarded.workspacePath != null) out.workspacePath = forwarded.workspacePath
      return out
    }
    return { ...forwarded }
  }

  /**
   * 按 agentType 创建底层 AG-UI 后端实例。
   *
   * @param config - UniAgentConfig
   * @returns OpenWorkerAgent 或 CursorAgent
   */
  private createBackend(config: UniAgentConfig): BackendAgent {
    const agentType = normalizeAgentType(config.agentType)
    const cwd = config.cwd?.trim() || undefined
    const common = {
      ...(config.threadId ? { threadId: config.threadId } : {}),
      ...(config.initialMessages ? { initialMessages: config.initialMessages } : {}),
      ...(config.initialState != null ? { initialState: config.initialState } : {})
    }

    if (agentType === 'cursor') {
      return new CursorAgent({
        agentId: config.agentId ?? 'uni-cursor',
        description: config.description ?? 'Openworker uni Cursor agent',
        ...common,
        agent: {
          apiKey: config.cursorApiKey?.trim() || '',
          model: config.cursorModel?.trim() || 'composer-2.5',
          ...(cwd ? { local: { cwd } } : {})
        },
        ...(config.runDefaults ? { runDefaults: config.runDefaults as CursorAgentRunDefaults } : {})
      })
    }

    return new OpenWorkerAgent({
      agentId: config.agentId ?? 'uni-openworker',
      description: config.description ?? 'Openworker uni ReAct agent',
      ...common,
      agent: {
        provider: config.provider ?? PLACEHOLDER_PROVIDER,
        ...(cwd ? { local: { cwd } } : {})
      },
      ...(config.runDefaults
        ? { runDefaults: config.runDefaults as OpenWorkerAgentRunDefaults }
        : {})
    })
  }
}
