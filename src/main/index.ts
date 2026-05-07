import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron'

import { bindAgentIpc, cancelRun, runUserMessage, resetQueue } from '@/main/agent/agent-service'
import {
  ensureUserSkillsLayout,
  gatherSkillsRuntimeState,
  uninstallLegacySkillFolder,
  uninstallMarketSkillFolder
} from '@/main/agent/skills'
import { mainLog } from '@/main/logger'
import { disposeMcpConnectionPool, probeMcpServer, warmupMcpServers } from '@/main/mcp/mcp-runtime'
import {
  loadSessionList,
  getSessions,
  createSession,
  renameSession,
  deleteSession,
  getSessionWorkspaceId,
  purgeWorkspaceSessions,
  touchSession
} from '@/main/sessions'
import { installSkillFromMarketItem } from '@/main/skills-market/install'
import {
  ensureHomeWorkspaceInList,
  restoreHomeWorkspaceInList,
  getActiveWorkspace,
  getActiveWorkspaceId,
  getSettings,
  getSessionMessages,
  getUiState,
  getWorkspace,
  getWorkspaceById,
  listWorkspaces,
  reorderWorkspaces,
  removeWorkspace,
  renameWorkspace,
  setSettings,
  setUiState,
  setActiveWorkspace,
  upsertWorkspaceByPath
} from '@/main/store'
import { completeCommandInWorkspace, killCommand, runCommand } from '@/main/tools/terminal'
import { listWorkspaceFileTree, readWorkspaceFileContent } from '@/main/workspace-files'
import {
  HOME_WORKSPACE_ID,
  IPC,
  EVENTS,
  type AppSettings,
  type McpServerEntry,
  type McpWarmupReport,
  type McpWarmupStatus,
  type RendererUiState,
  type SkillsMarketCatalogItem,
  type SkillsUninstallPayload,
  type StreamEvent,
  type WebEditAction,
  type WindowChromeAction
} from '@/shared/ipc'

mainLog.info('Electron 主进程启动')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null

let lastMcpWarmupReport: McpWarmupReport | null = null
/** 递增以作废进行中的预热结果（例如保存 MCP 后） */
let mcpWarmupGen = 0
let mcpWarmupPromise: Promise<McpWarmupReport> | null = null

function getMcpWarmupStatus(): McpWarmupStatus {
  return { report: lastMcpWarmupReport, inFlight: mcpWarmupPromise !== null }
}

async function executeMcpWarmupCycle(): Promise<McpWarmupReport> {
  const gen = ++mcpWarmupGen
  const servers = await warmupMcpServers(getSettings())
  if (gen !== mcpWarmupGen) {
    return lastMcpWarmupReport ?? { atMs: Date.now(), servers: [] }
  }
  const report: McpWarmupReport = { atMs: Date.now(), servers }
  lastMcpWarmupReport = report
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(EVENTS.MCP_WARMUP, report)
  }
  return report
}

function startMcpWarmup(): Promise<McpWarmupReport> {
  if (mcpWarmupPromise) return mcpWarmupPromise
  const tracked = executeMcpWarmupCycle().finally(() => {
    if (mcpWarmupPromise === tracked) mcpWarmupPromise = null
  })
  mcpWarmupPromise = tracked
  return tracked
}

function setupConsoleUtf8(): void {
  if (process.platform !== 'win32') return
  process.env['LANG'] = process.env['LANG'] || 'zh_CN.UTF-8'
  process.stdout.setDefaultEncoding('utf8')
  process.stderr.setDefaultEncoding('utf8')
}

setupConsoleUtf8()

async function loadDevtoolsExtension(): Promise<void> {
  if (!isDev) return

  const extensionPath = path.resolve(__dirname, '../../src/extensions/react-devtools')

  const removeExistingReactDevtools = (): void => {
    try {
      const all = session.defaultSession.getAllExtensions()
      for (const ext of all) {
        if (ext.name.toLowerCase().includes('react developer tools')) {
          session.defaultSession.removeExtension(ext.id)
          mainLog.info(`[react-devtools] 已移除旧扩展: ${ext.name} (${ext.id})`)
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      mainLog.warn('[react-devtools] 移除旧扩展失败:', msg)
    }
  }

  removeExistingReactDevtools()

  if (existsSync(extensionPath)) {
    try {
      await session.defaultSession.loadExtension(extensionPath, { allowFileAccess: true })
      mainLog.info('[react-devtools] 本地离线扩展加载成功')
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      mainLog.error('[react-devtools] 本地扩展加载失败:', msg)
    }
  } else {
    mainLog.warn(`[react-devtools] 本地扩展目录不存在: ${extensionPath}`)
  }

  // log the extensions
  try {
    const exts = session.defaultSession.getAllExtensions()
    const extNames = exts.map((ext) => ext.name).join(', ')
    mainLog.info(`[react-devtools] 当前已加载扩展: ${extNames || '(无)'}`)
    for (const ext of exts) {
      mainLog.info(`[react-devtools] 扩展详情: name=${ext.name}, id=${ext.id}, path=${ext.path}`)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    mainLog.error('[react-devtools] 读取扩展列表失败:', msg)
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

function createWindow(): void {
  const webPreferences = {
    preload: path.join(__dirname, '../preload/index.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
  /** Windows：隐藏原生标题栏与菜单栏占位，由渲染进程顶栏 + titleBarOverlay 承载系统按钮 */
  const win32Chrome =
    process.platform === 'win32'
      ? ({
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#f5f5f5',
            symbolColor: '#000000d9',
            height: 32
          }
        } as const)
      : {}
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    webPreferences,
    /** 等首屏 did-finish-load 再 show + maximize，避免 ready-to-show 未触发时无法最大化 */
    show: false,
    ...win32Chrome
  })

  // Why use if (rendererUrl) loadURL else loadFile?
  // Development: Must load from HTTP to enable HMR (Hot Module Replacement) and module hot updates.
  // Production (packaged): There is no dev server, so can only loadFile from index.html on disk.
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      mainLog.error(
        `[renderer] load failed code=${errorCode} desc=${errorDescription} url=${validatedURL}`
      )
    }
  )
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    mainLog.error(`[renderer] process gone: reason=${details.reason}, exitCode=${details.exitCode}`)
  })
  bindAgentIpc(mainWindow.webContents)
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.maximize()
    mainWindow?.show()
    broadcastWorkspaces()
    broadcastSessions()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function getActiveWorkspacePath(): string {
  return getActiveWorkspace()?.path || ''
}

function getSessionsInActiveWorkspace() {
  const activeWorkspaceId = getActiveWorkspaceId()
  if (!activeWorkspaceId) return []
  return getSessions(activeWorkspaceId)
}

function broadcastWorkspaces(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(EVENTS.WORKSPACES_SYNC, {
    list: listWorkspaces(),
    activeWorkspaceId: getActiveWorkspaceId()
  })
  mainWindow.webContents.send(EVENTS.WORKSPACE_CHANGED, { path: getActiveWorkspacePath() })
}

function broadcastSessions(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(EVENTS.SESSIONS_SYNC, getSessionsInActiveWorkspace())
}

function registerIpc(): void {
  ipcMain.handle(IPC.WORKSPACE_SELECT, async () => {
    const r = await dialog.showOpenDialog({
      title: '选择工作区',
      properties: ['openDirectory', 'createDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return { path: '' as const }
    const workspace = upsertWorkspaceByPath(r.filePaths[0])
    setActiveWorkspace(workspace.id)
    broadcastWorkspaces()
    broadcastSessions()
    return { path: workspace.path || '' }
  })
  ipcMain.handle(IPC.WORKSPACE_GET, () => getWorkspace())
  ipcMain.handle(IPC.WORKSPACE_FILE_TREE, async () => {
    const workspace = getActiveWorkspace()
    if (!workspace?.path) {
      return { rootPath: '', nodes: [] }
    }
    return await listWorkspaceFileTree(workspace.path)
  })
  ipcMain.handle(IPC.WORKSPACE_FILE_CONTENT, async (_e, relPath: string) => {
    const workspace = getActiveWorkspace()
    if (!workspace?.path) {
      return { ok: false as const, error: '当前工作区未绑定目录' }
    }
    return await readWorkspaceFileContent(workspace.path, relPath)
  })
  ipcMain.handle(IPC.TERMINAL_RUN, async (_e, workspaceId: string, command: string) => {
    const trimmed = String(command ?? '').trim()
    if (!trimmed) return { output: '请输入命令后再执行。' }
    const targetWorkspace = listWorkspaces().find((x) => x.id === workspaceId)
    const workspacePath = targetWorkspace?.path
    if (!workspacePath) {
      return { output: '当前工作区未绑定目录，无法执行命令。' }
    }
    const sessionKey = `right-pane:${workspaceId}`
    const output = await runCommand(
      sessionKey,
      workspacePath,
      trimmed,
      getSettings().maxTerminalOutputChars
    )
    return { output }
  })
  ipcMain.handle(IPC.TERMINAL_CANCEL, async (_e, workspaceId: string) => {
    await killCommand(`right-pane:${workspaceId}`)
    return { ok: true as const }
  })
  ipcMain.handle(IPC.TERMINAL_COMPLETE, async (_e, workspaceId: string, commandLine: string) => {
    const targetWorkspace = listWorkspaces().find((x) => x.id === workspaceId)
    const workspacePath = targetWorkspace?.path
    if (!workspacePath) return { items: [] as string[] }
    try {
      const items = await completeCommandInWorkspace(workspacePath, String(commandLine ?? ''))
      return { items }
    } catch {
      return { items: [] as string[] }
    }
  })
  ipcMain.handle(IPC.WORKSPACE_LIST, () => ({
    list: listWorkspaces(),
    activeWorkspaceId: getActiveWorkspaceId()
  }))
  ipcMain.handle(IPC.WORKSPACE_ADD, (_e, dir: string) => {
    if (!dir?.trim()) return null
    const workspace = upsertWorkspaceByPath(dir)
    setActiveWorkspace(workspace.id)
    broadcastWorkspaces()
    broadcastSessions()
    return workspace
  })
  ipcMain.handle(IPC.WORKSPACE_ACTIVATE, (_e, workspaceId: string) => {
    if (workspaceId === HOME_WORKSPACE_ID) {
      restoreHomeWorkspaceInList()
    }
    const next = setActiveWorkspace(workspaceId)
    if (!next) return null
    broadcastWorkspaces()
    broadcastSessions()
    return next
  })
  ipcMain.handle(IPC.WORKSPACE_REORDER, (_e, orderIds: string[]) => {
    reorderWorkspaces(orderIds)
    broadcastWorkspaces()
    return {
      list: listWorkspaces(),
      activeWorkspaceId: getActiveWorkspaceId()
    }
  })
  ipcMain.handle(IPC.WORKSPACE_RENAME, (_e, workspaceId: string, name: string) => {
    const next = renameWorkspace(workspaceId, name)
    if (!next) return null
    broadcastWorkspaces()
    return next
  })
  ipcMain.handle(IPC.WORKSPACE_REMOVE, (_e, workspaceId: string) => {
    purgeWorkspaceSessions(workspaceId)
    const ok = removeWorkspace(workspaceId)
    if (ok) {
      broadcastWorkspaces()
      broadcastSessions()
    }
    return { ok }
  })
  ipcMain.handle(IPC.SETTINGS_GET, () => getSettings())
  ipcMain.handle(IPC.SETTINGS_SET, (_e, patch: Partial<AppSettings>) => {
    if (typeof patch.maxConcurrentStreams === 'number') {
      resetQueue()
    }
    if (patch.mcpServers !== undefined) {
      mcpWarmupGen++
      mcpWarmupPromise = null
      void disposeMcpConnectionPool()
    }
    const next = setSettings(patch)
    mainWindow?.webContents.send(EVENTS.SETTINGS_SYNC, next)
    if (patch.mcpServers !== undefined) {
      void startMcpWarmup()
    }
    return next
  })
  ipcMain.handle(IPC.MCP_WARMUP_GET, () => getMcpWarmupStatus())
  ipcMain.handle(IPC.MCP_WARMUP_RUN, () => startMcpWarmup())
  ipcMain.handle(IPC.UI_STATE_GET, () => getUiState())
  ipcMain.handle(IPC.UI_STATE_SET, (_e, patch: Partial<RendererUiState>) => setUiState(patch))
  ipcMain.handle(IPC.SESSIONS_LIST, () => getSessionsInActiveWorkspace())
  ipcMain.handle(IPC.SESSIONS_LIST_BY_WORKSPACE, (_e, workspaceId: string) => {
    if (!workspaceId) return []
    return getSessions(workspaceId)
  })
  ipcMain.handle(IPC.SESSIONS_GET_MESSAGES, (_e, sessionId: string) => {
    const workspaceId = getSessionWorkspaceId(sessionId) || getActiveWorkspaceId()
    if (!workspaceId) return []
    return getSessionMessages(workspaceId, sessionId)
  })
  ipcMain.handle(IPC.SESSIONS_CREATE, (_e, name?: string) => {
    ensureHomeWorkspaceInList()
    let workspaceId = getActiveWorkspaceId()
    if (!workspaceId) {
      const home = getWorkspaceById(HOME_WORKSPACE_ID)
      if (home) {
        setActiveWorkspace(home.id)
        workspaceId = home.id
        broadcastWorkspaces()
      }
    }
    if (!workspaceId) {
      return null
    }
    const s = createSession(workspaceId, name)
    broadcastSessions()
    return s
  })
  ipcMain.handle(IPC.SESSIONS_RENAME, (_e, id: string, name: string) => {
    const workspaceId = getSessionWorkspaceId(id) || getActiveWorkspaceId()
    if (!workspaceId) return null
    const s = renameSession(workspaceId, id, name)
    broadcastSessions()
    return s
  })
  ipcMain.handle(IPC.SESSIONS_DELETE, (_e, id: string) => {
    const workspaceId = getSessionWorkspaceId(id) || getActiveWorkspaceId()
    if (!workspaceId) return { ok: false as const }
    deleteSession(workspaceId, id)
    broadcastSessions()
    return { ok: true as const }
  })

  /**
   * 发送消息到 Agent
   *
   * 支持并发发送消息
   *
   * @param sessionId 会话 ID
   * @param text 消息内容
   * @returns 发送结果
   */
  ipcMain.handle(IPC.AGENT_SEND, async (_e, sessionId: string, text: string) => {
    mainLog.info(`[AGENT_SEND] sessionId: ${sessionId}, text: ${text}`)

    if (!text.trim()) return { ok: false as const, error: '空消息' }
    const onQueued = (pos: number) => {
      if (pos > 0) {
        mainLog.info(`[AGENT_SEND] onQueued: ${pos}`)
        const ev: StreamEvent = { type: 'queued', sessionId, position: pos }
        mainWindow?.webContents.send(EVENTS.AGENT_STREAM, ev)
      } else {
        mainLog.info(`[AGENT_SEND] onQueued: ${pos}`)
      }
    }
    try {
      // 发送消息到 Agent
      await runUserMessage(sessionId, text.trim(), onQueued)
      // 更新会话时间
      const workspaceId = getSessionWorkspaceId(sessionId)
      if (workspaceId) {
        touchSession(workspaceId, sessionId)
      }
      // 广播会话列表
      broadcastSessions()
      // 返回发送结果
      return { ok: true as const }
    } catch (err) {
      mainLog.error(`[AGENT_SEND] error: ${err}`)

      const message = err instanceof Error ? err.message : String(err)
      mainWindow?.webContents.send(EVENTS.AGENT_STREAM, {
        type: 'error',
        sessionId,
        message
      } as StreamEvent)
      return { ok: false as const, error: message }
    }
  })
  ipcMain.handle(IPC.AGENT_CANCEL, (_e, sessionId: string) => {
    cancelRun(sessionId)
    return { ok: true as const }
  })
  ipcMain.handle(IPC.AGENT_STATUS, () => {
    // 可选：主进程不暴露细粒度
    return { ok: true as const }
  })
  ipcMain.handle(IPC.DEVTOOLS_TOGGLE, () => {
    if (!isDev || !mainWindow || mainWindow.isDestroyed()) {
      return { open: false }
    }
    if (mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools()
      return { open: false }
    }
    mainWindow.webContents.openDevTools({ mode: 'bottom' })
    return { open: true }
  })
  ipcMain.handle(IPC.EXTERNAL_OPEN, async (_e, url: string) => {
    if (!url || typeof url !== 'string') return { ok: false as const }
    try {
      const parsed = new URL(url)
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
        return { ok: false as const }
      }
      await shell.openExternal(url)
      return { ok: true as const }
    } catch {
      return { ok: false as const }
    }
  })
  ipcMain.handle(IPC.MCP_PROBE, async (_e, entry: McpServerEntry) => {
    if (!entry || typeof entry !== 'object') {
      return { ok: false as const, error: '无效配置' }
    }
    return await probeMcpServer(entry)
  })
  ipcMain.handle(IPC.SKILLS_STATE, async () => gatherSkillsRuntimeState())
  ipcMain.handle(IPC.SKILLS_INSTALL, async (_e, item: SkillsMarketCatalogItem) => {
    if (!item || typeof item !== 'object') {
      return { ok: false as const, error: '无效技能条目' }
    }
    return await installSkillFromMarketItem(item)
  })
  ipcMain.handle(IPC.SKILLS_UNINSTALL, async (_e, payload: SkillsUninstallPayload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false as const, error: '无效参数' }
    }
    if (payload.kind === 'market') {
      return await uninstallMarketSkillFolder(payload.folderId)
    }
    if (payload.kind === 'legacy') {
      return await uninstallLegacySkillFolder(payload.legacyFolderRelative)
    }
    return { ok: false as const, error: '无效参数' }
  })

  ipcMain.handle(IPC.WINDOW_ACTION, (_e, action: WindowChromeAction) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    switch (action) {
      case 'quit':
        app.quit()
        return
      case 'reload':
        win?.webContents.reload()
        return
      case 'minimize':
        win?.minimize()
        return
      case 'maximize-toggle':
        if (!win) return
        if (win.isMaximized()) win.unmaximize()
        else win.maximize()
        return
      case 'close':
        win?.close()
        return
      default:
        return
    }
  })

  ipcMain.handle(IPC.WEB_EDIT, (_e, action: WebEditAction) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const wc = win?.webContents
    if (!wc) return
    switch (action) {
      case 'undo':
        wc.undo()
        return
      case 'redo':
        wc.redo()
        return
      case 'cut':
        wc.cut()
        return
      case 'copy':
        wc.copy()
        return
      case 'paste':
        wc.paste()
        return
      case 'selectAll':
        wc.selectAll()
        return
      default:
        return
    }
  })

  ipcMain.handle(IPC.APP_ABOUT, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const opts = {
      type: 'info' as const,
      title: '关于 trou',
      message: 'trou',
      detail: `版本 ${app.getVersion()}`
    }
    if (win && !win.isDestroyed()) {
      await dialog.showMessageBox(win, opts)
    } else {
      await dialog.showMessageBox(opts)
    }
  })
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return
  if (process.platform === 'win32') {
    Menu.setApplicationMenu(null)
  }
  void (async () => {
    await loadDevtoolsExtension()
    await ensureUserSkillsLayout()
    loadSessionList()
    registerIpc()
    createWindow()
    void startMcpWarmup()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })()
})

app.on('before-quit', () => {
  void disposeMcpConnectionPool()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 外部链接触发
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
})
