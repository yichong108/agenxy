import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Card,
  Collapse,
  Form,
  Input,
  InputNumber,
  Layout,
  List,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
  Dropdown
} from 'antd'
import {
  PlusOutlined,
  SendOutlined,
  SettingOutlined,
  StopOutlined,
  FolderOpenOutlined
} from '@ant-design/icons'
import type { AppSettings, ChatMessage, SessionInfo, StreamEvent, ToolTimelineEvent } from '@shared/ipc'

const { Sider, Content, Header } = Layout
const { Text, Paragraph } = Typography
const { TextArea } = Input

const api = () => {
  if (typeof window === 'undefined' || !window.agentWeave) {
    throw new Error('preload 未注入')
  }
  return window.agentWeave
}

function randomId() {
  return `m-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function App() {
  const { message: msgApi, modal: modalApi } = AntdApp.useApp()
  const [workspace, setWorkspace] = useState('')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [form] = Form.useForm<AppSettings>()
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')

  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({})
  const [timeline, setTimeline] = useState<Record<string, ToolTimelineEvent[]>>({})
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [queued, setQueued] = useState<Record<string, number | undefined>>({})

  const streamBuf = useRef<Record<string, string>>({})
  const assistantMsgId = useRef<Record<string, string | null>>({})

  const load = useCallback(async () => {
    const [w, s, sList] = await Promise.all([api().getWorkspace(), api().getSettings(), api().listSessions()])
    setWorkspace(w)
    setSettings(s)
    setSessions(sList)
    setActiveId((prev) => (prev == null && sList.length > 0 ? sList[0]!.id : prev))
  }, [])

  const handleStream = useCallback((e: StreamEvent) => {
    if (e.type === 'run-start') {
      setRunning((r) => ({ ...r, [e.sessionId]: true }))
      setQueued((q) => ({ ...q, [e.sessionId]: undefined }))
      streamBuf.current[e.sessionId] = ''
      const aid = randomId()
      assistantMsgId.current[e.sessionId] = aid
      setMessages((m) => {
        const cur = m[e.sessionId] ?? []
        return {
          ...m,
          [e.sessionId]: [...cur, { id: aid, role: 'assistant' as const, content: '' }]
        }
      })
      setTimeline((t) => ({ ...t, [e.sessionId]: [] }))
      return
    }
    if (e.type === 'queued') {
      setQueued((q) => ({ ...q, [e.sessionId]: e.position }))
      return
    }
    if (e.type === 'text-delta') {
      streamBuf.current[e.sessionId] = (streamBuf.current[e.sessionId] ?? '') + e.text
      const buf = streamBuf.current[e.sessionId]!
      const amId = assistantMsgId.current[e.sessionId]
      if (!amId) return
      setMessages((m) => {
        const cur = [...(m[e.sessionId] ?? [])]
        const idx = cur.findIndex((c) => c.id === amId)
        if (idx < 0) return m
        const next = { ...cur[idx]!, content: buf }
        cur[idx] = next
        return { ...m, [e.sessionId]: cur }
      })
      return
    }
    if (e.type === 'tool') {
      const te = e.event
      setTimeline((t) => {
        const list = [...(t[e.sessionId] ?? [])]
        if (te.kind === 'tool') {
          const same = list.find(
            (x): x is Extract<ToolTimelineEvent, { kind: 'tool' }> => x.kind === 'tool' && x.id === te.id
          )
          if (same && te.status === 'end') {
            const next: Extract<ToolTimelineEvent, { kind: 'tool' }> = { ...te }
            return { ...t, [e.sessionId]: list.map((x) => (x.kind === 'tool' && x.id === te.id ? next : x)) }
          }
        }
        list.push(te)
        return { ...t, [e.sessionId]: list }
      })
      return
    }
    if (e.type === 'error') {
      msgApi.error(e.message)
      setRunning((r) => ({ ...r, [e.sessionId]: false }))
      return
    }
    if (e.type === 'done') {
      setRunning((r) => ({ ...r, [e.sessionId]: false }))
      setQueued((q) => ({ ...q, [e.sessionId]: undefined }))
      streamBuf.current[e.sessionId] = ''
      assistantMsgId.current[e.sessionId] = null
    }
  }, [msgApi])

  useEffect(() => {
    void load()
    const unSub = [
      api().onWorkspaceChange((p) => setWorkspace(p.path)),
      api().onSettingsSync((s) => {
        setSettings(s)
        form.setFieldsValue(s)
      }),
      api().onSessionsSync((list) => {
        setSessions(list)
        setActiveId((aid) => (aid && list.some((x) => x.id === aid) ? aid : list[0]?.id ?? null))
      }),
      api().onStream(handleStream)
    ]
    return () => unSub.forEach((f) => f())
  }, [form, handleStream, load])

  const pickWorkspace = async () => {
    const r = await api().selectWorkspace()
    if (r.path) {
      setWorkspace(r.path)
      msgApi.success('已选择工作区')
    }
  }

  const send = async () => {
    if (!activeId) return
    const t = input.trim()
    if (!t) return
    if (!workspace) {
      msgApi.warning('请先选择工作区')
      return
    }
    setInput('')
    setMessages((m) => {
      const cur = m[activeId] ?? []
      return {
        ...m,
        [activeId]: [...cur, { id: randomId(), role: 'user' as const, content: t }]
      }
    })
    const r = await api().sendAgentMessage(activeId, t)
    if (!r.ok) {
      msgApi.error('发送失败: ' + r.error)
    }
  }

  const openSettings = () => {
    if (settings) {
      form.setFieldsValue(settings)
    }
    setSettingsOpen(true)
  }

  const saveSettings = async () => {
    const v = await form.validateFields()
    await api().setSettings(v)
    setSettingsOpen(false)
    msgApi.success('已保存（Secret 仅保存在本机主进程）')
  }

  const currentMessages = useMemo(
    () => (activeId ? messages[activeId] ?? [] : []),
    [activeId, messages]
  )
  const currentTimeline = useMemo(
    () => (activeId ? timeline[activeId] ?? [] : []),
    [activeId, timeline]
  )
  const isRun = activeId ? running[activeId] : false
  const isQueued = activeId ? queued[activeId] : undefined

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={240} theme="dark" style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text strong style={{ color: 'rgba(255,255,255,0.85)' }}>AgentWeave</Text>
          <Button type="text" icon={<SettingOutlined />} onClick={openSettings} style={{ color: '#fff' }} />
        </div>
        <div style={{ padding: '0 8px' }}>
          <Button block type="dashed" icon={<PlusOutlined />} onClick={async () => { const s = await api().createSession(); setActiveId(s.id) }}>
            新会话
          </Button>
        </div>
        <List
          style={{ flex: 1, overflow: 'auto', marginTop: 8 }}
          dataSource={sessions}
          renderItem={(s) => (
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'rename',
                    label: '重命名',
                    onClick: () => {
                      setRenameId(s.id)
                      setRenameName(s.name)
                    }
                  },
                  {
                    key: 'del',
                    danger: true,
                    label: '删除',
                    onClick: () => {
                      modalApi.confirm({
                        title: '删除此会话？',
                        onOk: () => {
                          void api()
                            .deleteSession(s.id)
                            .then(() => msgApi.success('已删除'))
                        }
                      })
                    }
                  }
                ]
              }}
              trigger={['contextMenu']}
            >
              <List.Item
                style={{ cursor: 'pointer', background: s.id === activeId ? 'rgba(255,255,255,0.12)' : 'transparent' }}
                onClick={() => setActiveId(s.id)}
              >
                <List.Item.Meta title={s.name} description={new Date(s.updatedAt).toLocaleString('zh-CN')} />
              </List.Item>
            </Dropdown>
          )}
        />
        <div style={{ padding: 8, color: 'rgba(255,255,255,0.45)', fontSize: 11, wordBreak: 'break-all' }}>
          工作区: {workspace || '未选'}
        </div>
        <div style={{ padding: 8 }}>
          <Button block icon={<FolderOpenOutlined />} onClick={pickWorkspace}>
            选择工作区
          </Button>
        </div>
      </Sider>
      <Layout>
        <Header style={{ background: '#141414', display: 'flex', alignItems: 'center', paddingLeft: 16, borderBottom: '1px solid #303030' }}>
          {activeId && (
            <Space>
              <Text type="secondary">会话</Text>
              <Text>{sessions.find((s) => s.id === activeId)?.name}</Text>
              {isRun && <Tag color="processing">执行中</Tag>}
              {isQueued && isQueued > 0 && <Tag color="warning">排队 #{isQueued}</Tag>}
            </Space>
          )}
        </Header>
        <Content style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
            {currentMessages.map((m) => (
              <Card key={m.id} size="small" style={{ marginBottom: 8, background: m.role === 'user' ? '#1f1f1f' : '#111' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{m.role === 'user' ? '你' : '助理'}</Text>
                <Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{m.content || (m.role === 'assistant' && isRun ? '…' : '')}</Paragraph>
              </Card>
            ))}
            {!currentMessages.length && <Text type="secondary">发一条消息开始；务必先选择工作区并配置 API Key。</Text>}
          </div>
          {activeId && (
            <div style={{ borderTop: '1px solid #303030' }}>
              <Collapse items={[
                { key: 't', label: '工具 / 时间线', children: (
                  <List
                    size="small"
                    dataSource={currentTimeline}
                    renderItem={(e) => (
                      <List.Item>
                        {e.kind === 'error' ? (
                          <Text type="danger">{e.message}</Text>
                        ) : (
                          <>
                            <Text code>
                              {e.name} {e.status === 'start' ? '…' : '✓'}
                            </Text>
                            {e.args && <Text type="secondary"> {e.args}</Text>}
                            {e.status === 'end' && e.result && (
                              <pre style={{ fontSize: 11, maxHeight: 120, overflow: 'auto' }}>{e.result}</pre>
                            )}
                          </>
                        )}
                      </List.Item>
                    )}
                  />
                ) }
              ]} />
            </div>
          )}
          <div style={{ padding: 12, display: 'flex', gap: 8 }}>
            <TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoSize={{ minRows: 1, maxRows: 6 }}
              placeholder="输入消息… (Enter 发送，Shift+Enter 换行)"
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <Button type="primary" icon={<SendOutlined />} onClick={() => void send()} disabled={!activeId}>
                发送
              </Button>
              {activeId && (
                <Button danger icon={<StopOutlined />} onClick={() => void api().cancelAgent(activeId)} disabled={!isRun}>
                  停止
                </Button>
              )}
            </div>
          </div>
        </Content>
      </Layout>

      <Modal
        title="设置（模型与密钥）"
        open={settingsOpen}
        onOk={() => void saveSettings()}
        onCancel={() => setSettingsOpen(false)}
        width={520}
        destroyOnHidden
      >
        {settings && (
          <Form form={form} layout="vertical" initialValues={settings}>
            <Form.Item name="provider" label="提供方" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'openai-compatible', label: 'OpenAI 兼容 API' },
                  { value: 'openai', label: 'OpenAI' },
                  { value: 'anthropic', label: 'Anthropic' }
                ]}
              />
            </Form.Item>
            <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true }]}>
              <Input placeholder="如 https://api.openai.com/v1" />
            </Form.Item>
            <Form.Item name="model" label="Model" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="apiKey" label="API Key" rules={[{ required: true }]} hasFeedback>
              <Input.Password autoComplete="off" placeholder="仅保存在本机" />
            </Form.Item>
            <Form.Item name="maxConcurrentStreams" label="最大并行流">
              <InputNumber min={1} max={8} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="streamFlushMs" label="流式合并间隔 (ms)">
              <InputNumber min={8} max={200} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="streamFlushChars" label="流式合并字符数">
              <InputNumber min={32} max={2000} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="maxTerminalOutputChars" label="终端输出最大字符">
              <InputNumber min={2000} max={200000} style={{ width: '100%' }} />
            </Form.Item>
          </Form>
        )}
      </Modal>

      <Modal
        title="重命名会话"
        open={!!renameId}
        onOk={() => {
          const v = renameName.trim()
          if (renameId && v) {
            void api()
              .renameSession(renameId, v)
              .then(() => {
                msgApi.success('已重命名')
                setRenameId(null)
              })
          }
        }}
        onCancel={() => setRenameId(null)}
        okText="保存"
        destroyOnHidden
      >
        <Input value={renameName} onChange={(e) => setRenameName(e.target.value)} placeholder="名称" />
      </Modal>
    </Layout>
  )
}
