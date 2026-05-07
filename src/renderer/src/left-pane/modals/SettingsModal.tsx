import { App as AntdApp, Form, Input, Modal, Select, Switch } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  applySettingsForm,
  defaultProviderProfiles,
  defaultSettings,
  mergeFormIntoProviderProfiles,
  settingsToFormValues,
  type AppSettings,
  type ModelProviderId,
  type ProviderProfile,
  type SettingsFormValues
} from '@/shared/ipc'

const DEFAULT_SETTINGS: AppSettings = JSON.parse(JSON.stringify(defaultSettings))
const DEFAULT_FORM_VALUES: SettingsFormValues = settingsToFormValues(DEFAULT_SETTINGS)

function cloneProviderProfiles(
  p: Record<ModelProviderId, ProviderProfile>
): Record<ModelProviderId, ProviderProfile> {
  return JSON.parse(JSON.stringify(p)) as Record<ModelProviderId, ProviderProfile>
}

export type SettingsModalProps = {
  open: boolean
  onClose: () => void
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { message: msgApi } = AntdApp.useApp()
  const bridge = window.bridge

  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [form] = Form.useForm<SettingsFormValues>()
  const profilesDraftRef =
    useRef<Record<ModelProviderId, ProviderProfile>>(defaultProviderProfiles())
  const settingsProviderRef = useRef<ModelProviderId>('deepseek')

  const hydrateFromSettings = useCallback(
    (s: AppSettings) => {
      setSettings(s)
      profilesDraftRef.current = cloneProviderProfiles(s.providerProfiles)
      settingsProviderRef.current = s.provider
      form.setFieldsValue(settingsToFormValues(s))
    },
    [form]
  )

  useEffect(() => {
    if (!open) return
    void bridge.getSettings().then(hydrateFromSettings)
  }, [bridge, hydrateFromSettings, open])

  useEffect(() => {
    if (!open) return
    return bridge.onSettingsSync((s) => {
      hydrateFromSettings(s)
    })
  }, [bridge, hydrateFromSettings, open])

  const onProviderChange = useCallback(
    (next: ModelProviderId) => {
      const prev = settingsProviderRef.current
      if (prev === next) return
      const cur = form.getFieldsValue(['baseUrl', 'model', 'apiKey', 'enableTools']) as Pick<
        ProviderProfile,
        'baseUrl' | 'model' | 'apiKey' | 'enableTools'
      >
      profilesDraftRef.current[prev] = {
        ...profilesDraftRef.current[prev],
        baseUrl: String(cur.baseUrl ?? ''),
        model: String(cur.model ?? ''),
        apiKey: String(cur.apiKey ?? ''),
        enableTools: prev === 'deepseek' ? true : Boolean(cur.enableTools)
      }
      settingsProviderRef.current = next
      const nextProf = profilesDraftRef.current[next]
      form.setFieldsValue({
        provider: next,
        baseUrl: nextProf.baseUrl,
        model: nextProf.model,
        apiKey: nextProf.apiKey,
        enableTools: next === 'deepseek' ? true : nextProf.enableTools
      })
    },
    [form]
  )

  const saveSettings = useCallback(async () => {
    const v = await form.validateFields()
    const nextProfiles = mergeFormIntoProviderProfiles(profilesDraftRef.current, v)
    const next = applySettingsForm(settings, v, nextProfiles)
    const saved = await bridge.setSettings(next)
    profilesDraftRef.current = cloneProviderProfiles(saved.providerProfiles)
    settingsProviderRef.current = saved.provider
    setSettings(saved)
    onClose()
    msgApi.success('已保存（Secret 仅保存在本机主进程）')
  }, [bridge, form, msgApi, onClose, settings])

  return (
    <Modal
      title="设置（模型与密钥）"
      open={open}
      onOk={() => void saveSettings()}
      onCancel={onClose}
      width={520}
      destroyOnHidden
      centered
    >
      <Form form={form} layout="vertical" initialValues={DEFAULT_FORM_VALUES}>
        <Form.Item name="provider" label="提供方" rules={[{ required: true }]}>
          <Select
            options={[
              { value: 'deepseek', label: 'DeepSeek' },
              { value: 'ollama', label: 'Ollama' }
            ]}
            onChange={(v) => onProviderChange(v as ModelProviderId)}
          />
        </Form.Item>
        <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true }]}>
          <Input placeholder="DeepSeek: https://api.deepseek.com；Ollama: http://127.0.0.1:11434" />
        </Form.Item>
        <Form.Item name="model" label="Model" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(prev, cur) => prev.provider !== cur.provider}>
          {() => {
            const provider = form.getFieldValue('provider') as ModelProviderId
            if (provider === 'ollama') return null
            return (
              <Form.Item
                name="apiKey"
                label="API Key"
                rules={[{ required: true, message: '请先填写 API Key' }]}
                hasFeedback
              >
                <Input.Password autoComplete="off" placeholder="仅保存在本机" />
              </Form.Item>
            )
          }}
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(prev, cur) => prev.provider !== cur.provider}>
          {() =>
            form.getFieldValue('provider') === 'ollama' ? (
              <Form.Item
                name="enableTools"
                label="启用工作区工具"
                valuePropName="checked"
                extra="需模型支持 Ollama/OpenAI 的 tools API（如 llama3.2、qwen2.5）。deepseek-r1 等不支持，请保持关闭以免报错。"
              >
                <Switch />
              </Form.Item>
            ) : null
          }
        </Form.Item>
        <Form.Item
          name="tavilyApiKey"
          label="Tavily API Key（联网搜索）"
          extra="选填。填写后模型可调用 web_search；注册 https://tavily.com 。也可通过环境变量 TAVILY_API_KEY 提供（不设此项时）。"
        >
          <Input.Password autoComplete="off" placeholder="留空则不启用联网搜索" />
        </Form.Item>
      </Form>
    </Modal>
  )
}
