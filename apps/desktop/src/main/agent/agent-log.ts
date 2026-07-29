import { logScope } from '@/main/logger'

/** Desktop 主进程侧 agent 相关日志（与 @agenwork/agent 内置 logger 独立） */
export const agentLog = logScope('agent')
