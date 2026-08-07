import {
  assistantDisplayTimeline,
  formatWorkedDurationZh,
  type MessageTurn,
  remarkLinkifyBareUrls
} from './center-pane-utils'
import {
  displayLineNumber,
  type FileDiffLine,
  type FileEditDiffView,
  guessHighlightLanguage,
  highlightCodeLines,
  resolveFileEditDiff
} from './file-edit-diff'
import {
  estimateTimelineDurationMs,
  formatAtomicToolTitle,
  formatEditTitle,
  formatExploredTitle,
  formatMcpTitle,
  formatShellTitle,
  formatThoughtTitle,
  groupWorkedTimeline,
  isBriefThought,
  type WorkedChild,
  type WorkedNode
} from './worked-timeline'
import { CheckOutlined, CopyOutlined, RightOutlined } from '@ant-design/icons'
import { App as AntdApp, Card, Typography } from 'antd'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

import type { ChatMessage, ToolCallEvent, ToolTimelineEvent } from '@/shared/ipc'

const { Text } = Typography

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkLinkifyBareUrls]
const MARKDOWN_REHYPE_PLUGINS = [rehypeHighlight]

/** 递归收集 React 节点中的纯文本，用于代码块复制 */
function collectTextContent(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectTextContent).join('')
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return collectTextContent(node.props.children)
  }
  return ''
}

type MarkdownCodeBlockProps = {
  children?: React.ReactNode
}

/**
 * Markdown 围栏代码块：右上角复制按钮（不展示语言行）。
 *
 * 点击复制会写入剪贴板，并短暂切换为勾选图标作为反馈；
 * 事件 stopPropagation，避免触发外层 Markdown 外链确认逻辑。
 */
function MarkdownCodeBlock({ children }: MarkdownCodeBlockProps) {
  const { message: msgApi } = AntdApp.useApp()
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    }
  }, [])

  const codeText = collectTextContent(children)

  const handleCopy = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (!codeText) {
        msgApi.warning('没有可复制的代码')
        return
      }
      try {
        await navigator.clipboard.writeText(codeText)
        setCopied(true)
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
        resetTimerRef.current = setTimeout(() => setCopied(false), 1600)
      } catch {
        msgApi.error('复制失败，请手动选择文本复制')
      }
    },
    [codeText, msgApi]
  )

  return (
    <div className="app-message-codeblock">
      <button
        type="button"
        className="app-message-codeblock-copy"
        onClick={(event) => void handleCopy(event)}
        aria-label={copied ? '已复制' : '复制代码'}
        title={copied ? '已复制' : '复制'}
      >
        {copied ? <CheckOutlined /> : <CopyOutlined />}
      </button>
      <pre>{children}</pre>
    </div>
  )
}

/**
 * Markdown 自定义节点映射。
 *
 * 为代码块增加右上角复制、为表格增加横向滚动外壳，
 * 其余节点沿用默认渲染并由 SCSS 控制观感。
 */
const MARKDOWN_COMPONENTS: Components = {
  pre({ children }) {
    return <MarkdownCodeBlock>{children}</MarkdownCodeBlock>
  },
  table({ children }) {
    return (
      <div className="app-message-markdown-table-wrap">
        <table>{children}</table>
      </div>
    )
  }
}

export type MessageTurnItemProps = {
  /** 单个消息回合（用户消息及其后的 assistant 回复等） */
  turn: MessageTurn
  /** 当前会话最新 assistant 消息 id，用于时间线与流式态判定 */
  latestAssistantMessageId: string | null
  /** 当前会话是否正在执行 */
  isRun: boolean
  /** 当前会话的工具时间线 */
  currentTimeline: ToolTimelineEvent[]
  /** 工具时间线手风琴展开状态覆盖表，key 为 assistant message id */
  timelineOpenOverride: Record<string, boolean>
  /** 更新工具时间线手风琴展开状态 */
  setTimelineOpenOverride: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  /** 当前运行耗时（毫秒），用于时间线标题展示 */
  timelineWallMs: number
  /** Markdown 区域点击外链时的确认处理 */
  onMarkdownClick: (event: React.MouseEvent<HTMLDivElement>) => void
}

/** 单条消息卡片渲染所需的会话级上下文 */
type MessageCardContext = Pick<
  MessageTurnItemProps,
  | 'latestAssistantMessageId'
  | 'isRun'
  | 'currentTimeline'
  | 'timelineOpenOverride'
  | 'setTimelineOpenOverride'
  | 'timelineWallMs'
  | 'onMarkdownClick'
>

/** 单条消息的派生展示状态，将分支判断集中在 JSX 之外 */
type MessageCardView = {
  isLatestAssistant: boolean
  isStreaming: boolean
  worked: WorkedNode
  wallMs: number
  timelineExpanded: boolean
  showWorkedAccordion: boolean
  contentPlaceholder: string
}

/**
 * 根据消息与会话上下文计算单条消息的展示派生状态。
 *
 * @param msg - 当前消息
 * @param ctx - 会话级展示上下文
 * @returns 供子组件使用的只读视图模型
 */
function buildMessageCardView(msg: ChatMessage, ctx: MessageCardContext): MessageCardView {
  const isLatestAssistant = msg.role === 'assistant' && msg.id === ctx.latestAssistantMessageId
  const isStreaming = Boolean(ctx.isRun && isLatestAssistant)
  const displayTimeline = assistantDisplayTimeline(
    msg,
    ctx.latestAssistantMessageId,
    isStreaming,
    ctx.currentTimeline
  )
  const worked = groupWorkedTimeline(displayTimeline)
  // 有过程事件，或当前 run 中的最新 assistant：显示 Worked（过程可追溯）
  const showWorkedAccordion =
    worked.children.length > 0 || (isLatestAssistant && Boolean(ctx.isRun))
  const timelineExpanded =
    ctx.timelineOpenOverride[msg.id] !== undefined
      ? ctx.timelineOpenOverride[msg.id]!
      : Boolean(ctx.isRun)

  const estimatedMs = estimateTimelineDurationMs(displayTimeline)
  const wallMs =
    isLatestAssistant && (ctx.isRun || ctx.timelineWallMs > 0)
      ? ctx.timelineWallMs
      : (estimatedMs ?? ctx.timelineWallMs)

  return {
    isLatestAssistant,
    isStreaming,
    worked,
    wallMs,
    timelineExpanded,
    showWorkedAccordion,
    contentPlaceholder: isStreaming ? '…' : ''
  }
}

type MessageMarkdownProps = {
  content: string
  className?: string
  onMarkdownClick: (event: React.MouseEvent<HTMLDivElement>) => void
}

/** 消息区 Markdown 渲染，统一 remark/rehype 插件配置 */
function MessageMarkdown({
  content,
  className = 'app-message-markdown',
  onMarkdownClick
}: MessageMarkdownProps) {
  return (
    <div className={className} onClick={onMarkdownClick}>
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

type MessageContentCopyButtonProps = {
  /** 要写入剪贴板的完整 Markdown 原文 */
  text: string
}

/**
 * 助手回复完成后的全文复制按钮（右下角常显）。
 *
 * @param text - 消息 Markdown 原文
 */
function MessageContentCopyButton({ text }: MessageContentCopyButtonProps) {
  const { message: msgApi } = AntdApp.useApp()
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    }
  }, [])

  const handleCopy = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      const value = text.trim()
      if (!value) {
        msgApi.warning('没有可复制的内容')
        return
      }
      try {
        await navigator.clipboard.writeText(value)
        setCopied(true)
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
        resetTimerRef.current = setTimeout(() => setCopied(false), 1600)
      } catch {
        msgApi.error('复制失败，请手动选择文本复制')
      }
    },
    [msgApi, text]
  )

  return (
    <button
      type="button"
      className="app-message-markdown-copy"
      onClick={(event) => void handleCopy(event)}
      aria-label={copied ? '已复制' : '复制回复'}
      title={copied ? '已复制' : '复制'}
    >
      {copied ? <CheckOutlined /> : <CopyOutlined />}
    </button>
  )
}

type NestedAccordionProps = {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
  className?: string
}

/**
 * Worked 内二级手风琴（Thought / Explored 等）。
 *
 * 默认折叠；展开后显示 L3 原子步骤或思考正文。
 */
function NestedAccordion({
  title,
  defaultOpen = false,
  children,
  className
}: NestedAccordionProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className={`app-worked-l2${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="app-worked-l2-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="app-worked-l2-title">{title}</span>
        <RightOutlined className={`app-timeline-chevron${open ? ' is-open' : ''}`} />
      </button>
      {open ? <div className="app-worked-l2-body">{children}</div> : null}
    </div>
  )
}

type AtomicToolRowProps = {
  event: ToolCallEvent
}

/** Explored 内的 L3 原子工具行 */
function AtomicToolRow({ event }: AtomicToolRowProps) {
  const [open, setOpen] = useState(false)
  const hasDetail = Boolean(event.args || (event.status === 'end' && event.result))
  const title = formatAtomicToolTitle(event)

  if (!hasDetail) {
    return (
      <div className="app-worked-l3-item">
        <span className="app-worked-l3-title">{title}</span>
      </div>
    )
  }

  return (
    <div className="app-worked-l3-item">
      <button
        type="button"
        className="app-worked-l3-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="app-worked-l3-title">{title}</span>
        <RightOutlined className={`app-timeline-chevron${open ? ' is-open' : ''}`} />
      </button>
      {open ? (
        <div className="app-worked-l3-body">
          {event.args ? <div className="app-worked-args">{event.args}</div> : null}
          {event.status === 'end' && event.result ? (
            <pre className="app-timeline-result">{event.result}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

type ToolLeafRowProps = {
  title: string
  event: ToolCallEvent
  defaultOpen?: boolean
}

type FileDiffLineRowProps = {
  line: FileDiffLine
  index: number
  codeHtml: string
}

/**
 * 渲染单行 unified diff（行号 + +/- + 语法高亮）。
 *
 * @param line - diff 行
 * @param index - 列表索引
 * @param codeHtml - 行内 HTML
 */
function FileDiffLineRow({ line, index, codeHtml }: FileDiffLineRowProps) {
  const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
  const lineno = displayLineNumber(line)
  return (
    <div className={`app-file-diff-line is-${line.kind}`} data-diff-index={index}>
      <span className="app-file-diff-lineno" aria-hidden>
        {lineno ?? ''}
      </span>
      <span className="app-file-diff-sign" aria-hidden>
        {prefix}
      </span>
      <span className="app-file-diff-code" dangerouslySetInnerHTML={{ __html: codeHtml || ' ' }} />
    </div>
  )
}

/**
 * 将纯文本转义为可安全写入 innerHTML 的片段。
 *
 * @param text - 原始行文本
 */
function escapePlain(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 编辑文件展开区：jsdiff 计算 + 轻量 unified 渲染（无文件名头、带行号）。
 *
 * @param view - 已解析的 diff 视图模型
 */
function FileEditDiffBody({ view }: { view: FileEditDiffView }) {
  const language = useMemo(() => guessHighlightLanguage(view.path), [view.path])
  const beforeHtmlLines = useMemo(
    () => highlightCodeLines(view.before, language),
    [view.before, language]
  )
  const afterHtmlLines = useMemo(
    () => highlightCodeLines(view.after, language),
    [view.after, language]
  )

  const codeHtmlForLine = (line: FileDiffLine): string => {
    if (line.kind === 'del' && line.oldLine != null) {
      return beforeHtmlLines[line.oldLine - 1] ?? escapePlain(line.text)
    }
    if (line.newLine != null) {
      return afterHtmlLines[line.newLine - 1] ?? escapePlain(line.text)
    }
    return escapePlain(line.text)
  }

  return (
    <div className="app-file-diff" role="region" aria-label={`${view.path} 的变更`}>
      {view.lines.length === 0 ? (
        <div className="app-file-diff-empty">（无内容变更）</div>
      ) : (
        view.lines.map((line, index) => (
          <FileDiffLineRow
            key={`${line.kind}-${line.oldLine ?? ''}-${line.newLine ?? ''}-${index}`}
            line={line}
            index={index}
            codeHtml={codeHtmlForLine(line)}
          />
        ))
      )}
    </div>
  )
}

/** Shell / Edit / MCP / 通用工具：Worked 下的 L2 叶子（可展开看输出） */
function ToolLeafRow({ title, event, defaultOpen = false }: ToolLeafRowProps) {
  const [open, setOpen] = useState(defaultOpen)
  const hasDetail = Boolean(event.args || (event.status === 'end' && event.result))

  return (
    <div className="app-worked-l2">
      <button
        type="button"
        className="app-worked-l2-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={!hasDetail}
      >
        <span className="app-worked-l2-title">{title}</span>
        <RightOutlined
          className={`app-timeline-chevron${open ? ' is-open' : ''}${hasDetail ? '' : ' is-hidden'}`}
        />
      </button>
      {open && hasDetail ? (
        <div className="app-worked-l2-body">
          {event.args ? <div className="app-worked-args">{event.args}</div> : null}
          {event.status === 'end' && event.result ? (
            <pre className="app-timeline-result">{event.result}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

type EditToolLeafRowProps = {
  title: string
  event: ToolCallEvent
}

/**
 * 编辑类工具叶子：展开时优先渲染文件 diff；无法解析时回退到通用 ToolLeafRow。
 *
 * @param title - 二级标题
 * @param event - write_file / delete_file 事件
 */
function EditToolLeafRow({ title, event }: EditToolLeafRowProps) {
  const [open, setOpen] = useState(false)
  const diffView = useMemo(
    () => resolveFileEditDiff(event.name, event.args, event.result),
    [event.name, event.args, event.result]
  )
  const hasDetail = Boolean(diffView || event.args || (event.status === 'end' && event.result))

  if (!diffView) {
    return <ToolLeafRow title={title} event={event} />
  }

  return (
    <div className="app-worked-l2">
      <button
        type="button"
        className="app-worked-l2-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={!hasDetail}
      >
        <span className="app-worked-l2-title">{title}</span>
        <RightOutlined
          className={`app-timeline-chevron${open ? ' is-open' : ''}${hasDetail ? '' : ' is-hidden'}`}
        />
      </button>
      {open && hasDetail ? (
        <div className="app-worked-l2-body">
          <FileEditDiffBody view={diffView} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * Thought 行：对齐 Cursor——标签 +（可选）正文，不是二级手风琴。
 *
 * - 略作思考：仅一行灰字标题
 * - 较长思考：标题「思考 · N 秒」+ 正文始终可见（随 Worked 展开）
 */
function ThoughtRow({ child }: { child: Extract<WorkedChild, { kind: 'thought' }> }) {
  const title = formatThoughtTitle(child)
  const brief = isBriefThought(child)
  const text = child.text.trim()

  return (
    <div className={`app-worked-thought${brief ? ' is-brief' : ''}`}>
      <div className="app-worked-thought-label">{title}</div>
      {text ? <div className="app-worked-thought-text">{text}</div> : null}
    </div>
  )
}

/**
 * 渲染单个 Worked L2 子节点。
 *
 * Thought 为静态标签块；Explored 为可折叠组；Shell/Edit/MCP 为可展开叶子。
 */
function WorkedChildNode({ child }: { child: WorkedChild }) {
  if (child.kind === 'thought') {
    return <ThoughtRow child={child} />
  }

  if (child.kind === 'explored') {
    return (
      <NestedAccordion title={formatExploredTitle(child.tools)}>
        {child.tools.map((tool) => (
          <AtomicToolRow key={tool.id} event={tool} />
        ))}
      </NestedAccordion>
    )
  }

  if (child.kind === 'shell') {
    return <ToolLeafRow title={formatShellTitle(child.event)} event={child.event} />
  }

  if (child.kind === 'edit') {
    return <EditToolLeafRow title={formatEditTitle(child.event)} event={child.event} />
  }

  if (child.kind === 'mcp') {
    return <ToolLeafRow title={formatMcpTitle(child.event)} event={child.event} />
  }

  if (child.kind === 'error') {
    return (
      <div className="app-worked-l2 app-worked-error">
        <Text type="danger">{child.event.message}</Text>
      </div>
    )
  }

  return <ToolLeafRow title={child.event.name} event={child.event} />
}

type WorkedAccordionProps = {
  expanded: boolean
  wallMs: number
  worked: WorkedNode
  onToggle: () => void
}

/**
 * Worked（L1）手风琴：本轮干活过程总容器。
 *
 * 默认视图只显示一行摘要；展开后展示 Thought / Explored / Shell / Edit 等 L2。
 * 最终回答（Result）与此并列，由外层 Markdown 渲染。
 */
function WorkedAccordion({ expanded, wallMs, worked, onToggle }: WorkedAccordionProps) {
  // 对齐 Cursor「Worked for 25s」：标题以耗时为主，步骤数过密时不抢视线
  const title = `已工作 · ${formatWorkedDurationZh(wallMs)}`

  return (
    <div className="app-timeline-accordion app-worked-accordion">
      <button
        type="button"
        className="app-timeline-accordion-head"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="app-timeline-accordion-title">{title}</span>
        <RightOutlined className={`app-timeline-chevron${expanded ? ' is-open' : ''}`} />
      </button>
      {expanded ? (
        <div className="app-timeline-wrap app-worked-children">
          {worked.children.length === 0 ? (
            <Text type="secondary">进行中…</Text>
          ) : (
            worked.children.map((child) => <WorkedChildNode key={child.id} child={child} />)
          )}
        </div>
      ) : null}
    </div>
  )
}

type AssistantMessageBodyProps = {
  msg: ChatMessage
  view: MessageCardView
  ctx: MessageCardContext
}

/** assistant 消息正文：Worked（过程）+ Result（Markdown）；回复完成后右下角常显复制 */
function AssistantMessageBody({ msg, view, ctx }: AssistantMessageBodyProps) {
  const markdownContent = msg.content || view.contentPlaceholder
  const showContentCopy = !view.isStreaming && Boolean(msg.content?.trim())

  return (
    <>
      {view.showWorkedAccordion ? (
        <WorkedAccordion
          expanded={view.timelineExpanded}
          wallMs={view.wallMs}
          worked={view.worked}
          onToggle={() =>
            ctx.setTimelineOpenOverride((prev) => ({
              ...prev,
              [msg.id]: !view.timelineExpanded
            }))
          }
        />
      ) : null}
      <div className="app-message-markdown-wrap">
        <MessageMarkdown content={markdownContent} onMarkdownClick={ctx.onMarkdownClick} />
        {showContentCopy ? (
          <div className="app-message-markdown-actions">
            <MessageContentCopyButton text={msg.content} />
          </div>
        ) : null}
      </div>
    </>
  )
}

type MessageCardProps = {
  msg: ChatMessage
  ctx: MessageCardContext
}

/** 单条消息卡片：用户消息直接展示文本，assistant 走专用正文组件 */
function MessageCard({ msg, ctx }: MessageCardProps) {
  const isUser = msg.role === 'user'

  if (isUser) {
    return (
      <Card size="small" variant="outlined" className="app-message-card is-user is-sticky-prompt">
        <div className="app-message-content">{msg.content}</div>
      </Card>
    )
  }

  const view = buildMessageCardView(msg, ctx)

  return (
    <Card size="small" variant="borderless" className="app-message-card is-assistant">
      <div className="app-message-content">
        <AssistantMessageBody msg={msg} view={view} ctx={ctx} />
      </div>
    </Card>
  )
}

/**
 * 渲染单个消息回合：包含该回合内所有消息卡片（用户 / assistant、Worked/Result 等）。
 *
 * 从 `WorkspaceMessagesInner` 抽离，便于独立维护单回合 UI 与后续 memo 优化。
 *
 * @param props - 回合数据与会话级展示状态
 */
export function MessageTurnItem(props: MessageTurnItemProps) {
  const { turn, ...ctx } = props

  return (
    <div className="app-message-turn">
      {turn.messages.map((msg) => (
        <MessageCard key={msg.id} msg={msg} ctx={ctx} />
      ))}
    </div>
  )
}
