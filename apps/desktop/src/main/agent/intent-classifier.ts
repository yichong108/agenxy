import { agentLog } from './agent-service'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
import { z } from 'zod'

import { SKILLS_WITH_TAGS } from '@/main/agent/skills'
import type { AppSettings } from '@/shared/ipc'
import { getActiveProviderProfile } from '@/shared/ipc'

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
 * 所有技能的意图标签（用于反向映射）
 * 键为注册工具名：文件技能经 sanitizeToolName 后与 frontmatter/目录名一致（不自动加 skill_ 前缀）；内置代码技能仍为 skill_* 名称。
 */
export const SKILL_INTENT_TAGS: Record<string, UserIntent[]> = {
  // 编程相关技能（打包 skill.md）
  bug_fix: ['coding'],
  feature_implement: ['coding'],
  code_review: ['coding'],
  debug_workflow: ['coding'],
  release_workflow: ['coding'],
  // 非编程技能
  frontend_slides: ['general'],
  frontend_slides_ppt_controlled: ['general'],
  triage_workflow: ['general'],
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
    const messages = [new SystemMessage(systemPrompt), new HumanMessage(userText)]
    const result = await model.invoke(messages, { signal })

    // Additional validation to ensure intent value is valid (handle unexpected enum values from model)
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
 * 检查技能是否应该被加载
 *
 * 技能没有定义标签的话，默认就是general
 * @param skillName 技能名
 * @param targetIntents 目标意图列表（空表示加载所有）
 */
export function shouldLoadSkill(skillName: string, targetIntents: UserIntent[]): boolean {
  if (targetIntents.length === 0 || targetIntents.includes('general')) return true

  const tags = SKILLS_WITH_TAGS.find((el) => el.id === skillName)?.tags || ['general']

  // 检查技能和目标意图是否有交集
  return tags.some((el) => targetIntents.includes(el))
}
