/**
 * 用户意图分类 — Desktop 可选增强。
 *
 * 用于 Build 模式下按意图筛选 skills；与 @agenwork/agent 解耦，
 * agent 核心不依赖本模块。
 */

import { resolveChatModel } from '@agenwork/agent'
import { type AppSettings } from '@agenwork/shared'
import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'

import { SKILLS_WITH_TAGS, type UserIntent } from '@/main/agent/intent/skill-tags'
import { mainLog } from '@/main/logger'

const IntentClassificationSchema = z.object({
  intent: z.enum(['coding', 'general']).describe('用户意图类型'),
  confidence: z.number().min(0).max(1).describe('置信度 (0-1)'),
  reasoning: z.string().describe('分类理由说明')
})

export type { UserIntent }

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
 * @param provider - 可选注入的模型；未传则从 settings 解析
 * @returns 意图分类结果
 */
export async function classifyIntent(
  userText: string,
  settings: AppSettings,
  signal?: AbortSignal,
  provider?: LanguageModel | null
): Promise<IntentClassification> {
  const model = resolveChatModel(settings, provider)
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
    mainLog.warn('[classifyIntent] Failed:', error instanceof Error ? error.message : error)
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
 * @param targetIntents - 目标意图列表（空或含 general 表示加载所有）
 * @returns 是否应加载
 */
export function shouldLoadSkill(skillName: string, targetIntents: UserIntent[]): boolean {
  if (targetIntents.length === 0 || targetIntents.includes('general')) return true

  const tags = SKILLS_WITH_TAGS.find((el) => el.id === skillName)?.tags || ['general']

  return tags.some((el) => targetIntents.includes(el))
}

/**
 * Build 模式下解析应加载的意图列表。
 *
 * 置信度不足或为 general 时返回空数组（表示加载全部 skills）。
 *
 * @param userText - 用户文本
 * @param settings - 应用设置
 * @param signal - 可选取消信号
 * @param provider - 可选模型
 * @returns 检测到的意图列表
 */
export async function resolveFilterIntents(
  userText: string,
  settings: AppSettings,
  signal?: AbortSignal,
  provider?: LanguageModel | null
): Promise<UserIntent[]> {
  try {
    const classification = await classifyIntent(userText, settings, signal, provider)
    mainLog.info(
      `[resolveFilterIntents] intent=${classification.intent} confidence=${classification.confidence.toFixed(2)}`
    )
    if (classification.intent !== 'general' && classification.confidence > 0.6) {
      return [classification.intent]
    }
    return []
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e
    mainLog.warn('[resolveFilterIntents] failed:', e)
    throw e
  }
}
