import log from 'electron-log/renderer.js'

/**
 * 渲染进程日志：DevTools 控制台 + IPC 到主进程（与主进程共用 electron-log 文件落盘）。
 * 需在 preload 中加载 `electron-log/preload.js`。
 */
if (log.transports.console) {
  log.transports.console.level = import.meta.env.DEV ? 'debug' : 'info'
}
if (log.transports.ipc) {
  log.transports.ipc.level = import.meta.env.DEV ? 'debug' : 'info'
}

export const renderLog = log.scope('renderer')

export function logScope(scope: string) {
  return log.scope(scope)
}
