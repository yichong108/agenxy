import {
  Alert,
  Button,
  Card,
  Divider,
  Input,
  Modal,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography
} from 'antd'

import type { McpServerEntry, McpWarmupReport } from '@/shared/ipc'

const { TextArea } = Input
const { Text, Title } = Typography

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

type McpHubModalProps = {
  open: boolean
  mcpDraft: McpServerEntry[]
  mcpJsonImportText: string
  mcpWarmupSummary: string | null
  mcpWarmup: McpWarmupReport | null
  mcpWarmupBusy: boolean
  mcpProbingId: string | null
  onClose: () => void
  onSave: () => void
  onRerunWarmup: () => void
  onMcpJsonImportTextChange: (text: string) => void
  onImportFromJsonText: () => void
  onOpenMcpAdd: () => void
  onSetMcpEnabled: (id: string, checked: boolean) => void
  onProbeMcpRow: (row: McpServerEntry) => void
  onOpenMcpEdit: (row: McpServerEntry) => void
  onDeleteMcpRow: (id: string) => void
  onOpenExternalWithConfirm: (url: string) => void
}

export function McpHubModal({
  open,
  mcpDraft,
  mcpJsonImportText,
  mcpWarmupSummary,
  mcpWarmup,
  mcpWarmupBusy,
  mcpProbingId,
  onClose,
  onSave,
  onRerunWarmup,
  onMcpJsonImportTextChange,
  onImportFromJsonText,
  onOpenMcpAdd,
  onSetMcpEnabled,
  onProbeMcpRow,
  onOpenMcpEdit,
  onDeleteMcpRow,
  onOpenExternalWithConfirm
}: McpHubModalProps) {
  return (
    <Modal
      title="MCP 与扩展"
      open={open}
      onCancel={onClose}
      width={760}
      destroyOnHidden
      footer={[
        <Button key="close" onClick={onClose}>
          关闭
        </Button>,
        <Button key="save" type="primary" onClick={onSave}>
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
                  <Button size="small" loading={mcpWarmupBusy} onClick={onRerunWarmup}>
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
                    onChange={(e) => onMcpJsonImportTextChange(e.target.value)}
                    placeholder={`例如：\n{\n  "mcpServers": {\n    "mysql": {\n      "command": "npx",\n      "args": ["-y", "@f4ww4z/mcp-mysql-server"],\n      "env": { "MYSQL_HOST": "localhost" }\n    }\n  }\n}`}
                    rows={6}
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                  />
                  <Button type="default" style={{ marginTop: 8 }} onClick={onImportFromJsonText}>
                    解析并追加到列表
                  </Button>
                </div>
                <Space style={{ marginBottom: 12 }}>
                  <Button type="primary" onClick={onOpenMcpAdd}>
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
                          onChange={(checked) => onSetMcpEnabled(row.id, checked)}
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
                            onClick={() => onProbeMcpRow(row)}
                          >
                            测试
                          </Button>
                          <Button size="small" onClick={() => onOpenMcpEdit(row)}>
                            编辑
                          </Button>
                          <Button size="small" danger onClick={() => onDeleteMcpRow(row.id)}>
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
                      <Typography.Link
                        href={item.url}
                        onClick={(e) => {
                          e.preventDefault()
                          onOpenExternalWithConfirm(item.url)
                        }}
                      >
                        {item.url}
                      </Typography.Link>
                    </Card>
                  ))}
                </Space>
              </div>
            )
          }
        ]}
      />
    </Modal>
  )
}
