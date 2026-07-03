/**
 * Agent 日志接口 — 宿主应用（如 Electron 主进程）在启动时注入实现。
 */
export type AgentLogger = {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

const consoleLogger: AgentLogger = {
  info: (...args) => console.info('[agent]', ...args),
  warn: (...args) => console.warn('[agent]', ...args),
  error: (...args) => console.error('[agent]', ...args)
}

let currentLogger: AgentLogger = consoleLogger

/**
 * 注入 Agent 运行时日志实现。
 *
 * @param logger - 宿主提供的 logger（如 electron-log scope）
 */
export function setAgentLogger(logger: AgentLogger): void {
  currentLogger = logger
}

/** Agent 主流程共享 logger */
export const agentLog: AgentLogger = {
  info: (...args) => currentLogger.info(...args),
  warn: (...args) => currentLogger.warn(...args),
  error: (...args) => currentLogger.error(...args)
}
