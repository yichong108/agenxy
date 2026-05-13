/**
 * 在其它主进程模块之前执行：加载 apps/desktop 目录下的 `.env*` 到 `process.env`。
 * 只读取 desktop 自身目录的配置，不向父级查找。
 *
 * 优先级顺序（高到低）：
 * 1. `.env.development.local` - 本地特定配置（最高优先级，覆盖所有）
 * 2. `.env.development` - 开发环境配置（覆盖 .env）
 * 3. `.env` - 基础配置（只在变量未定义时设置）
 *
 * 合并完成后关闭 LangChain 内置追踪（不使用 LangSmith / langsmith 客户端）。
 * Langfuse 见 `LANGFUSE_*` 环境变量，在 `index.ts` 中于本模块之后启动 OpenTelemetry。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function disableLangChainBuiltInTracing(): void {
  process.env.LANGCHAIN_TRACING_V2 = 'false'
  process.env.LANGSMITH_TRACING_V2 = 'false'
}

function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

const mainDir = dirname(fileURLToPath(import.meta.url))
/**
 * electron-vite 输出目录结构:
 * - 开发时: apps/desktop/src/main/ → 向上两级到 apps/desktop 目录
 * - 构建后: apps/desktop/out/main/ → 向上两级到 apps/desktop 目录
 */
const desktopDir = resolve(mainDir, '../..')

// 合并到 process.env（.env.development 和 .env.development.local 优先级更高，可以覆盖已存在的值）
// 优先级顺序: .env.development.local > .env.development > .env
const envFiles = ['.env', '.env.development', '.env.development.local']
for (const file of envFiles) {
  const full = join(desktopDir, file)
  if (!existsSync(full)) continue
  const parsed = parseDotEnv(readFileSync(full, 'utf8'))
  for (const [k, v] of Object.entries(parsed)) {
    // .env.development 和 .env.development.local 可以覆盖已有值
    // .env 只在变量未定义时才设置
    if (file === '.env') {
      if (process.env[k] === undefined) {
        process.env[k] = v
      }
    } else {
      process.env[k] = v
    }
  }
}

disableLangChainBuiltInTracing()
