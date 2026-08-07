import { SettingsModal } from './modals'
import { useWorkspaceLeftPane } from './useWorkspaceLeftPane'
import {
  FolderAddOutlined,
  InboxOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  RightOutlined,
  SettingOutlined,
  UserOutlined
} from '@ant-design/icons'
import { App as AntdApp, Avatar, Button, Dropdown, Input, Modal, Typography } from 'antd'
import type { DragEvent } from 'react'
import { createPortal } from 'react-dom'

import { useAuthStore } from '@/renderer/src/store/auth-store'

const { Text } = Typography

/**
 * 由用户名生成头像展示用首字（无用户名时回退空串）
 *
 * @param username - 登录用户名
 * @returns 用于 Avatar 的单个字符
 */
function getUserAvatarLabel(username: string | undefined): string {
  const trimmed = username?.trim() ?? ''
  if (!trimmed) return ''
  return trimmed.charAt(0).toUpperCase()
}

export type WorkspaceLeftPaneProps = {
  /** 顶栏左侧挂载点：侧栏收起时仅将「展开」按钮 portal 到此，展开时按钮在侧栏内 */
  leftTogglePortalHost?: HTMLElement | null
}

export function WorkspaceLeftPane({ leftTogglePortalHost }: WorkspaceLeftPaneProps) {
  const p = useWorkspaceLeftPane()
  const { message: msgApi } = AntdApp.useApp()
  const authUser = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)

  const handleLogout = () => {
    logout()
    msgApi.success('已退出登录')
  }

  const leftToggleInTopbar = (
    <Button
      type="text"
      icon={<MenuUnfoldOutlined />}
      onClick={p.handleSidebarCollapseToggle}
      className="app-settings-btn app-sidebar-collapse-btn app-topbar-pane-toggle"
      title="展开侧边栏"
      aria-label="展开侧边栏"
    />
  )

  return (
    <>
      {p.isSidebarCollapsed && leftTogglePortalHost
        ? createPortal(leftToggleInTopbar, leftTogglePortalHost)
        : null}
      <div
        className={`app-sidebar ${p.isSidebarCollapsed ? 'is-collapsed' : ''}`}
        style={{ width: `${p.sidebarWidth}px` }}
      >
        <div className={`app-sidebar-inner ${p.isSidebarCollapsed ? 'is-collapsed' : ''}`}>
          <div className="app-sidebar-header">
            {!p.isSidebarCollapsed ? (
              <Button
                type="text"
                icon={<MenuFoldOutlined />}
                onClick={p.handleSidebarCollapseToggle}
                className="app-settings-btn app-sidebar-collapse-btn"
                title="收起侧边栏"
                aria-label="收起侧边栏"
              />
            ) : null}
          </div>
          {!p.isSidebarCollapsed && (
            <div className="app-new-session-wrap">
              <Button
                block
                type="primary"
                icon={<PlusOutlined />}
                className="app-new-session-btn"
                onClick={p.openBlankConversationForActiveWorkspace}
              >
                新会话
              </Button>
            </div>
          )}
          {!p.isSidebarCollapsed && (
            <div className="app-workspace-section-header">
              <Text className="app-workspace-section-title">工作区</Text>
              <button
                type="button"
                className="app-workspace-add-btn"
                aria-label="添加工作区"
                title="添加工作区"
                onClick={() => void p.pickWorkspace()}
              >
                <FolderAddOutlined aria-hidden />
              </button>
            </div>
          )}
          {!p.isSidebarCollapsed && (
            <div className="app-workspace-tree">
              {p.workspacesForSidebar.length === 0 ? (
                <div className="app-workspace-tree-empty" role="status">
                  <Text type="secondary">{p.workspaceTreeEmptyMessage}</Text>
                </div>
              ) : (
                p.workspacesForSidebar.map((workspace) => {
                  const isActiveWorkspace = workspace.id === p.activeWorkspaceId
                  const isExpanded = p.expandedWorkspaceIds.has(workspace.id)
                  const dropMarkerPlacement =
                    !!p.draggingWorkspaceId &&
                    p.draggingWorkspaceId !== workspace.id &&
                    p.workspaceDropMarker?.workspaceId === workspace.id
                      ? p.workspaceDropMarker.placement
                      : null
                  const workspaceSessions = p.sessionsByWorkspaceForSidebar[workspace.id] || []
                  return (
                    <div
                      key={workspace.id}
                      className={`app-workspace-node ${isActiveWorkspace ? 'is-active' : ''} ${dropMarkerPlacement === 'before' ? 'is-drop-before' : ''} ${dropMarkerPlacement === 'after' ? 'is-drop-after' : ''}`}
                    >
                      <div
                        className="app-workspace-node-header is-draggable"
                        draggable
                        onDragStart={(event: DragEvent<HTMLDivElement>) =>
                          p.handleWorkspaceDragStart(event, workspace.id)
                        }
                        onDragOver={(event: DragEvent<HTMLDivElement>) =>
                          p.handleWorkspaceDragOver(event, workspace.id)
                        }
                        onDrop={(event: DragEvent<HTMLDivElement>) =>
                          void p.handleWorkspaceDrop(event, workspace.id)
                        }
                        onDragEnd={p.handleWorkspaceDragEnd}
                      >
                        <button
                          type="button"
                          className="app-workspace-chevron-btn"
                          aria-label={isExpanded ? '收起工作区会话' : '展开工作区会话'}
                          onClick={(event) => {
                            event.stopPropagation()
                            p.handleWorkspaceToggle(workspace.id)
                          }}
                        >
                          <RightOutlined
                            className={`app-workspace-chevron ${isExpanded ? 'is-open' : ''}`}
                            aria-hidden="true"
                          />
                        </button>
                        {p.handleRemoveWorkspaceFromSidebar ? (
                          <Dropdown
                            menu={{
                              items: [
                                {
                                  key: 'remove-from-sidebar',
                                  label: '从侧边栏移除',
                                  onClick: () =>
                                    void p.handleRemoveWorkspaceFromSidebar?.(workspace)
                                }
                              ]
                            }}
                            trigger={['contextMenu']}
                          >
                            <span className="app-workspace-name-btn" role="presentation">
                              <Text className="app-workspace-name">{workspace.name}</Text>
                            </span>
                          </Dropdown>
                        ) : (
                          <span className="app-workspace-name-btn">
                            <Text className="app-workspace-name">{workspace.name}</Text>
                          </span>
                        )}
                        <button
                          type="button"
                          className="app-workspace-add-session-btn"
                          aria-label={`在${workspace.name}下打开空白对话`}
                          title="空白对话"
                          onClick={(event) => {
                            event.stopPropagation()
                            void p.openBlankConversationInWorkspace(workspace.id)
                          }}
                        >
                          <PlusOutlined />
                        </button>
                      </div>
                      {isExpanded && (
                        <div className="app-session-sublist">
                          {workspaceSessions.map((session) => (
                            <Dropdown
                              key={session.id}
                              menu={{
                                items: [
                                  {
                                    key: 'rename',
                                    label: '重命名',
                                    onClick: () => p.handleSessionRenameRequest(session)
                                  }
                                ]
                              }}
                              trigger={['contextMenu']}
                            >
                              <div
                                className={`app-session-item app-session-item-sub ${session.id === p.activeSessionId ? 'is-active' : ''}`}
                                onClick={() => void p.handleSessionClick(workspace.id, session.id)}
                              >
                                <div className="app-session-item-inner">
                                  <div className="app-session-title">{session.name}</div>
                                  <button
                                    type="button"
                                    className="app-session-archive-btn"
                                    title="归档"
                                    aria-label="归档"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      p.handleRemoveSessionFromSidebar(workspace.id, session)
                                    }}
                                  >
                                    <InboxOutlined aria-hidden />
                                  </button>
                                </div>
                              </div>
                            </Dropdown>
                          ))}
                          {workspaceSessions.length === 0 && (
                            <div className="app-session-placeholder">当前工作区暂无会话</div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          )}
          {!p.isSidebarCollapsed ? (
            <div className="app-sidebar-footer">
              {authUser ? (
                <Dropdown
                  menu={{
                    items: [
                      {
                        key: 'logout',
                        label: '退出登录',
                        icon: <LogoutOutlined />,
                        onClick: handleLogout
                      }
                    ]
                  }}
                  trigger={['click']}
                  placement="topLeft"
                  overlayClassName="app-sidebar-user-dropdown"
                  overlayStyle={{ minWidth: 120 }}
                >
                  <button
                    type="button"
                    className="app-sidebar-user"
                    aria-label={`当前用户 ${authUser.username}，打开用户菜单`}
                  >
                    <Avatar
                      size={28}
                      className="app-sidebar-user-avatar"
                      icon={!getUserAvatarLabel(authUser.username) ? <UserOutlined /> : undefined}
                    >
                      {getUserAvatarLabel(authUser.username)}
                    </Avatar>
                    <Text className="app-sidebar-user-name" ellipsis>
                      {authUser.username}
                    </Text>
                  </button>
                </Dropdown>
              ) : (
                <div className="app-sidebar-user-spacer" />
              )}
              <Button
                type="text"
                icon={<SettingOutlined />}
                onClick={p.openSettings}
                className="app-settings-btn app-sidebar-footer-settings"
                title="设置"
                aria-label="设置"
              />
            </div>
          ) : null}
        </div>
      </div>
      <div
        className={`app-sidebar-resizer ${p.isSidebarResizing ? 'is-dragging' : ''} ${p.isSidebarCollapsed ? 'is-hidden' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
        onMouseDown={p.isSidebarCollapsed ? undefined : p.handleSidebarResizeStart}
      />
      <SettingsModal open={p.settingsOpen} onClose={p.closeSettings} />

      <Modal
        title="重命名会话"
        open={!!p.renameModal.renameId}
        onOk={p.renameModal.confirmRename}
        onCancel={p.renameModal.closeRename}
        okText="保存"
        destroyOnHidden
        centered
      >
        <Input
          value={p.renameModal.renameName}
          onChange={(e) => p.renameModal.setRenameName(e.target.value)}
          placeholder="名称"
        />
      </Modal>
    </>
  )
}
