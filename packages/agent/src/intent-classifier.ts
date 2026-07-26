import { type AppSettings } from '@agenxy/shared'
import { generateObject } from 'ai'
import { z } from 'zod'

import { agentLog } from './logger.js'
import { getChatModel } from './llm.js'
import { SKILLS_WITH_TAGS } from './skill-tags.js'

const IntentClassificationSchema = z.object({
  intent: z.enum(['coding', 'general']).describe('用户意图类型'),
  confidence: z.number().min(0).max(1).describe('置信度 (0-1)'),
  reasoning: z.string().describe('分类理由说明')
})

export type UserIntent = 'coding' | 'general'

export type IntentClassification = {
  intent: UserIntent
  confidence: number
  reasoning: string
}

/**
 * 对用户输入进行意图分类。
 *
 * @param userText - 用户消息
 * @param settings - 应用设置
 * @param signal - 可选取消信号
 * @returns 意图分类结果
 */
export async function classifyIntent(
  userText: string,
  settings: AppSettings,
  signal?: AbortSignal
): Promise<IntentClassification> {
  const model = getChatModel(settings)
  if (!model) {
    return {
      intent: 'general',
      confidence: 0.5,
      reasoning: '未配置 API Key，回退为通用意图'
    }
  }

  const systemPrompt = `你是意图分类专家。分析用户输入，判断属于编程相关任务还是通用任务。

可用意图类型：
- coding：编程相关（改代码、修 bug、功能开发、代码评审、排障、部署等）
- general：通用任务（做幻灯片、问题分拣、写文档等）

分类规则：
1. 涉及代码、程序、软件、缺陷、功能开发、评审、排障、部署等 → 选 "coding"
2. 涉及 PPT、幻灯片、演示、问题分拣、一般咨询等 → 选 "general"
3. 不确定时选 "general"

输出要求：
- "reasoning" 字段须用中文
- 给出清晰的分类理由`

  try {
    const { object: result } = await generateObject({
      model,
      schema: IntentClassificationSchema,
      system: systemPrompt,
      prompt: userText,
      abortSignal: signal,
      temperature: 0
    })

    const intent = validateIntent(result.intent)
    const confidence = Math.max(0, Math.min(1, result.confidence ?? 0.5))

    return {
      intent,
      confidence,
      reasoning: result.reasoning || '根据内容分析'
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    agentLog.warn('[classifyIntent] Failed:', error instanceof Error ? error.message : error)
    return {
      intent: 'general',
      confidence: 0.5,
      reasoning: '分类失败，回退为通用意图'
    }
  }
}

function validateIntent(raw: unknown): UserIntent {
  if (typeof raw === 'string') {
    const normalized = raw.toLowerCase().trim()
    if (normalized === 'coding' || normalized === 'code' || normalized.includes('programming')) {
      return 'coding'
    }
  }
  return 'general'
}

/**
 * 检查技能是否应该被加载。
 *
 * @param skillName - 技能名
 * @param targetIntents - 目标意图列表（空表示加载所有）
 * @returns 是否应加载
 */
export function shouldLoadSkill(skillName: string, targetIntents: UserIntent[]): boolean {
  if (targetIntents.length === 0 || targetIntents.includes('general')) return true

  const tags = SKILLS_WITH_TAGS.find((el) => el.id === skillName)?.tags || ['general']

  return tags.some((el) => targetIntents.includes(el))
}
