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

/**
 * 发送智能体消息时的可选参数（IPC / 宿主 send 共用）。
 */
export type AgentSendOptions = {
  mode?: AgentComposerMode
  /** 本轮工作区根目录绝对路径；宿主可据此覆盖会话默认路径 */
  workspacePath?: string
}
