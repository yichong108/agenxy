import {
  BugOutlined,
  PlusOutlined,
  SendOutlined,
  SettingOutlined,
  StopOutlined,
  FolderOpenOutlined
} from '@ant-design/icons'
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Form,
  FloatButton,
  Input,
  InputNumber,
  List,
  Modal,
  Select,
  Space,
  Tag,
  theme,
  Typography,
  Dropdown
} from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  defaultSettings,
  type AppSettings,
  type ChatMessage,
  type SessionInfo,
  type StreamEvent,
  type ToolTimelineEvent
} from '@shared/ipc'

import { useUiStore } from './store/ui-store'

const { Text, Paragraph } = Typography
const { TextArea } = Input

const PRELOAD_MISSING_ERROR = '未检测到 preload 注入（window.bridge 不存在）'

const DEFAULT_SETTINGS: AppSettings = JSON.parse(JSON.stringify(defaultSettings))

function randomId() {
  return `m-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

type RunStats = {
  runId?: string
  traceId?: string
  startedAt?: number
  durationMs?: number
  toolCalls: number
  toolErrors: number
  status: 'running' | 'done' | 'error'
}

export function App() {
  const { message: msgApi, modal: modalApi } = AntdApp.useApp()
  const { token } = theme.useToken()
  const preloadOk = typeof window !== 'undefined' && typeof window.bridge !== 'undefined'
  const bridge = window.bridge
  const [workspace, setWorkspace] = useState('')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const activeId = useUiStore((s) => s.activeSessionId)
  const setActiveId = useUiStore((s) => s.setActiveSessionId)
  const input = useUiStore((s) => s.inputDraft)
  const setInput = useUiStore((s) => s.setInputDraft)
  const hydrateUiStore = useUiStore((s) => s.hydrateFromMain)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [form] = Form.useForm<AppSettings>()
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const isDevEnv = import.meta.env.DEV

  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({})
  const [timeline, setTimeline] = useState<Record<string, ToolTimelineEvent[]>>({})
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [queued, setQueued] = useState<Record<string, number | undefined>>({})
  const [runStats, setRunStats] = useState<Record<string, RunStats | undefined>>({})

  const streamBuf = useRef<Record<string, string>>({})
  const assistantMsgId = useRef<Record<string, string | null>>({})

  const load = useCallback(async () => {
    const [w, s, sList] = await Promise.all([
      bridge.getWorkspace(),
      bridge.getSettings(),
      bridge.listSessions()
    ])
    setWorkspace(w)
    setSettings(s)
    form.setFieldsValue(s)
    setSessions(sList)
    const currentActiveId = useUiStore.getState().activeSessionId
    if (currentActiveId && sList.some((x) => x.id === currentActiveId)) return
    setActiveId(sList[0]?.id ?? null)
  }, [form])

  const handleStream = useCallback(
    (e: StreamEvent) => {
      console.log(e)

      if (e.type === 'run-start') {
        const startedAt = e.timestampMs ?? Date.now()
        setRunning((r) => ({ ...r, [e.sessionId]: true }))
        setQueued((q) => ({ ...q, [e.sessionId]: undefined }))
        setRunStats((s) => ({
          ...s,
          [e.sessionId]: {
            runId: e.runId,
            traceId: e.traceId,
            startedAt,
            durationMs: 0,
            toolCalls: 0,
            toolErrors: 0,
            status: 'running'
          }
        }))
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
        setRunStats((s) => {
          const cur = s[e.sessionId]
          if (!cur) return s
          const isToolStart = te.kind === 'tool' && te.status === 'start'
          const isToolError = te.kind === 'error'
          return {
            ...s,
            [e.sessionId]: {
              ...cur,
              toolCalls: cur.toolCalls + (isToolStart ? 1 : 0),
              toolErrors: cur.toolErrors + (isToolError ? 1 : 0)
            }
          }
        })
        setTimeline((t) => {
          const list = [...(t[e.sessionId] ?? [])]
          if (te.kind === 'tool') {
            const same = list.find(
              (x): x is Extract<ToolTimelineEvent, { kind: 'tool' }> =>
                x.kind === 'tool' && x.id === te.id
            )
            if (same && te.status === 'end') {
              const next: Extract<ToolTimelineEvent, { kind: 'tool' }> = { ...te }
              return {
                ...t,
                [e.sessionId]: list.map((x) => (x.kind === 'tool' && x.id === te.id ? next : x))
              }
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
        setRunStats((s) => {
          const cur = s[e.sessionId]
          if (!cur) return s
          const durationMs =
            e.durationMs ?? (cur.startedAt ? Math.max(0, Date.now() - cur.startedAt) : undefined)
          return {
            ...s,
            [e.sessionId]: { ...cur, durationMs, status: 'error' }
          }
        })
        return
      }
      if (e.type === 'done') {
        setRunning((r) => ({ ...r, [e.sessionId]: false }))
        setQueued((q) => ({ ...q, [e.sessionId]: undefined }))
        setRunStats((s) => {
          const cur = s[e.sessionId]
          if (!cur) return s
          const durationMs =
            e.durationMs ?? (cur.startedAt ? Math.max(0, Date.now() - cur.startedAt) : undefined)
          return {
            ...s,
            [e.sessionId]: { ...cur, durationMs, status: 'done' }
          }
        })
        streamBuf.current[e.sessionId] = ''
        assistantMsgId.current[e.sessionId] = null
      }
    },
    [msgApi]
  )

  useEffect(() => {
    if (!preloadOk) {
      msgApi.error(PRELOAD_MISSING_ERROR)
      return
    }
    void (async () => {
      await hydrateUiStore()
      await load()
    })()
    const unSub = [
      bridge.onWorkspaceChange((p) => setWorkspace(p.path)),
      bridge.onSettingsSync((s) => {
        setSettings(s)
        form.setFieldsValue(s)
      }),
      bridge.onSessionsSync((list) => {
        setSessions(list)
        const currentActiveId = useUiStore.getState().activeSessionId
        if (currentActiveId && list.some((x) => x.id === currentActiveId)) return
        setActiveId(list[0]?.id ?? null)
      }),
      bridge.onStream(handleStream)
    ]
    return () => unSub.forEach((f) => f())
  }, [bridge, form, handleStream, hydrateUiStore, load, msgApi, preloadOk, setActiveId])

  const pickWorkspace = async () => {
    const r = await bridge.selectWorkspace()
    if (r.path) {
      setWorkspace(r.path)
      msgApi.success('已选择工作区')
    }
  }

  // 发送当前输入消息，并立即在本地追加用户消息
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
    const r = await bridge.sendAgentMessage(activeId, t)
    if (!r.ok) {
      msgApi.error('发送失败: ' + r.error)
    }
  }

  const openSettings = () => {
    form.setFieldsValue(settings)
    setSettingsOpen(true)
  }

  const saveSettings = async () => {
    const v = await form.validateFields()
    await bridge.setSettings(v)
    setSettingsOpen(false)
    msgApi.success('已保存（Secret 仅保存在本机主进程）')
  }

  // 检查 React DevTools 是否已加载完成
  const checkDevToolsReady = (): boolean => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__
    return !!(hook && (hook.renderers?.size > 0 || hook._renderers))
  }

  const toggleDevtools = async () => {
    bridge
      .toggleDevtools()
      .then(() => {
        if (checkDevToolsReady()) {
          console.log('✅ React DevTools 已就绪')
        } else {
          console.log('[devtool]⏳ 正在等待 React DevTools 加载完成...')
        }
        window.location.reload()
      })
      .catch((err: Error) => {
        console.error('打开 DevTools 失败:', err)
      })
  }

  const currentMessages = useMemo(
    () => (activeId ? (messages[activeId] ?? []) : []),
    [activeId, messages]
  )
  const currentTimeline = useMemo(
    () => (activeId ? (timeline[activeId] ?? []) : []),
    [activeId, timeline]
  )
  const latestAssistantMessageId = useMemo(() => {
    for (let i = currentMessages.length - 1; i >= 0; i -= 1) {
      const msg = currentMessages[i]
      if (msg?.role === 'assistant') return msg.id
    }
    return null
  }, [currentMessages])
  const isRun = activeId ? running[activeId] : false
  const isQueued = activeId ? queued[activeId] : undefined
  const currentRunStats = activeId ? runStats[activeId] : undefined

  return (
    <div style={{ minHeight: '100vh', background: '#f3f6fb', display: 'flex' }}>
      <div
        style={{
          width: 260,
          background: '#f8fbff',
          borderRight: '1px solid #dbe5f0',
          boxShadow: '2px 0 12px rgba(15, 23, 42, 0.05)'
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <div
            style={{
              padding: '14px 12px 12px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              borderBottom: '1px solid #dbe5f0'
            }}
          >
            <Text strong style={{ color: '#1f2a37', letterSpacing: 0.3 }}>
              AgentWeave
            </Text>
            <Button
              type="text"
              icon={<SettingOutlined />}
              onClick={openSettings}
              style={{ color: '#52607a' }}
            />
          </div>
          <div style={{ padding: '10px 10px 0' }}>
            <Button
              block
              type="primary"
              icon={<PlusOutlined />}
              style={{ boxShadow: '0 4px 12px rgba(22, 119, 255, 0.25)' }}
              onClick={async () => {
                const s = await bridge.createSession()
                setActiveId(s.id)
              }}
            >
              新会话
            </Button>
          </div>
          <List
            style={{ flex: 1, overflow: 'auto', marginTop: 10, padding: '0 6px' }}
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
                            void bridge.deleteSession(s.id).then(() => msgApi.success('已删除'))
                          }
                        })
                      }
                    }
                  ]
                }}
                trigger={['contextMenu']}
              >
                <List.Item
                  style={{
                    cursor: 'pointer',
                    margin: '0 4px 6px',
                    borderRadius: 10,
                    paddingInline: 10,
                    background:
                      s.id === activeId ? 'rgba(22, 119, 255, 0.16)' : 'rgba(255,255,255,0.96)',
                    border:
                      s.id === activeId
                        ? '1px solid rgba(22, 119, 255, 0.42)'
                        : '1px solid #e8eef6',
                    transition: 'all .2s ease'
                  }}
                  onClick={() => setActiveId(s.id)}
                >
                  <List.Item.Meta
                    title={<Text style={{ color: '#1f2a37' }}>{s.name}</Text>}
                    description={
                      <Text style={{ color: '#73839c', fontSize: 11 }}>
                        {new Date(s.updatedAt).toLocaleString('zh-CN')}
                      </Text>
                    }
                  />
                </List.Item>
              </Dropdown>
            )}
          />
          <div
            style={{
              padding: '10px 10px 8px',
              color: '#73839c',
              fontSize: 11,
              wordBreak: 'break-all'
            }}
          >
            工作区: {workspace || '未选'}
          </div>
          <div style={{ padding: '0 10px 10px' }}>
            <Button block icon={<FolderOpenOutlined />} onClick={pickWorkspace}>
              选择工作区
            </Button>
          </div>
        </div>
      </div>
      <div style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div
          style={{
            background: 'linear-gradient(90deg, #ffffff 0%, #f8fbff 100%)',
            display: 'flex',
            alignItems: 'center',
            paddingInline: 18,
            height: 52,
            lineHeight: '52px',
            borderBottom: '1px solid #dbe5f0'
          }}
        >
          {activeId && (
            <Space>
              <Text type="secondary">会话</Text>
              <Text>{sessions.find((s) => s.id === activeId)?.name}</Text>
              {isRun && <Tag color="processing">执行中</Tag>}
              {isQueued && isQueued > 0 && <Tag color="warning">排队 #{isQueued}</Tag>}
              {currentRunStats && (
                <Text type="secondary">
                  本轮: {currentRunStats.toolCalls} 次调用 / {currentRunStats.toolErrors} 次错误 /{' '}
                  {((currentRunStats.durationMs ?? 0) / 1000).toFixed(2)}s
                </Text>
              )}
              {currentRunStats?.traceId && (
                <Tag color="default">trace: {currentRunStats.traceId.slice(-12)}</Tag>
              )}
            </Space>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            minHeight: 0,
            background: '#f7faff',
            flex: 1
          }}
        >
          {!preloadOk && (
            <div style={{ padding: '12px 16px 0 16px' }}>
              <Alert
                type="error"
                showIcon
                message="preload 注入失败"
                description="当前窗口未接收到主进程暴露的 API（window.bridge）。请重启 dev 进程后重试。"
              />
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflow: 'auto',
                padding: '14px 18px',
                background:
                  'radial-gradient(circle at 20% 0%, rgba(22,119,255,0.12) 0%, rgba(247,250,255,0) 34%), #f7faff'
              }}
            >
              {currentMessages.map((m) => (
                <Card
                  key={m.id}
                  size="small"
                  style={{
                    marginBottom: 10,
                    marginLeft: m.role === 'user' ? 'auto' : undefined,
                    maxWidth: '86%',
                    borderRadius: 12,
                    border:
                      m.role === 'user' ? '1px solid rgba(22,119,255,0.35)' : '1px solid #dbe5f0',
                    background:
                      m.role === 'user'
                        ? 'linear-gradient(135deg, rgba(230,243,255,1) 0%, rgba(242,248,255,1) 100%)'
                        : '#ffffff'
                  }}
                >
                  <Text type="secondary" style={{ fontSize: 12, color: '#73839c' }}>
                    {m.role === 'user' ? '你' : '助理'}
                  </Text>
                  <Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap', color: '#1f2a37' }}>
                    {m.content || (m.role === 'assistant' && isRun ? '…' : '')}
                  </Paragraph>
                  {m.role === 'assistant' &&
                    m.id === latestAssistantMessageId &&
                    currentTimeline.length > 0 && (
                      <div
                        style={{
                          marginTop: 10,
                          borderTop: '1px solid #dbe5f0',
                          paddingTop: 8
                        }}
                      >
                        {currentTimeline.map((e, idx) => (
                          <div
                            key={`${e.kind}-${'id' in e ? e.id : idx}-${idx}`}
                            style={{ marginBottom: 8 }}
                          >
                            {e.kind === 'error' ? (
                              <Text type="danger">{e.message}</Text>
                            ) : (
                              <>
                                <Text code>
                                  {e.name} {e.status === 'start' ? '…' : '✓'}
                                </Text>
                                {e.args && <Text type="secondary"> {e.args}</Text>}
                                {e.status === 'end' && e.result && (
                                  <pre
                                    style={{
                                      fontSize: 11,
                                      maxHeight: 120,
                                      overflow: 'auto',
                                      marginTop: 8,
                                      marginBottom: 0,
                                      padding: 8,
                                      borderRadius: 8,
                                      background: '#f5f9ff',
                                      border: '1px solid #dbe5f0'
                                    }}
                                  >
                                    {e.result}
                                  </pre>
                                )}
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                </Card>
              ))}
              {!currentMessages.length && (
                <Card
                  size="small"
                  style={{
                    maxWidth: 520,
                    marginTop: 4,
                    background: '#ffffff',
                    border: '1px solid #dbe5f0',
                    borderRadius: 12
                  }}
                >
                  <Text type="secondary" style={{ color: '#73839c' }}>
                    发一条消息开始；务必先选择工作区并配置 API Key。
                  </Text>
                </Card>
              )}
            </div>
          </div>
          <div
            style={{
              padding: 12,
              display: 'flex',
              gap: 10,
              background: '#ffffff',
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              flexShrink: 0
            }}
          >
            <TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoSize={{ minRows: 1, maxRows: 6 }}
              placeholder="输入消息… (Enter 发送，Shift+Enter 换行)"
              style={{
                background: '#f8fbff',
                borderColor: '#dbe5f0',
                borderRadius: 10
              }}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <Button
                type="primary"
                icon={<SendOutlined />}
                onClick={() => void send()}
                disabled={!activeId}
                style={{ height: 36 }}
              >
                发送
              </Button>
              {activeId && (
                <Button
                  danger
                  icon={<StopOutlined />}
                  onClick={() => void bridge.cancelAgent(activeId)}
                  disabled={!isRun}
                  style={{ height: 34 }}
                >
                  停止
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      <Modal
        title="设置（模型与密钥）"
        open={settingsOpen}
        onOk={() => void saveSettings()}
        onCancel={() => setSettingsOpen(false)}
        width={520}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" initialValues={DEFAULT_SETTINGS}>
          <Form.Item name="provider" label="提供方" rules={[{ required: true }]}>
            <Select options={[{ value: 'deepseek', label: 'DeepSeek' }]} />
          </Form.Item>
          <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true }]}>
            <Input placeholder="如 https://api.deepseek.com/v1" />
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
            <InputNumber min={1} max={1000} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="重命名会话"
        open={!!renameId}
        onOk={() => {
          const v = renameName.trim()
          if (renameId && v) {
            void bridge.renameSession(renameId, v).then(() => {
              msgApi.success('已重命名')
              setRenameId(null)
            })
          }
        }}
        onCancel={() => setRenameId(null)}
        okText="保存"
        destroyOnHidden
      >
        <Input
          value={renameName}
          onChange={(e) => setRenameName(e.target.value)}
          placeholder="名称"
        />
      </Modal>

      {isDevEnv && (
        <FloatButton
          icon={<BugOutlined />}
          tooltip="切换 DevTools"
          onClick={() => void toggleDevtools()}
          style={{ right: 24, bottom: 24 }}
        />
      )}
    </div>
  )
}
