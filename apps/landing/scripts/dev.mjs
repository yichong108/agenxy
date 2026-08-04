import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

/**
 * 启动 Next.js 开发服务器，并禁止自动打开浏览器
 *
 * Next / 底层 open 会读取 BROWSER；设为 none 后启动不再拉起默认浏览器。
 * 使用独立脚本以便在 Windows 上也能正确注入环境变量（无需 cross-env）。
 */
const require = createRequire(import.meta.url)
const nextBin = require.resolve('next/dist/bin/next')

const child = spawn(process.execPath, [nextBin, 'dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    BROWSER: 'none'
  }
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
