/**
 * 从环境变量 / .env 构建 CLI 用的 AppSettings。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type AppSettings, defaultSettings, normalizeSettings } from '@openworker/shared'
import { config as loadDotenv } from 'dotenv'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 加载 apps/cli 下的 `.env` / `.env.local`（后者覆盖前者）。
 *
 * 不覆盖已存在的 process.env，便于 shell 导出优先。
 */
export function loadCliEnv(): void {
  for (const name of ['.env', '.env.local'] as const) {
    const path = join(packageRoot, name)
    if (existsSync(path)) {
      loadDotenv({ path, override: false })
    }
  }
}

/**
 * 从环境变量组装 CLI 用 AppSettings。
 *
 * 读取 `OPENWORKERER_API_KEY` / `OPENWORKERER_BASE_URL` / `OPENWORKERER_MODEL` /
 * `TAVILY_API_KEY`；未设置时回退 defaultSettings。
 *
 * @returns 规范化后的 AppSettings
 */
export function settingsFromEnv(): AppSettings {
  const apiKey =
    process.env.OPENWORKERER_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || ''
  const baseUrl =
    process.env.OPENWORKERER_BASE_URL?.trim() || defaultSettings.providerProfiles.deepseek.baseUrl
  const model =
    process.env.OPENWORKERER_MODEL?.trim() || defaultSettings.providerProfiles.deepseek.model
  const tavilyApiKey = process.env.TAVILY_API_KEY?.trim() || ''

  return normalizeSettings({
    ...defaultSettings,
    tavilyApiKey,
    providerProfiles: {
      deepseek: {
        baseUrl,
        model,
        apiKey
      }
    }
  })
}
