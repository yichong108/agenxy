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
import { Button, Dropdown, Space, Typography } from 'antd'
import type { FormInstance } from 'antd'
import type { DragEvent, MouseEvent } from 'react'

import type {
  McpServerEntry,
  McpWarmupReport,
  ModelProviderId,
  SessionInfo,
  SettingsFormValues,
  SkillUiEntry,
  SkillsMarketCatalogItem,
  WorkspaceInfo
} from '@/shared/ipc'

import { McpHubModal, SettingsModal, SkillsHubModal } from './modals'

const { Text } = Typography

type WorkspaceDropMarker = {
  workspaceId: string
  placement: 'before' | 'after'
}

type WorkspaceLeftPaneProps = {
  sidebarWidth: number
  isSidebarCollapsed: boolean
  isSidebarResizing: boolean
  activeWorkspaceId: string | null
  activeSessionId: string | null
  workspaces: WorkspaceInfo[]
  sessionsByWorkspace: Record<string, SessionInfo[]>
  expandedWorkspaceIds: Set<string>
  draggingWorkspaceId: string | null
  workspaceDropMarker: WorkspaceDropMarker | null
  onOpenMcpHub: () => void
  onOpenSkillsHub: () => void
  onOpenSettings: () => void
  onOpenBlankConversation: () => void
  onToggleWorkspace: (workspaceId: string) => void
  onWorkspaceDragStart: (event: DragEvent<HTMLDivElement>, workspaceId: string) => void
  onWorkspaceDragOver: (event: DragEvent<HTMLDivElement>, workspaceId: string) => void
  onWorkspaceDrop: (event: DragEvent<HTMLDivElement>, workspaceId: string) => void
  onWorkspaceDragEnd: () => void
  onOpenBlankConversationInWorkspace: (workspaceId: string) => void
  onSessionClick: (workspaceId: string, sessionId: string) => void
  onRenameSession: (session: SessionInfo) => void
  onDeleteSession: (session: SessionInfo) => void
  /** 从左侧列表隐藏会话（不删除数据） */
  onRemoveSessionFromSidebar?: (workspaceId: string, session: SessionInfo) => void
  /** 多工作区模式下：从侧边栏移除工作区（该工作区下会话一律从本机删除，不并入其他工作区） */
  onRemoveWorkspaceFromSidebar?: (workspace: WorkspaceInfo) => void
  onPickWorkspace: () => void
  onSidebarResizeStart: (event: MouseEvent<HTMLDivElement>) => void
  onSidebarCollapseToggle: () => void
  mcpOpen: boolean
  mcpDraft: McpServerEntry[]
  mcpJsonImportText: string
  mcpWarmupSummary: string | null
  mcpWarmup: McpWarmupReport | null
  mcpWarmupBusy: boolean
  mcpProbingId: string | null
  onCloseMcpHub: () => void
  onSaveMcpServers: () => void
  onRerunMcpWarmup: () => void
  onMcpJsonImportTextChange: (text: string) => void
  onImportMcpFromJsonText: () => void
  onOpenMcpAdd: () => void
  onSetMcpEnabled: (id: string, checked: boolean) => void
  onProbeMcpRow: (row: McpServerEntry) => void
  onOpenMcpEdit: (row: McpServerEntry) => void
  onDeleteMcpRow: (id: string) => void
  onOpenExternalWithConfirm: (url: string) => void
  settingsOpen: boolean
  settingsForm: FormInstance<SettingsFormValues>
  defaultSettingsFormValues: SettingsFormValues
  onSaveSettings: () => void
  onCloseSettings: () => void
  onSettingsProviderChange: (next: ModelProviderId) => void
  skillsOpen: boolean
  skillsStateLoading: boolean
  installedSkillRows: SkillUiEntry[]
  installedMarketFolderIds: Set<string>
  skillsMarketInstallingId: string | null
  onCloseSkillsHub: () => void
  onReloadSkillsState: () => void
  onInstallMarketSkill: (item: SkillsMarketCatalogItem) => void
  onUninstallSkillRow: (row: SkillUiEntry) => void
}

export function WorkspaceLeftPane({
  sidebarWidth,
  isSidebarCollapsed,
  isSidebarResizing,
  activeWorkspaceId,
  activeSessionId,
  workspaces,
  sessionsByWorkspace,
  expandedWorkspaceIds,
  draggingWorkspaceId,
  workspaceDropMarker,
  onOpenMcpHub,
  onOpenSkillsHub,
  onOpenSettings,
  onOpenBlankConversation,
  onToggleWorkspace,
  onWorkspaceDragStart,
  onWorkspaceDragOver,
  onWorkspaceDrop,
  onWorkspaceDragEnd,
  onOpenBlankConversationInWorkspace,
  onSessionClick,
  onRenameSession,
  onDeleteSession,
  onRemoveSessionFromSidebar,
  onRemoveWorkspaceFromSidebar,
  onPickWorkspace,
  onSidebarResizeStart,
  onSidebarCollapseToggle,
  mcpOpen,
  mcpDraft,
  mcpJsonImportText,
  mcpWarmupSummary,
  mcpWarmup,
  mcpWarmupBusy,
  mcpProbingId,
  onCloseMcpHub,
  onSaveMcpServers,
  onRerunMcpWarmup,
  onMcpJsonImportTextChange,
  onImportMcpFromJsonText,
  onOpenMcpAdd,
  onSetMcpEnabled,
  onProbeMcpRow,
  onOpenMcpEdit,
  onDeleteMcpRow,
  onOpenExternalWithConfirm,
  settingsOpen,
  settingsForm,
  defaultSettingsFormValues,
  onSaveSettings,
  onCloseSettings,
  onSettingsProviderChange,
  skillsOpen,
  skillsStateLoading,
  installedSkillRows,
  installedMarketFolderIds,
  skillsMarketInstallingId,
  onCloseSkillsHub,
  onReloadSkillsState,
  onInstallMarketSkill,
  onUninstallSkillRow
}: WorkspaceLeftPaneProps) {
  return (
    <>
      <div className="app-sidebar" style={{ width: `${sidebarWidth}px` }}>
        <div className={`app-sidebar-inner ${isSidebarCollapsed ? 'is-collapsed' : ''}`}>
          <div className="app-sidebar-header">
            <Button
              type="text"
              icon={isSidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={onSidebarCollapseToggle}
              className="app-settings-btn app-sidebar-collapse-btn"
              title={isSidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
              aria-label={isSidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
            />
            {!isSidebarCollapsed && (
              <Space size={0}>
                <Button
                  type="text"
                  icon={<ApiOutlined />}
                  onClick={onOpenMcpHub}
                  className="app-settings-btn"
                  title="MCP 与扩展"
                />
                <Button
                  type="text"
                  icon={<ShopOutlined />}
                  onClick={onOpenSkillsHub}
                  className="app-settings-btn"
                  title="技能与市场"
                />
                <Button
                  type="text"
                  icon={<SettingOutlined />}
                  onClick={onOpenSettings}
                  className="app-settings-btn"
                  title="设置"
                />
              </Space>
            )}
          </div>
          {!isSidebarCollapsed && (
            <div className="app-new-session-wrap">
              <Button
                block
                type="primary"
                icon={<PlusOutlined />}
                className="app-new-session-btn"
                onClick={onOpenBlankConversation}
              >
                新会话
              </Button>
            </div>
          )}
          {!isSidebarCollapsed && (
            <div className="app-workspace-tree">
              {workspaces.length === 0 ? (
                <div className="app-workspace-tree-empty" role="status">
                  <Text type="secondary">
                    暂无工作区。请点击下方「添加并切换工作区」选择项目文件夹。
                  </Text>
                </div>
              ) : (
                workspaces.map((workspace) => {
                  const isActiveWorkspace = workspace.id === activeWorkspaceId
                  const isExpanded = expandedWorkspaceIds.has(workspace.id)
                  const dropMarkerPlacement =
                    !!draggingWorkspaceId &&
                    draggingWorkspaceId !== workspace.id &&
                    workspaceDropMarker?.workspaceId === workspace.id
                      ? workspaceDropMarker.placement
                      : null
                  const workspaceSessions = sessionsByWorkspace[workspace.id] || []
                  return (
                    <div
                      key={workspace.id}
                      className={`app-workspace-node ${isActiveWorkspace ? 'is-active' : ''} ${dropMarkerPlacement === 'before' ? 'is-drop-before' : ''} ${dropMarkerPlacement === 'after' ? 'is-drop-after' : ''}`}
                    >
                    <div
                      className="app-workspace-node-header is-draggable"
                      draggable
                      onDragStart={(event) => onWorkspaceDragStart(event, workspace.id)}
                      onDragOver={(event) => onWorkspaceDragOver(event, workspace.id)}
                      onDrop={(event) => void onWorkspaceDrop(event, workspace.id)}
                      onDragEnd={onWorkspaceDragEnd}
                    >
                      <button
                        type="button"
                        className="app-workspace-chevron-btn"
                        aria-label={isExpanded ? '收起工作区会话' : '展开工作区会话'}
                        onClick={(event) => {
                          event.stopPropagation()
                          onToggleWorkspace(workspace.id)
                        }}
                      >
                        <RightOutlined
                          className={`app-workspace-chevron ${isExpanded ? 'is-open' : ''}`}
                          aria-hidden="true"
                        />
                      </button>
                      {onRemoveWorkspaceFromSidebar ? (
                        <Dropdown
                          menu={{
                            items: [
                              {
                                key: 'remove-from-sidebar',
                                label: '从侧边栏移除',
                                onClick: () => onRemoveWorkspaceFromSidebar(workspace)
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
                          onOpenBlankConversationInWorkspace(workspace.id)
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
                                  onClick: () => onRenameSession(session)
                                },
                                ...(onRemoveSessionFromSidebar
                                  ? [
                                      {
                                        key: 'remove-from-sidebar',
                                        label: '从侧边栏移除',
                                        onClick: () =>
                                          onRemoveSessionFromSidebar(workspace.id, session)
                                      }
                                    ]
                                  : []),
                                {
                                  key: 'del',
                                  danger: true,
                                  label: '删除',
                                  onClick: () => onDeleteSession(session)
                                }
                              ]
                            }}
                            trigger={['contextMenu']}
                          >
                            <div
                              className={`app-session-item app-session-item-sub ${session.id === activeSessionId ? 'is-active' : ''}`}
                              onClick={() => onSessionClick(workspace.id, session.id)}
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
          {!isSidebarCollapsed && (
            <div className="app-workspace-btn-wrap">
              <Button block icon={<FolderOpenOutlined />} onClick={onPickWorkspace}>
                添加并切换工作区
              </Button>
            </div>
          )}
        </div>
      </div>
      <div
        className={`app-sidebar-resizer ${isSidebarResizing ? 'is-dragging' : ''} ${isSidebarCollapsed ? 'is-hidden' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
        onMouseDown={isSidebarCollapsed ? undefined : onSidebarResizeStart}
      />
      <McpHubModal
        open={mcpOpen}
        mcpDraft={mcpDraft}
        mcpJsonImportText={mcpJsonImportText}
        mcpWarmupSummary={mcpWarmupSummary}
        mcpWarmup={mcpWarmup}
        mcpWarmupBusy={mcpWarmupBusy}
        mcpProbingId={mcpProbingId}
        onClose={onCloseMcpHub}
        onSave={onSaveMcpServers}
        onRerunWarmup={onRerunMcpWarmup}
        onMcpJsonImportTextChange={onMcpJsonImportTextChange}
        onImportFromJsonText={onImportMcpFromJsonText}
        onOpenMcpAdd={onOpenMcpAdd}
        onSetMcpEnabled={onSetMcpEnabled}
        onProbeMcpRow={onProbeMcpRow}
        onOpenMcpEdit={onOpenMcpEdit}
        onDeleteMcpRow={onDeleteMcpRow}
        onOpenExternalWithConfirm={onOpenExternalWithConfirm}
      />
      <SettingsModal
        open={settingsOpen}
        form={settingsForm}
        defaultFormValues={defaultSettingsFormValues}
        onSave={onSaveSettings}
        onCancel={onCloseSettings}
        onProviderChange={onSettingsProviderChange}
      />
      <SkillsHubModal
        open={skillsOpen}
        skillsStateLoading={skillsStateLoading}
        installedSkillRows={installedSkillRows}
        installedMarketFolderIds={installedMarketFolderIds}
        skillsMarketInstallingId={skillsMarketInstallingId}
        onClose={onCloseSkillsHub}
        onReloadSkillsState={onReloadSkillsState}
        onInstallMarketSkill={onInstallMarketSkill}
        onUninstallSkillRow={onUninstallSkillRow}
      />
    </>
  )
}
