import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'

import type { AppSettings } from '@/shared/ipc'
import { getActiveProviderProfile } from '@/shared/ipc'

import { agentLog } from './agent-service'

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

function openAiBaseUrlForProvider(provider: string, rawBaseUrl: string): string {
  const deepseekDefault = 'https://api.deepseek.com/v1'
  if (provider === 'ollama') {
    const host = rawBaseUrl.trim() || 'http://127.0.0.1:11434'
    return ensureOpenAiV1BaseUrl(host, 'http://127.0.0.1:11434/v1')
  }
  return ensureOpenAiV1BaseUrl(rawBaseUrl, deepseekDefault)
}

function createLanguageModel(settings: AppSettings) {
  const profile = getActiveProviderProfile(settings)
  const isOllama = settings.provider === 'ollama'
  const apiKey = isOllama ? 'ollama' : profile.apiKey?.trim() || ''
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
 */
export async function classifyIntent(
  userText: string,
  settings: AppSettings,
  signal?: AbortSignal
): Promise<IntentClassification> {
  const model = createLanguageModel(settings)

  const systemPrompt = `你是意图分类专家。分析用户输入，判断是编程相关任务还是通用任务。

可选意图类型：
- coding: 编程相关任务（代码修改、Bug修复、功能开发、代码评审、故障排查、发布部署等）
- general: 通用任务（幻灯片制作、问题分类、文档编写等）

分类规则：
1. 如果涉及代码、程序、软件、Bug、功能开发、代码评审、故障排查、部署等，选择 coding
2. 如果涉及PPT、幻灯片、演示文稿、问题分类、通用咨询等，选择 general
3. 如果无法明确判断，选择 general

返回格式必须是有效的 JSON 对象：
{
  "intent": "coding 或 general",
  "confidence": 0.95,
  "reasoning": "简短的理由说明"
}`

  try {
    const messages = [new SystemMessage(systemPrompt), new HumanMessage(userText)]
    const response = await model.invoke(messages, { signal })
    const content = typeof response.content === 'string' ? response.content : ''

    // 尝试从响应中提取 JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      agentLog.warn('[classifyIntent] No JSON found in response:', content)
      return { intent: 'general', confidence: 0.5, reasoning: '解析失败，回退到通用意图' }
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      intent?: string
      confidence?: number
      reasoning?: string
    }

    const intent = validateIntent(parsed.intent)
    const confidence = Math.max(0, Math.min(1, parsed.confidence ?? 0.5))

    return {
      intent,
      confidence,
      reasoning: parsed.reasoning || '基于内容分析'
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    agentLog.warn('[classifyIntent] Failed:', error instanceof Error ? error.message : error)
    return { intent: 'general', confidence: 0.5, reasoning: '分类失败，回退到通用意图' }
  }
}

function validateIntent(raw: unknown): UserIntent {
  if (typeof raw === 'string') {
    const normalized = raw.toLowerCase().trim()
    if (normalized === 'coding' || normalized === 'code' || normalized.includes('编程')) {
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

/**
 * 快速意图检测（基于关键词）
 * 用于在完整分类前提供初步判断，避免不必要的 LLM 调用
 */
export function quickIntentDetect(userText: string): UserIntent | null {
  const text = userText.toLowerCase()

  // 非编程类（高优先级检测）
  if (/\b(ppt|slide|幻灯片|演示文稿|presentation|deck|triage|分类)\b/i.test(text)) {
    return 'general'
  }

  // 编程类关键词
  if (
    /(\bbug\b|修复|报错|错误|异常|crash|fix.*error|fix.*bug|代码|code|编程|程序|函数|开发|实现|feature|评审|review|排查|部署|release|上线)/i.test(
      text
    )
  ) {
    return 'coding'
  }

  return null
}
