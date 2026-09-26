import { readFileSync, realpathSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const prod = Boolean(process.env['PRODUCTION'])
const vaultPath = process.env['VAULT_PATH']
const outDir = vaultPath ? `${vaultPath}/.obsidian/plugins/casefile` : '.'

// The only third-party code main.js inlines. Their MIT licences ask for the
// notice in every copy, and an install from a release downloads main.js,
// manifest.json and styles.css only, so the notices travel inside main.js.
// deps.onlyBundle below fails the build if anything else gets bundled, so a
// new dependency cannot ship without its notice being added here.
const BUNDLED = ['temporal-polyfill', 'temporal-utils']
// ponytail: each package is looked up as a sibling of temporal-polyfill's real
// folder, which is where pnpm (and a flat npm install) put its dependencies. A
// nested install makes the read throw, so the build stops rather than ships
// without a notice.
const packages = join(realpathSync(fileURLToPath(new URL('node_modules/temporal-polyfill', import.meta.url))), '..')
const notices = BUNDLED.map(
  (name) => `${name}:\n\n${readFileSync(join(packages, name, 'LICENSE'), 'utf8').trim()}`
).join('\n\n')
// A "*/" in a licence would end the comment early and leave the rest as code.
if (notices.includes('*/')) throw new Error('A bundled licence contains "*/" and cannot go in a comment banner')

export default defineConfig({
  entry: 'src/main.ts',
  format: 'cjs',
  target: 'es2022',
  outDir,
  platform: 'node',
  dts: false,
  minify: prod,
  sourcemap: prod ? false : 'inline',
  clean: false,
  hash: false,
  outExtensions: () => ({ js: '.js' }),
  // "/*!" marks a comment the minifier must keep.
  banner: `/*! Responder bundles the following third-party code.\n\n${notices}\n*/`,
  define: {
    __STYLEGUIDE__: JSON.stringify(!prod || Boolean(process.env['STYLEGUIDE']))
  },
  deps: {
    onlyBundle: BUNDLED,
    neverBundle: [
      'obsidian',
      'electron',
      '@codemirror/autocomplete',
      '@codemirror/collab',
      '@codemirror/commands',
      '@codemirror/language',
      '@codemirror/lint',
      '@codemirror/search',
      '@codemirror/state',
      '@codemirror/view',
      '@lezer/common',
      '@lezer/highlight',
      '@lezer/lr',
      ...builtinModules
    ]
  }
})
