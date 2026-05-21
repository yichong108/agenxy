import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import {
  App as AntdApp,
  Button,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Table,
  Typography
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useState } from 'react'

import {
  type AppSettings,
  defaultSettings,
  MAX_MEMORY_CONTENT_CHARS,
  type MemoryEntry,
  type UserMemoriesState
} from '@/shared/ipc'

const { TextArea } = Input
const { Text, Paragraph } = Typography

function formatTime(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

export type MemoryHubModalProps = {
  open: boolean
  onClose: () => void
}

export function MemoryHubModal({ open, onClose }: MemoryHubModalProps) {
  const { message: msgApi } = AntdApp.useApp()
  const bridge = window.bridge

  const [memories, setMemories] = useState<UserMemoriesState>({ items: [] })
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [loading, setLoading] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorId, setEditorId] = useState<string | null>(null)
  const [editorContent, setEditorContent] = useState('')

  const hydrate = useCallback(async () => {
    setLoading(true)
    try {
      const [mem, s] = await Promise.all([bridge.listMemories(), bridge.getSettings()])
      setMemories(mem)
      setSettings(s)
    } finally {
      setLoading(false)
    }
  }, [bridge])

  useEffect(() => {
    if (!open) return
    void hydrate()
  }, [hydrate, open])

  useEffect(() => {
    if (!open) return
    return bridge.onMemorySync((payload) => {
      setMemories({ items: payload.items })
    })
  }, [bridge, open])

  useEffect(() => {
    if (!open) return
    return bridge.onSettingsSync((s) => setSettings(s))
  }, [bridge, open])

  const patchSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const saved = await bridge.setSettings(patch)
      setSettings(saved)
    },
    [bridge]
  )

  const openAddEditor = useCallback(() => {
    setEditorId(null)
    setEditorContent('')
    setEditorOpen(true)
  }, [])

  const openEditEditor = useCallback((row: MemoryEntry) => {
    setEditorId(row.id)
    setEditorContent(row.content)
    setEditorOpen(true)
  }, [])

  const saveEditor = useCallback(async () => {
    const content = editorContent.trim()
    if (!content) {
      msgApi.warning('记忆内容不能为空')
      return
    }
    if (content.length > MAX_MEMORY_CONTENT_CHARS) {
      msgApi.warning(`单条记忆不超过 ${MAX_MEMORY_CONTENT_CHARS} 字`)
      return
    }
    if (editorId) {
      const next = await bridge.updateMemory(editorId, content)
      setMemories(next)
      msgApi.success('已更新记忆')
    } else {
      const next = await bridge.addMemory(content)
      setMemories(next)
      msgApi.success('已添加记忆')
    }
    setEditorOpen(false)
  }, [bridge, editorContent, editorId, msgApi])

  const handleDelete = useCallback(
    async (id: string) => {
      const next = await bridge.deleteMemory(id)
      setMemories(next)
      msgApi.success('已删除')
    },
    [bridge, msgApi]
  )

  const handleClearAll = useCallback(async () => {
    const next = await bridge.clearMemories()
    setMemories(next)
    msgApi.success('已清空全部记忆')
  }, [bridge, msgApi])

  const columns: ColumnsType<MemoryEntry> = [
    {
      title: '内容',
      dataIndex: 'content',
      key: 'content',
      ellipsis: true
    },
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      width: 88,
      render: (source: MemoryEntry['source']) => (source === 'auto' ? '自动' : '手动')
    },
    {
      title: '更新',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 168,
      render: (t: number) => formatTime(t)
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: (_v, row) => (
        <Space size={4}>
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => openEditEditor(row)}
            aria-label="编辑"
          />
          <Popconfirm title="删除这条记忆？" onConfirm={() => void handleDelete(row.id)}>
            <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label="删除" />
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <>
      <Modal
        title="用户记忆"
        open={open}
        onCancel={onClose}
        footer={null}
        width={720}
        destroyOnHidden
        centered
      >
        <Paragraph type="secondary" style={{ marginTop: 0 }}>
          全局记忆在所有工作区与会话间共享，会注入 Agent 的 system prompt。数据仅保存在本机{' '}
          <Text code>agenxy.json</Text>，不会上传。
        </Paragraph>

        <Space wrap style={{ marginBottom: 16 }}>
          <Space size={8}>
            <Text>启用记忆</Text>
            <Switch
              checked={settings.memoryEnabled !== false}
              onChange={(checked) => void patchSettings({ memoryEnabled: checked })}
            />
          </Space>
          <Space size={8}>
            <Text>对话后自动提取</Text>
            <Switch
              checked={settings.autoExtractMemory !== false}
              disabled={settings.memoryEnabled === false}
              onChange={(checked) => void patchSettings({ autoExtractMemory: checked })}
            />
          </Space>
        </Space>

        <Space style={{ marginBottom: 12 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAddEditor}>
            添加记忆
          </Button>
          <Popconfirm
            title="清空全部记忆？"
            description="此操作不可撤销。"
            onConfirm={() => void handleClearAll()}
            disabled={memories.items.length === 0}
          >
            <Button danger disabled={memories.items.length === 0}>
              清空全部
            </Button>
          </Popconfirm>
        </Space>

        <Table<MemoryEntry>
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={memories.items}
          pagination={{ pageSize: 8, hideOnSinglePage: true }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="暂无记忆。可手动添加，或在对话中说明长期偏好以触发自动提取。"
              />
            )
          }}
        />
      </Modal>

      <Modal
        title={editorId ? '编辑记忆' : '添加记忆'}
        open={editorOpen}
        onOk={() => void saveEditor()}
        onCancel={() => setEditorOpen(false)}
        okText="保存"
        destroyOnHidden
        centered
      >
        <TextArea
          rows={4}
          value={editorContent}
          onChange={(e) => setEditorContent(e.target.value)}
          placeholder="例如：偏好使用 TypeScript 与 pnpm"
          maxLength={MAX_MEMORY_CONTENT_CHARS}
          showCount
        />
      </Modal>
    </>
  )
}
