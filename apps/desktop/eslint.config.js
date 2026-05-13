import path from 'node:path'
import { fileURLToPath } from 'node:url'

import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import importPlugin from 'eslint-plugin-import'
import prettierPlugin from 'eslint-plugin-prettier'
import eslintConfigPrettier from 'eslint-config-prettier'

const repoRoot = fileURLToPath(new URL('.', import.meta.url))

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'release/**',
      'node_modules/**',
      'eslint.config.js',
      'src/extensions/**',
      'src/skills/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    plugins: {
      import: importPlugin,
      prettier: prettierPlugin
    },
    settings: {
      'import/resolver': {
        // typescript 解析器在 bundler + 多 tsconfig 下对 paths 偶发失效；alias 做显式兜底
        alias: {
          map: [['@', path.join(repoRoot, 'src')]],
          extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.scss', '.css']
        },
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx', '.d.ts', '.json', '.scss']
        },
        typescript: {
          project: [
            path.join(repoRoot, 'tsconfig.web.json'),
            path.join(repoRoot, 'tsconfig.node.json')
          ],
          alwaysTryTypes: true,
          noWarnOnMultipleProjects: true
        }
      }
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'import/no-unresolved': 'error',
      'import/order': [
        'warn',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          alphabetize: { order: 'asc', caseInsensitive: true },
          'newlines-between': 'always'
        }
      ],
      'prettier/prettier': 'warn'
    }
  },
  eslintConfigPrettier
)
