import type { Ioc, IocType, Task } from '../types'
import { flattenTasks } from '../store/TaskTreeOps'

export const IOC_TYPE_LABELS: Record<IocType, string> = {
  ip: 'IP',
  domain: 'Domain',
  hash: 'Hash',
  url: 'URL',
  email: 'Email'
}

export const IOC_TYPE_ICONS: Record<IocType, string> = {
  ip: 'network',
  domain: 'globe',
  hash: 'hash',
  url: 'link',
  email: 'mail'
}

/**
 * Defang an IOC for display so it is never click- or copy-hazardous:
 * http→hxxp, dots→[.], @→[at]. The stored value stays real; only rendering
 * defangs. Hashes pass through untouched (nothing to neutralize).
 */
export function defangIoc(value: string, type: IocType): string {
  if (type === 'hash') return value
  let out = value.replace(/^(\s*)https?/i, (m) => m.replace(/http/i, (h) => (h === 'HTTP' ? 'HXXP' : 'hxxp')))
  out = out.replace(/\./g, '[.]')
  if (type === 'email' || type === 'url') out = out.replace(/@/g, '[at]')
  return out
}

/**
 * Undo the common defang forms so pasted report indicators are stored real:
 * hxxp→http, [.]/(.)→., [at]/(at)/[@]→@, [:]→:. Inverse of defangIoc plus
 * the variants seen in vendor reports. Idempotent on already-real values.
 */
// ponytail: covers the defang forms in real CTI reports; extend the map if a new one shows up
export function refangIoc(value: string): string {
  return value
    .trim()
    .replace(/^hxxp/i, (h) => (h === 'HXXP' ? 'HTTP' : 'http'))
    .replace(/[[(]\.[\])]/g, '.')
    .replace(/[[(]at[\])]/gi, '@')
    .replace(/\[@\]/g, '@')
    .replace(/\[:\]/g, ':')
}

/** Appended wherever an indicator leaves the UI (handover, copied block, report). */
export const OWN_ASSET_SUFFIX = ' (own asset)'

/**
 * One display line per indicator: 'type: defangedValue — note' (note only when
 * present), with ' (own asset)' when the value names the analyst's own estate.
 * `owned` is required, not defaulted: a copied block or a handover note that
 * quietly drops the mark is the honesty hole this change exists to close.
 */
export function formatIocLine(ioc: Ioc, owned: string[]): string {
  const line = `${ioc.type}: ${defangIoc(ioc.value, ioc.type)}`
  const note = ioc.note ? `${line} — ${ioc.note}` : line
  return assetRule(ioc.value, owned) ? note + OWN_ASSET_SUFFIX : note
}

/**
 * Turn a pasted blob into new indicator rows: split on whitespace/commas,
 * refang and classify each token, drop anything already on the task
 * (case-insensitive over refanged values — stored values may predate
 * refang-on-intake) and repeats within the paste itself.
 */
export function parseIocPaste(text: string, existingValues: string[]): Ioc[] {
  const seen = new Set(existingValues.map((v) => refangIoc(v).toLowerCase()))
  const out: Ioc[] = []
  for (const token of text.split(/[\s,]+/)) {
    const value = refangIoc(token)
    // Shape gate (SD-06): a paste splits on whitespace, so alert labels
    // ("SHA256:", "Sender") used to fall through detectIocType's final
    // `return 'domain'` and land as indicator rows. The caller reports the
    // drop count separately from the duplicate count — two reasons, never merged.
    if (!value || !hasIocShape(value)) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ type: detectIocType(value), value })
  }
  return out
}

/** Minimum gap between VirusTotal-bearing lookups: free tier is 4/minute. */
// ponytail: 15.5s keeps a whole run safely under 4/min with clock-jitter margin
export const VT_PACE_MS = 15500

/**
 * Pacing decision for the check-all run: given the start timestamps of prior
 * VirusTotal-bearing lookups, how long to wait before starting the next one.
 * No prior calls = start immediately. Pure — the caller supplies `now`.
 */
export function vtWaitMs(prevVtStarts: number[], now: number): number {
  if (!prevVtStarts.length) return 0
  return Math.max(0, VT_PACE_MS - (now - Math.max(...prevVtStarts)))
}

/**
 * Cases (other than `excludeTaskId`) whose indicators contain the same real
 * value: both sides refang (idempotent on real values) and compare
 * case-insensitively, so a defanged query still finds a real stored value and
 * vice versa. Subtasks are searched too.
 */
export function iocSightings(
  value: string,
  tasks: Task[],
  excludeTaskId: string,
  owned: string[]
): { taskId: string; key: string; title: string }[] {
  const needle = refangIoc(value).toLowerCase()
  if (!needle) return []
  // An asset sits on half the cases by definition, so pivoting on one links
  // every case to every other (SD-05). Still recorded, still marked, never a
  // sighting — and the row says so rather than rendering nothing, which would
  // read as "never seen anywhere else".
  if (assetRule(needle, owned)) return []
  const out: { taskId: string; key: string; title: string }[] = []
  for (const { task } of flattenTasks(tasks)) {
    if (task.id === excludeTaskId) continue
    if (task.iocs.some((i) => refangIoc(i.value).toLowerCase() === needle)) {
      out.push({ taskId: task.id, key: task.key, title: task.title })
    }
  }
  return out
}

/** Classify a (refanged) indicator: hex hash, IP literal, scheme://=url, @=email, else domain. */
export function detectIocType(value: string): IocType {
  const v = value.trim()
  if (/^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(v)) return 'hash'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return 'url'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return 'ip'
  if (v.includes(':') && /^[0-9a-f:]+$/i.test(v)) return 'ip'
  if (v.includes('@')) return 'email'
  return 'domain'
}

/** Defanged-or-real fragment patterns for prose scanning. */
const RE_URL = /\bh(?:xx|tt)ps?(?:\[:\]|:)\/\/[^\s<>"')]+/gi
const RE_IP = /\b\d{1,3}(?:(?:\[\.\]|\(\.\)|\.)\d{1,3}){3}\b/g
const RE_HASH = /\b[a-f0-9]{64}\b|\b[a-f0-9]{40}\b|\b[a-f0-9]{32}\b/gi
const RE_EMAIL = /\b[\w.+-]+(?:@|\[at\]|\(at\))[\w-]+(?:(?:\[\.\]|\(\.\)|\.)[\w-]+)+\b/gi
const RE_DEFANGED_DOMAIN = /\b[\w-]+(?:(?:\[\.\]|\(\.\))[\w-]+)+\b/g
// ponytail: bare (non-defanged) domains in prose need a TLD gate or every
// "file.js" becomes an indicator; extend the list when a real miss shows up.
const BARE_DOMAIN_TLDS = new Set([
  'com',
  'net',
  'org',
  'io',
  'ru',
  'cn',
  'info',
  'biz',
  'co',
  'uk',
  'de',
  'fr',
  'xyz',
  'top',
  'online',
  'site',
  'club',
  'live',
  'pw',
  'cc',
  'su',
  'tk',
  'ws'
])
const RE_BARE_DOMAIN = /\b[\w-]+(?:\.[\w-]+)+\b/g

function validIp(v: string): boolean {
  return v.split('.').every((o) => Number(o) <= 255)
}

/**
 * Scan free prose (a case note) for indicators — defanged or real — and
 * return the NEW ones as typed rows, deduped against `existingValues` and
 * within the scan, in order of first appearance. Conservative by design:
 * bare domains must end in a known TLD; everything else matches by shape.
 */
export function extractIocsFromText(text: string, existingValues: string[]): Ioc[] {
  const seen = new Set(existingValues.map((v) => refangIoc(v).toLowerCase()))
  const out: Ioc[] = []
  const found: { index: number; value: string }[] = []
  const collect = (re: RegExp, filter?: (v: string) => boolean) => {
    for (const m of text.matchAll(re)) {
      const raw = m[0].replace(/[),.;:!?'"\]]+$/, '')
      const value = refangIoc(raw)
      if (filter && !filter(value)) continue
      found.push({ index: m.index ?? 0, value })
    }
  }
  collect(RE_URL)
  collect(RE_IP, validIp)
  collect(RE_HASH)
  collect(RE_EMAIL)
  collect(RE_DEFANGED_DOMAIN, (v) => v.includes('.') && !/^\d+(\.\d+)*$/.test(v))
  collect(RE_BARE_DOMAIN, (v) => {
    const labels = v.toLowerCase().split('.')
    return labels.length >= 2 && BARE_DOMAIN_TLDS.has(labels[labels.length - 1])
  })
  found.sort((a, b) => a.index - b.index)
  for (const f of found) {
    const key = f.value.toLowerCase()
    if (seen.has(key)) continue
    // Skip fragments of an already-captured longer indicator (ip inside url is
    // kept deliberately: both are real indicators with distinct values).
    seen.add(key)
    out.push({ type: detectIocType(f.value), value: f.value })
  }
  return out
}

// ─── Asset boundary ──────────────────────────────────────────────────────────

/** What the boundary matched, and who declared it — the badge must not confuse the two. */
export interface AssetMatch {
  /** The settings entry verbatim, or the built-in range, as shown on the badge. */
  rule: string
  /** True = a private/loopback/link-local range built in here, absent from settings. */
  builtIn: boolean
}

/** Private, loopback and link-local IPv4 — internal by definition, never configured. */
const BUILT_IN_V4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16']

/** A host shape: dot-separated labels ending in an alphabetic TLD. Non-ASCII labels
 *  are allowed so an IDN survives; the alphabetic TLD is what keeps a half-typed
 *  address ("198.51.100", "10") from ever becoming a live suffix rule. */
const RE_HOST_SHAPE = /^(?=.{1,253}$)[^\s./:@]+(?:\.[^\s./:@]+)*\.[a-z¡-￿]{2,}$/i
const RE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/** Dotted quad → uint32; null when the value is not an IPv4 literal. */
function ipv4(value: string): number | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const octet of parts) {
    if (!/^\d{1,3}$/.test(octet)) return null
    const b = Number(octet)
    if (b > 255) return null
    n = n * 256 + b
  }
  return n >>> 0
}

/** uint32 → dotted quad. */
function ipv4Text(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

/**
 * An IPv6 literal expanded to its eight group values, or null when the value is
 * not one. A trailing dotted quad (::ffff:10.0.0.5) folds into two hex groups
 * first, so every spelling of one address normalizes identically — ::1 and
 * 0:0:0:0:0:0:0:1 are the same eight numbers. A clock (12:34:56) and a MAC
 * (08:00:27:12:34:56) are neither compressed nor eight groups, so both are null.
 */
function ipv6(value: string): number[] | null {
  const v = value.toLowerCase()
  if (!v.includes(':') || !/^[0-9a-f:.]+$/.test(v)) return null
  let body = v
  const quad = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(body)
  if (quad) {
    const n = ipv4(quad[2])
    if (n === null) return null
    body = `${quad[1]}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`
  } else if (body.includes('.')) return null
  const halves = body.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return null
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail]
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => parseInt(g, 16))
}

/** The IPv4 an IPv4-MAPPED address carries (::ffff:a.b.c.d), else null. */
// ponytail: mapped only. IPv4-COMPATIBLE (::a.b.c.d) is deprecated and would
// collide with ::1; add it here if one ever turns up in a real case.
function mappedV4(g: number[]): number | null {
  if (g.slice(0, 5).some((x) => x !== 0) || g[5] !== 0xffff) return null
  return (g[6] * 65536 + g[7]) >>> 0
}

/** The built-in IPv6 range this address is in — by arithmetic, not by text prefix. */
function builtInV6(g: number[]): string | null {
  if (g.every((x, i) => (i < 7 ? x === 0 : x === 1))) return 'IPv6 loopback ::1'
  const top = g[0] >>> 8
  if (top === 0xfc || top === 0xfd) return 'IPv6 unique-local fc00::/7'
  if ((g[0] & 0xffc0) === 0xfe80) return 'IPv6 link-local fe80::/10'
  return null
}

/**
 * The host an indicator points at — a URL's hostname, an email's domain, or the
 * value itself — refanged, lowercased, de-ported, de-bracketed, de-zoned.
 * Canonical: an IPv6 literal comes back expanded, and an IPv4-mapped one
 * (::ffff:10.0.0.5 — what Java, nginx and Windows event logs emit for internal
 * clients, and what new URL() turns into ::ffff:a00:5) comes back as its dotted
 * quad, so it is judged on the IPv4 side.
 *
 * A URL the parser rejects is stripped BY HAND rather than waved through:
 * returning '' there would make http://10.0.0.5:99999/a "not an asset" and send
 * the internal host to VirusTotal.
 *
 * A hash comes back as itself. It can never match a rule, because every rule
 * form contains a dot or a colon and a hash contains neither.
 */
export function hostOf(value: string): string {
  let v = refangIoc(value).toLowerCase()
  if (RE_SCHEME.test(v)) {
    try {
      v = new URL(v).hostname
    } catch {
      v = v
        .replace(RE_SCHEME, '')
        .replace(/^[^/@]*@/, '')
        .replace(/[/?#].*$/, '')
    }
  } else {
    const at = v.lastIndexOf('@')
    if (at >= 0) v = v.slice(at + 1)
    v = v.replace(/[/?#].*$/, '')
  }
  v = v.split(/\s/)[0]
  v = v.replace(/^\[([^\]]*)\](?::\d+)?$/, '$1') // [fe80::1]:443
  const port = /^(.*):\d+$/.exec(v) // an IPv6 body keeps a second colon, so it is never stripped
  if (port && !port[1].includes(':')) v = port[1]
  v = v.replace(/\.$/, '').split('%')[0]
  const g = ipv6(v)
  if (!g) return v
  const m = mappedV4(g)
  return m === null ? g.map((x) => x.toString(16)).join(':') : ipv4Text(m)
}

type AssetRuleSpec =
  | { kind: 'v4'; net: number; mask: number }
  | { kind: 'v6'; addr: string }
  | { kind: 'host'; host: string }

/**
 * One listed entry → the rule it means, or null when the boundary cannot match
 * it. `unmatchableAssetRules` is exactly "this returned null", so a shape the
 * matcher ignores is always named in settings instead of reading as cover.
 *
 * The mask has NO default: '10.0.0.0/'.split('/') gives ['10.0.0.0',''], and a
 * `= '32'` default does not fire on '' — Number('') is 0, which would mask
 * nothing and mark every IPv4 on every case as the analyst's own.
 *
 * A host rule must end in an alphabetic TLD, which is what stops a half-typed
 * address ('10', '198.51.100') becoming a live suffix rule when the settings
 * textarea saves mid-word.
 */
function parseAssetRule(raw: string): AssetRuleSpec | null {
  // A leading *. is firewall habit; *.corp.example means corp.example, which
  // also covers the apex — erring toward not-sending.
  const text = raw.trim().toLowerCase().replace(/^\*\./, '')
  if (!text || text.startsWith('#')) return null
  const slash = text.indexOf('/')
  if (slash >= 0) {
    const net = ipv4(text.slice(0, slash))
    const bits = text.slice(slash + 1)
    // ponytail: IPv4 CIDR only — an IPv6 range needs bigint masking. An IPv6
    // ADDRESS still matches exactly below, and a listed IPv6 range is named by
    // unmatchableAssetRules rather than silently ignored.
    if (net === null || !/^\d{1,2}$/.test(bits) || Number(bits) > 32) return null
    const n = Number(bits)
    return { kind: 'v4', net, mask: n === 0 ? 0 : (-1 << (32 - n)) >>> 0 }
  }
  // Same normalizer as the value side, so 2001:db8::5 and 2001:0db8:0:0:0:0:0:5
  // are one rule and an IPv4-mapped entry lands on the IPv4 branch.
  const host = hostOf(text)
  const quad = ipv4(host)
  if (quad !== null) return { kind: 'v4', net: quad, mask: 0xffffffff }
  if (host.includes(':')) return ipv6(host) ? { kind: 'v6', addr: host } : null
  return RE_HOST_SHAPE.test(host) ? { kind: 'host', host } : null
}

/** Is this IPv4 inside `rule`? False when `rule` is not an IPv4 CIDR or literal. */
function inV4(addr: number, rule: string): boolean {
  const spec = parseAssetRule(rule)
  return spec?.kind === 'v4' && (addr & spec.mask) >>> 0 === (spec.net & spec.mask) >>> 0
}

/**
 * The asset boundary: the rule this indicator matched — the org's own estate —
 * or null. Analyst-owned (`owned` comes from settings; nothing is guessed),
 * plus the private/loopback/link-local ranges, which need no configuration and
 * are reported as builtIn so the badge does not attribute them to the analyst.
 *
 * Judged on the VALUE's shape, not the row's declared type, so re-typing a row
 * cannot walk an internal address past the boundary. Branching once on that
 * shape is what keeps a DOMAIN rule from suffix-matching an IP literal: without
 * it the entry '10' silently owns 203.0.113.10.
 *
 * This decides only what is never sent and what is marked — an asset stays
 * recorded on the case.
 */
export function assetRule(value: string, owned: string[]): AssetMatch | null {
  const host = hostOf(value)
  if (!host) return null
  const quad = ipv4(host)
  const g = quad === null ? ipv6(host) : null
  if (quad !== null) {
    for (const rule of BUILT_IN_V4) if (inV4(quad, rule)) return { rule, builtIn: true }
  } else if (g) {
    const built = builtInV6(g)
    if (built) return { rule: built, builtIn: true }
  }
  for (const raw of owned) {
    const spec = parseAssetRule(raw)
    if (!spec) continue
    const hit =
      spec.kind === 'v4'
        ? quad !== null && (quad & spec.mask) >>> 0 === (spec.net & spec.mask) >>> 0
        : spec.kind === 'v6'
          ? host === spec.addr
          : // Label boundary, and never against an IP literal: corp.example
            // matches mail.corp.example, not evilcorp.example.
            quad === null && !g && (host === spec.host || host.endsWith('.' + spec.host))
    if (hit) return { rule: raw.trim(), builtIn: false }
  }
  return null
}

/** Listed entries the boundary cannot match — named in settings, never silently ignored. */
export function unmatchableAssetRules(owned: string[]): string[] {
  return owned.filter((raw) => raw.trim() && !parseAssetRule(raw))
}

/**
 * Does this token have the shape of an indicator at all? Says nothing about
 * reputation. Tests the HOST, not the raw token, so a scheme-less URL with a
 * path (evil[.]com/payload.exe — the most common form in a vendor report), a
 * host:port and a trailing-dot domain all survive, while "SHA256:", "Sender",
 * "2026-09-20", a clock and a MAC do not.
 *
 * Deliberately NOT a TLD allowlist: victim.gov.ie must survive. The
 * "invoice.docx becomes a domain" class is CP-05's observable-type work, not
 * this change's — and extractIocsFromText's BARE_DOMAIN_TLDS already drops
 * victim.gov.ie today, so the two ingest paths already differ; this narrows
 * that gap rather than opening it.
 */
export function hasIocShape(value: string): boolean {
  const v = refangIoc(value)
  if (!v) return false
  // Even-length hex 32–128 covers md5/sha1/sha224/sha256/sha512.
  if (/^[0-9a-f]{32,128}$/i.test(v) && v.length % 2 === 0) return true
  if (/^[a-z][a-z0-9+.-]*:\/\/\S/i.test(v)) return true
  const host = hostOf(v)
  if (!host) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return validIp(host)
  if (ipv6(host)) return true
  return RE_HOST_SHAPE.test(host)
}
