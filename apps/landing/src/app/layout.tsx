import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Agenxy — AI Agent 桌面应用',
  description: '智能助手，本地优先，保护隐私的 AI Agent 桌面应用'
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
