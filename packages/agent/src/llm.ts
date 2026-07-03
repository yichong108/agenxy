import { createOpenAI } from '@ai-sdk/openai'
import {
  type AppSettings,
  getActiveProviderProfile,
  type ModelProviderId
} from '@agenxy/shared'
import type { LanguageModel } from 'ai'

function ensureOpenAiV1BaseUrl(baseUrl: string, fallback: string): string {
  const u = baseUrl.trim() || fallback
  if (!u) return fallback
  if (/\/v1\/?$/i.test(u)) return u.replace(/\/+$/, '')
  return `${u.replace(/\/+$/, '')}/v1`
}

function openAiBaseUrlForProvider(_provider: ModelProviderId, rawBaseUrl: string): string {
  return ensureOpenAiV1BaseUrl(rawBaseUrl, 'https://api.deepseek.com/v1')
}

/**
 * 创建 OpenAI 兼容 API 的 AI SDK provider。
 *
 * @param settings - 应用设置（含 provider profile）
 * @returns createOpenAI 实例
 * @throws 未配置 API Key 时抛出
 */
export function createOpenAiProvider(settings: AppSettings) {
  const profile = getActiveProviderProfile(settings)
  if (!profile.apiKey?.trim()) {
    throw new Error('请先在设置中配置 API Key')
  }
  const apiKey = profile.apiKey.trim()
  const baseURL = openAiBaseUrlForProvider(settings.provider, profile.baseUrl)
  return createOpenAI({ apiKey, baseURL })
}

/**
 * 获取用于 ReAct 主循环的聊天模型。
 *
 * @param settings - 应用设置
 * @returns AI SDK LanguageModel
 * @throws 未配置 API Key 时抛出
 */
export function getChatModel(settings: AppSettings): LanguageModel {
  const profile = getActiveProviderProfile(settings)
  const provider = createOpenAiProvider(settings)
  return provider.chat(profile.model)
}

/**
 * 获取用于辅助 LLM 调用的聊天模型（意图分类、记忆提取、plan-after-tool）。
 *
 * @param settings - 应用设置
 * @returns AI SDK LanguageModel；无 API Key 时返回 null
 */
export function getAuxChatModel(settings: AppSettings): LanguageModel | null {
  const profile = getActiveProviderProfile(settings)
  if (!profile.apiKey?.trim()) return null
  const provider = createOpenAiProvider(settings)
  return provider.chat(profile.model)
}
