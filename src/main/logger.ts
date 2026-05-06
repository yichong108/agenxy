import { app } from 'electron'
import log from 'electron-log/main.js'

type LogLevelName = 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly'

const LEVELS = new Set<string>(['error', 'warn', 'info', 'verbose', 'debug', 'silly'])

function parseLevel(raw: string | undefined): LogLevelName | undefined {
  if (!raw?.trim()) return undefined
  const n = raw.trim().toLowerCase()
  return LEVELS.has(n) ? (n as LogLevelName) : undefined
}

let initialized = false

/**
 * 配置主进程日志（控制台 + 用户目录下文件，见 electron-log 默认路径）。
 * 环境变量 `TROU_LOG_LEVEL` 可设为 error | warn | info | verbose | debug | silly。
 */
export function initMainLogger(): void {
  if (initialized) return
  initialized = true

  log.initialize({ preload: false })

  const fromEnv = parseLevel(process.env['TROU_LOG_LEVEL'])
  const isPackaged = app.isPackaged
  const fileLevel: LogLevelName = fromEnv ?? (isPackaged ? 'info' : 'debug')
  const consoleLevel: LogLevelName = fromEnv ?? (isPackaged ? 'info' : 'debug')

  if (log.transports.file) {
    log.transports.file.level = fileLevel
  }
  if (log.transports.console) {
    log.transports.console.level = consoleLevel
  }

  log.errorHandler.startCatching({
    showDialog: app.isPackaged
  })

  log.info(`主进程日志已就绪（file=${fileLevel}, console=${consoleLevel}）`)
  logAppDirectoriesToConsole()
}

/** 始终在终端打印，便于定位日志文件（不受 TROU_LOG_LEVEL 影响） */
function logAppDirectoriesToConsole(): void {
  const emit = (): void => {
    try {
      console.log('[trou] 用户数据目录:', app.getPath('userData'))
      console.log('[trou] Electron 日志目录:', app.getPath('logs'))
    } catch (e) {
      console.warn('[trou] 读取 app 路径失败:', e)
    }
  }
  if (app.isReady()) {
    emit()
  } else {
    app.once('ready', emit)
  }
}

/** 按模块划分 scope，便于检索 */
export function logScope(scope: string) {
  return log.scope(scope)
}

initMainLogger()

/**
 * 主进程默认记录器，写入控制台与日志文件。
 * 业务里显式记录错误：`mainLog.error('说明', err)` 或 `mainLog.error(err)`。
 */
export const mainLog = log.scope('main')
