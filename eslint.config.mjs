import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginSvelte from 'eslint-plugin-svelte'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '.bench/**',
      'private/**',
      'design/**',
      'src/main/appframe/shim.js',
      'src/main/appframe/export-shim.js',
      'src/main/appframe/slider-shim.js'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginSvelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser
      }
    }
  },
  {
    files: ['**/*.{tsx,svelte}'],
    rules: {
      'svelte/no-unused-svelte-ignore': 'off'
    }
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  eslintConfigPrettier
)
