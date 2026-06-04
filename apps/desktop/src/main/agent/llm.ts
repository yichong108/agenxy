import { ChatOpenAI } from '@langchain/openai'

import { type AppSettings, getActiveProviderProfile, type ModelProviderId } from '@/shared/ipc'

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
 * 创建用于 ReAct 主循环的流式 ChatOpenAI 实例。
 *
 * @param settings - 应用设置（含 provider profile）
 * @returns 绑定了 API Key 与 baseURL 的 ChatOpenAI
 * @throws 未配置 API Key 时抛出
 */
export function createStreamingLanguageModel(settings: AppSettings) {
  const profile = getActiveProviderProfile(settings)
  if (!profile.apiKey?.trim()) {
    throw new Error('请先在设置中配置 API Key')
  }
  const apiKey = profile.apiKey.trim()
  const baseURL = openAiBaseUrlForProvider(settings.provider, profile.baseUrl)
  return new ChatOpenAI({
    apiKey,
    model: profile.model,
    configuration: { baseURL },
    streaming: true,
    temperature: 0
  })
}
