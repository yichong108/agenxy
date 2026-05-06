import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Divider,
  Form,
  Input,
  Modal,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography
} from 'antd'
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'

import {
  MAX_MCP_SERVERS,
  parseMcpServersFromUnknown,
  type McpServerEntry,
  type McpWarmupReport
} from '@/shared/ipc'

const { TextArea } = Input
const { Text, Title, Link } = Typography

const MCP_MARKET_LINKS: { title: string; desc: string; url: string }[] = [
  {
    title: 'Cursor Directory',
    desc: '社区收录的 MCP 与扩展，可按场景筛选',
    url: 'https://cursor.directory/mcp'
  },
  {
    title: 'Smithery',
    desc: 'MCP 注册与托管，可浏览可安装的 stdio 包',
    url: 'https://smithery.ai/'
  },
  {
    title: 'Glama MCP',
    desc: 'MCP 服务器目录与文档',
    url: 'https://glama.ai/mcp/servers'
  },
  {
    title: 'MCP 官方规范',
    desc: '协议说明、能力模型与实现参考',
    url: 'https://modelcontextprotocol.io/'
  },
  {
    title: 'awesome-mcp-servers',
    desc: 'GitHub 上的开源 MCP 服务器合集',
    url: 'https://github.com/punkpeye/awesome-mcp-servers'
  }
]

function randomId() {
  return `m-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function stringifyMcpEnvForForm(env: McpServerEntry['env']): string {
  if (env == null) return ''
  if (typeof env !== 'object' || Array.isArray(env)) return ''
  return JSON.stringify(env, null, 2)
}

export type McpHubModalProps = {
  open: boolean
  onClose: () => void
}

export function McpHubModal({ open, onClose }: McpHubModalProps) {
  const { message: msgApi, modal: modalApi } = AntdApp.useApp()
  const bridge = window.bridge

  const [mcpDraft, setMcpDraft] = useState<McpServerEntry[]>([])
  const [mcpJsonImportText, setMcpJsonImportText] = useState('')
  const [mcpWarmup, setMcpWarmup] = useState<McpWarmupReport | null>(null)
  const [mcpWarmupBusy, setMcpWarmupBusy] = useState(false)
  const [mcpProbingId, setMcpProbingId] = useState<string | null>(null)

  const [mcpEditorOpen, setMcpEditorOpen] = useState(false)
  const [mcpEditorRecord, setMcpEditorRecord] = useState<McpServerEntry | null>(null)
  const [mcpEditorNonce, setMcpEditorNonce] = useState(0)
  const [mcpEnvTextLocal, setMcpEnvTextLocal] = useState('')
  const [mcpForm] = Form.useForm<{
    name: string
    command: string
    argsText: string
    cwd: string
    enabled: boolean
  }>()

  const mcpWarmupSummary = useMemo(() => {
    if (!mcpWarmup) return null
    if (!mcpWarmup.servers.length) {
      return '当前没有已启用且 command 非空的 MCP 参与预检。'
    }
    const ok = mcpWarmup.servers.filter((x) => x.ok).length
    const bad = mcpWarmup.servers.length - ok
    return `已检查 ${mcpWarmup.servers.length} 台：成功 ${ok}，失败 ${bad}。成功项的连接会留在主进程池中，Agent 调用工具时复用，空闲一段时间后自动断开。`
  }, [mcpWarmup])

  useEffect(() => {
    if (!open) return
    void (async () => {
      const settingsResult = await bridge.getSettings()
      setMcpDraft(JSON.parse(JSON.stringify(settingsResult.mcpServers ?? [])))
      setMcpJsonImportText('')
      const w = await bridge.getMcpWarmupStatus()
      if (w.report) setMcpWarmup(w.report)
      setMcpWarmupBusy(w.inFlight)
    })()
  }, [bridge, open])

  useEffect(() => {
    if (!open) return
    return bridge.onMcpWarmup((r) => {
      setMcpWarmup(r)
      setMcpWarmupBusy(false)
    })
  }, [bridge, open])

  const handleClose = useCallback(() => {
    setMcpJsonImportText('')
    setMcpEditorOpen(false)
    setMcpEditorRecord(null)
    setMcpEnvTextLocal('')
    onClose()
  }, [onClose])

  const saveMcpServers = useCallback(async () => {
    const payload = JSON.parse(JSON.stringify(mcpDraft)) as McpServerEntry[]
    const saved = await bridge.setSettings({ mcpServers: payload })
    setMcpDraft(JSON.parse(JSON.stringify(saved.mcpServers ?? [])) as McpServerEntry[])
    setMcpJsonImportText('')
    handleClose()
    msgApi.success('MCP 配置已保存')
  }, [bridge, handleClose, mcpDraft, msgApi])

  const importMcpFromJsonText = useCallback(() => {
    const t = mcpJsonImportText.trim()
    if (!t) {
      msgApi.error('请粘贴 JSON')
      return
    }
    try {
      const parsed = JSON.parse(t) as unknown
      const entries = parseMcpServersFromUnknown(parsed)
      if (entries.length === 0) {
        msgApi.error(
          '未解析到任何 MCP。支持：① Cursor 形态 { "mcpServers": { "名称": { "command", "args", "env" } } }；② 本应用使用的服务器对象数组。'
        )
        return
      }
      const mergedLen = mcpDraft.length + entries.length
      const dropped = mergedLen > MAX_MCP_SERVERS ? mergedLen - MAX_MCP_SERVERS : 0
      setMcpDraft((prev) => [...prev, ...entries].slice(0, MAX_MCP_SERVERS))
      if (dropped > 0) {
        msgApi.warning(`最多共 ${MAX_MCP_SERVERS} 条，已截断 ${dropped} 条导入项`)
      }
      setMcpJsonImportText('')
      msgApi.success(`已加入列表 ${entries.length} 条（请点击「保存 MCP」持久化）`)
    } catch {
      msgApi.error('JSON 解析失败')
    }
  }, [mcpDraft.length, mcpJsonImportText, msgApi])

  const openMcpAdd = useCallback(() => {
    setMcpEditorNonce((n) => n + 1)
    setMcpEnvTextLocal('')
    setMcpEditorRecord({
      id: randomId(),
      name: '新 MCP 服务器',
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.']
    })
    setMcpEditorOpen(true)
  }, [])

  const openMcpEdit = useCallback(
    (row: McpServerEntry) => {
      setMcpEditorNonce((n) => n + 1)
      const merged = mcpDraft.find((x) => x.id === row.id) ?? row
      setMcpEditorRecord({ ...merged })
      setMcpEnvTextLocal(stringifyMcpEnvForForm(merged.env))
      setMcpEditorOpen(true)
    },
    [mcpDraft]
  )

  useLayoutEffect(() => {
    if (!mcpEditorOpen || !mcpEditorRecord) return
    mcpForm.setFieldsValue({
      name: mcpEditorRecord.name,
      command: mcpEditorRecord.command,
      argsText: (mcpEditorRecord.args ?? []).join('\n'),
      cwd: mcpEditorRecord.cwd ?? '',
      enabled: mcpEditorRecord.enabled
    })
    setMcpEnvTextLocal(stringifyMcpEnvForForm(mcpEditorRecord.env))
  }, [mcpEditorOpen, mcpEditorRecord, mcpEditorNonce, mcpForm])

  const closeMcpEditor = useCallback(() => {
    setMcpEditorOpen(false)
    setMcpEditorRecord(null)
    setMcpEnvTextLocal('')
  }, [])

  const submitMcpEditor = useCallback(async () => {
    if (!mcpEditorRecord) {
      return Promise.reject(new Error('未选择编辑项'))
    }
    const v = await mcpForm.validateFields()
    const argsTextRaw = String(v.argsText ?? '')
    const args = argsTextRaw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (args.length === 0) {
      msgApi.error('参数至少填写一行（每行一个参数）')
      return Promise.reject(new Error('args empty'))
    }
    let env: Record<string, unknown> | undefined
    const trimmedEnv = mcpEnvTextLocal.trim()
    if (trimmedEnv) {
      try {
        const parsed = JSON.parse(trimmedEnv) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          msgApi.error('环境变量须为 JSON 对象，例如 {"KEY":"value"} 或含嵌套对象')
          return Promise.reject(new Error('env shape'))
        }
        const o: Record<string, unknown> = {}
        for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
          if (val === undefined) continue
          o[k] = val
        }
        if (Object.keys(o).length) env = o
      } catch {
        msgApi.error('环境变量 JSON 解析失败')
        return Promise.reject(new Error('env json'))
      }
    }
    const cwdTrim = String(v.cwd ?? '').trim()
    const nextRow: McpServerEntry = {
      id: mcpEditorRecord.id,
      name: v.name.trim() || mcpEditorRecord.id,
      enabled: v.enabled,
      command: v.command.trim(),
      args,
      ...(cwdTrim ? { cwd: cwdTrim } : {}),
      ...(env ? { env } : {})
    }
    setMcpDraft((prev) => {
      const i = prev.findIndex((x) => x.id === nextRow.id)
      if (i >= 0) {
        const copy = [...prev]
        copy[i] = nextRow
        return copy
      }
      return [...prev, nextRow]
    })
    closeMcpEditor()
    msgApi.success('已写入列表（请点击主窗口底部「保存 MCP」持久化）')
  }, [closeMcpEditor, mcpEditorRecord, mcpEnvTextLocal, mcpForm, msgApi])

  const probeMcpRow = useCallback(
    async (row: McpServerEntry) => {
      setMcpProbingId(row.id)
      try {
        const r = await bridge.mcpProbeServer(row)
        if (r.ok) {
          modalApi.info({
            title: `「${row.name}」连接成功`,
            width: 600,
            centered: true,
            content: (
              <div>
                <Text>共 {r.tools.length} 个工具：</Text>
                <ul style={{ marginTop: 8, paddingLeft: 18, maxHeight: 360, overflow: 'auto' }}>
                  {r.tools.map((t) => (
                    <li key={t.name} style={{ marginBottom: 6 }}>
                      <Text code>{t.name}</Text>
                      {t.description ? (
                        <Text type="secondary">
                          {' '}
                          {t.description.length > 160
                            ? `${t.description.slice(0, 160)}…`
                            : t.description}
                        </Text>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })
        } else {
          msgApi.error(r.error)
        }
      } finally {
        setMcpProbingId(null)
      }
    },
    [bridge, modalApi, msgApi]
  )

  const rerunMcpWarmup = useCallback(async () => {
    setMcpWarmupBusy(true)
    try {
      const r = await bridge.mcpRunWarmup()
      setMcpWarmup(r)
    } catch {
      msgApi.error('MCP 预检失败')
    } finally {
      setMcpWarmupBusy(false)
    }
  }, [bridge, msgApi])

  const openExternalWithConfirm = useCallback(
    (href: string) => {
      const target = (() => {
        try {
          const parsed = new URL(href)
          return parsed.host || href
        } catch {
          return href
        }
      })()
      modalApi.confirm({
        title: '即将打开外部链接',
        content: `目标地址：${target}`,
        centered: true,
        okText: '继续打开',
        cancelText: '取消',
        onOk: async () => {
          const r = await bridge.openExternal(href)
          if (!r.ok) msgApi.warning('打开链接失败')
        }
      })
    },
    [bridge, modalApi, msgApi]
  )

  return (
    <>
      <Modal
        title="MCP 与扩展"
        open={open}
        onCancel={handleClose}
        width={760}
        destroyOnHidden
        centered
        footer={[
          <Button key="close" onClick={handleClose}>
            关闭
          </Button>,
          <Button key="save" type="primary" onClick={() => void saveMcpServers()}>
            保存 MCP
          </Button>
        ]}
      >
        <Tabs
          items={[
            {
              key: 'servers',
              label: '我的 MCP',
              children: (
                <div>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="stdio 方式连接 MCP 子进程"
                    description={
                      <div>
                        <div>
                          与 Cursor 类似：填写启动命令与参数。启用后，Agent
                          在「已开启工具」模式下会把各服务器的工具挂到对话中（工具名以 mcp_
                          开头）。应用启动时会<strong>预检</strong>已启用的服务器并
                          <strong>池化复用</strong>
                          连接，减少反复拉起子进程；长时间无调用会自动断开。
                        </div>
                        {mcpWarmupSummary ? (
                          <div style={{ marginTop: 8 }}>
                            <Text strong>预检摘要：</Text>
                            {mcpWarmupSummary}
                            {mcpWarmup ? (
                              <Text type="secondary" style={{ marginLeft: 8 }}>
                                （{new Date(mcpWarmup.atMs).toLocaleString()}）
                              </Text>
                            ) : null}
                          </div>
                        ) : null}
                        {mcpWarmupBusy ? (
                          <div style={{ marginTop: 8 }}>
                            <Text type="secondary">正在预检已启用的 MCP…</Text>
                          </div>
                        ) : null}
                      </div>
                    }
                  />
                  <Space style={{ marginBottom: 12 }}>
                    <Button size="small" loading={mcpWarmupBusy} onClick={() => void rerunMcpWarmup()}>
                      重新预检全部 MCP
                    </Button>
                  </Space>
                  <div style={{ marginBottom: 12 }}>
                    <Text strong>从 JSON 导入</Text>
                    <div style={{ marginTop: 6, marginBottom: 8 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        支持 Cursor 片段：根对象含 <Text code>mcpServers</Text>
                        ，子键为显示名，值为含 command、args、env
                        等字段的对象；也支持本应用使用的服务器对象数组。
                      </Text>
                    </div>
                    <TextArea
                      value={mcpJsonImportText}
                      onChange={(e) => setMcpJsonImportText(e.target.value)}
                      placeholder={`例如：\n{\n  "mcpServers": {\n    "mysql": {\n      "command": "npx",\n      "args": ["-y", "@f4ww4z/mcp-mysql-server"],\n      "env": { "MYSQL_HOST": "localhost" }\n    }\n  }\n}`}
                      rows={6}
                      style={{ fontFamily: 'monospace', fontSize: 12 }}
                    />
                    <Button type="default" style={{ marginTop: 8 }} onClick={importMcpFromJsonText}>
                      解析并追加到列表
                    </Button>
                  </div>
                  <Space style={{ marginBottom: 12 }}>
                    <Button type="primary" onClick={openMcpAdd}>
                      添加服务器
                    </Button>
                  </Space>
                  <Table<McpServerEntry>
                    size="small"
                    rowKey="id"
                    pagination={false}
                    dataSource={mcpDraft}
                    locale={{ emptyText: '暂无 MCP，可从「MCP 市场」挑选后在此添加' }}
                    columns={[
                      { title: '名称', dataIndex: 'name', width: 140, ellipsis: true },
                      {
                        title: '命令',
                        dataIndex: 'command',
                        width: 100,
                        ellipsis: true
                      },
                      {
                        title: '参数预览',
                        key: 'args',
                        ellipsis: true,
                        render: (_, row) => (
                          <Text type="secondary" ellipsis>
                            {(row.args ?? []).join(' ').slice(0, 80)}
                            {(row.args ?? []).join(' ').length > 80 ? '…' : ''}
                          </Text>
                        )
                      },
                      {
                        title: '启用',
                        width: 72,
                        render: (_, row) => (
                          <Switch
                            checked={row.enabled}
                            onChange={(checked) =>
                              setMcpDraft((prev) =>
                                prev.map((x) => (x.id === row.id ? { ...x, enabled: checked } : x))
                              )
                            }
                          />
                        )
                      },
                      {
                        title: '启动预检',
                        key: 'warmup',
                        width: 108,
                        render: (_, row) => {
                          if (!row.enabled || !row.command?.trim()) {
                            return <Text type="secondary">—</Text>
                          }
                          const report = mcpWarmup?.servers.find((x) => x.id === row.id)
                          if (!report && mcpWarmupBusy) {
                            return (
                              <Tag color="processing" style={{ margin: 0 }}>
                                检测中
                              </Tag>
                            )
                          }
                          if (!report) return <Text type="secondary">—</Text>
                          if (report.ok) {
                            return (
                              <Tag color="success" style={{ margin: 0 }}>
                                {report.toolCount} 工具
                              </Tag>
                            )
                          }
                          return (
                            <Tag color="error" style={{ margin: 0 }} title={report.error}>
                              失败
                            </Tag>
                          )
                        }
                      },
                      {
                        title: '操作',
                        key: 'actions',
                        width: 200,
                        render: (_, row) => (
                          <Space size={4} wrap>
                            <Button
                              size="small"
                              loading={mcpProbingId === row.id}
                              onClick={() => void probeMcpRow(row)}
                            >
                              测试
                            </Button>
                            <Button size="small" onClick={() => openMcpEdit(row)}>
                              编辑
                            </Button>
                            <Button
                              size="small"
                              danger
                              onClick={() =>
                                setMcpDraft((prev) => prev.filter((x) => x.id !== row.id))
                              }
                            >
                              删除
                            </Button>
                          </Space>
                        )
                      }
                    ]}
                  />
                </div>
              )
            },
            {
              key: 'market',
              label: 'MCP 市场',
              children: (
                <div>
                  <Text type="secondary">
                    以下为常用 MCP 发现与文档站点，点击在系统浏览器中打开（需确认）。
                  </Text>
                  <Divider style={{ margin: '12px 0' }} />
                  <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                    {MCP_MARKET_LINKS.map((item) => (
                      <Card key={item.url} size="small" type="inner">
                        <Title level={5} style={{ marginTop: 0, marginBottom: 4 }}>
                          {item.title}
                        </Title>
                        <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                          {item.desc}
                        </Text>
                        <Link
                          href={item.url}
                          onClick={(e) => {
                            e.preventDefault()
                            openExternalWithConfirm(item.url)
                          }}
                        >
                          {item.url}
                        </Link>
                      </Card>
                    ))}
                  </Space>
                </div>
              )
            }
          ]}
        />
      </Modal>

      <Modal
        title={
          mcpDraft.some((x) => x.id === mcpEditorRecord?.id) ? '编辑 MCP 服务器' : '添加 MCP 服务器'
        }
        open={mcpEditorOpen}
        onOk={() => void submitMcpEditor()}
        onCancel={closeMcpEditor}
        okText="写入列表"
        destroyOnHidden
        width={520}
        centered
      >
        {mcpEditorRecord ? (
          <Form
            key={`mcp-editor-${mcpEditorRecord.id}-${mcpEditorNonce}`}
            form={mcpForm}
            layout="vertical"
            preserve={false}
            initialValues={{
              name: mcpEditorRecord.name,
              command: mcpEditorRecord.command,
              argsText: (mcpEditorRecord.args ?? []).join('\n'),
              cwd: mcpEditorRecord.cwd ?? '',
              enabled: mcpEditorRecord.enabled
            }}
          >
            <Form.Item
              name="name"
              label="显示名称"
              rules={[{ required: true, message: '请填写名称' }]}
            >
              <Input placeholder="例如 Filesystem MCP" />
            </Form.Item>
            <Form.Item
              name="command"
              label="可执行文件"
              rules={[{ required: true, message: '请填写命令' }]}
            >
              <Input placeholder="如 npx、uvx、node" />
            </Form.Item>
            <Form.Item
              name="argsText"
              label="参数（每行一个）"
              rules={[{ required: true, message: '至少填写一行参数' }]}
              extra="示例：-y 换行 @modelcontextprotocol/server-filesystem 换行 工作区绝对路径"
            >
              <TextArea
                rows={5}
                placeholder={['-y', '@modelcontextprotocol/server-filesystem', '.'].join('\n')}
              />
            </Form.Item>
            <Form.Item name="cwd" label="工作目录 cwd（可选）">
              <Input placeholder="子进程启动目录，默认可留空" />
            </Form.Item>
            <Form.Item
              label="环境变量 JSON（可选）"
              extra="支持嵌套对象/数组，会原样写入配置；启动 MCP 子进程时非字符串会 JSON.stringify 后作为环境变量值传入。"
            >
              <TextArea
                rows={3}
                placeholder="{}"
                value={mcpEnvTextLocal}
                onChange={(e) => setMcpEnvTextLocal(e.target.value)}
              />
            </Form.Item>
            <Form.Item name="enabled" label="添加后立即启用" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Form>
        ) : null}
      </Modal>
    </>
  )
}
