import { Form, Input, InputNumber, Modal, Select, Switch } from 'antd'
import type { FormInstance } from 'antd'

import type { ModelProviderId, SettingsFormValues } from '@/shared/ipc'

type SettingsModalProps = {
  open: boolean
  form: FormInstance<SettingsFormValues>
  defaultFormValues: SettingsFormValues
  onSave: () => void
  onCancel: () => void
  onProviderChange: (next: ModelProviderId) => void
}

export function SettingsModal({
  open,
  form,
  defaultFormValues,
  onSave,
  onCancel,
  onProviderChange
}: SettingsModalProps) {
  return (
    <Modal
      title="设置（模型与密钥）"
      open={open}
      onOk={onSave}
      onCancel={onCancel}
      width={520}
      destroyOnHidden
      centered
    >
      <Form form={form} layout="vertical" initialValues={defaultFormValues}>
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
