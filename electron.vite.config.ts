import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const aliasSrc = resolve(__dirname, 'src')
const aliasShared = resolve(__dirname, 'src/shared')
/** monaco-themes 未在 package exports 中暴露 themes/，需直连磁盘路径供 Vite 解析 */
const monacoGithubLightThemeJson = resolve(
  rootDir,
  'node_modules/monaco-themes/themes/GitHub Light.json'
)

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@': aliasSrc,
        '@shared': aliasShared
      }
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@': aliasSrc,
        '@shared': aliasShared
      }
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      // 沙箱内 preload 以非 ES 模块方式执行，需输出 CJS
      lib: {
        entry: resolve(rootDir, 'src/preload/index.ts'),
        formats: ['cjs']
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@': aliasSrc,
        '@shared': aliasShared,
        '@monaco-themes/github-light': monacoGithubLightThemeJson
      }
    },
    /** monaco-editor 的 language workers 与 dep optimizer 不兼容，预构建会生成缺失的 html.worker 等路径 */
    optimizeDeps: {
      exclude: ['monaco-editor']
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    plugins: [react()]
  }
})
