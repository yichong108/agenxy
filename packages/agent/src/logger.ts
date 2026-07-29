/**
 * Agent 包内置日志 — 不依赖宿主注入，默认输出到 console。
 */
export type AgentLogger = {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/** Agent 主流程共享 logger */
export const agentLog: AgentLogger = {
  info: (...args) => console.info('[agent]', ...args),
  warn: (...args) => console.warn('[agent]', ...args),
  error: (...args) => console.error('[agent]', ...args)
}
