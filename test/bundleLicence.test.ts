// The release ships main.js, manifest.json and styles.css and nothing else, so
// the licence notices of the code main.js bundles have to be inside main.js.
// This runs the real production build (the same one `build:js` runs) into a
// throwaway vault folder and reads what came out, because the minifier is what
// could drop the notice.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const vault = mkdtempSync(join(tmpdir(), 'responder-build-'))
afterAll(() => rmSync(vault, { recursive: true, force: true }))

describe('production main.js', () => {
  it('opens with the MIT notice of every bundled package', () => {
    execFileSync(process.execPath, [join(root, 'node_modules/tsdown/dist/run.mjs')], {
      cwd: root,
      env: { ...process.env, PRODUCTION: '1', VAULT_PATH: vault },
      stdio: 'pipe'
    })
    const main = readFileSync(join(vault, '.obsidian/plugins/casefile/main.js'), 'utf8')
    const banner = main.slice(0, main.indexOf('*/'))
    expect(banner.startsWith('/*!')).toBe(true)
    for (const name of ['temporal-polyfill', 'temporal-utils']) {
      expect(banner).toContain(`${name}:\n\nMIT License\n\nCopyright`)
    }
    // One full permission notice per package, not a one-line credit.
    expect(banner.split('The above copyright notice and this permission notice shall be included').length - 1).toBe(2)
  })
})
