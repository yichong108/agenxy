import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
import { z } from 'zod'

import type { AppSettings } from '@/shared/ipc'
import { getActiveProviderProfile } from '@/shared/ipc'

import { agentLog } from './agent-service'

/**
 * 意图分类结果 schema
 */
const IntentClassificationSchema = z.object({
  intent: z.enum(['coding', 'general']).describe('用户意图类型'),
  confidence: z.number().min(0).max(1).describe('置信度 (0-1)'),
  reasoning: z.string().describe('分类理由说明')
})

/**
 * 用户意图类型 - 粗粒度分类
 * coding: 编程相关（代码修改、Bug修复、功能开发、代码评审等）
 * general: 其他通用任务
 */
export type UserIntent = 'coding' | 'general'

/**
 * 意图分类结果
 */
export type IntentClassification = {
  intent: UserIntent
  confidence: number // 0-1
  reasoning: string // 分类理由
}

/**
 * 意图与技能名的映射
 * coding 意图加载所有编程相关技能
 * general 意图不限制技能（加载所有）
 */
export const INTENT_TO_SKILLS: Record<UserIntent, string[]> = {
  // coding 意图加载所有编程相关技能
  coding: [
    'skill_bug_fix',
    'skill_feature_implement',
    'skill_code_review',
    'skill_debug_workflow',
    'skill_release_workflow'
  ],
  // general 意图加载所有技能（不限制）
  general: []
}

/**
 * 所有技能的意图标签（用于反向映射）
 * 技能名格式：skill_<name>（sanitizeToolName 转换后）
 */
export const SKILL_INTENT_TAGS: Record<string, UserIntent[]> = {
  // 编程相关技能
  skill_bug_fix: ['coding'],
  skill_feature_implement: ['coding'],
  skill_code_review: ['coding'],
  skill_debug_workflow: ['coding'],
  skill_release_workflow: ['coding'],
  // 非编程技能
  skill_frontend_slides: ['general'],
  skill_frontend_slides_ppt_controlled: ['general'],
  skill_triage_workflow: ['general'],
  // 内置技能（所有意图都可用）
  skill_inspect_workspace: ['coding', 'general'],
  skill_write_file: ['coding', 'general'],
  skill_run_terminal: ['coding', 'general']
}

function ensureOpenAiV1BaseUrl(baseUrl: string, fallback: string): string {
  const u = baseUrl.trim() || fallback
  if (!u) return fallback
  if (/\/v1\/?$/i.test(u)) return u.replace(/\/+$/, '')
  return `${u.replace(/\/+$/, '')}/v1`
}

function openAiBaseUrlForProvider(_provider: string, rawBaseUrl: string): string {
  const deepseekDefault = 'https://api.deepseek.com/v1'
  return ensureOpenAiV1BaseUrl(rawBaseUrl, deepseekDefault)
}

function createLanguageModel(settings: AppSettings) {
  const profile = getActiveProviderProfile(settings)
  const apiKey = profile.apiKey?.trim() || ''
  const baseURL = openAiBaseUrlForProvider(settings.provider, profile.baseUrl)
  return new ChatOpenAI({
    apiKey,
    model: profile.model,
    configuration: { baseURL },
    streaming: false,
    temperature: 0
  })
}

/**
 * 对用户输入进行意图分类
 * 使用结构化输出确保可靠的 JSON 格式返回
 */
export async function classifyIntent(
  userText: string,
  settings: AppSettings,
  signal?: AbortSignal
): Promise<IntentClassification> {
  const model = createLanguageModel(settings).withStructuredOutput(IntentClassificationSchema, {
    name: 'classify_user_intent',
    strict: true
  })

  const systemPrompt = `You are an intent classification expert. Analyze the user input and determine whether it is a programming-related task or a general task.

Available intent types:
- coding: Programming-related tasks (code modification, bug fixes, feature development, code review, troubleshooting, deployment, etc.)
- general: General tasks (slide creation, issue triage, documentation writing, etc.)

Classification rules:
1. If the input involves code, programs, software, bugs, feature development, code review, troubleshooting, deployment, etc., select "coding"
2. If the input involves PPT, slides, presentations, issue triage, general inquiries, etc., select "general"
3. If uncertain, select "general"

Output requirements:
- The "reasoning" field must be written in English
- Provide clear justification for the classification decision`

  try {
    const messages = [new SystemMessage(systemPrompt), new HumanMessage(userText)]
    const result = await model.invoke(messages, { signal })

    // Additional validation to ensure intent value is valid (handle unexpected enum values from model)
    const intent = validateIntent(result.intent)
    const confidence = Math.max(0, Math.min(1, result.confidence ?? 0.5))

    return {
      intent,
      confidence,
      reasoning: result.reasoning || 'Based on content analysis'
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    agentLog.warn('[classifyIntent] Failed:', error instanceof Error ? error.message : error)
    return {
      intent: 'general',
      confidence: 0.5,
      reasoning: 'Classification failed, falling back to general intent'
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
 * 根据意图获取应加载的技能名列表
 * - general 意图返回空数组（表示加载所有技能）
 * - coding 意图返回编程相关技能列表
 */
export function getSkillNamesForIntent(intent: UserIntent): string[] {
  if (intent === 'general') return []
  return INTENT_TO_SKILLS[intent] || []
}

/**
 * 检查技能是否应该被加载
 * @param skillName 技能名
 * @param targetIntents 目标意图列表（空表示加载所有）
 */
export function shouldLoadSkill(skillName: string, targetIntents: UserIntent[]): boolean {
  if (targetIntents.length === 0 || targetIntents.includes('general')) return true

  const skillIntents = SKILL_INTENT_TAGS[skillName] || ['general']

  // 如果技能标记为 general，且目标意图包含 general，则加载
  if (skillIntents.includes('general') && targetIntents.includes('general')) return true

  // 检查技能和目标意图是否有交集
  return skillIntents.some((si) => targetIntents.includes(si))
}
