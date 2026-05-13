/**
 * 在其它主进程模块之前执行：动态加载 apps/desktop 目录下的 `.env*` 到 `process.env`。
 * 只读取 desktop 自身目录的配置，不向父级查找。
 *
 * 支持任意 `.env.*` 文件，自动识别并排序加载。优先级遵循 Vite 规范：
 *   高优先级（后加载，可覆盖）：.env.[mode].local > .env.[mode] > .env.local
 *   低优先级（先加载）：.env
 *
 * 例如：.env.production.local > .env.production > .env.local > .env
 *
 * 合并完成后关闭 LangChain 内置追踪（不使用 LangSmith / langsmith 客户端）。
 * Langfuse 见 `LANGFUSE_*` 环境变量，在 `index.ts` 中于本模块之后启动 OpenTelemetry。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'dotenv'

function disableLangChainBuiltInTracing(): void {
  process.env.LANGCHAIN_TRACING_V2 = 'false'
  process.env.LANGSMITH_TRACING_V2 = 'false'
}

const mainDir = dirname(fileURLToPath(import.meta.url))
/**
 * electron-vite 输出目录结构:
 * - 开发时: apps/desktop/src/main/ → 向上两级到 apps/desktop 目录
 * - 构建后: apps/desktop/out/main/ → 向上两级到 apps/desktop 目录
 */
const desktopDir = resolve(mainDir, '../..')

/**
 * 动态扫描并排序环境文件
 * 遵循 Vite 优先级规范（高到低）：
 *   .env.[mode].local > .env.[mode] > .env.local > .env
 *
 * 例如：
 *   .env.production.local (最高 - 生产环境本地配置)
 *   .env.production       (高 - 生产环境配置)
 *   .env.local            (中 - 通用本地配置)
 *   .env                   (低 - 基础配置)
 */
function getEnvFiles(dir: string): string[] {
  if (!existsSync(dir)) return []

  const allFiles = readdirSync(dir)
  const envFiles = allFiles.filter((name) => {
    // 匹配 .env 或 .env.* 但不包括 .env.example
    if (name === '.env.example') return false
    return name === '.env' || name.startsWith('.env.')
  })

  // 解析文件名：.env.[mode].local 或 .env.[mode] 或 .env.local
  const parseEnvFile = (name: string): { mode: string | null; isLocal: boolean } => {
    if (name === '.env') return { mode: null, isLocal: false }
    if (name === '.env.local') return { mode: null, isLocal: true }

    // 去掉前缀 .env.
    const rest = name.slice(5)
    const isLocal = rest.endsWith('.local')
    const mode = isLocal ? rest.slice(0, -6) || null : rest || null

    return { mode, isLocal }
  }

  // 计算优先级分数（分数越低，排序越靠前，加载越早）
  // 加载顺序：低优先级先加载，高优先级后加载（覆盖前者）
  const getPriority = (name: string): number => {
    const { mode, isLocal } = parseEnvFile(name)

    if (name === '.env') return 0 // 基础配置：最早加载
    if (name === '.env.local') return 10 // 通用本地
    if (mode && !isLocal) return 20 // .env.[mode]
    if (mode && isLocal) return 30 // .env.[mode].local：最晚加载（最高优先级）
    return 15 // 其他 .env.xxx
  }

  return envFiles.sort((a, b) => getPriority(a) - getPriority(b))
}

// 获取排序后的环境文件列表
const envFiles = getEnvFiles(desktopDir)

// 合并到 process.env（优先级高的文件可以覆盖已存在的值）
for (const file of envFiles) {
  const full = join(desktopDir, file)
  if (!existsSync(full)) continue

  const content = readFileSync(full, 'utf8')
  const parsed = parse(content)

  for (const [k, v] of Object.entries(parsed)) {
    // .env 基础文件只在变量未定义时才设置
    // 其他文件可以覆盖已有值
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
