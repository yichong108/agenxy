import path from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

/**
 * Vite 配置 — 后台管理前端
 *
 * 开发默认端口 5174，避免与 landing / 其它本地服务冲突。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.join(rootDir, 'src')
    }
  },
  server: {
    port: 5174,
    host: '127.0.0.1',
    // 开发启动时不自动打开浏览器
    open: false
  }
})
