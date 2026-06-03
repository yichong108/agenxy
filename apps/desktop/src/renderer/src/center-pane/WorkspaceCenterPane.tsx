import 'simplebar-react/dist/simplebar.min.css'
import 'highlight.js/styles/github.css'
import '@/renderer/src/center-pane/WorkspaceCenterPane.scss'
import {
  assistantDisplayTimeline,
  formatWorkedDuration,
  remarkLinkifyBareUrls
} from './center-pane-utils'
import {
  useWorkspaceCenterPane,
  type UseWorkspaceCenterPaneOptions
} from './useWorkspaceCenterPane'
import { MenuUnfoldOutlined, RightOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Space, Tag, Typography } from 'antd'
import React from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import SimpleBar from 'simplebar-react'

import agenxyLogoUrl from '@/renderer/src/assets/agenxy-logo.png'
import { parseAgentPlan } from '@/renderer/src/plan/parse-plan'
import { PlanChecklistPanel } from '@/renderer/src/plan/PlanChecklistPanel'

const { Text } = Typography

export type WorkspaceCenterPaneProps = UseWorkspaceCenterPaneOptions

export function WorkspaceCenterPane(props: WorkspaceCenterPaneProps) {
  const p = useWorkspaceCenterPane(props)

  return (
    <div className="app-main-pane">
      {/* 顶部栏 */}
      <div className="app-topbar">
        {p.isWinCustomChrome ? (
          <div
            className="app-topbar-leading"
            ref={(el) => {
              p.onLeftTogglePortalHostChange(el)
            }}
          />
        ) : (
          <div className="app-topbar-leading-cluster">
            <span className="app-brand-logo-visual app-brand-logo-visual--topbar">
              <img
                src={agenxyLogoUrl}
                alt=""
                width={19}
                height={19}
                className="app-topbar-brand-logo"
                draggable={false}
              />
            </span>
            <div
              className="app-topbar-leading"
              ref={(el) => {
                p.onLeftTogglePortalHostChange(el)
              }}
            />
          </div>
        )}
        <div className="app-topbar-body">
          {p.activeId ? (
            <Space>
              <Text>
                {
                  (p.sessionsByWorkspace[p.composerSelectedWorkspaceId] ?? []).find(
                    (s) => s.id === p.activeId
                  )?.name
                }
              </Text>
              {p.isRun && <Tag color="processing">执行中</Tag>}
              {p.isQueued && p.isQueued > 0 && <Tag color="warning">排队 #{p.isQueued}</Tag>}
              {p.currentRunStats && (
                <Text type="secondary">
                  本轮: {p.currentRunStats.toolCalls} 次调用 / {p.currentRunStats.toolErrors} 次错误
                  / {((p.currentRunStats.durationMs ?? 0) / 1000).toFixed(2)}s
                </Text>
              )}
              {p.currentRunStats?.traceId && (
                <Tag color="default">追踪: {p.currentRunStats.traceId.slice(-12)}</Tag>
              )}
            </Space>
          ) : null}
        </div>
        {p.isRightPaneCollapsed ? (
          <div className="app-topbar-trailing">
            <Button
              type="text"
              icon={<MenuUnfoldOutlined />}
              onClick={p.onRightPaneExpand}
              className="app-settings-btn app-topbar-pane-toggle"
              title="展开右边栏"
              aria-label="展开右边栏"
            />
          </div>
        ) : null}
      </div>
      {/* 内容区 */}
      <div className={`app-content ${p.isEmptyConversation ? 'is-empty-conversation' : ''}`}>
        {!p.preloadOk && (
          <div className="app-preload-alert-wrap">
            <Alert
              type="error"
              showIcon
              message="preload 注入失败"
              description="当前窗口未接收到主进程暴露的 API（window.bridge）。请重启 dev 进程后重试。"
            />
          </div>
        )}
        {p.isEmptyConversation ? (
          <div className="app-composer-hero">
            <div className="app-composer-hero-inner">
              {p.composerWorkspaceToolbar}
              {p.hitlApprovalBar}
              {p.planReadyBar}
              {p.composerInput}
            </div>
          </div>
        ) : (
          <>
            {/* 消息区 */}
            <div className="app-messages-shell" onMouseLeave={p.handleMessagesShellMouseLeave}>
              <SimpleBar
                className={`app-messages-scroll${p.messagesScrollSurfaceHot ? ' is-messages-scrollbar-hot' : ''}`}
                ref={p.messagesSimpleBarRef}
                autoHide={false}
                scrollableNodeProps={{
                  onMouseEnter: () => p.setMessagesScrollSurfaceHot(true),
                  onScroll: (e: React.UIEvent<HTMLElement>) => {
                    p.autoScrollRef.current = p.isNearBottom(e.currentTarget as HTMLDivElement)
                  }
                }}
              >
                <div className="app-messages-inner">
                  {p.messageTurns.map((turn) => (
                    <div key={turn.key} className="app-message-turn">
                      {turn.messages.map((m) => {
                        const isLatestAssistant =
                          m.role === 'assistant' && m.id === p.latestAssistantMessageId
                        const displayTimeline = assistantDisplayTimeline(
                          m,
                          p.latestAssistantMessageId,
                          Boolean(p.isRun && isLatestAssistant),
                          p.currentTimeline
                        )
                        const showTimelineAccordion = displayTimeline.length > 0
                        const intentText = m.intentThinking?.trim()
                        const timelineExpanded =
                          p.timelineOpenOverride[m.id] !== undefined
                            ? p.timelineOpenOverride[m.id]!
                            : Boolean(p.isRun && showTimelineAccordion)
                        const isUser = m.role === 'user'
                        return (
                          <Card
                            key={m.id}
                            size="small"
                            bordered={isUser}
                            className={`app-message-card ${isUser ? 'is-user is-sticky-prompt' : 'is-assistant'}`}
                          >
                            <div className="app-message-content">
                              {m.role === 'assistant' ? (
                                <>
                                  {showTimelineAccordion || intentText ? (
                                    <div className="app-timeline-accordion">
                                      <button
                                        type="button"
                                        className="app-timeline-accordion-head"
                                        aria-expanded={timelineExpanded}
                                        onClick={() =>
                                          p.setTimelineOpenOverride((prev) => ({
                                            ...prev,
                                            [m.id]: !timelineExpanded
                                          }))
                                        }
                                      >
                                        <RightOutlined
                                          className={`app-timeline-chevron${timelineExpanded ? ' is-open' : ''}`}
                                        />
                                        <span className="app-timeline-accordion-title">
                                          耗时 {formatWorkedDuration(p.timelineWallMs)}
                                        </span>
                                      </button>
                                      {timelineExpanded ? (
                                        <div className="app-timeline-wrap">
                                          {intentText ? (
                                            <div className="app-timeline-item">
                                              <Text
                                                type="secondary"
                                                className="app-timeline-plan-label"
                                              >
                                                思考
                                              </Text>
                                              <div className="app-intent-preamble">
                                                {intentText}
                                              </div>
                                            </div>
                                          ) : null}
                                          {displayTimeline.map((e, idx) => (
                                            <div
                                              key={`${e.kind}-${'id' in e ? e.id : idx}-${idx}`}
                                              className={`app-timeline-item${e.kind === 'plan' ? ' is-plan' : ''}`}
                                            >
                                              {e.kind === 'error' ? (
                                                <Text type="danger">{e.message}</Text>
                                              ) : e.kind === 'plan' ? (
                                                <>
                                                  <Text
                                                    type="secondary"
                                                    className="app-timeline-plan-label"
                                                  >
                                                    下一步
                                                    {e.toolName ? (
                                                      <Text type="secondary">
                                                        {' '}
                                                        · 在 {e.toolName} 之后
                                                      </Text>
                                                    ) : null}
                                                  </Text>
                                                  <div className="app-timeline-plan">
                                                    {e.text ||
                                                      (e.status === 'streaming' ? '…' : '')}
                                                  </div>
                                                </>
                                              ) : (
                                                <>
                                                  <Text code>
                                                    {e.name}{' '}
                                                    {e.status === 'start'
                                                      ? '…'
                                                      : e.result?.includes('用户已拒绝') ||
                                                          e.result?.includes('Rejected by user')
                                                        ? '✗'
                                                        : '✓'}
                                                  </Text>
                                                  {e.args && (
                                                    <Text type="secondary"> {e.args}</Text>
                                                  )}
                                                  {e.status === 'end' && e.result && (
                                                    <pre className="app-timeline-result">
                                                      {e.result}
                                                    </pre>
                                                  )}
                                                </>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>
                                  ) : null}
                                  {p.planAssistantIds.has(m.id) ? (
                                    <>
                                      <PlanChecklistPanel
                                        content={m.content}
                                        streaming={Boolean(p.isRun && isLatestAssistant)}
                                        onExecutePlan={() => p.preparePlanExecution(m.content)}
                                        executeDisabled={Boolean(p.isRun)}
                                      />
                                      {parseAgentPlan(m.content) ? (
                                        <details className="app-plan-full-details">
                                          <summary>查看完整说明</summary>
                                          <div
                                            className="app-message-markdown app-message-markdown--plan-extra"
                                            onClick={p.onMarkdownClick}
                                          >
                                            <ReactMarkdown
                                              remarkPlugins={[remarkGfm, remarkLinkifyBareUrls]}
                                              rehypePlugins={[rehypeHighlight]}
                                            >
                                              {m.content}
                                            </ReactMarkdown>
                                          </div>
                                        </details>
                                      ) : (
                                        <>
                                          <div
                                            className="app-message-markdown"
                                            onClick={p.onMarkdownClick}
                                          >
                                            <ReactMarkdown
                                              remarkPlugins={[remarkGfm, remarkLinkifyBareUrls]}
                                              rehypePlugins={[rehypeHighlight]}
                                            >
                                              {m.content ||
                                                (p.isRun && isLatestAssistant ? '…' : '')}
                                            </ReactMarkdown>
                                          </div>
                                          {m.content.trim() && !(p.isRun && isLatestAssistant) ? (
                                            <div className="app-plan-execute-fallback">
                                              <Button
                                                type="primary"
                                                size="small"
                                                disabled={Boolean(p.isRun)}
                                                onClick={() => p.preparePlanExecution(m.content)}
                                              >
                                                执行计划
                                              </Button>
                                            </div>
                                          ) : null}
                                        </>
                                      )}
                                    </>
                                  ) : (
                                    <div
                                      className="app-message-markdown"
                                      onClick={p.onMarkdownClick}
                                    >
                                      <ReactMarkdown
                                        remarkPlugins={[remarkGfm, remarkLinkifyBareUrls]}
                                        rehypePlugins={[rehypeHighlight]}
                                      >
                                        {m.content || (p.isRun && isLatestAssistant ? '…' : '')}
                                      </ReactMarkdown>
                                    </div>
                                  )}
                                </>
                              ) : (
                                m.content
                              )}
                            </div>
                          </Card>
                        )
                      })}
                    </div>
                  ))}
                  <div ref={p.messagesBottomRef} />
                </div>
              </SimpleBar>
            </div>
            {/* 输入区 */}
            <div className="app-composer-stack">
              {p.hitlApprovalBar}
              {p.planReadyBar}
              {p.composerInput}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
