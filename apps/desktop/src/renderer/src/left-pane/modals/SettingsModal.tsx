import { App as AntdApp, Form, Input, Modal, Radio, Typography } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  type AgentType,
  applySettingsForm,
  type AppSettings,
  defaultProviderProfiles,
  defaultSettings,
  mergeFormIntoProviderProfiles,
  type ModelProviderId,
  type ProviderProfile,
  type SettingsFormValues,
  settingsToFormValues
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
  const agentType = Form.useWatch('agentType', form) as AgentType | undefined

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
    // 仅校验当前可见字段；未挂载字段用已有 settings 补齐，避免 Cursor/OpenWorker 互切时 trim(undefined)
    const v = await form.validateFields()
    const merged: SettingsFormValues = {
      ...settingsToFormValues(settings),
      ...v
    }
    const nextProfiles = mergeFormIntoProviderProfiles(profilesDraftRef.current, merged)
    const next = applySettingsForm(settings, merged, nextProfiles)
    const saved = await bridge.setSettings(next)
    profilesDraftRef.current = cloneProviderProfiles(saved.providerProfiles)
    setSettings(saved)
    onClose()
    msgApi.success('已保存到 API 服务')
  }, [bridge, form, msgApi, onClose, settings])

  const isCursor = agentType === 'cursor'

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
        <Form.Item
          name="agentType"
          label="Agent 类型"
          rules={[{ required: true, message: '请选择 Agent 类型' }]}
        >
          <Radio.Group
            optionType="button"
            buttonStyle="solid"
            options={[
              { label: 'OpenWorker', value: 'openworker' },
              { label: 'Cursor', value: 'cursor' }
            ]}
          />
        </Form.Item>

        {isCursor ? (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 16, marginTop: 0 }}>
              使用 Cursor SDK（local）运行 Agent。API Key 在 Cursor Dashboard → Integrations 获取。
            </Typography.Paragraph>
            <Form.Item
              name="cursorApiKey"
              label="Cursor API Key"
              rules={[{ required: true, message: '请先填写 Cursor API Key' }]}
              hasFeedback
            >
              <Input.Password autoComplete="off" placeholder="cursor_..." />
            </Form.Item>
            <Form.Item name="cursorModel" label="Cursor 模型" rules={[{ required: true }]}>
              <Input placeholder="composer-2.5" />
            </Form.Item>
          </>
        ) : (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 16, marginTop: 0 }}>
              仅支持接入兼容 OpenAI API 标准格式的模型服务。配置由 API 服务持久化。
            </Typography.Paragraph>
            <Form.Item name="baseUrl" label="接口地址" rules={[{ required: true }]}>
              <Input placeholder="https://api.deepseek.com" />
            </Form.Item>
            <Form.Item name="model" label="模型" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item
              name="apiKey"
              label="API 密钥"
              rules={[{ required: true, message: '请先填写 API Key' }]}
              hasFeedback
            >
              <Input.Password autoComplete="off" placeholder="保存到 API 服务" />
            </Form.Item>
            <Form.Item
              name="tavilyApiKey"
              label="Tavily 密钥（联网搜索）"
              extra="填写后模型可调用 web_search，注册 https://tavily.com 获取Tavily API Key。"
            >
              <Input.Password autoComplete="off" placeholder="留空则不启用联网搜索" />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  )
}
