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
const aliasSrc = resolve(rootDir, 'src')
const aliasUniAgent = resolve(rootDir, '../../packages/uni-agent/src/index.ts')
const aliasAgent = resolve(rootDir, '../../packages/agent/src/index.ts')
const aliasCursorAgent = resolve(rootDir, '../../packages/cursor-agent/src/index.ts')
const aliasShared = resolve(rootDir, '../../packages/shared/src/index.ts')
/** 内置 skills 内容根目录（开发/未打包时由 define 注入，避免打包后 import.meta.url 漂移） */
const bundledSkillsDir = resolve(rootDir, '../../packages/skills/content')
/** monaco-themes 未在 package exports 中暴露 themes/，需直连磁盘路径供 Vite 解析 */
const monacoGithubLightThemeJson = resolve(
  rootDir,
  'node_modules/monaco-themes/themes/GitHub Light.json'
)

export default defineConfig({
  main: {
    define: {
      __OPENWORKERER_GIT_COMMIT__: JSON.stringify(readGitShortHash(rootDir)),
      __OPENWORKERER_BUILD_ISO__: JSON.stringify(new Date().toISOString()),
      __OPENWORKERER_BUNDLED_SKILLS_DIR__: JSON.stringify(bundledSkillsDir)
    },
    resolve: {
      alias: {
        '@': aliasSrc,
        '@openworker/uni-agent': aliasUniAgent,
        // uni-agent 源码打包时解析其后端依赖
        '@openworker/agent': aliasAgent,
        '@openworker/cursor-agent': aliasCursorAgent,
        '@openworker/shared': aliasShared
      }
    },
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@openworker/uni-agent',
          '@openworker/agent',
          '@openworker/cursor-agent',
          '@openworker/shared'
        ]
      })
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve(rootDir, 'src/main/index.ts')
        },
        // Cursor SDK 含原生二进制，保持 external 由 Node/Electron 解析
        external: [/^@cursor\//]
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@': aliasSrc,
        '@openworker/uni-agent': aliasUniAgent,
        '@openworker/agent': aliasAgent,
        '@openworker/cursor-agent': aliasCursorAgent,
        '@openworker/shared': aliasShared
      }
    },
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@openworker/uni-agent',
          '@openworker/agent',
          '@openworker/cursor-agent',
          '@openworker/shared'
        ]
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
          index: resolve(rootDir, 'src/renderer/index.html')
        }
      }
    },
    plugins: [react()]
  }
})
