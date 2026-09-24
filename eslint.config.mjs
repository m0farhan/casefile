import tsparser from '@typescript-eslint/parser'
import { defineConfig } from 'eslint/config'
import obsidianmd from 'eslint-plugin-obsidianmd'

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: './tsconfig.json' },
      globals: { __STYLEGUIDE__: 'readonly' }
    }
  },
  {
    files: ['src/views/table/**/*.ts'],
    rules: {
      'obsidianmd/no-static-styles-assignment': 'off'
    }
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'obsidianmd/ui/sentence-case': ['error', { ignoreWords: ['TaskNotes'] }]
    }
  },
  {
    // Tests never run inside Obsidian. The popout-window rule exists so the
    // plugin reaches the right window at runtime; a node test has no window,
    // and a test of the "this device has no DecompressionStream" path has to
    // reach for the global to take it away.
    files: ['src/**/*.test.ts'],
    rules: {
      'obsidianmd/no-global-this': 'off'
    }
  }
])
