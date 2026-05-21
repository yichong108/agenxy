'use client'

import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import 'highlight.js/styles/github-dark.css'

interface DocSection {
  id: string
  title: string
  items: DocItem[]
}

interface DocItem {
  id: string
  title: string
  content: string
}

const docSections: DocSection[] = [
  {
    id: 'getting-started',
    title: '快速开始',
    items: [
      {
        id: 'introduction',
        title: '简介',
        content: `
# 简介

Agenxy 是一个强大的 AI Agent 桌面应用，旨在提供智能、安全、高效的 AI 助手体验。

## 主要特性

- **本地优先**: 所有数据在本地处理，保护您的隐私安全
- **智能助手**: 基于大语言模型的智能对话与任务执行
- **可扩展**: 支持 MCP 协议，可接入各种工具和服务
- **跨平台**: 支持 Windows、macOS 和 Linux

## 为什么选择 Agenxy？

Agenxy 专为需要与 AI 智能体进行复杂交互的用户设计。无论是代码编写、文档生成还是自动化任务，Agenxy 都能提供强大的支持。
        `
      },
      {
        id: 'installation',
        title: '安装指南',
        content: `
# 安装指南

## 系统要求

- **Windows**: Windows 10 或更高版本
- **macOS**: macOS 10.15 或更高版本
- **Linux**: Ubuntu 18.04 或更高版本

## 下载安装

### Windows

1. 访问官网下载 Windows 安装包
2. 双击安装包，按照提示完成安装
3. 启动 Agenxy 应用

### macOS

1. 下载 macOS 版本的应用包
2. 将应用拖拽到 Applications 文件夹
3. 右键点击应用，选择"打开"以启动

### Linux

\`\`\`bash
# 使用 AppImage
chmod +x Agenxy.AppImage
./Agenxy.AppImage

# 或使用 DEB 包
sudo dpkg -i agenxy.deb
\`\`\`

## 验证安装

启动应用后，您应该能看到欢迎界面。如果遇到问题，请查看故障排除部分。
        `
      },
      {
        id: 'quick-start',
        title: '快速开始',
        content: `
# 快速开始

## 创建您的第一个 Agent

1. **启动应用**: 打开 Agenxy 应用
2. **创建 Workspace**: 点击"新建 Workspace"按钮
3. **配置 Agent**: 选择或创建您的 AI Agent
4. **开始对话**: 在聊天窗口输入您的第一个问题

## 基础操作

### 发送消息

在聊天输入框中输入您的问题或指令，按 Enter 发送。

### 使用工具

Agent 可以调用各种工具来完成任务，包括：
- 文件操作
- 代码执行
- 网络请求
- 数据处理

### 保存对话

对话会自动保存，您可以随时查看历史记录。

## 下一步

- 了解 [配置选项](#configuration)
- 探索 [高级功能](#advanced-features)
- 查看 [API 文档](#api-reference)
        `
      }
    ]
  },
  {
    id: 'features',
    title: '功能特性',
    items: [
      {
        id: 'mcp-support',
        title: 'MCP 协议支持',
        content: `
# MCP 协议支持

Agenxy 完全支持 Model Context Protocol (MCP)，这是一个开放的标准，允许 AI Agent 与外部工具和服务进行交互。

## 什么是 MCP？

MCP (Model Context Protocol) 是一个标准化的协议，定义了 AI Agent 如何与外部系统通信。它提供了一套统一的接口，使得开发者可以轻松地为 Agent 添加新的能力。

## 配置 MCP 服务器

在 Workspace 设置中，您可以添加 MCP 服务器：

\`\`\`json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/directory"]
    }
  }
}
\`\`\`

## 可用的 MCP 服务器

- **文件系统**: 读取和写入本地文件
- **数据库**: 连接和查询数据库
- **API**: 调用外部 API 服务
- **Git**: 版本控制操作

## 开发自定义 MCP 服务器

您可以开发自己的 MCP 服务器来扩展 Agenxy 的功能。详细文档请参考 [MCP 官方文档](https://modelcontextprotocol.io)。
        `
      },
      {
        id: 'workspace',
        title: 'Workspace 管理',
        content: `
# Workspace 管理

Workspace 是 Agenxy 中的工作空间概念，每个 Workspace 可以包含多个 Agent 和对话。

## 创建 Workspace

1. 点击左侧边栏的 "+" 按钮
2. 输入 Workspace 名称
3. 选择初始配置

## Workspace 设置

每个 Workspace 都有独立的配置：

- **Agent 配置**: 定义 Agent 的行为和能力
- **MCP 服务器**: 配置可用的工具和服务
- **环境变量**: 设置运行时环境变量
- **权限管理**: 控制文件和系统访问权限

## 导入导出

您可以导出 Workspace 配置，方便分享或备份：

\`\`\`json
{
  "name": "My Workspace",
  "agents": [...],
  "mcpServers": [...],
  "settings": {...}
}
\`\`\`

## 团队协作

Workspace 配置可以通过 Git 进行版本控制，便于团队协作。
        `
      }
    ]
  },
  {
    id: 'configuration',
    title: '配置',
    items: [
      {
        id: 'agent-config',
        title: 'Agent 配置',
        content: `
# Agent 配置

Agent 是 Agenxy 的核心组件，负责处理用户请求和执行任务。

## 基础配置

\`\`\`json
{
  "name": "My Agent",
  "model": "gpt-4",
  "temperature": 0.7,
  "maxTokens": 2000,
  "systemPrompt": "You are a helpful assistant."
}
\`\`\`

## 配置选项

- **name**: Agent 显示名称
- **model**: 使用的语言模型
- **temperature**: 控制输出的随机性 (0-1)
- **maxTokens**: 最大响应长度
- **systemPrompt**: 系统提示词

## 高级配置

### 工具调用

配置 Agent 可以使用的工具：

\`\`\`json
{
  "tools": [
    {
      "name": "filesystem",
      "enabled": true,
      "permissions": ["read", "write"]
    }
  ]
}
\`\`\`

### 记忆管理

配置 Agent 的记忆能力：

\`\`\`json
{
  "memory": {
    "type": "vector",
    "maxEntries": 1000,
    "retentionDays": 30
  }
}
\`\`\`
        `
      },
      {
        id: 'settings',
        title: '应用设置',
        content: `
# 应用设置

## 界面设置

- **主题**: 浅色/深色模式
- **字体**: 调整字体大小和类型
- **语言**: 选择界面语言

## 性能设置

- **并发请求**: 同时处理的最大请求数
- **缓存大小**: 设置缓存限制
- **资源限制**: CPU 和内存使用限制

## 隐私设置

- **数据存储**: 选择数据存储位置
- **遥测**: 启用或禁用使用数据收集
- **日志**: 配置日志级别和保留策略

## 快捷键

自定义快捷键以提高效率：

| 操作 | 默认快捷键 |
|------|-----------|
| 新建对话 | Ctrl/Cmd + N |
| 搜索 | Ctrl/Cmd + K |
| 发送消息 | Enter |
| 换行 | Shift + Enter |
        `
      }
    ]
  }
]

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState('getting-started')
  const [activeItem, setActiveItem] = useState('introduction')

  const activeSectionData = docSections.find((s) => s.id === activeSection)
  const activeItemData = activeSectionData?.items.find((i) => i.id === activeItem)

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <a href="/" className="text-xl font-bold text-gray-900">
              Agenxy
            </a>
            <nav className="flex gap-6">
              <a href="/" className="text-gray-600 hover:text-gray-900">
                首页
              </a>
              <a href="/docs" className="text-gray-900 font-medium">
                文档
              </a>
            </nav>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex gap-8">
          <aside className="w-64 flex-shrink-0">
            <nav className="sticky top-8">
              {docSections.map((section) => (
                <div key={section.id} className="mb-6">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    {section.title}
                  </h3>
                  <ul className="space-y-1">
                    {section.items.map((item) => (
                      <li key={item.id}>
                        <button
                          onClick={() => {
                            setActiveSection(section.id)
                            setActiveItem(item.id)
                          }}
                          className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                            activeItem === item.id
                              ? 'bg-blue-50 text-blue-700 font-medium'
                              : 'text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          {item.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          </aside>

          <main className="flex-1 min-w-0">
            <article className="prose prose-lg max-w-none prose-headings:font-bold prose-headings:text-gray-900 prose-h1:text-3xl prose-h2:text-2xl prose-h3:text-xl prose-h1:border-b prose-h1:border-gray-200 prose-h1:pb-4 prose-h1:mb-6 prose-h2:mt-8 prose-h2:mb-4 prose-h3:mt-6 prose-h3:mb-3 prose-p:text-gray-700 prose-p:leading-relaxed prose-p:mb-4 prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline prose-a:font-medium prose-strong:text-gray-900 prose-code:text-blue-600 prose-code:bg-blue-50 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-pre:rounded-lg prose-pre:p-4 prose-pre:overflow-x-auto prose-pre:mb-6 prose-ul:list-disc prose-ul:pl-6 prose-ul:mb-4 prose-ol:list-decimal prose-ol:pl-6 prose-ol:mb-4 prose-li:mb-2 prose-li:text-gray-700 prose-blockquote:border-l-4 prose-blockquote:border-blue-500 prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-gray-600 prose-blockquote:mb-4 prose-hr:border-gray-200 prose-hr:my-8 prose-table:mb-6 prose-th:text-left prose-th:font-semibold prose-th:text-gray-900 prose-th:border-b prose-th:border-gray-200 prose-th:pb-2 prose-th:pr-4 prose-td:border-b prose-td:border-gray-100 prose-td:py-3 prose-td:pr-4 prose-td:text-gray-700">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight, rehypeRaw]}
              >
                {activeItemData?.content || ''}
              </ReactMarkdown>
            </article>
          </main>
        </div>
      </div>
    </div>
  )
}
