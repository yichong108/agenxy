import { CodeOutlined, FileOutlined } from '@ant-design/icons'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { App as AntdApp, Button, Spin, Tag, Tree, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { WorkspaceFileNode } from '@/shared/ipc'

import '@/renderer/src/right-pane/WorkspaceRightPane.scss'
import '@xterm/xterm/css/xterm.css'

const { Text } = Typography

type FileTreeDataNode = {
  key: string
  title: string
  isLeaf?: boolean
  children?: FileTreeDataNode[]
}

function toAntdFileTree(nodes: WorkspaceFileNode[]): FileTreeDataNode[] {
  return nodes.map((node) => ({
    key: node.path,
    title: node.name,
    isLeaf: node.kind === 'file',
    children: node.kind === 'directory' ? toAntdFileTree(node.children ?? []) : undefined
  }))
}

function longestCommonPrefix(values: string[]): string {
  if (!values.length) return ''
  let prefix = values[0] ?? ''
  for (let i = 1; i < values.length; i += 1) {
    const current = values[i] ?? ''
    let j = 0
    while (j < prefix.length && j < current.length && prefix[j] === current[j]) j += 1
    prefix = prefix.slice(0, j)
    if (!prefix) return ''
  }
  return prefix
}

type WorkspaceRightPaneProps = {
  bridge: Window['bridge']
  activeWorkspaceId: string | null
  activeWorkspacePath: string | null
  width: number
}

export function WorkspaceRightPane(props: WorkspaceRightPaneProps) {
  const { bridge, activeWorkspaceId, activeWorkspacePath, width } = props
  const { message: msgApi } = AntdApp.useApp()
  const [activePanel, setActivePanel] = useState<'file' | 'terminal'>('file')
  const [fileTreeLoading, setFileTreeLoading] = useState(false)
  const [fileTree, setFileTree] = useState<WorkspaceFileNode[]>([])
  const [fileTreeExpandedKeys, setFileTreeExpandedKeys] = useState<string[]>([])
  const [filePreviewPath, setFilePreviewPath] = useState('')
  const [filePreviewContent, setFilePreviewContent] = useState('')
  const [filePreviewLoading, setFilePreviewLoading] = useState(false)
  const [filePreviewTruncated, setFilePreviewTruncated] = useState(false)
  const [filePreviewError, setFilePreviewError] = useState('')
  const fileTreeData = useMemo(() => toAntdFileTree(fileTree), [fileTree])
  const terminalPromptPrefix = useMemo(
    () => `PS ${activeWorkspacePath || '[未绑定工作区]'}>`,
    [activeWorkspacePath]
  )
  const terminalContainerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const terminalFitAddonRef = useRef<FitAddon | null>(null)
  const terminalInputBufferRef = useRef('')
  const terminalRunningRef = useRef(false)
  const terminalPromptPrefixRef = useRef(terminalPromptPrefix)
  const terminalHistoryRef = useRef<string[]>([])
  const terminalHistoryIndexRef = useRef<number | null>(null)
  const terminalHistoryDraftRef = useRef('')

  const writeTerminalPrompt = useCallback((term: Terminal) => {
    term.write(`\x1b[38;2;102;102;102m${terminalPromptPrefixRef.current}\x1b[0m `)
  }, [])

  const replaceTerminalInputLine = useCallback((term: Terminal, nextValue: string) => {
    const current = terminalInputBufferRef.current
    if (current.length > 0) {
      term.write('\b \b'.repeat(current.length))
    }
    terminalInputBufferRef.current = nextValue
    if (nextValue) term.write(nextValue)
  }, [])

  const navigateTerminalHistory = useCallback(
    (term: Terminal, direction: 'up' | 'down') => {
      const history = terminalHistoryRef.current
      if (history.length === 0) return
      const currentIndex = terminalHistoryIndexRef.current
      if (direction === 'up') {
        if (currentIndex === null) {
          terminalHistoryDraftRef.current = terminalInputBufferRef.current
          const nextIndex = history.length - 1
          terminalHistoryIndexRef.current = nextIndex
          replaceTerminalInputLine(term, history[nextIndex] ?? '')
          return
        }
        const nextIndex = Math.max(0, currentIndex - 1)
        terminalHistoryIndexRef.current = nextIndex
        replaceTerminalInputLine(term, history[nextIndex] ?? '')
        return
      }
      if (currentIndex === null) return
      if (currentIndex >= history.length - 1) {
        terminalHistoryIndexRef.current = null
        replaceTerminalInputLine(term, terminalHistoryDraftRef.current)
        return
      }
      const nextIndex = currentIndex + 1
      terminalHistoryIndexRef.current = nextIndex
      replaceTerminalInputLine(term, history[nextIndex] ?? '')
    },
    [replaceTerminalInputLine]
  )

  const completeTerminalInput = useCallback(async () => {
    const term = terminalRef.current
    if (!term || terminalRunningRef.current) return
    if (!activeWorkspaceId) return
    const currentInput = terminalInputBufferRef.current
    const { items } = await bridge.completeTerminalCommand(activeWorkspaceId, currentInput)
    if (!items.length) return
    if (items.length === 1) {
      const only = items[0] ?? ''
      const completed = /\/$/.test(only) ? only : `${only} `
      replaceTerminalInputLine(term, completed)
      return
    }
    const common = longestCommonPrefix(items)
    if (common && common.length > currentInput.length) {
      replaceTerminalInputLine(term, common)
      return
    }
    term.write('\r\n')
    term.write(`${items.join('    ')}\r\n`)
    writeTerminalPrompt(term)
    term.write(currentInput)
  }, [activeWorkspaceId, bridge, replaceTerminalInputLine, writeTerminalPrompt])

  const loadWorkspaceTree = useCallback(async () => {
    if (!activeWorkspacePath) {
      setFileTree([])
      setFileTreeExpandedKeys([])
      return
    }
    setFileTreeLoading(true)
    try {
      const payload = await bridge.getWorkspaceFileTree()
      setFileTree(payload.nodes)
      setFileTreeExpandedKeys(payload.nodes.slice(0, 8).map((node) => node.path))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      msgApi.error(`读取文件树失败：${msg}`)
    } finally {
      setFileTreeLoading(false)
    }
  }, [activeWorkspacePath, bridge, msgApi])

  const previewWorkspaceFile = useCallback(
    async (relPath: string) => {
      setFilePreviewLoading(true)
      setFilePreviewError('')
      try {
        const result = await bridge.readWorkspaceFile(relPath)
        if (!result.ok) {
          setFilePreviewPath(relPath)
          setFilePreviewContent('')
          setFilePreviewTruncated(false)
          setFilePreviewError(result.error)
          return
        }
        setFilePreviewPath(result.path)
        setFilePreviewContent(result.content)
        setFilePreviewTruncated(result.truncated)
      } finally {
        setFilePreviewLoading(false)
      }
    },
    [bridge]
  )

  const runTerminalCommand = useCallback(
    async (commandText: string) => {
      const term = terminalRef.current
      if (!term) return
      const command = commandText.trim()
      if (!command) {
        term.write('\r\n')
        writeTerminalPrompt(term)
        return
      }
      const history = terminalHistoryRef.current
      if (history[history.length - 1] !== command) {
        history.push(command)
      }
      terminalHistoryIndexRef.current = null
      terminalHistoryDraftRef.current = ''
      if (!activeWorkspaceId || !activeWorkspacePath) {
        term.write('\r\n当前工作区未绑定目录，无法执行命令。\r\n')
        writeTerminalPrompt(term)
        return
      }
      terminalRunningRef.current = true
      try {
        const { output } = await bridge.runTerminalCommand(activeWorkspaceId, command)
        const normalizedOutput = (output || '[无输出]').replace(/\r?\n/g, '\r\n')
        term.write('\r\n')
        term.write(normalizedOutput)
        if (!normalizedOutput.endsWith('\r\n')) {
          term.write('\r\n')
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        msgApi.error(`命令执行失败：${msg}`)
        term.write(`\r\n命令执行失败：${msg}\r\n`)
      } finally {
        terminalRunningRef.current = false
        terminalInputBufferRef.current = ''
        writeTerminalPrompt(term)
      }
    },
    [activeWorkspaceId, activeWorkspacePath, bridge, msgApi, writeTerminalPrompt]
  )

  useEffect(() => {
    if (activePanel !== 'file') return
    void loadWorkspaceTree()
  }, [activePanel, loadWorkspaceTree])

  useEffect(() => {
    setFileTree([])
    setFileTreeExpandedKeys([])
    setFilePreviewPath('')
    setFilePreviewContent('')
    setFilePreviewTruncated(false)
    setFilePreviewError('')
  }, [activeWorkspaceId])

  useEffect(() => {
    terminalPromptPrefixRef.current = terminalPromptPrefix
  }, [terminalPromptPrefix])

  useEffect(() => {
    if (activePanel !== 'terminal') return
    const container = terminalContainerRef.current
    if (!container || terminalRef.current) return
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      lineHeight: 1.5,
      fontFamily: "Consolas, 'Courier New', monospace",
      scrollback: 5000,
      theme: {
        background: '#fafafa',
        foreground: '#191919',
        cursor: '#1f1f1f',
        cursorAccent: '#fafafa',
        selectionBackground: '#d9d9d980'
      }
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()
    terminalRef.current = term
    terminalFitAddonRef.current = fitAddon
    terminalInputBufferRef.current = ''
    terminalRunningRef.current = false
    writeTerminalPrompt(term)

    const disposable = term.onData((data) => {
      const activeTerm = terminalRef.current
      if (!activeTerm) return
      if (terminalRunningRef.current) {
        if (data === '\u0003' && activeWorkspaceId) {
          void bridge.cancelTerminalCommand(activeWorkspaceId).then(() => {
            terminalRunningRef.current = false
            terminalInputBufferRef.current = ''
            activeTerm.write('^C\r\n[命令已取消]\r\n')
            writeTerminalPrompt(activeTerm)
          })
        }
        return
      }
      if (data === '\r') {
        const command = terminalInputBufferRef.current
        terminalInputBufferRef.current = ''
        void runTerminalCommand(command)
        return
      }
      if (data === '\u001b[A') {
        navigateTerminalHistory(activeTerm, 'up')
        return
      }
      if (data === '\u001b[B') {
        navigateTerminalHistory(activeTerm, 'down')
        return
      }
      if (data === '\t') {
        void completeTerminalInput()
        return
      }
      if (data === '\u007f') {
        terminalHistoryIndexRef.current = null
        if (terminalInputBufferRef.current.length > 0) {
          terminalInputBufferRef.current = terminalInputBufferRef.current.slice(0, -1)
          activeTerm.write('\b \b')
        }
        return
      }
      if (data >= ' ') {
        terminalHistoryIndexRef.current = null
        terminalInputBufferRef.current += data
        activeTerm.write(data)
      }
    })

    const resizeObserver = new ResizeObserver(() => {
      terminalFitAddonRef.current?.fit()
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      disposable.dispose()
      term.dispose()
      terminalRef.current = null
      terminalFitAddonRef.current = null
    }
  }, [
    activePanel,
    activeWorkspaceId,
    bridge,
    completeTerminalInput,
    navigateTerminalHistory,
    runTerminalCommand,
    writeTerminalPrompt
  ])

  useEffect(() => {
    if (activePanel !== 'terminal') return
    const term = terminalRef.current
    if (!term) return
    terminalInputBufferRef.current = ''
    terminalRunningRef.current = false
    terminalHistoryRef.current = []
    terminalHistoryIndexRef.current = null
    terminalHistoryDraftRef.current = ''
    term.reset()
    writeTerminalPrompt(term)
    terminalFitAddonRef.current?.fit()
  }, [activePanel, activeWorkspaceId, writeTerminalPrompt])

  return (
    <aside className="app-right-pane" style={{ width: `${width}px` }}>
      <div className="app-right-toolbar">
        <Button
          size="small"
          icon={<FileOutlined />}
          type={activePanel === 'file' ? 'primary' : 'default'}
          onClick={() => setActivePanel('file')}
        >
          文件
        </Button>
        <Button
          size="small"
          icon={<CodeOutlined />}
          type={activePanel === 'terminal' ? 'primary' : 'default'}
          onClick={() => setActivePanel('terminal')}
        >
          控制台终端
        </Button>
      </div>
      <div className="app-right-content">
        {activePanel === 'file' ? (
          <>
            <div className="app-right-tree-panel">
              <div className="app-right-tree-wrap">
                {fileTreeLoading ? (
                  <div className="app-right-tree-loading">
                    <Spin size="small" />
                    <Text type="secondary">正在加载文件树...</Text>
                  </div>
                ) : fileTreeData.length ? (
                  <Tree
                    showLine
                    className="app-right-tree"
                    treeData={fileTreeData}
                    expandedKeys={fileTreeExpandedKeys}
                    onExpand={(keys) => setFileTreeExpandedKeys(keys.map((x) => String(x)))}
                    onSelect={(_, info) => {
                      const relPath = String(info.node.key)
                      if (!info.node.isLeaf) return
                      void previewWorkspaceFile(relPath)
                    }}
                  />
                ) : (
                  <Text type="secondary" className="app-right-empty-tip">
                    当前工作区暂无可展示文件
                  </Text>
                )}
              </div>
            </div>
            <div className="app-right-preview-wrap">
              <div className="app-right-preview-header">
                <Text strong>{filePreviewPath || '文件内容'}</Text>
                {filePreviewTruncated ? <Tag color="warning">已截断</Tag> : null}
              </div>
              <div className="app-right-preview-body">
                {filePreviewLoading ? (
                  <div className="app-right-preview-loading">
                    <Spin size="small" />
                    <Text type="secondary">正在读取文件...</Text>
                  </div>
                ) : filePreviewError ? (
                  <Text type="danger">{filePreviewError}</Text>
                ) : filePreviewContent ? (
                  <pre className="app-right-preview-code">{filePreviewContent}</pre>
                ) : (
                  <Text type="secondary" className="app-right-empty-tip">
                    点击文件树中的文件即可预览内容
                  </Text>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="app-right-terminal-panel">
            <div ref={terminalContainerRef} className="app-right-terminal-canvas" />
          </div>
        )}
      </div>
    </aside>
  )
}
