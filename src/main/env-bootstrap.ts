/**
 * 在其它主进程模块之前执行：加载仓库根目录 `.env*` 到 `process.env`。
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
/** electron-vite 输出为 out/main，向上两级为仓库根目录 */
const repoRoot = resolve(mainDir, '../..')

const merged: Record<string, string> = {}
for (const file of ['.env', '.env.development', '.env.development.local']) {
  const full = join(repoRoot, file)
  if (!existsSync(full)) continue
  Object.assign(merged, parseDotEnv(readFileSync(full, 'utf8')))
}

for (const [k, v] of Object.entries(merged)) {
  if (process.env[k] === undefined) {
    process.env[k] = v
  }
}

disableLangChainBuiltInTracing()
