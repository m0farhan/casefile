// Builds a portable install bundle: dist/casefile-<version>.zip containing
// main.js, styles.css and manifest.json — unzip into any vault's
// .obsidian/plugins/casefile/ folder. Fully offline, no dev tooling needed
// on the target machine.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const stage = join(root, 'dist', 'casefile')
const zip = join(root, 'dist', `casefile-${version}.zip`)

// Production build into the repo root (VAULT_PATH deliberately unset).
// npm_execpath = the package manager that invoked this script (works under corepack).
const pm = process.env.npm_execpath
const buildEnv = { ...process.env, VAULT_PATH: '' }
if (pm) execFileSync(process.execPath, [pm, 'build'], { cwd: root, stdio: 'inherit', env: buildEnv })
else execFileSync('pnpm', ['build'], { cwd: root, stdio: 'inherit', env: buildEnv })

rmSync(join(root, 'dist'), { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
for (const f of ['main.js', 'styles.css', 'manifest.json']) {
  copyFileSync(join(root, f), join(stage, f))
}
execFileSync('zip', ['-qr', zip, 'casefile'], { cwd: join(root, 'dist'), stdio: 'inherit' })
console.log(`packaged ${zip}`)
