import { Alert, App as AntdApp, Button, Modal, Table, Tabs, Tag, Tooltip } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { SkillsMarketPanel } from '@/renderer/src/skills-market/SkillsMarketPanel'
import type { SkillUiEntry, SkillsMarketCatalogItem, SkillsRuntimeState } from '@/shared/ipc'

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

export type SkillsHubModalProps = {
  open: boolean
  onClose: () => void
}

export function SkillsHubModal({ open, onClose }: SkillsHubModalProps) {
  const { message: msgApi, modal: modalApi } = AntdApp.useApp()
  const bridge = window.bridge

  const [skillsState, setSkillsState] = useState<SkillsRuntimeState | null>(null)
  const [skillsStateLoading, setSkillsStateLoading] = useState(false)
  const [skillsMarketInstallingId, setSkillsMarketInstallingId] = useState<string | null>(null)

  const installedSkillRows = useMemo(() => {
    if (!skillsState) return []
    return [
      ...skillsState.builtinCode,
      ...skillsState.builtinPackaged,
      ...skillsState.installedMarket,
      ...skillsState.legacyUser
    ]
  }, [skillsState])

  const installedMarketFolderIds = useMemo(() => {
    const ids = new Set<string>()
    if (!skillsState) return ids
    for (const row of skillsState.installedMarket) {
      if (row.marketFolderId) ids.add(row.marketFolderId)
    }
    return ids
  }, [skillsState])

  const reloadSkillsState = useCallback(async () => {
    setSkillsStateLoading(true)
    try {
      const next = await bridge.getSkillsState()
      setSkillsState(next)
    } finally {
      setSkillsStateLoading(false)
    }
  }, [bridge])

  useEffect(() => {
    if (!open) return
    void reloadSkillsState()
  }, [open, reloadSkillsState])

  const installMarketSkill = useCallback(
    async (item: SkillsMarketCatalogItem) => {
      setSkillsMarketInstallingId(item.id)
      try {
        const r = await bridge.installSkillFromMarket(item)
        if (r.ok) {
          msgApi.success(`已安装「${item.name}」`)
          await reloadSkillsState()
        } else {
          msgApi.error(r.error)
        }
      } finally {
        setSkillsMarketInstallingId(null)
      }
    },
    [bridge, msgApi, reloadSkillsState]
  )

  const uninstallSkillRow = useCallback(
    async (row: SkillUiEntry) => {
      if (row.kind === 'market') {
        const folderId = row.marketFolderId
        if (!folderId) return
        modalApi.confirm({
          title: '卸载市场技能？',
          content: `将删除目录「market/${folderId}」及其中的文件。`,
          centered: true,
          okButtonProps: { danger: true },
          onOk: async () => {
            const r = await bridge.uninstallSkill({ kind: 'market', folderId })
            if (r.ok) {
              msgApi.success('已卸载')
              await reloadSkillsState()
            } else {
              msgApi.error(r.error)
            }
          }
        })
        return
      }
      if (row.kind === 'legacy') {
        const rel = row.legacyFolderRelative
        if (!rel) {
          msgApi.warning('该条目位于兼容根目录，无法按文件夹卸载；请手动编辑 userData/skills。')
          return
        }
        modalApi.confirm({
          title: '卸载兼容技能目录？',
          content: `将删除「skills/${rel}」。`,
          centered: true,
          okButtonProps: { danger: true },
          onOk: async () => {
            const r = await bridge.uninstallSkill({ kind: 'legacy', legacyFolderRelative: rel })
            if (r.ok) {
              msgApi.success('已卸载')
              await reloadSkillsState()
            } else {
              msgApi.error(r.error)
            }
          }
        })
      }
    },
    [bridge, modalApi, msgApi, reloadSkillsState]
  )

  return (
    <Modal
      title="技能与市场"
      open={open}
      onCancel={onClose}
      width={920}
      destroyOnHidden
      centered
      footer={[
        <Button key="close" onClick={onClose}>
          关闭
        </Button>,
        <Button key="reload-installed" loading={skillsStateLoading} onClick={() => void reloadSkillsState()}>
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
                            <Button size="small" danger onClick={() => void uninstallSkillRow(row)}>
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
                              onClick={() => void uninstallSkillRow(row)}
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
                onInstall={(item) => void installMarketSkill(item)}
              />
            )
          }
        ]}
      />
    </Modal>
  )
}
