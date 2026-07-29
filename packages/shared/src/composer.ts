/**
 * 主输入区发送模式（对齐 Cursor）：
 * - build：可写文件、终端、技能/MCP
 * - ask：只读问答
 */
export type AgentComposerMode = 'build' | 'ask'

/**
 * 规范化 composer mode，非法值回退为 build。
 *
 * @param mode - 可选模式
 * @returns build / ask
 */
export function normalizeComposerMode(mode?: AgentComposerMode): AgentComposerMode {
  if (mode === 'ask') return mode
  return 'build'
}

export type AgentSendOptions = {
  mode?: AgentComposerMode
  userDisplayText?: string
}
