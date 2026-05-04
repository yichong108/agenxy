import type { IpcRendererEvent } from 'electron'
import { contextBridge, ipcRenderer } from 'electron'

type PreloadSelf = typeof globalThis & {
  postMessage(message: unknown): void
  __electronLog?: unknown
}

const self = globalThis as PreloadSelf

/**
 * 与 `electron-log/preload.js` 等价：暴露 `window.__electronLog`，供 `electron-log/renderer` 经 IPC 写主进程日志。
 * 内联避免打包后 `require('electron-log/preload.js')` 无法解析。
 */
export function installElectronLogBridge(): void {
  ipcRenderer.on(
    '__ELECTRON_LOG_IPC__',
    (_: IpcRendererEvent, message: Record<string, unknown>) => {
      self.postMessage({ cmd: 'message', ...message })
    }
  )

  void ipcRenderer.invoke('__ELECTRON_LOG__', { cmd: 'getOptions' }).catch((e: Error) => {
    console.error(
      new Error(`electron-log 主进程未初始化，请确认已加载 electron-log/main。${e.message}`)
    )
  })

  const electronLog = {
    sendToMain(message: Record<string, unknown>): void {
      try {
        ipcRenderer.send('__ELECTRON_LOG__', message)
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        console.error('electronLog.sendToMain', err, 'data:', message)
        ipcRenderer.send('__ELECTRON_LOG__', {
          cmd: 'errorHandler',
          error: { message: err.message, stack: err.stack },
          errorName: 'sendToMain'
        })
      }
    },
    log(...data: unknown[]): void {
      electronLog.sendToMain({ data, level: 'info' })
    }
  }

  for (const level of ['error', 'warn', 'info', 'verbose', 'debug', 'silly'] as const) {
    Object.assign(electronLog, {
      [level]: (...data: unknown[]) => electronLog.sendToMain({ data, level })
    })
  }

  if (typeof process !== 'undefined' && process.contextIsolated) {
    try {
      contextBridge.exposeInMainWorld('__electronLog', electronLog as never)
    } catch {
      // 重复注入时忽略
    }
  }

  self.__electronLog = electronLog
}
