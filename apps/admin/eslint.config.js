import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import prettierPlugin from 'eslint-plugin-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'eslint.config.js', 'vite.config.ts']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    },
    plugins: {
      prettier: prettierPlugin
    },
    rules: {
      'prettier/prettier': 'warn'
    }
  },
  eslintConfigPrettier
)
