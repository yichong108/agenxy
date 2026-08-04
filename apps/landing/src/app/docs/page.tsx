'use client'

import Link from 'next/link'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import 'highlight.js/styles/github-dark.css'

import introductionContent from './markdown/getting-started/introduction.md'
import installationContent from './markdown/getting-started/installation.md'
import quickStartContent from './markdown/getting-started/quick-start.md'
import mcpSupportContent from './markdown/features/mcp-support.md'
import workspaceContent from './markdown/features/workspace.md'
import agentConfigContent from './markdown/configuration/agent-config.md'
import settingsContent from './markdown/configuration/settings.md'

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
        content: introductionContent
      },
      {
        id: 'installation',
        title: '安装指南',
        content: installationContent
      },
      {
        id: 'quick-start',
        title: '快速开始',
        content: quickStartContent
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
        content: mcpSupportContent
      },
      {
        id: 'workspace',
        title: 'Workspace 管理',
        content: workspaceContent
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
        content: agentConfigContent
      },
      {
        id: 'settings',
        title: '应用设置',
        content: settingsContent
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
      <header className="fixed top-0 left-0 right-0 border-b border-gray-200 bg-white z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <Link href="/" className="text-xl font-bold text-gray-900">
              Openwork
            </Link>
            <nav className="flex gap-6">
              <Link href="/" className="text-gray-600 hover:text-gray-900">
                首页
              </Link>
              <Link href="/docs" className="text-gray-900 font-medium">
                文档
              </Link>
            </nav>
          </div>
        </div>
      </header>

      <div className="fixed top-16 left-0 right-0 bottom-0 overflow-hidden">
        <div className="h-full flex">
          <aside className="w-64 flex-shrink-0 overflow-y-auto bg-white border-r border-gray-200">
            <div className="p-4">
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
            </div>
          </aside>

          <main className="flex-1 overflow-y-auto bg-white">
            <div className="max-w-4xl mx-auto px-8 py-8">
              <article className="prose prose-lg max-w-none prose-headings:font-bold prose-headings:text-gray-900 prose-h1:text-3xl prose-h2:text-2xl prose-h3:text-xl prose-h1:border-b prose-h1:border-gray-200 prose-h1:pb-4 prose-h1:mb-6 prose-h2:mt-8 prose-h2:mb-4 prose-h3:mt-6 prose-h3:mb-3 prose-p:text-gray-700 prose-p:leading-relaxed prose-p:mb-4 prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline prose-a:font-medium prose-strong:text-gray-900 prose-code:text-blue-600 prose-code:bg-blue-50 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-pre:rounded-lg prose-pre:p-4 prose-pre:overflow-x-auto prose-pre:mb-6 prose-ul:list-disc prose-ul:pl-6 prose-ul:mb-4 prose-ol:list-decimal prose-ol:pl-6 prose-ol:mb-4 prose-li:mb-2 prose-li:text-gray-700 prose-blockquote:border-l-4 prose-blockquote:border-blue-500 prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-gray-600 prose-blockquote:mb-4 prose-hr:border-gray-200 prose-hr:my-8 prose-table:mb-6 prose-th:text-left prose-th:font-semibold prose-th:text-gray-900 prose-th:border-b prose-th:border-gray-200 prose-th:pb-2 prose-th:pr-4 prose-td:border-b prose-td:border-gray-100 prose-td:py-3 prose-td:pr-4 prose-td:text-gray-700">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight, rehypeRaw]}
                >
                  {activeItemData?.content || ''}
                </ReactMarkdown>
              </article>
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
