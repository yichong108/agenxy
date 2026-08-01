/**
 * @file LLM调用层
 * @description 比如提供 OpenAI 兼容聊天模型
 */

import { createOpenAI } from '@ai-sdk/openai'
import { type AppSettings, getActiveProviderProfile } from '@agenwork/shared'
import type { LanguageModel } from 'ai'

/**
 * 规范化 OpenAI 兼容 baseURL：确保以 `/v1` 结尾。
 *
 * @param baseUrl - 用户配置的接口地址
 * @returns 规范化后的 baseURL
 * @throws 未配置 baseURL 时抛出
 */
function normalizeOpenAiV1BaseUrl(baseUrl: string): string {
  const u = baseUrl.trim()
  if (!u) {
    throw new Error('请先在设置中配置接口地址（Base URL）')
  }
  if (/\/v1\/?$/i.test(u)) return u.replace(/\/+$/, '')
  return `${u.replace(/\/+$/, '')}/v1`
}

/**
 * 创建 OpenAI 兼容 API 的 AI SDK provider。
 *
 * @param settings - 应用设置（含 provider profile）
 * @returns createOpenAI 实例
 * @throws 未配置 API Key 或 Base URL 时抛出
 */
export function createOpenAiProvider(settings: AppSettings) {
  const profile = getActiveProviderProfile(settings)
  if (!profile.apiKey?.trim()) {
    throw new Error('请先在设置中配置 API Key')
  }
  const apiKey = profile.apiKey.trim()
  const baseURL = normalizeOpenAiV1BaseUrl(profile.baseUrl)
  return createOpenAI({ apiKey, baseURL })
}

/**
 * 获取 OpenAI 兼容聊天模型（对话 + 工具调用）。
 *
 * 未配置 API Key 时返回 null，由调用方决定抛错或降级。
 *
 * @param settings - 应用设置
 * @returns AI SDK LanguageModel；未配置 API Key 时为 null
 * @throws 已配置 API Key 但未配置 Base URL 时抛出
 */
export function getChatModel(settings: AppSettings): LanguageModel | null {
  const profile = getActiveProviderProfile(settings)
  if (!profile.apiKey?.trim()) return null
  const provider = createOpenAiProvider(settings)
  return provider.chat(profile.model)
}

/**
 * 解析本轮应使用的聊天模型。
 *
 * 优先使用显式传入的 provider（如 createAgent / send 注入）；
 * 未传入时回退到从 settings 创建。
 *
 * @param settings - 应用设置（provider 未传入时使用）
 * @param provider - 可选的 LanguageModel 覆盖
 * @returns 可用模型；均不可用时为 null
 */
export function resolveChatModel(
  settings: AppSettings,
  provider?: LanguageModel | null
): LanguageModel | null {
  return provider ?? getChatModel(settings)
}
