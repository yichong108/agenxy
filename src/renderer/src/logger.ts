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

/** 未捕获异常、未处理的 Promise 拒绝 → error 级别写入日志（并保留浏览器默认控制台输出） */
if (typeof window !== 'undefined') {
  log.errorHandler.startCatching({
    showDialog: false,
    preventDefault: false
  })
}

/**
 * 渲染进程记录器；显式错误：`renderLog.error('说明', err)`（经 IPC 落盘到主进程日志文件）。
 */
export const renderLog = log.scope('renderer')

export function logScope(scope: string) {
  return log.scope(scope)
}
