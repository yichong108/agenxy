import { Alert, Button, Modal, Table, Tabs, Tag, Tooltip } from 'antd'

import { SkillsMarketPanel } from '@/renderer/src/skills-market/SkillsMarketPanel'
import type { SkillUiEntry, SkillsMarketCatalogItem } from '@/shared/ipc'

function skillKindLabel(kind: SkillUiEntry['kind']): string {
  switch (kind) {
    case 'builtin_code':
      return '内置（代码）'
    case 'builtin_packaged':
      return '内置（随应用）'
    case 'market':
      return '市场'
    case 'legacy':
      return '兼容/本地'
    default:
      return kind
  }
}

type SkillsHubModalProps = {
  open: boolean
  skillsStateLoading: boolean
  installedSkillRows: SkillUiEntry[]
  installedMarketFolderIds: Set<string>
  skillsMarketInstallingId: string | null
  onClose: () => void
  onReloadSkillsState: () => void
  onInstallMarketSkill: (item: SkillsMarketCatalogItem) => void
  onUninstallSkillRow: (row: SkillUiEntry) => void
}

export function SkillsHubModal({
  open,
  skillsStateLoading,
  installedSkillRows,
  installedMarketFolderIds,
  skillsMarketInstallingId,
  onClose,
  onReloadSkillsState,
  onInstallMarketSkill,
  onUninstallSkillRow
}: SkillsHubModalProps) {
  return (
    <Modal
      title="技能与市场"
      open={open}
      onCancel={onClose}
      width={920}
      destroyOnHidden
      footer={[
        <Button key="close" onClick={onClose}>
          关闭
        </Button>,
        <Button key="reload-installed" loading={skillsStateLoading} onClick={onReloadSkillsState}>
          刷新已安装
        </Button>
      ]}
    >
      <Tabs
        items={[
          {
            key: 'installed',
            label: '已安装',
            children: (
              <div>
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="卸载说明"
                  description="内置（代码）与内置（随应用）不可卸载。市场安装位于 userData/skills/market。兼容目录来自旧版种子或手动放置的技能。"
                />
                <Table<SkillUiEntry>
                  size="small"
                  rowKey="key"
                  loading={skillsStateLoading}
                  pagination={false}
                  dataSource={installedSkillRows}
                  locale={{ emptyText: '暂无技能数据，请点击「刷新已安装」' }}
                  scroll={{ x: 820 }}
                  columns={[
                    {
                      title: '类型',
                      dataIndex: 'kind',
                      width: 120,
                      render: (kind: SkillUiEntry['kind']) => {
                        const color =
                          kind === 'builtin_code'
                            ? 'purple'
                            : kind === 'builtin_packaged'
                              ? 'blue'
                              : kind === 'market'
                                ? 'green'
                                : 'orange'
                        return <Tag color={color}>{skillKindLabel(kind)}</Tag>
                      }
                    },
                    { title: '工具名', dataIndex: 'toolName', width: 200, ellipsis: true },
                    { title: '标题', dataIndex: 'title', width: 160, ellipsis: true },
                    {
                      title: '描述',
                      dataIndex: 'description',
                      ellipsis: true,
                      render: (description: string) => (
                        <Tooltip title={description}>
                          <span>{description}</span>
                        </Tooltip>
                      )
                    },
                    {
                      title: '来源',
                      dataIndex: 'sourceLabel',
                      width: 220,
                      ellipsis: true
                    },
                    {
                      title: '操作',
                      key: 'actions',
                      width: 120,
                      render: (_, row) => {
                        if (row.kind === 'builtin_code' || row.kind === 'builtin_packaged') {
                          return (
                            <Tooltip title="内置技能不可卸载">
                              <Button size="small" disabled>
                                卸载
                              </Button>
                            </Tooltip>
                          )
                        }
                        if (row.kind === 'market') {
                          return (
                            <Button size="small" danger onClick={() => onUninstallSkillRow(row)}>
                              卸载
                            </Button>
                          )
                        }
                        const canLegacy = Boolean(row.legacyFolderRelative)
                        return (
                          <Tooltip
                            title={
                              canLegacy
                                ? '删除整个兼容技能目录'
                                : '该条目位于 skills 根目录，无法安全卸载'
                            }
                          >
                            <Button
                              size="small"
                              danger
                              disabled={!canLegacy}
                              onClick={() => onUninstallSkillRow(row)}
                            >
                              卸载
                            </Button>
                          </Tooltip>
                        )
                      }
                    }
                  ]}
                />
              </div>
            )
          },
          {
            key: 'market',
            label: '技能市场',
            children: (
              <SkillsMarketPanel
                installedMarketFolderIds={installedMarketFolderIds}
                installingId={skillsMarketInstallingId}
                onInstall={onInstallMarketSkill}
              />
            )
          }
        ]}
      />
    </Modal>
  )
}
