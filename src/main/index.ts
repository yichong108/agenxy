import { existsSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'

import { IPC, EVENTS, type AppSettings, type StreamEvent } from '../shared/ipc.js'

import { bindAgentIpc, cancelRun, runUserMessage, resetQueue } from './agent/agent-service.js'
import {
  loadSessionList,
  getSessions,
  createSession,
  renameSession,
  deleteSession,
  touchSession
} from './sessions.js'
import { getSettings, getWorkspace, setSettings, setWorkspace } from './store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null
let devWatcher: FSWatcher | null = null
let restartTimer: NodeJS.Timeout | null = null
let hasRetriedDevLoad = false

function setupConsoleUtf8(): void {
  if (process.platform !== 'win32') return
  process.env['LANG'] = process.env['LANG'] || 'zh_CN.UTF-8'
  process.stdout.setDefaultEncoding('utf8')
  process.stderr.setDefaultEncoding('utf8')
}

setupConsoleUtf8()

async function loadReactDevtoolsExtension(): Promise<void> {
  if (!isDev) return

  const extensionPath = path.resolve(__dirname, '../../extensions/react-devtools')

  const removeExistingReactDevtools = (): void => {
    try {
      const all = session.defaultSession.getAllExtensions()
      for (const ext of all) {
        if (ext.name.toLowerCase().includes('react developer tools')) {
          session.defaultSession.removeExtension(ext.id)
          console.log(`[react-devtools] 已移除旧扩展: ${ext.name} (${ext.id})`)
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn('[react-devtools] 移除旧扩展失败:', msg)
    }
  }

  removeExistingReactDevtools()

  if (existsSync(extensionPath)) {
    try {
      await session.defaultSession.loadExtension(extensionPath, { allowFileAccess: true })
      console.log('[react-devtools] 本地离线扩展加载成功')
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[react-devtools] 本地扩展加载失败:', msg)
    }
  } else {
    console.warn(`[react-devtools] 本地扩展目录不存在: ${extensionPath}`)
  }

  try {
    const exts = session.defaultSession.getAllExtensions()
    const extNames = exts.map((ext) => ext.name).join(', ')
    console.log(`[react-devtools] 当前已加载扩展: ${extNames || '(无)'}`)
    for (const ext of exts) {
      console.log(`[react-devtools] 扩展详情: name=${ext.name}, id=${ext.id}, path=${ext.path}`)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[react-devtools] 读取扩展列表失败:', msg)
  }
}

function getRendererUrl(): string {
  return (
    process.env['ELECTRON_RENDERER_URL'] ||
    process.env['VITE_DEV_SERVER_URL'] ||
    'http://localhost:5173'
  )
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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // React DevTools 在 sandbox renderer 中可能无法正确注入
      // 开发环境关闭 sandbox，生产环境继续保持开启
      sandbox: !isDev
    },
    show: false
  })
  if (isDev) {
    void mainWindow.loadURL(getRendererUrl())
    // 页面 DOM 就绪后再打开 DevTools，确保 React DevTools 面板已完成注入
    mainWindow.webContents.once('dom-ready', () => {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    })
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize()
    mainWindow?.show()
  })
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      console.error(
        `[renderer] load failed code=${errorCode} desc=${errorDescription} url=${validatedURL}`
      )
      if (isDev && !hasRetriedDevLoad) {
        hasRetriedDevLoad = true
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            void mainWindow.loadURL(getRendererUrl())
          }
        }, 500)
      }
    }
  )
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer] process gone: reason=${details.reason}, exitCode=${details.exitCode}`)
  })
  bindAgentIpc(mainWindow.webContents)
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.send(EVENTS.SESSIONS_SYNC, getSessions())
    mainWindow?.webContents.send(EVENTS.WORKSPACE_CHANGED, { path: getWorkspace() })
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function setupDevAutoRestart(): void {
  if (!isDev || devWatcher) return
  const watchPath = path.resolve(__dirname, '../../src')
  try {
    devWatcher = watch(watchPath, { recursive: true }, (_eventType, filename) => {
      if (!filename) return
      // 防抖，避免一次保存触发多次重启
      if (restartTimer) clearTimeout(restartTimer)
      restartTimer = setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 250)
    })
  } catch {
    // 监听失败时不阻塞应用启动
  }
}

function broadcastSessions(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(EVENTS.SESSIONS_SYNC, getSessions())
}

function registerIpc(): void {
  ipcMain.handle(IPC.WORKSPACE_SELECT, async () => {
    const r = await dialog.showOpenDialog({
      title: '选择工作区',
      properties: ['openDirectory', 'createDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return { path: '' as const }
    setWorkspace(r.filePaths[0])
    mainWindow?.webContents.send(EVENTS.WORKSPACE_CHANGED, { path: r.filePaths[0] })
    return { path: r.filePaths[0] }
  })
  ipcMain.handle(IPC.WORKSPACE_GET, () => getWorkspace())
  ipcMain.handle(IPC.SETTINGS_GET, () => getSettings())
  ipcMain.handle(IPC.SETTINGS_SET, (_e, patch: Partial<AppSettings>) => {
    if (typeof patch.maxConcurrentStreams === 'number') {
      resetQueue()
    }
    const next = setSettings(patch)
    mainWindow?.webContents.send(EVENTS.SETTINGS_SYNC, next)
    return next
  })
  ipcMain.handle(IPC.SESSIONS_LIST, () => getSessions())
  ipcMain.handle(IPC.SESSIONS_CREATE, (_e, name?: string) => {
    const s = createSession(name)
    broadcastSessions()
    return s
  })
  ipcMain.handle(IPC.SESSIONS_RENAME, (_e, id: string, name: string) => {
    const s = renameSession(id, name)
    broadcastSessions()
    return s
  })
  ipcMain.handle(IPC.SESSIONS_DELETE, (_e, id: string) => {
    deleteSession(id)
    broadcastSessions()
    return { ok: true as const }
  })
  ipcMain.handle(IPC.AGENT_SEND, async (_e, sessionId: string, text: string) => {
    if (!text.trim()) return { ok: false as const, error: '空消息' }
    const onQueued = (pos: number) => {
      if (pos > 0) {
        const ev: StreamEvent = { type: 'queued', sessionId, position: pos }
        mainWindow?.webContents.send(EVENTS.AGENT_STREAM, ev)
      }
    }
    try {
      await runUserMessage(sessionId, text.trim(), onQueued)
      touchSession(sessionId)
      broadcastSessions()
      return { ok: true as const }
    } catch (err) {
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
    mainWindow.webContents.openDevTools({ mode: 'detach' })
    return { open: true }
  })
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return
  void (async () => {
    await loadReactDevtoolsExtension()
    setupDevAutoRestart()
    loadSessionList()
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (devWatcher) {
    devWatcher.close()
    devWatcher = null
  }
})

// 外部链接触发
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
})
