import {
  assistantDisplayTimeline,
  formatWorkedDuration,
  type MessageTurn,
  remarkLinkifyBareUrls
} from './center-pane-utils'
import { CheckOutlined, CopyOutlined, RightOutlined } from '@ant-design/icons'
import { App as AntdApp, Card, Typography } from 'antd'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

import type { ChatMessage, ToolTimelineEvent } from '@/shared/ipc'

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
  displayTimeline: ToolTimelineEvent[]
  timelineExpanded: boolean
  showTimelineAccordion: boolean
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
  // 有工具事件，或当前 run 中的最新 assistant：均显示耗时手风琴（不依赖已移除的意图思考）
  const showTimelineAccordion =
    displayTimeline.length > 0 || (isLatestAssistant && Boolean(ctx.isRun))
  const timelineExpanded =
    ctx.timelineOpenOverride[msg.id] !== undefined
      ? ctx.timelineOpenOverride[msg.id]!
      : Boolean(ctx.isRun)

  return {
    isLatestAssistant,
    isStreaming,
    displayTimeline,
    timelineExpanded,
    showTimelineAccordion,
    contentPlaceholder: isStreaming ? '…' : ''
  }
}

/** 生成时间线事件列表项的稳定 key */
function timelineEventKey(event: ToolTimelineEvent, index: number): string {
  return `${event.kind}-${'id' in event ? event.id : index}-${index}`
}

/** 判断工具调用结果是否为用户拒绝 */
function isToolCallRejected(result?: string): boolean {
  return Boolean(result?.includes('用户已拒绝') || result?.includes('Rejected by user'))
}

/** 工具调用在时间线上的状态符号 */
function toolCallStatusSymbol(status: 'start' | 'end', result?: string): string {
  if (status === 'start') return '…'
  return isToolCallRejected(result) ? '✗' : '✓'
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

type TimelineEventItemProps = {
  event: ToolTimelineEvent
}

/** 单条工具时间线事件，按 kind 分支渲染 */
function TimelineEventItem({ event }: TimelineEventItemProps) {
  if (event.kind === 'error') {
    return <Text type="danger">{event.message}</Text>
  }

  return (
    <>
      <Text code>
        {event.name} {toolCallStatusSymbol(event.status, event.result)}
      </Text>
      {event.args ? <Text type="secondary"> {event.args}</Text> : null}
      {event.status === 'end' && event.result ? (
        <pre className="app-timeline-result">{event.result}</pre>
      ) : null}
    </>
  )
}

type TimelineAccordionProps = {
  expanded: boolean
  wallMs: number
  events: ToolTimelineEvent[]
  onToggle: () => void
}

/** 工具时间线手风琴：工具事件列表 */
function TimelineAccordion({ expanded, wallMs, events, onToggle }: TimelineAccordionProps) {
  return (
    <div className="app-timeline-accordion">
      <button
        type="button"
        className="app-timeline-accordion-head"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <RightOutlined className={`app-timeline-chevron${expanded ? ' is-open' : ''}`} />
        <span className="app-timeline-accordion-title">耗时 {formatWorkedDuration(wallMs)}</span>
      </button>
      {expanded ? (
        <div className="app-timeline-wrap">
          {events.map((event, index) => (
            <div key={timelineEventKey(event, index)} className="app-timeline-item">
              <TimelineEventItem event={event} />
            </div>
          ))}
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

/** assistant 消息正文：时间线手风琴 + Markdown；回复完成后右下角常显复制 */
function AssistantMessageBody({ msg, view, ctx }: AssistantMessageBodyProps) {
  const markdownContent = msg.content || view.contentPlaceholder
  const showContentCopy = !view.isStreaming && Boolean(msg.content?.trim())

  return (
    <>
      {view.showTimelineAccordion ? (
        <TimelineAccordion
          expanded={view.timelineExpanded}
          wallMs={ctx.timelineWallMs}
          events={view.displayTimeline}
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
      <Card size="small" bordered className="app-message-card is-user is-sticky-prompt">
        <div className="app-message-content">{msg.content}</div>
      </Card>
    )
  }

  const view = buildMessageCardView(msg, ctx)

  return (
    <Card size="small" bordered={false} className="app-message-card is-assistant">
      <div className="app-message-content">
        <AssistantMessageBody msg={msg} view={view} ctx={ctx} />
      </div>
    </Card>
  )
}

/**
 * 渲染单个消息回合：包含该回合内所有消息卡片（用户 / assistant、时间线等）。
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
