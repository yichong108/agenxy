import { App as AntdApp, Button, Modal, Table, Tag, Tooltip } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { SkillsRuntimeState, SkillUiEntry } from '@/shared/ipc'

/**
 * 将技能安装类型映射为中文标签
 *
 * @param kind - 技能条目的安装来源类型
 * @returns 用于表格 Tag 展示的中文文案
 */
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

/**
 * 技能中心弹窗：展示已安装技能并支持卸载市场/兼容目录技能
 *
 * 聚合内置、历史市场安装与兼容目录技能；不再提供在线技能市场浏览与安装。
 *
 * @param open - 是否打开弹窗
 * @param onClose - 关闭弹窗回调
 */
export function SkillsHubModal({ open, onClose }: SkillsHubModalProps) {
  const { message: msgApi, modal: modalApi } = AntdApp.useApp()
  const bridge = window.bridge

  const [skillsState, setSkillsState] = useState<SkillsRuntimeState | null>(null)
  const [skillsStateLoading, setSkillsStateLoading] = useState(false)

  const installedSkillRows = useMemo(() => {
    if (!skillsState) return []
    return [
      ...skillsState.builtinCode,
      ...skillsState.builtinPackaged,
      ...skillsState.installedMarket,
      ...skillsState.legacyUser
    ]
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
      title="技能"
      open={open}
      onCancel={onClose}
      width={920}
      destroyOnHidden
      centered
      footer={[
        <Button key="close" onClick={onClose}>
          关闭
        </Button>,
        <Button
          key="reload-installed"
          loading={skillsStateLoading}
          onClick={() => void reloadSkillsState()}
        >
          刷新
        </Button>
      ]}
    >
      <Table<SkillUiEntry>
        size="small"
        rowKey="key"
        loading={skillsStateLoading}
        pagination={false}
        dataSource={installedSkillRows}
        locale={{ emptyText: '暂无技能数据，请点击「刷新」' }}
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
                      ? 'geekblue'
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
                    canLegacy ? '删除整个兼容技能目录' : '该条目位于 skills 根目录，无法安全卸载'
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
    </Modal>
  )
}
