import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

function readGitShortHash(cwd: string): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}
const aliasSrc = resolve(__dirname, 'src')
const aliasAgent = resolve(__dirname, '../../packages/agent/src/index.ts')
const aliasShared = resolve(__dirname, '../../packages/shared/src/index.ts')
/** monaco-themes 未在 package exports 中暴露 themes/，需直连磁盘路径供 Vite 解析 */
const monacoGithubLightThemeJson = resolve(
  rootDir,
  'node_modules/monaco-themes/themes/GitHub Light.json'
)

export default defineConfig({
  main: {
    define: {
      __OPENWORK_GIT_COMMIT__: JSON.stringify(readGitShortHash(rootDir)),
      __OPENWORK_BUILD_ISO__: JSON.stringify(new Date().toISOString())
    },
    resolve: {
      alias: {
        '@': aliasSrc,
        '@openwork/agent': aliasAgent,
        '@openwork/shared': aliasShared
      }
    },
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@openwork/agent', '@openwork/shared']
      })
    ],
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
        '@openwork/agent': aliasAgent,
        '@openwork/shared': aliasShared
      }
    },
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@openwork/agent', '@openwork/shared']
      })
    ],
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
      /**
       * 强制渲染进程只使用同一份 React，避免 antd App.useApp 与 Provider
       * 落到不同 React 实例上出现 useContext(null)。
       */
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': aliasSrc,
        '@monaco-themes/github-light': monacoGithubLightThemeJson,
        react: resolve(rootDir, 'node_modules/react'),
        'react-dom': resolve(rootDir, 'node_modules/react-dom')
      }
    },
    /** monaco-editor 的 language workers 与 dep optimizer 不兼容，预构建会生成缺失的 html.worker 等路径 */
    optimizeDeps: {
      exclude: ['monaco-editor'],
      include: ['react', 'react-dom', 'antd']
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
