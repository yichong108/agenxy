import '@/renderer/src/right-pane/WorkspaceRightPane.scss'
import '@xterm/xterm/css/xterm.css'
import 'file-icons-js/css/style.css'
import {
  CodeOutlined,
  FileOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  MenuFoldOutlined,
  RightOutlined
} from '@ant-design/icons'
import Editor, { loader } from '@monaco-editor/react'
import githubLightThemeJson from '@monaco-themes/github-light'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { App as AntdApp, Button, Spin, Tag, Typography } from 'antd'
import { getClassWithColor } from 'file-icons-js'
import * as monaco from 'monaco-editor'
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { type NodeRendererProps, Tree } from 'react-arborist'

import { WorkspaceFileTreeContainer } from '@/renderer/src/right-pane/WorkspaceFileTreeContainer'
import { HOME_WORKSPACE_ID, type WorkspaceFileNode } from '@/shared/ipc'

const { Text } = Typography
loader.config({ monaco })
const GITHUB_LIGHT_THEME_NAME = 'github-light'

/** 新版：存文件树列像素宽度，避免拖拽「聊天区—右侧栏」外部分割条时树列随总宽按比例变宽/变窄 */
const FILE_TREE_WIDTH_STORAGE_KEY = 'aw.fileTreeWidthPx'
/** 旧版比例（仅用于一次性迁移到像素） */
const FILE_TREE_SPLIT_FRACTION_LEGACY_KEY = 'aw.fileTreeSplitFraction'
const FILE_TREE_SPLITTER_PX = 3
const FILE_TREE_MIN_TREE_PX = 200
const FILE_TREE_MIN_PREVIEW_PX = 200
const FILE_TREE_DEFAULT_WIDTH_PX = 236

function readStoredTreeWidthPx(): number {
  try {
    const raw = localStorage.getItem(FILE_TREE_WIDTH_STORAGE_KEY)
    if (!raw) return FILE_TREE_DEFAULT_WIDTH_PX
    const n = Number(raw)
    if (!Number.isFinite(n)) return FILE_TREE_DEFAULT_WIDTH_PX
    return Math.max(FILE_TREE_MIN_TREE_PX, n)
  } catch {
    return FILE_TREE_DEFAULT_WIDTH_PX
  }
}

function isTerminalEnter(data: string): boolean {
  return data === '\r' || data === '\n' || data === '\r\n'
}

function isTerminalCtrlC(data: string): boolean {
  return data === '\u0003' || data.includes('\u0003')
}

/** 关闭 PTY/子进程可能开启的鼠标追踪，避免拖选被当作鼠标上报 */
const TERMINAL_MOUSE_TRACKING_OFF = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l'

function resetTerminalMouseTracking(term: Terminal): void {
  term.write(TERMINAL_MOUSE_TRACKING_OFF)
}

/** 粘贴进当前输入行：换行压成空格，去掉不可见控制符 */
function writeTerminalStreamChunk(term: Terminal, chunk: string): void {
  if (!chunk) return
  term.write(chunk.replace(/\r?\n/g, '\r\n'))
}

function normalizePastedTerminalText(raw: string): string {
  return (
    raw
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  )
}

function clampTreeWidthPx(treePx: number, contentWidth: number): number {
  if (!(contentWidth > 0)) return treePx
  const maxW = contentWidth - FILE_TREE_SPLITTER_PX - FILE_TREE_MIN_PREVIEW_PX
  if (maxW < FILE_TREE_MIN_TREE_PX) return treePx
  return Math.min(maxW, Math.max(FILE_TREE_MIN_TREE_PX, treePx))
}

/** `clientHeight` 含 padding；虚拟列表高度需为内容区高度，否则会与 padding 叠出多余滚动条。 */
function readTreeViewportHeight(el: HTMLElement): number {
  const style = getComputedStyle(el)
  const pt = Number.parseFloat(style.paddingTop) || 0
  const pb = Number.parseFloat(style.paddingBottom) || 0
  return Math.max(0, el.clientHeight - pt - pb)
}

type FileTreeDataNode = {
  id: string
  name: string
  kind: WorkspaceFileNode['kind']
  children?: FileTreeDataNode[]
}

function renderNodeTitle(
  name: string,
  kind: WorkspaceFileNode['kind'],
  isOpen?: boolean
): ReactNode {
  if (kind === 'directory') {
    return (
      <span className="app-right-tree-title">
        {isOpen ? (
          <FolderOpenOutlined className="app-right-tree-title-icon app-right-tree-folder-icon" />
        ) : (
          <FolderOutlined className="app-right-tree-title-icon app-right-tree-folder-icon" />
        )}
        <span className="app-right-tree-title-text">{name}</span>
      </span>
    )
  }

  const atomIconClass = getClassWithColor(name) ?? 'text-icon medium-blue'

  return (
    <span className="app-right-tree-title">
      <span className={`app-right-tree-atom-icon icon ${atomIconClass}`} aria-hidden />
      <span className="app-right-tree-title-text">{name}</span>
    </span>
  )
}

function toAntdFileTree(nodes: WorkspaceFileNode[]): FileTreeDataNode[] {
  return nodes.map((node) => ({
    id: node.path,
    name: node.name,
    kind: node.kind,
    children: node.kind === 'directory' ? toAntdFileTree(node.children ?? []) : undefined
  }))
}

function FileTreeNodeRenderer({ node, style, dragHandle }: NodeRendererProps<FileTreeDataNode>) {
  return (
    <div
      style={style}
      ref={dragHandle}
      className={`app-right-tree-node ${node.isSelected ? 'is-selected' : ''}`}
      onDoubleClick={() => {
        if (node.isInternal) node.toggle()
      }}
    >
      <span
        className={`app-right-tree-switcher-icon ${node.isOpen ? 'is-open' : ''} ${node.isLeaf ? 'is-leaf' : ''}`}
        onClick={(event) => {
          event.stopPropagation()
          if (node.isInternal) node.toggle()
        }}
      >
        <RightOutlined />
      </span>
      {renderNodeTitle(node.data.name, node.data.kind, node.isOpen)}
    </div>
  )
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

function inferMonacoLanguage(filePath: string): string {
  const lowerPath = filePath.toLowerCase()
  const fileName = lowerPath.split('/').pop() ?? lowerPath
  if (fileName === 'dockerfile') return 'dockerfile'
  if (fileName === '.gitignore') return 'plaintext'
  if (fileName === '.env' || fileName.startsWith('.env.')) return 'shell'
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : ''
  if (!ext) return 'plaintext'
  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    jsonc: 'json',
    md: 'markdown',
    markdown: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    xml: 'xml',
    sh: 'shell',
    bash: 'shell',
    ps1: 'powershell',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    h: 'cpp',
    cc: 'cpp',
    cpp: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    sql: 'sql',
    toml: 'ini',
    ini: 'ini',
    conf: 'ini',
    txt: 'plaintext',
    log: 'plaintext'
  }
  return languageMap[ext] ?? 'plaintext'
}

type WorkspaceRightPaneProps = {
  bridge: Window['bridge']
  activeWorkspaceId: string | null
  activeWorkspacePath: string | null
  width: number
  isCollapsed: boolean
  onToggleCollapse: () => void
}

export function WorkspaceRightPane(props: WorkspaceRightPaneProps) {
  const { bridge, activeWorkspaceId, activeWorkspacePath, width, isCollapsed, onToggleCollapse } =
    props
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
  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(null)
  const [fileTreeWidthPx, setFileTreeWidthPx] = useState(readStoredTreeWidthPx)
  const [fileSplitDragging, setFileSplitDragging] = useState(false)
  const fileTreeWidthPxRef = useRef(fileTreeWidthPx)
  /** 首帧在实测 content 宽度上尝试从旧版比例 key 迁移到像素 key（仅一次） */
  const fileTreeWidthMigrateAttemptedRef = useRef(false)
  const rightContentRef = useRef<HTMLDivElement | null>(null)
  const treeContainerRef = useRef<HTMLDivElement | null>(null)
  /** 切换工作区时作废尚未返回的文件树请求，避免旧结果覆盖 Home 等状态 */
  const fileTreeLoadGenRef = useRef(0)
  const [treeHeight, setTreeHeight] = useState(0)
  const fileTreeData = useMemo(() => toAntdFileTree(fileTree), [fileTree])
  const fileTreeOpenState = useMemo(
    () => Object.fromEntries(fileTreeExpandedKeys.map((key) => [key, true])),
    [fileTreeExpandedKeys]
  )
  const terminalPromptPrefix = useMemo(
    () => `PS ${activeWorkspacePath || '[未绑定工作区]'}>`,
    [activeWorkspacePath]
  )
  const terminalContainerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const terminalFitAddonRef = useRef<FitAddon | null>(null)
  const terminalInputBufferRef = useRef('')
  const terminalRunningRef = useRef(false)
  const terminalCancelledRef = useRef(false)
  const activeWorkspaceIdRef = useRef(activeWorkspaceId)
  const terminalPromptPrefixRef = useRef(terminalPromptPrefix)
  const terminalHistoryRef = useRef<string[]>([])
  const terminalHistoryIndexRef = useRef<number | null>(null)
  const terminalHistoryDraftRef = useRef('')
  const filePreviewLanguage = useMemo(() => inferMonacoLanguage(filePreviewPath), [filePreviewPath])

  useEffect(() => {
    fileTreeWidthPxRef.current = fileTreeWidthPx
  }, [fileTreeWidthPx])

  useEffect(() => {
    if (activePanel !== 'file') return
    const el = rightContentRef.current
    if (!el) return
    const applyContentResize = () => {
      const w = el.getBoundingClientRect().width
      if (!(w > 0)) return

      if (!fileTreeWidthMigrateAttemptedRef.current) {
        fileTreeWidthMigrateAttemptedRef.current = true
        try {
          const hasNew = localStorage.getItem(FILE_TREE_WIDTH_STORAGE_KEY)
          const legacyRaw = localStorage.getItem(FILE_TREE_SPLIT_FRACTION_LEGACY_KEY)
          if (!hasNew && legacyRaw) {
            const f = Number(legacyRaw)
            if (Number.isFinite(f)) {
              const frac = Math.min(0.82, Math.max(0.18, f))
              const migrated = clampTreeWidthPx(frac * w, w)
              fileTreeWidthPxRef.current = migrated
              setFileTreeWidthPx(migrated)
              localStorage.setItem(FILE_TREE_WIDTH_STORAGE_KEY, String(migrated))
              return
            }
          }
        } catch {
          /* ignore */
        }
      }

      setFileTreeWidthPx((prev) => {
        const next = clampTreeWidthPx(prev, w)
        fileTreeWidthPxRef.current = next
        return next
      })
    }
    applyContentResize()
    const ro = new ResizeObserver(applyContentResize)
    ro.observe(el)
    return () => ro.disconnect()
  }, [activePanel, width, isCollapsed])

  useEffect(() => {
    monaco.editor.defineTheme(GITHUB_LIGHT_THEME_NAME, githubLightThemeJson)
  }, [])

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
    const gen = ++fileTreeLoadGenRef.current
    if (activeWorkspaceId === HOME_WORKSPACE_ID || !activeWorkspacePath) {
      setFileTree([])
      setFileTreeExpandedKeys([])
      setFileTreeLoading(false)
      return
    }
    setFileTreeLoading(true)
    try {
      const payload = await bridge.getWorkspaceFileTree()
      if (gen !== fileTreeLoadGenRef.current) return
      setFileTree(payload.nodes)
      setFileTreeExpandedKeys(payload.nodes.slice(0, 8).map((node) => node.path))
    } catch (error) {
      if (gen !== fileTreeLoadGenRef.current) return
      const msg = error instanceof Error ? error.message : String(error)
      msgApi.error(`读取文件树失败：${msg}`)
    } finally {
      if (gen === fileTreeLoadGenRef.current) {
        setFileTreeLoading(false)
      }
    }
  }, [activeWorkspaceId, activeWorkspacePath, bridge, msgApi])

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

  const onFileSplitterMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      if (activePanel !== 'file') return
      const content = rightContentRef.current
      if (!content) return
      const startTreeWidth = fileTreeWidthPxRef.current
      const startX = event.clientX
      setFileSplitDragging(true)
      const prevUserSelect = document.body.style.userSelect
      const prevCursor = document.body.style.cursor
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'

      const onMove = (ev: MouseEvent) => {
        const cw = content.getBoundingClientRect().width
        if (cw <= 0) return
        const next = clampTreeWidthPx(startTreeWidth + (ev.clientX - startX), cw)
        fileTreeWidthPxRef.current = next
        setFileTreeWidthPx(next)
      }
      const onUp = () => {
        setFileSplitDragging(false)
        document.body.style.userSelect = prevUserSelect
        document.body.style.cursor = prevCursor
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        try {
          localStorage.setItem(FILE_TREE_WIDTH_STORAGE_KEY, String(fileTreeWidthPxRef.current))
        } catch {
          /* ignore */
        }
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [activePanel]
  )

  const insertTerminalPastedText = useCallback((term: Terminal, raw: string) => {
    const text = normalizePastedTerminalText(raw)
    if (!text) return
    terminalHistoryIndexRef.current = null
    terminalInputBufferRef.current += text
    term.write(text)
  }, [])

  const pasteTerminalClipboard = useCallback(
    async (term: Terminal): Promise<boolean> => {
      if (terminalRunningRef.current) return false
      try {
        const text = navigator.clipboard?.readText ? await navigator.clipboard.readText() : ''
        if (text) {
          insertTerminalPastedText(term, text)
          return true
        }
      } catch {
        /* fall through to webEdit */
      }
      try {
        term.focus()
        await bridge.webEdit('paste')
        return true
      } catch {
        msgApi.error('粘贴失败')
        return false
      }
    },
    [bridge, insertTerminalPastedText, msgApi]
  )

  const copyTerminalSelection = useCallback(
    async (term: Terminal): Promise<boolean> => {
      if (!term.hasSelection()) return false
      const text = term.getSelection()
      if (!text) return false
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
        } else {
          await bridge.webEdit('copy')
        }
      } catch {
        try {
          await bridge.webEdit('copy')
        } catch {
          msgApi.error('复制失败')
          return false
        }
      }
      term.clearSelection()
      return true
    },
    [bridge, msgApi]
  )

  const handleTerminalContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      const term = terminalRef.current
      if (!term) return
      if (term.hasSelection()) {
        void copyTerminalSelection(term)
        return
      }
      if (!terminalRunningRef.current) {
        void pasteTerminalClipboard(term)
      }
    },
    [copyTerminalSelection, pasteTerminalClipboard]
  )

  const interruptTerminalCommand = useCallback(() => {
    const term = terminalRef.current
    if (!term || !terminalRunningRef.current) return
    terminalCancelledRef.current = true
    const workspaceId = activeWorkspaceIdRef.current
    const finishInterrupt = () => {
      terminalRunningRef.current = false
      terminalInputBufferRef.current = ''
      term.write('^C\r\n[命令已取消]\r\n')
      resetTerminalMouseTracking(term)
      writeTerminalPrompt(term)
    }
    if (!workspaceId || workspaceId === HOME_WORKSPACE_ID) {
      finishInterrupt()
      return
    }
    void bridge.cancelTerminalCommand(workspaceId).then(finishInterrupt)
  }, [bridge, writeTerminalPrompt])

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
      terminalCancelledRef.current = false
      terminalRunningRef.current = true
      let receivedStream = false
      const stopTerminalOutput = bridge.onTerminalOutput((payload) => {
        if (payload.workspaceId !== activeWorkspaceIdRef.current) return
        if (terminalCancelledRef.current) return
        receivedStream = true
        writeTerminalStreamChunk(term, payload.chunk)
      })
      term.write('\r\n')
      try {
        const { output } = await bridge.runTerminalCommand(activeWorkspaceId, command)
        if (terminalCancelledRef.current) return
        const tail = (output || '').replace(/\r?\n/g, '\r\n')
        if (tail) {
          term.write(tail)
          if (!tail.endsWith('\r\n')) term.write('\r\n')
        } else if (!receivedStream) {
          term.write('[无输出]\r\n')
        }
        resetTerminalMouseTracking(term)
      } catch (error) {
        if (terminalCancelledRef.current) return
        const msg = error instanceof Error ? error.message : String(error)
        msgApi.error(`命令执行失败：${msg}`)
        term.write(`\r\n命令执行失败：${msg}\r\n`)
      } finally {
        stopTerminalOutput()
        if (!terminalCancelledRef.current) {
          terminalRunningRef.current = false
          terminalInputBufferRef.current = ''
          resetTerminalMouseTracking(term)
          writeTerminalPrompt(term)
        }
      }
    },
    [activeWorkspaceId, activeWorkspacePath, bridge, msgApi, writeTerminalPrompt]
  )

  const interruptTerminalCommandRef = useRef(interruptTerminalCommand)
  const runTerminalCommandRef = useRef(runTerminalCommand)
  const completeTerminalInputRef = useRef(completeTerminalInput)
  const navigateTerminalHistoryRef = useRef(navigateTerminalHistory)
  const writeTerminalPromptRef = useRef(writeTerminalPrompt)
  const copyTerminalSelectionRef = useRef(copyTerminalSelection)
  const pasteTerminalClipboardRef = useRef(pasteTerminalClipboard)
  const insertTerminalPastedTextRef = useRef(insertTerminalPastedText)
  interruptTerminalCommandRef.current = interruptTerminalCommand
  runTerminalCommandRef.current = runTerminalCommand
  completeTerminalInputRef.current = completeTerminalInput
  navigateTerminalHistoryRef.current = navigateTerminalHistory
  writeTerminalPromptRef.current = writeTerminalPrompt
  copyTerminalSelectionRef.current = copyTerminalSelection
  pasteTerminalClipboardRef.current = pasteTerminalClipboard
  insertTerminalPastedTextRef.current = insertTerminalPastedText

  useEffect(() => {
    if (activePanel !== 'file') return
    void loadWorkspaceTree()
  }, [activePanel, loadWorkspaceTree])

  useEffect(() => {
    setFileTree([])
    setFileTreeExpandedKeys([])
    setSelectedFileKey(null)
    setFilePreviewPath('')
    setFilePreviewContent('')
    setFilePreviewTruncated(false)
    setFilePreviewError('')
  }, [activeWorkspaceId])

  useLayoutEffect(() => {
    if (activePanel !== 'file') return
    const container = treeContainerRef.current
    if (!container) return
    const measure = () => setTreeHeight(readTreeViewportHeight(container))
    measure()
    const observer = new ResizeObserver(() => {
      measure()
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [activePanel, width, isCollapsed, fileTreeWidthPx, fileTreeLoading, fileTreeData.length])

  useEffect(() => {
    terminalPromptPrefixRef.current = terminalPromptPrefix
  }, [terminalPromptPrefix])

  useEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceId
  }, [activeWorkspaceId])

  useEffect(() => {
    if (activePanel !== 'terminal' || isCollapsed) return
    const container = terminalContainerRef.current
    if (!container) return
    if (terminalRef.current) {
      terminalRef.current.dispose()
      terminalRef.current = null
      terminalFitAddonRef.current = null
    }
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      lineHeight: 1.5,
      fontFamily: "Consolas, 'Courier New', monospace",
      scrollback: 5000,
      rightClickSelectsWord: true,
      theme: {
        background: '#f4f4f5',
        foreground: '#18181b',
        cursor: '#27272a',
        cursorAccent: '#f4f4f5',
        selectionBackground: 'rgb(37 99 235 / 0.35)',
        selectionForeground: '#18181b',
        selectionInactiveBackground: 'rgb(24 24 27 / 0.16)'
      }
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()
    term.focus()
    terminalRef.current = term
    terminalFitAddonRef.current = fitAddon
    terminalInputBufferRef.current = ''
    terminalRunningRef.current = false
    terminalCancelledRef.current = false
    // 首行提示符仅由下方「activePanel / activeWorkspaceId」effect 统一写入，避免与
    // term.reset() 后的 write 在 xterm 异步解析队列中叠加成「PS …> PS …>」。

    const disposable = term.onData((data) => {
      const activeTerm = terminalRef.current
      if (!activeTerm) return
      if (isTerminalCtrlC(data)) {
        if (activeTerm.hasSelection()) {
          void copyTerminalSelectionRef.current(activeTerm)
          return
        }
        if (terminalRunningRef.current) {
          interruptTerminalCommandRef.current()
        } else if (terminalInputBufferRef.current.length > 0) {
          const len = terminalInputBufferRef.current.length
          terminalInputBufferRef.current = ''
          activeTerm.write('\b \b'.repeat(len))
          activeTerm.write('^C\r\n')
          writeTerminalPromptRef.current(activeTerm)
        }
        return
      }
      if (terminalRunningRef.current) return
      if (data.length > 1 && !data.startsWith('\u001b')) {
        insertTerminalPastedTextRef.current(activeTerm, data)
        return
      }
      if (isTerminalEnter(data)) {
        const command = terminalInputBufferRef.current
        terminalInputBufferRef.current = ''
        void runTerminalCommandRef.current(command)
        return
      }
      if (data === '\u001b[A') {
        navigateTerminalHistoryRef.current(activeTerm, 'up')
        return
      }
      if (data === '\u001b[B') {
        navigateTerminalHistoryRef.current(activeTerm, 'down')
        return
      }
      if (data === '\t') {
        void completeTerminalInputRef.current()
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

    const handleTerminalKeyDown = (event: KeyboardEvent) => {
      const activeTerm = terminalRef.current
      if (!activeTerm) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        activeTerm.selectAll()
        return
      }
      const wantsCopy =
        (mod && event.key.toLowerCase() === 'c') || (event.ctrlKey && event.key === 'Insert')
      if (wantsCopy && activeTerm.hasSelection()) {
        event.preventDefault()
        event.stopPropagation()
        void copyTerminalSelectionRef.current(activeTerm)
        return
      }
      const wantsPaste =
        (mod && event.key.toLowerCase() === 'v') ||
        (event.shiftKey && event.key === 'Insert' && !event.ctrlKey)
      if (wantsPaste && !terminalRunningRef.current) {
        event.preventDefault()
        event.stopPropagation()
        void pasteTerminalClipboardRef.current(activeTerm)
      }
    }

    const handleTerminalPaste = (event: ClipboardEvent) => {
      if (terminalRunningRef.current) {
        event.preventDefault()
        return
      }
      const text = event.clipboardData?.getData('text/plain')
      if (!text) return
      event.preventDefault()
      const activeTerm = terminalRef.current
      if (!activeTerm) return
      insertTerminalPastedTextRef.current(activeTerm, text)
    }

    container.addEventListener('keydown', handleTerminalKeyDown, true)
    container.addEventListener('paste', handleTerminalPaste)

    const resizeObserver = new ResizeObserver(() => {
      terminalFitAddonRef.current?.fit()
    })
    resizeObserver.observe(container)
    resetTerminalMouseTracking(term)
    writeTerminalPromptRef.current(term)

    return () => {
      container.removeEventListener('keydown', handleTerminalKeyDown, true)
      container.removeEventListener('paste', handleTerminalPaste)
      resizeObserver.disconnect()
      disposable.dispose()
      term.dispose()
      terminalRef.current = null
      terminalFitAddonRef.current = null
      terminalRunningRef.current = false
      terminalCancelledRef.current = false
    }
  }, [activePanel, isCollapsed])

  useEffect(() => {
    if (activePanel !== 'terminal' || isCollapsed) return
    let cancelled = false
    const applyWorkspaceReset = () => {
      if (cancelled) return
      const term = terminalRef.current
      if (!term) {
        requestAnimationFrame(applyWorkspaceReset)
        return
      }
      if (terminalRunningRef.current) {
        interruptTerminalCommandRef.current()
      }
      terminalInputBufferRef.current = ''
      terminalRunningRef.current = false
      terminalCancelledRef.current = false
      terminalHistoryRef.current = []
      terminalHistoryIndexRef.current = null
      terminalHistoryDraftRef.current = ''
      term.reset()
      resetTerminalMouseTracking(term)
      writeTerminalPrompt(term)
      terminalFitAddonRef.current?.fit()
      term.focus()
    }
    applyWorkspaceReset()
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, isCollapsed, writeTerminalPrompt])

  useEffect(() => {
    if (activePanel !== 'terminal' || isCollapsed) return
    requestAnimationFrame(() => {
      terminalRef.current?.focus()
    })
  }, [activePanel, isCollapsed])

  return (
    <aside
      className={`app-right-pane ${isCollapsed ? 'is-collapsed' : ''}`}
      style={{ width: `${width}px` }}
      aria-hidden={isCollapsed}
    >
      {!isCollapsed ? (
        <>
          <div className="app-right-toolbar">
            <Button
              type="text"
              className={`app-right-toolbar-btn ${activePanel === 'file' ? 'is-active' : ''}`}
              icon={<FileOutlined />}
              onClick={() => setActivePanel('file')}
              aria-label="文件"
              title="文件"
            />
            <Button
              type="text"
              className={`app-right-toolbar-btn ${activePanel === 'terminal' ? 'is-active' : ''}`}
              icon={<CodeOutlined />}
              onClick={() => setActivePanel('terminal')}
              aria-label="控制台终端"
              title="控制台终端"
            />
            <div className="app-right-toolbar-spacer" />
            <Button
              type="text"
              className="app-right-toolbar-btn app-right-toolbar-toggle"
              icon={<MenuFoldOutlined />}
              onClick={onToggleCollapse}
              aria-label="收起右边栏"
              title="收起右边栏"
            />
          </div>
          <div className="app-right-content" ref={rightContentRef}>
            {activePanel === 'file' ? (
              <>
                <div className="app-right-tree-panel" style={{ flex: `0 0 ${fileTreeWidthPx}px` }}>
                  <div className="app-right-tree-wrap">
                    <div className="app-right-tree-viewport" ref={treeContainerRef}>
                      {activeWorkspaceId === HOME_WORKSPACE_ID ? (
                        <div className="app-right-tree-loading" role="status">
                          <Text type="secondary">当前未选择工作文件夹</Text>
                        </div>
                      ) : fileTreeLoading ? (
                        <div className="app-right-tree-loading">
                          <Spin size="small" />
                          <Text type="secondary">正在加载文件树...</Text>
                        </div>
                      ) : fileTreeData.length ? (
                        <Tree<FileTreeDataNode>
                          className="app-right-tree"
                          data={fileTreeData}
                          width="100%"
                          height={treeHeight > 0 ? treeHeight : 240}
                          rowHeight={26}
                          indent={16}
                          openByDefault={false}
                          initialOpenState={fileTreeOpenState}
                          renderContainer={WorkspaceFileTreeContainer}
                          disableDrag
                          disableEdit
                          selectionFollowsFocus
                          selection={selectedFileKey ?? undefined}
                          onToggle={(id) => {
                            setFileTreeExpandedKeys((prev) =>
                              prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
                            )
                          }}
                          onSelect={(nodes) => {
                            const node = nodes[0]
                            if (!node || node.data.kind !== 'file') return
                            const relPath = node.id
                            setSelectedFileKey(relPath)
                            void previewWorkspaceFile(relPath)
                          }}
                        >
                          {FileTreeNodeRenderer}
                        </Tree>
                      ) : (
                        <Text type="secondary" className="app-right-empty-tip">
                          当前工作区暂无可展示文件
                        </Text>
                      )}
                    </div>
                  </div>
                </div>
                <div
                  className={`app-right-file-split-handle ${fileSplitDragging ? 'is-active' : ''}`}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="调整文件树与预览区宽度"
                  onMouseDown={onFileSplitterMouseDown}
                />
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
                      <div className="app-right-preview-editor">
                        <Editor
                          path={filePreviewPath || undefined}
                          language={filePreviewLanguage}
                          value={filePreviewContent}
                          theme={GITHUB_LIGHT_THEME_NAME}
                          options={{
                            readOnly: true,
                            automaticLayout: true,
                            minimap: { enabled: false },
                            lineNumbers: 'on',
                            wordWrap: 'on',
                            renderWhitespace: 'selection',
                            scrollBeyondLastLine: false,
                            contextmenu: false,
                            fontSize: 12
                          }}
                        />
                      </div>
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
                <div
                  ref={terminalContainerRef}
                  className="app-right-terminal-canvas"
                  onClick={() => terminalRef.current?.focus()}
                  onContextMenu={handleTerminalContextMenu}
                />
              </div>
            )}
          </div>
        </>
      ) : null}
    </aside>
  )
}
