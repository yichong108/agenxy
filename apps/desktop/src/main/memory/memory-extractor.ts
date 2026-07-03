import { getAuxChatModel } from '@agenxy/agent'
import { generateObject } from 'ai'
import { z } from 'zod'

import { logScope } from '@/main/logger'
import {
  applyMemoryExtractionActions,
  type MemoryExtractionAction
} from '@/main/memory/memory-service'
import { getSettings, getUserMemories } from '@/main/store'
import { getActiveProviderProfile } from '@/shared/ipc'

const memLog = logScope('memory')

const MemoryExtractionSchema = z.object({
  actions: z
    .array(
      z.object({
        op: z.enum(['add', 'update', 'delete']),
        id: z.string().optional(),
        content: z.string().optional()
      })
    )
    .describe('要应用的记忆变更；若无持久信息则为空')
})

const MIN_ASSISTANT_CHARS_FOR_EXTRACT = 24
const MAX_TURN_TEXT_CHARS = 2000

function truncateTurnText(text: string): string {
  const t = text.trim()
  if (t.length <= MAX_TURN_TEXT_CHARS) return t
  return `${t.slice(0, MAX_TURN_TEXT_CHARS)}…`
}

/**
 * After a successful agent run, extract durable user facts into global memory.
 */
export async function extractMemoriesAfterRun(opts: {
  sessionId: string
  userText: string
  assistantText: string
}): Promise<void> {
  const settings = getSettings()
  if (!settings.memoryEnabled || !settings.autoExtractMemory) return

  const userText = opts.userText.trim()
  const assistantText = opts.assistantText.trim()
  if (!userText || assistantText.length < MIN_ASSISTANT_CHARS_FOR_EXTRACT) return

  const profile = getActiveProviderProfile(settings)
  if (!profile.apiKey?.trim()) {
    memLog.warn('[extractMemoriesAfterRun] skipped: no API key')
    return
  }

  const model = getAuxChatModel(settings)
  if (!model) return

  const existing = getUserMemories().items
  const existingBlock =
    existing.length > 0 ? existing.map((m) => `- id=${m.id} | ${m.content}`).join('\n') : '（无）'

  const systemPrompt = `你维护桌面编码智能体关于用户的小型全局记忆。

仅输出对未来会话有用的持久事实：
- 偏好（语言、框架、包管理器、编辑器习惯）
- 用户明确分享的稳定身份或角色背景
- 长期沟通偏好

不要存储：
- API 密钥、密码、令牌、机密
- 一次性任务说明、文件路径、缺陷状态或临时计划
- 仅与当前消息相关的内容

与已有记忆对比：
- 新事实细化已有条目时，用 op "update" 并保留相同 id
- 事实过时或被推翻时，用 op "delete"
- 全新事实用 op "add"
- 无持久变更时返回 actions: []

每条 add/update 的 content 须为一句简洁中文（200 字以内）。`

  const humanPrompt = [
    '## 已有记忆',
    existingBlock,
    '',
    '## 最近一轮对话',
    '用户：',
    truncateTurnText(userText),
    '',
    '助手：',
    truncateTurnText(assistantText)
  ].join('\n')

  try {
    const { object: result } = await generateObject({
      model,
      schema: MemoryExtractionSchema,
      system: systemPrompt,
      prompt: humanPrompt,
      temperature: 0
    })

    const actions = (result.actions ?? []) as MemoryExtractionAction[]
    if (!actions.length) return

    const { delta } = applyMemoryExtractionActions(actions, {
      sourceSessionId: opts.sessionId
    })
    memLog.info(
      `[extractMemoriesAfterRun] applied delta added=${delta.added} updated=${delta.updated} deleted=${delta.deleted}`
    )
  } catch (error) {
    memLog.warn('[extractMemoriesAfterRun] failed:', error instanceof Error ? error.message : error)
  }
}
