import {
  ApiOutlined,
  FolderOpenOutlined,
  PlusOutlined,
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
  onCreateSessionForActiveWorkspace: () => void
  onToggleWorkspace: (workspaceId: string) => void
  onWorkspaceDragStart: (event: DragEvent<HTMLDivElement>, workspaceId: string) => void
  onWorkspaceDragOver: (event: DragEvent<HTMLDivElement>, workspaceId: string) => void
  onWorkspaceDrop: (event: DragEvent<HTMLDivElement>, workspaceId: string) => void
  onWorkspaceDragEnd: () => void
  onCreateSessionInWorkspace: (workspaceId: string) => void
  onSessionClick: (workspaceId: string, sessionId: string) => void
  onRenameSession: (session: SessionInfo) => void
  onDeleteSession: (session: SessionInfo) => void
  onPickWorkspace: () => void
  onSidebarResizeStart: (event: MouseEvent<HTMLDivElement>) => void
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
  onCreateSessionForActiveWorkspace,
  onToggleWorkspace,
  onWorkspaceDragStart,
  onWorkspaceDragOver,
  onWorkspaceDrop,
  onWorkspaceDragEnd,
  onCreateSessionInWorkspace,
  onSessionClick,
  onRenameSession,
  onDeleteSession,
  onPickWorkspace,
  onSidebarResizeStart,
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
        <div className="app-sidebar-inner">
          <div className="app-sidebar-header">
            <Text strong className="app-brand-text">
              AgentWeave
            </Text>
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
          </div>
          <div className="app-new-session-wrap">
            <Button
              block
              type="primary"
              icon={<PlusOutlined />}
              className="app-new-session-btn"
              onClick={onCreateSessionForActiveWorkspace}
            >
              新会话
            </Button>
          </div>
          <div className="app-workspace-tree">
            {workspaces.map((workspace) => {
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
                      <span
                        className={`app-workspace-chevron ${isExpanded ? 'is-open' : ''}`}
                        aria-hidden="true"
                      >
                        {'>'}
                      </span>
                    </button>
                    <span className="app-workspace-name-btn">
                      <Text className="app-workspace-name">{workspace.name}</Text>
                    </span>
                    <button
                      type="button"
                      className="app-workspace-add-session-btn"
                      aria-label={`在${workspace.name}下添加会话`}
                      title="添加会话"
                      onClick={(event) => {
                        event.stopPropagation()
                        onCreateSessionInWorkspace(workspace.id)
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
            })}
          </div>
          <div className="app-workspace-btn-wrap">
            <Button block icon={<FolderOpenOutlined />} onClick={onPickWorkspace}>
              添加并切换工作区
            </Button>
          </div>
        </div>
      </div>
      <div
        className={`app-sidebar-resizer ${isSidebarResizing ? 'is-dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
        onMouseDown={onSidebarResizeStart}
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
