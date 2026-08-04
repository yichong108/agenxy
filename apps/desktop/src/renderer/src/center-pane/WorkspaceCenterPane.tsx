import 'simplebar-react/dist/simplebar.min.css'
import 'highlight.js/styles/github.css'
import '@/renderer/src/center-pane/WorkspaceCenterPane.scss'
import {
  useWorkspaceCenterPane,
  type UseWorkspaceCenterPaneOptions
} from './useWorkspaceCenterPane'
import { WorkspaceMessagesInner } from './WorkspaceMessagesInner'
import { MenuUnfoldOutlined } from '@ant-design/icons'
import { Alert, Button, Space, Tag, Typography } from 'antd'

import openworkLogoUrl from '@/renderer/src/assets/openwork-logo.png'

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
                src={openworkLogoUrl}
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
              {p.composerInput}
            </div>
          </div>
        ) : (
          <>
            <WorkspaceMessagesInner
              activeId={p.activeId}
              currentMessages={p.currentMessages}
              currentTimeline={p.currentTimeline}
              isRun={Boolean(p.isRun)}
              currentRunStats={p.currentRunStats}
            />
            <div className="app-composer-stack">{p.composerInput}</div>
          </>
        )}
      </div>
    </div>
  )
}
