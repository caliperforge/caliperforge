import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import { manifest } from './checks/manifest.ts'

const { ceilings } = manifest(import.meta.dirname)

export default defineConfig(
  { ignores: ['checks/fixtures/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
    rules: {
      'max-depth': ['error', ceilings.nesting],
      'max-lines-per-function': ['error', { max: ceilings.function_lines }],
      'no-console': 'error',
      'no-unreachable-loop': 'error',
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx'] }],
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { args: 'all' }],
    },
  },
)
