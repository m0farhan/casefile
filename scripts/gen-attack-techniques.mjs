// Regenerates src/data/attack-techniques.json from MITRE's CC-BY-4.0 ATT&CK
// STIX data (network at generation time only; the JSON is checked in and
// bundled into main.js so the plugin itself never touches the network).
// Run: node scripts/gen-attack-techniques.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC =
  'https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/enterprise-attack/enterprise-attack.json'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'src/data/attack-techniques.json')

const res = await fetch(SRC)
if (!res.ok) throw new Error(`fetch failed: ${res.status}`)
const bundle = await res.json()

const techniques = bundle.objects
  .filter(
    (o) =>
      o.type === 'attack-pattern' &&
      !o.revoked &&
      !o.x_mitre_deprecated &&
      Array.isArray(o.external_references) &&
      o.external_references[0]?.source_name === 'mitre-attack'
  )
  .map((o) => ({ id: o.external_references[0].external_id, name: o.name }))
  .sort((a, b) => a.id.localeCompare(b.id))

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(techniques, null, 0) + '\n')
console.log(`${techniques.length} techniques -> ${out}`)
