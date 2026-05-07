import {
  ApiOutlined,
  FolderOpenOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  RightOutlined,
  SettingOutlined,
  ShopOutlined
} from '@ant-design/icons'
import { Button, Dropdown, Input, Modal, Space, Typography } from 'antd'
import type { DragEvent } from 'react'

import { McpHubModal, SettingsModal, SkillsHubModal } from './modals'
import { useWorkspaceLeftPane } from './useWorkspaceLeftPane'

const { Text } = Typography

export type WorkspaceLeftPaneProps = {
  /** 从侧栏变更当前会话后，主区域按需强制拉取消息（例如移除侧栏会话时） */
  ensureSessionMessages?: (sessionId: string, force?: boolean) => void
}

export function WorkspaceLeftPane({ ensureSessionMessages }: WorkspaceLeftPaneProps) {
  const p = useWorkspaceLeftPane({ ensureSessionMessages })

  return (
    <>
      <div className="app-sidebar" style={{ width: `${p.sidebarWidth}px` }}>
        <div className={`app-sidebar-inner ${p.isSidebarCollapsed ? 'is-collapsed' : ''}`}>
          <div className="app-sidebar-header">
            <Button
              type="text"
              icon={p.isSidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={p.handleSidebarCollapseToggle}
              className="app-settings-btn app-sidebar-collapse-btn"
              title={p.isSidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
              aria-label={p.isSidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
            />
            {!p.isSidebarCollapsed && (
              <Space size={0}>
                <Button
                  type="text"
                  icon={<ApiOutlined />}
                  onClick={p.openMcpHub}
                  className="app-settings-btn"
                  title="MCP 与扩展"
                />
                <Button
                  type="text"
                  icon={<ShopOutlined />}
                  onClick={p.openSkillsHub}
                  className="app-settings-btn"
                  title="技能与市场"
                />
                <Button
                  type="text"
                  icon={<SettingOutlined />}
                  onClick={p.openSettings}
                  className="app-settings-btn"
                  title="设置"
                />
              </Space>
            )}
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
                                  },
                                  {
                                    key: 'remove-from-sidebar',
                                    label: '从侧边栏移除',
                                    onClick: () =>
                                      p.handleRemoveSessionFromSidebar(workspace.id, session)
                                  },
                                  {
                                    key: 'del',
                                    danger: true,
                                    label: '删除',
                                    onClick: () => p.handleSessionDeleteRequest(session)
                                  }
                                ]
                              }}
                              trigger={['contextMenu']}
                            >
                              <div
                                className={`app-session-item app-session-item-sub ${session.id === p.activeSessionId ? 'is-active' : ''}`}
                                onClick={() => void p.handleSessionClick(workspace.id, session.id)}
                              >
                                <div className="app-session-title">{session.name}</div>
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
          {!p.isSidebarCollapsed && (
            <div className="app-workspace-btn-wrap">
              <Button block icon={<FolderOpenOutlined />} onClick={() => void p.pickWorkspace()}>
                添加并切换工作区
              </Button>
            </div>
          )}
        </div>
      </div>
      <div
        className={`app-sidebar-resizer ${p.isSidebarResizing ? 'is-dragging' : ''} ${p.isSidebarCollapsed ? 'is-hidden' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
        onMouseDown={p.isSidebarCollapsed ? undefined : p.handleSidebarResizeStart}
      />
      <McpHubModal open={p.mcpOpen} onClose={p.closeMcpHub} />
      <SettingsModal open={p.settingsOpen} onClose={p.closeSettings} />
      <SkillsHubModal open={p.skillsOpen} onClose={p.closeSkillsHub} />

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
