/**
 * 将 CLI 入口与 workspace 包打成可 node 执行的 ESM 产物。
 * `@vscode/ripgrep` 含平台二进制，保持 external，运行时从 node_modules 解析。
 */
import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  // 原生二进制；其余依赖打进 bundle
  external: ['@vscode/ripgrep'],
  // 兼容被打进 ESM 的 CJS 包（如 dotenv）里的动态 require
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
  }
})
