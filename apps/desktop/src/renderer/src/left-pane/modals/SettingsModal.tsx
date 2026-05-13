import { App as AntdApp, Form, Input, Modal, Typography } from 'antd'
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

function cloneProviderProfiles(
  p: Record<ModelProviderId, ProviderProfile>
): Record<ModelProviderId, ProviderProfile> {
  return JSON.parse(JSON.stringify(p)) as Record<ModelProviderId, ProviderProfile>
}

const DEFAULT_SETTINGS: AppSettings = JSON.parse(JSON.stringify(defaultSettings))
const DEFAULT_FORM_VALUES: SettingsFormValues = settingsToFormValues(DEFAULT_SETTINGS)

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

  const hydrateFromSettings = useCallback(
    (s: AppSettings) => {
      setSettings(s)
      profilesDraftRef.current = cloneProviderProfiles(s.providerProfiles)
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

  const saveSettings = useCallback(async () => {
    const v = await form.validateFields()
    const nextProfiles = mergeFormIntoProviderProfiles(profilesDraftRef.current, v)
    const next = applySettingsForm(settings, v, nextProfiles)
    const saved = await bridge.setSettings(next)
    profilesDraftRef.current = cloneProviderProfiles(saved.providerProfiles)
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
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16, marginTop: 0 }}>
          仅支持接入兼容 OpenAI API 标准格式的模型服务。
        </Typography.Paragraph>
        <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true }]}>
          <Input placeholder="https://api.deepseek.com" />
        </Form.Item>
        <Form.Item name="model" label="Model" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item
          name="apiKey"
          label="API Key"
          rules={[{ required: true, message: '请先填写 API Key' }]}
          hasFeedback
        >
          <Input.Password autoComplete="off" placeholder="仅保存在本机" />
        </Form.Item>
        <Form.Item
          name="tavilyApiKey"
          label="Tavily API Key（联网搜索）"
          extra="填写后模型可调用 web_search，注册 https://tavily.com 获取Tavily API Key。"
        >
          <Input.Password autoComplete="off" placeholder="留空则不启用联网搜索" />
        </Form.Item>
      </Form>
    </Modal>
  )
}
