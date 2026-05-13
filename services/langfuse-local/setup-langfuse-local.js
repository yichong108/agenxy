#!/usr/bin/env node

/**
 * Langfuse 本地服务初始化脚本
 *
 * 用法:
 *   node scripts/setup-langfuse-local.js [命令]
 *
 * 命令:
 *   init       - 创建环境配置文件
 *   start      - 启动本地服务
 *   stop       - 停止本地服务
 *   status     - 查看服务状态
 *   logs       - 查看服务日志
 *   reset      - 重置所有数据（⚠️ 谨慎使用）
 *   help       - 显示帮助信息
 */

import { execSync } from 'child_process'
import { existsSync, writeFileSync, readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import * as readline from 'readline'

const COMMANDS = ['init', 'start', 'stop', 'status', 'logs', 'reset', 'help']

const DOCKER_COMPOSE_FILE = 'docker-compose.yml'
const ENV_EXAMPLE = '.env.example'
const ENV_LOCAL = '.env.langfuse.local'

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
}

function log(message, color = 'reset') {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`)
}

function run(command, options = {}) {
  try {
    return execSync(command, {
      encoding: 'utf-8',
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options
    })
  } catch (error) {
    if (!options.ignoreError) {
      throw error
    }
    return null
  }
}

function checkDocker() {
  try {
    run('docker --version', { silent: true })
    run('docker-compose --version', { silent: true })
    return true
  } catch {
    return false
  }
}

function getProjectRoot() {
  // 从脚本所在目录向上找到项目根目录（包含 .env.example 的目录）
  const __dirname = dirname(fileURLToPath(import.meta.url))
  let currentDir = resolve(__dirname, '..')
  while (currentDir !== resolve(currentDir, '..')) {
    if (existsSync(resolve(currentDir, '.env.example'))) {
      return currentDir
    }
    currentDir = resolve(currentDir, '..')
  }
  // 兜底：返回原始工作目录
  return resolve(process.cwd())
}

function showHelp() {
  log(`
${COLORS.bright}Langfuse 本地服务管理脚本${COLORS.reset}

用法: node scripts/setup-langfuse-local.js [命令]

命令:
  ${COLORS.cyan}init${COLORS.reset}       创建环境配置文件 (.env.langfuse.local)
  ${COLORS.cyan}start${COLORS.reset}      启动本地 Langfuse 服务
  ${COLORS.cyan}stop${COLORS.reset}       停止本地服务
  ${COLORS.cyan}status${COLORS.reset}     查看服务运行状态
  ${COLORS.cyan}logs${COLORS.reset}       查看服务日志 (按 Ctrl+C 退出)
  ${COLORS.cyan}reset${COLORS.reset}      ⚠️  删除所有数据并重新初始化
  ${COLORS.cyan}help${COLORS.reset}       显示本帮助信息

快速开始:
  1. node scripts/setup-langfuse-local.js init
  2. node scripts/setup-langfuse-local.js start
  3. 访问 http://localhost:3000 创建项目并获取 API 密钥
  4. 将密钥填入 .env.development.local
  5. 重启 Electron 应用
`, 'reset')
}

function cmdInit() {
  log('🚀 初始化 Langfuse 本地服务配置...', 'bright')

  const root = getProjectRoot()
  const envExamplePath = resolve(root, ENV_EXAMPLE)
  const envLocalPath = resolve(root, ENV_LOCAL)

  if (!existsSync(envExamplePath)) {
    log(`❌ 未找到 ${ENV_EXAMPLE}，请确保在项目根目录运行此脚本`, 'red')
    process.exit(1)
  }

  if (existsSync(envLocalPath)) {
    log(`⚠️  ${ENV_LOCAL} 已存在，跳过创建`, 'yellow')
    log('   如需重新配置，请手动删除该文件后重试', 'dim')
    return
  }

  // 生成随机密钥
  const generateRandomString = (length) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let result = ''
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return result
  }

  const nextauthSecret = generateRandomString(32)
  const salt = generateRandomString(32)

  // 读取 .env.example 并修改特定值
  let content = ''
  try {
    content = readFileSync(envExamplePath, 'utf-8')
  } catch {
    // 如果读取失败，使用默认模板
    content = getDefaultEnvTemplate()
  }

  // 替换关键配置
  content = content.replace(/NEXTAUTH_SECRET=.*/, `NEXTAUTH_SECRET=${nextauthSecret}`)
  content = content.replace(/SALT=.*/, `SALT=${salt}`)

  writeFileSync(envLocalPath, content)

  log(`✅ 已创建 ${ENV_LOCAL}`, 'green')
  log('', 'reset')
  log('📋 默认配置:', 'bright')
  log('   - Langfuse Web UI: http://localhost:3000', 'reset')
  log('   - MinIO Console:   http://localhost:9001', 'reset')
  log('   - Postgres:        localhost:5432', 'reset')
  log('   - 默认账号:        admin@example.com / admin', 'reset')
  log('', 'reset')
  log('⚠️  提示: 生产环境请修改默认密码和加密密钥！', 'yellow')
}

function getDefaultEnvTemplate() {
  return `# Langfuse 本地服务配置
LANGFUSE_MODE=local
LANGFUSE_BASE_URL=http://localhost:3000
LANGFUSE_PUBLIC_KEY=pk-lf-local-xxxxxxxx
LANGFUSE_SECRET_KEY=sk-lf-local-xxxxxxxx

# Docker 服务配置
POSTGRES_USER=langfuse
POSTGRES_PASSWORD=langfuse
POSTGRES_DB=langfuse
POSTGRES_PORT=5432

REDIS_PASSWORD=langfuse
REDIS_PORT=6379

MINIO_ROOT_USER=minio
MINIO_ROOT_PASSWORD=minio123
MINIO_PORT=9000
MINIO_CONSOLE_PORT=9001

LANGFUSE_PORT=3000
SALT=your-salt-here-min-32-chars-long!!
NEXTAUTH_SECRET=your-nextauth-secret-here
TELEMETRY_ENABLED=false
`
}

function getServiceDir() {
  return dirname(fileURLToPath(import.meta.url))
}

function cmdStart() {
  log('🚀 启动 Langfuse 本地服务...', 'bright')

  if (!checkDocker()) {
    log('❌ 请先安装 Docker 和 Docker Compose', 'red')
    log('   下载地址: https://www.docker.com/products/docker-desktop', 'dim')
    process.exit(1)
  }

  const serviceDir = getServiceDir()
  const composeFile = resolve(serviceDir, DOCKER_COMPOSE_FILE)

  if (!existsSync(composeFile)) {
    log(`❌ 未找到 ${DOCKER_COMPOSE_FILE}`, 'red')
    process.exit(1)
  }

  const root = getProjectRoot()
  const envFile = resolve(root, ENV_LOCAL)
  const envArgs = existsSync(envFile) ? `--env-file ${envFile}` : ''

  log('📦 拉取镜像并启动服务（首次启动可能需要几分钟）...', 'cyan')

  try {
    run(`docker-compose -f ${composeFile} ${envArgs} up -d`)

    log('', 'reset')
    log('✅ 服务启动成功！', 'green')
    log('', 'reset')
    log('📋 访问地址:', 'bright')
    log('   Langfuse UI:    http://localhost:3000', 'reset')
    log('   MinIO Console:  http://localhost:9001', 'reset')
    log('', 'reset')
    log('⏳ 等待服务初始化（约 10-30 秒）...', 'yellow')
    log('', 'reset')
    log('下一步:', 'bright')
    log('   1. 访问 http://localhost:3000', 'reset')
    log('   2. 使用默认账号登录: admin@example.com / admin', 'reset')
    log('   3. 创建项目并获取 API 密钥', 'reset')
    log('   4. 将密钥填入 .env.development.local', 'reset')
    log('   5. 重启 Electron 应用', 'reset')
  } catch (error) {
    log('', 'reset')
    log('❌ 启动失败', 'red')
    log('   尝试查看日志: node scripts/setup-langfuse-local.js logs', 'dim')
    process.exit(1)
  }
}

function cmdStop() {
  log('🛑 停止 Langfuse 本地服务...', 'bright')

  const serviceDir = getServiceDir()
  const composeFile = resolve(serviceDir, DOCKER_COMPOSE_FILE)

  if (!existsSync(composeFile)) {
    log(`❌ 未找到 ${DOCKER_COMPOSE_FILE}`, 'red')
    process.exit(1)
  }

  const root = getProjectRoot()
  const envFile = resolve(root, ENV_LOCAL)
  const envArgs = existsSync(envFile) ? `--env-file ${envFile}` : ''

  try {
    run(`docker-compose -f ${composeFile} ${envArgs} stop`)
    log('✅ 服务已停止', 'green')
  } catch {
    log('⚠️  部分服务停止失败', 'yellow')
  }
}

function cmdStatus() {
  log('📊 服务状态', 'bright')

  const serviceDir = getServiceDir()
  const composeFile = resolve(serviceDir, DOCKER_COMPOSE_FILE)

  if (!existsSync(composeFile)) {
    log(`❌ 未找到 ${DOCKER_COMPOSE_FILE}`, 'red')
    process.exit(1)
  }

  const root = getProjectRoot()
  const envFile = resolve(root, ENV_LOCAL)
  const envArgs = existsSync(envFile) ? `--env-file ${envFile}` : ''

  try {
    const output = run(`docker-compose -f ${composeFile} ${envArgs} ps`, { silent: true })
    if (output.trim()) {
      console.log(output)
    } else {
      log('ℹ️  没有运行中的服务', 'dim')
    }
  } catch {
    log('ℹ️  无法获取服务状态，请检查 Docker 是否运行', 'yellow')
  }
}

function cmdLogs() {
  log('📜 查看服务日志（按 Ctrl+C 退出）...', 'bright')

  const serviceDir = getServiceDir()
  const composeFile = resolve(serviceDir, DOCKER_COMPOSE_FILE)

  if (!existsSync(composeFile)) {
    log(`❌ 未找到 ${DOCKER_COMPOSE_FILE}`, 'red')
    process.exit(1)
  }

  const root = getProjectRoot()
  const envFile = resolve(root, ENV_LOCAL)
  const envArgs = existsSync(envFile) ? `--env-file ${envFile}` : ''

  try {
    run(`docker-compose -f ${composeFile} ${envArgs} logs -f`, { ignoreError: true })
  } catch {
    // 用户按 Ctrl+C 退出
  }
}

async function cmdReset() {
  log('⚠️  警告: 此操作将删除所有 Langfuse 数据！', 'red')
  log('   包括: 追踪记录、项目配置、用户账号', 'red')
  log('', 'reset')

  // 简单的确认机制
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  const answer = await new Promise((resolve) => {
    rl.question('确认删除所有数据? 请输入 "RESET" 继续: ', (ans) => {
      rl.close()
      resolve(ans.trim())
    })
  })

  if (answer !== 'RESET') {
    log('❌ 操作已取消', 'yellow')
    process.exit(0)
  }

  const serviceDir = getServiceDir()
  const composeFile = resolve(serviceDir, DOCKER_COMPOSE_FILE)

  if (!existsSync(composeFile)) {
    log(`❌ 未找到 ${DOCKER_COMPOSE_FILE}`, 'red')
    process.exit(1)
  }

  const root = getProjectRoot()
  const envFile = resolve(root, ENV_LOCAL)
  const envArgs = existsSync(envFile) ? `--env-file ${envFile}` : ''

  try {
    log('🗑️  正在删除数据...', 'yellow')
    run(`docker-compose -f ${composeFile} ${envArgs} down -v`)
    log('✅ 数据已清除', 'green')
    log('   请重新运行: node scripts/setup-langfuse-local.js start', 'dim')
  } catch {
    log('❌ 删除失败', 'red')
  }
}

// 主程序
async function main() {
  const command = process.argv[2] || 'help'

  if (!COMMANDS.includes(command)) {
    log(`❌ 未知命令: ${command}`, 'red')
    log('   运行 "node scripts/setup-langfuse-local.js help" 查看帮助', 'dim')
    process.exit(1)
  }

  switch (command) {
    case 'init':
      await cmdInit()
      break
    case 'start':
      cmdStart()
      break
    case 'stop':
      cmdStop()
      break
    case 'status':
      cmdStatus()
      break
    case 'logs':
      cmdLogs()
      break
    case 'reset':
      await cmdReset()
      break
    case 'help':
    default:
      showHelp()
      break
  }
}

main().catch((error) => {
  log(`❌ 错误: ${error.message}`, 'red')
  process.exit(1)
})
