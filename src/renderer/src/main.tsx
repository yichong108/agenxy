import { App as AntApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import dayjs from 'dayjs'
import React from 'react'
import ReactDOM from 'react-dom/client'
import 'antd/dist/reset.css'
import '@/renderer/src/assets/reset.scss'

import 'dayjs/locale/zh-cn'
import { App } from '@/renderer/src/App'
import { renderLog } from '@/renderer/src/logger' // 初始化渲染端 electron-log（IPC → 主进程落盘）

dayjs.locale('zh-cn')

type AppErrorBoundaryState = {
  error: Error | null
}

class AppErrorBoundary extends React.Component<React.PropsWithChildren, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    renderLog.error('[renderer] React 渲染异常:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16, color: '#fff', background: '#141414', height: '100%' }}>
          <h3 style={{ marginTop: 0 }}>渲染异常（已阻止白屏）</h3>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.error.message}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

const root = document.getElementById('root')
if (root) {
  document.body.style.margin = '0'
  document.body.style.overflow = 'hidden'
  root.style.height = '100%'

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ConfigProvider
        locale={zhCN}
        theme={{
          token: {
            colorPrimary: '#0d9488',
            colorInfo: '#0d9488',
            colorSuccess: '#059669',
            colorWarning: '#d97706',
            colorError: '#dc2626',
            colorText: '#18181b',
            /* 略浅：侧栏/工具条等图标与次要文案更柔和 */
            colorTextSecondary: '#52525b',
            colorTextTertiary: '#5f5f6b',
            colorBorder: 'rgba(24, 24, 27, 0.09)',
            colorSplit: 'rgba(24, 24, 27, 0.055)',
            borderRadius: 12,
            borderRadiusSM: 10,
            borderRadiusLG: 14,
            wireframe: false,
            fontSize: 13,
            fontFamily:
              "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
            controlHeight: 36
          },
          components: {
            Button: {
              controlHeight: 36,
              borderRadius: 10,
              fontWeight: 500,
              primaryShadow: '0 1px 2px rgb(24 24 27 / 0.06)'
            },
            Card: {
              borderRadiusLG: 14
            },
            Input: {
              borderRadius: 10
            },
            Select: {
              borderRadius: 10
            },
            Modal: {
              borderRadiusLG: 16
            },
            Table: {
              borderRadius: 12,
              headerBg: '#f4f4f5'
            },
            Tabs: {
              itemColor: '#5f5f6b',
              itemSelectedColor: '#18181b',
              inkBarColor: '#0d9488'
            },
            Tag: {
              borderRadiusSM: 8
            }
          }
        }}
      >
        <AppErrorBoundary>
          <AntApp>
            <App />
          </AntApp>
        </AppErrorBoundary>
      </ConfigProvider>
    </React.StrictMode>
  )
}
