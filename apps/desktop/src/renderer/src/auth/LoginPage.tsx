import '@/renderer/src/auth/LoginPage.scss'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { Alert, Button, Form, Input, Typography } from 'antd'
import { useState } from 'react'

import openworkerLogoUrl from '@/renderer/src/assets/openworker-logo.png'
import { useAuthStore } from '@/renderer/src/store/auth-store'

const { Title, Text } = Typography

type LoginFormValues = {
  username: string
  password: string
}

/**
 * 桌面端登录页
 *
 * 账号密码表单；提交后由 auth-store 直连后端 API，成功后进入主工作区。
 */
export function LoginPage() {
  const login = useAuthStore((s) => s.login)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const handleFinish = async (values: LoginFormValues) => {
    setFormError(null)
    setSubmitting(true)
    try {
      await login(values.username.trim(), values.password)
    } catch (error) {
      const text = error instanceof Error ? error.message : '登录失败'
      setFormError(text)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-page-panel">
        <div className="login-page-brand">
          <img
            src={openworkerLogoUrl}
            alt=""
            width={28}
            height={28}
            className="login-page-logo"
            draggable={false}
          />
          <Title level={3} className="login-page-title">
            OpenWorker
          </Title>
          <Text type="secondary" className="login-page-subtitle">
            使用账号密码登录
          </Text>
        </div>

        {formError ? (
          <Alert
            type="error"
            showIcon
            message={formError}
            className="login-page-alert"
            closable
            onClose={() => setFormError(null)}
          />
        ) : null}

        <Form<LoginFormValues>
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => void handleFinish(values)}
          initialValues={{ username: '', password: '' }}
          className="login-page-form"
          size="large"
        >
          <Form.Item
            name="username"
            label="账号"
            rules={[{ required: true, message: '请输入账号' }]}
          >
            <Input prefix={<UserOutlined />} placeholder="账号" autoComplete="username" autoFocus />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="密码"
              autoComplete="current-password"
            />
          </Form.Item>
          <Form.Item className="login-page-submit">
            <Button type="primary" htmlType="submit" block loading={submitting}>
              登录
            </Button>
          </Form.Item>
        </Form>
      </div>
    </div>
  )
}
