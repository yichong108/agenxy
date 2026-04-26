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
import './App.scss'

const { Text, Paragraph } = Typography
const { TextArea } = Input

const PRELOAD_MISSING_ERROR = '未检测到 preload 注入（window.bridge 不存在）'

const DEFAULT_SETTINGS: AppSettings = JSON.parse(JSON.stringify(defaultSettings))

function randomId() {
  return `m-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function appendAssistantText(list: ChatMessage[], text: string, forceNew = false): ChatMessage[] {
  const next = [...list]
  const last = next[next.length - 1]
  if (!forceNew && last?.role === 'assistant') {
    next[next.length - 1] = { ...last, content: text }
    return next
  }
  next.push({ id: randomId(), role: 'assistant', content: text })
  return next
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
  const hydratedMessageSessions = useRef<Set<string>>(new Set())

  const ensureSessionMessages = useCallback(
    async (sessionId: string, force = false) => {
      if (!sessionId) return
      if (!force && hydratedMessageSessions.current.has(sessionId)) return
      const list = await bridge.getSessionMessages(sessionId)
      setMessages((m) => ({ ...m, [sessionId]: list }))
      hydratedMessageSessions.current.add(sessionId)
    },
    [bridge]
  )

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
    const nextActiveId =
      currentActiveId && sList.some((x) => x.id === currentActiveId)
        ? currentActiveId
        : (sList[0]?.id ?? null)
    setActiveId(nextActiveId)
    if (nextActiveId) {
      await ensureSessionMessages(nextActiveId, true)
    }
  }, [ensureSessionMessages, form, setActiveId])

  const handleStream = useCallback(
    (e: StreamEvent) => {
      console.log(e)

      if (e.type === 'replace-messages') {
        setMessages((m) => ({ ...m, [e.sessionId]: e.messages }))
        hydratedMessageSessions.current.add(e.sessionId)
        return
      }
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
        setMessages((m) => {
          const cur = m[e.sessionId] ?? []
          return {
            ...m,
            [e.sessionId]: appendAssistantText(cur, `执行失败：${e.message}`)
          }
        })
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
        const validIds = new Set(list.map((x) => x.id))
        for (const id of hydratedMessageSessions.current) {
          if (!validIds.has(id)) hydratedMessageSessions.current.delete(id)
        }
        const currentActiveId = useUiStore.getState().activeSessionId
        if (currentActiveId && list.some((x) => x.id === currentActiveId)) return
        setActiveId(list[0]?.id ?? null)
      }),
      bridge.onStream(handleStream)
    ]
    return () => unSub.forEach((f) => f())
  }, [bridge, form, handleStream, hydrateUiStore, load, msgApi, preloadOk, setActiveId])

  useEffect(() => {
    if (!preloadOk || !activeId) return
    void ensureSessionMessages(activeId)
  }, [activeId, ensureSessionMessages, preloadOk])

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
      setMessages((m) => {
        const cur = m[activeId] ?? []
        return {
          ...m,
          [activeId]: appendAssistantText(cur, `发送失败：${r.error}`, true)
        }
      })
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
    <div className="app-shell">
      <div className="app-sidebar">
        <div className="app-sidebar-inner">
          <div className="app-sidebar-header">
            <Text strong className="app-brand-text">
              AgentWeave
            </Text>
            <Button
              type="text"
              icon={<SettingOutlined />}
              onClick={openSettings}
              className="app-settings-btn"
            />
          </div>
          <div className="app-new-session-wrap">
            <Button
              block
              type="primary"
              icon={<PlusOutlined />}
              className="app-new-session-btn"
              onClick={async () => {
                const s = await bridge.createSession()
                setActiveId(s.id)
              }}
            >
              新会话
            </Button>
          </div>
          <List
            className="app-session-list"
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
                  className={`app-session-item ${s.id === activeId ? 'is-active' : ''}`}
                  onClick={() => setActiveId(s.id)}
                >
                  <List.Item.Meta
                    title={<Text className="app-session-title">{s.name}</Text>}
                    description={
                      <Text className="app-session-time">
                        {new Date(s.updatedAt).toLocaleString('zh-CN')}
                      </Text>
                    }
                  />
                </List.Item>
              </Dropdown>
            )}
          />
          <div className="app-workspace-info">工作区: {workspace || '未选'}</div>
          <div className="app-workspace-btn-wrap">
            <Button block icon={<FolderOpenOutlined />} onClick={pickWorkspace}>
              选择工作区
            </Button>
          </div>
        </div>
      </div>
      <div className="app-main-pane">
        <div className="app-topbar">
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
        <div className="app-content">
          {!preloadOk && (
            <div className="app-preload-alert-wrap">
              <Alert
                type="error"
                showIcon
                message="preload 注入失败"
                description="当前窗口未接收到主进程暴露的 API（window.bridge）。请重启 dev 进程后重试。"
              />
            </div>
          )}
          <div className="app-messages-shell">
            <div className="app-messages-scroll">
              {currentMessages.map((m) => (
                <Card
                  key={m.id}
                  size="small"
                  className={`app-message-card ${m.role === 'user' ? 'is-user' : 'is-assistant'}`}
                >
                  <Text type="secondary" className="app-message-role">
                    {m.role === 'user' ? '你' : '助理'}
                  </Text>
                  <Paragraph className="app-message-content">
                    {m.content || (m.role === 'assistant' && isRun ? '…' : '')}
                  </Paragraph>
                  {m.role === 'assistant' &&
                    m.id === latestAssistantMessageId &&
                    currentTimeline.length > 0 && (
                      <div className="app-timeline-wrap">
                        {currentTimeline.map((e, idx) => (
                          <div
                            key={`${e.kind}-${'id' in e ? e.id : idx}-${idx}`}
                            className="app-timeline-item"
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
                                  <pre className="app-timeline-result">{e.result}</pre>
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
                <Card size="small" className="app-empty-card">
                  <Text type="secondary" className="app-empty-tip">
                    发一条消息开始；务必先选择工作区并配置 API Key。
                  </Text>
                </Card>
              )}
            </div>
          </div>
          <div className="app-composer">
            <TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoSize={{ minRows: 1, maxRows: 6 }}
              placeholder="输入消息… (Enter 发送，Shift+Enter 换行)"
              className="app-composer-input"
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <div className="app-composer-actions">
              <Button
                type="primary"
                icon={<SendOutlined />}
                onClick={() => void send()}
                disabled={!activeId}
                className="app-send-btn"
              >
                发送
              </Button>
              {activeId && (
                <Button
                  danger
                  icon={<StopOutlined />}
                  onClick={() => void bridge.cancelAgent(activeId)}
                  disabled={!isRun}
                  className="app-stop-btn"
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
            <InputNumber min={1} max={8} className="app-settings-number" />
          </Form.Item>
          <Form.Item name="streamFlushMs" label="流式合并间隔 (ms)">
            <InputNumber min={8} max={200} className="app-settings-number" />
          </Form.Item>
          <Form.Item name="streamFlushChars" label="流式合并字符数">
            <InputNumber min={32} max={2000} className="app-settings-number" />
          </Form.Item>
          <Form.Item name="maxTerminalOutputChars" label="终端输出最大字符">
            <InputNumber min={1} max={1000} className="app-settings-number" />
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
          className="app-devtools-float"
        />
      )}
    </div>
  )
}
