import { buildMessageTurns, type RunStats } from './center-pane-utils'
import { MessageTurnItem } from './MessageTurnItem'
import { App as AntdApp } from 'antd'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type SimpleBarCore from 'simplebar-core'
import SimpleBar from 'simplebar-react'

import type { ChatMessage, ToolTimelineEvent } from '@/shared/ipc'

export type WorkspaceMessagesInnerProps = {
  /** 当前会话 ID，用于切换会话时重置滚动状态 */
  activeId: string | null
  /** 当前会话的消息列表 */
  currentMessages: ChatMessage[]
  /** 当前会话的工具时间线 */
  currentTimeline: ToolTimelineEvent[]
  /** 当前会话是否正在执行 */
  isRun: boolean
  /** 当前会话的运行统计，用于时间线耗时展示 */
  currentRunStats: RunStats | undefined
  /** Plan 模式生成的 assistant 消息 id 集合 */
  planAssistantIds: Set<string>
  /** 将计划正文挂到会话并切换到 Build 模式 */
  onPreparePlanExecution: (planContent: string) => void
}

/**
 * 管理消息列表区的展示状态：时间线手风琴、自动滚动、Markdown 外链确认等。
 *
 * @param options - 来自工作区中心面板的会话与消息数据
 * @returns 消息区内渲染所需的 state、ref 与事件处理器
 */
function useWorkspaceMessagesInner({
  activeId,
  currentMessages,
  currentTimeline,
  isRun,
  currentRunStats,
  planAssistantIds,
  onPreparePlanExecution
}: WorkspaceMessagesInnerProps) {
  const { message: msgApi, modal: modalApi } = AntdApp.useApp()
  const bridge = window.bridge

  /** 工具时间线手风琴：key 为 assistant message id，未设置时由 isRun 推导默认展开/收起 */
  const [timelineOpenOverride, setTimelineOpenOverride] = useState<Record<string, boolean>>({})
  const messagesSimpleBarRef = useRef<SimpleBarCore | null>(null)
  const messagesBottomRef = useRef<HTMLDivElement | null>(null)
  const autoScrollRef = useRef(true)
  /** 指针在消息区 `.simplebar-content-wrapper` 内时为 true，用于仅在该区域悬停时显示滚动条 */
  const [messagesScrollSurfaceHot, setMessagesScrollSurfaceHot] = useState(false)
  const [liveTick, setLiveTick] = useState(0)

  const messageTurns = useMemo(() => buildMessageTurns(currentMessages), [currentMessages])

  const latestAssistantMessageId = useMemo(() => {
    for (let i = currentMessages.length - 1; i >= 0; i -= 1) {
      const msg = currentMessages[i]
      if (msg?.role === 'assistant') return msg.id
    }
    return null
  }, [currentMessages])

  const isNearBottom = useCallback((el: HTMLDivElement) => {
    const threshold = 48
    return el.scrollTop + el.clientHeight >= el.scrollHeight - threshold
  }, [])

  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const bottomEl = messagesBottomRef.current
    if (bottomEl) {
      bottomEl.scrollIntoView({ block: 'end', behavior })
      return
    }
    const el = messagesSimpleBarRef.current?.getScrollElement()
    if (el) el.scrollTo({ top: el.scrollHeight, behavior })
  }, [])

  const handleMessagesShellMouseLeave = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const next = e.relatedTarget
    if (next instanceof Node && e.currentTarget.contains(next)) return
    setMessagesScrollSurfaceHot(false)
  }, [])

  useEffect(() => {
    if (!isRun) return
    const id = window.setInterval(() => setLiveTick((n) => n + 1), 500)
    return () => window.clearInterval(id)
  }, [isRun])

  const timelineWallMs = useMemo(() => {
    const started = currentRunStats?.startedAt
    if (isRun && started != null) return Math.max(0, Date.now() - started + liveTick * 0)
    if (currentRunStats?.durationMs != null && currentRunStats.durationMs >= 0) {
      return currentRunStats.durationMs
    }
    return 0
  }, [currentRunStats, isRun, liveTick])

  const openExternalWithConfirm = useCallback(
    (href: string) => {
      const target = (() => {
        try {
          const parsed = new URL(href)
          return parsed.host || href
        } catch {
          return href
        }
      })()
      modalApi.confirm({
        title: '即将打开外部链接',
        content: `目标地址：${target}`,
        centered: true,
        okText: '继续打开',
        cancelText: '取消',
        onOk: async () => {
          const r = await bridge.openExternal(href)
          if (!r.ok) msgApi.warning('打开链接失败')
        }
      })
    },
    [bridge, modalApi, msgApi]
  )

  const onMarkdownClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null
      const anchor = target?.closest('a')
      if (!anchor) return
      const href = anchor.getAttribute('href') ?? ''
      if (!/^(https?:|mailto:)/i.test(href)) return
      event.preventDefault()
      openExternalWithConfirm(href)
    },
    [openExternalWithConfirm]
  )

  useEffect(() => {
    setMessagesScrollSurfaceHot(false)
  }, [activeId])

  useEffect(() => {
    autoScrollRef.current = true
    const rafId = window.requestAnimationFrame(() => {
      scrollMessagesToBottom('auto')
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [activeId, scrollMessagesToBottom])

  useLayoutEffect(() => {
    if (!autoScrollRef.current) return
    const rafId = window.requestAnimationFrame(() => {
      scrollMessagesToBottom('auto')
      window.requestAnimationFrame(() => {
        if (autoScrollRef.current) scrollMessagesToBottom('auto')
      })
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [currentMessages, currentTimeline, scrollMessagesToBottom])

  return {
    messageTurns,
    latestAssistantMessageId,
    timelineOpenOverride,
    setTimelineOpenOverride,
    timelineWallMs,
    messagesScrollSurfaceHot,
    setMessagesScrollSurfaceHot,
    handleMessagesShellMouseLeave,
    messagesSimpleBarRef,
    messagesBottomRef,
    autoScrollRef,
    isNearBottom,
    onMarkdownClick,
    onPreparePlanExecution,
    planAssistantIds,
    isRun,
    currentTimeline
  }
}

/**
 * 工作区消息列表区：包含滚动容器与消息回合渲染。
 *
 * 将原 `app-messages-inner` 及其关联逻辑（时间线手风琴、计划清单、自动滚动）封装为独立组件，
 * 便于与顶部栏、输入区解耦维护。
 *
 * @param props - 当前会话消息数据与计划执行回调
 */
export function WorkspaceMessagesInner(props: WorkspaceMessagesInnerProps) {
  const m = useWorkspaceMessagesInner(props)

  return (
    <div className="app-messages-shell" onMouseLeave={m.handleMessagesShellMouseLeave}>
      <SimpleBar
        className={`app-messages-scroll${m.messagesScrollSurfaceHot ? ' is-messages-scrollbar-hot' : ''}`}
        ref={m.messagesSimpleBarRef}
        autoHide={false}
        scrollableNodeProps={{
          onMouseEnter: () => m.setMessagesScrollSurfaceHot(true),
          onScroll: (e: React.UIEvent<HTMLElement>) => {
            m.autoScrollRef.current = m.isNearBottom(e.currentTarget as HTMLDivElement)
          }
        }}
      >
        <div className="app-messages-inner">
          {m.messageTurns.map((turn) => (
            <MessageTurnItem
              key={turn.key}
              turn={turn}
              latestAssistantMessageId={m.latestAssistantMessageId}
              isRun={m.isRun}
              currentTimeline={m.currentTimeline}
              timelineOpenOverride={m.timelineOpenOverride}
              setTimelineOpenOverride={m.setTimelineOpenOverride}
              timelineWallMs={m.timelineWallMs}
              planAssistantIds={m.planAssistantIds}
              onPreparePlanExecution={m.onPreparePlanExecution}
              onMarkdownClick={m.onMarkdownClick}
            />
          ))}
          <div ref={m.messagesBottomRef} />
        </div>
      </SimpleBar>
    </div>
  )
}
