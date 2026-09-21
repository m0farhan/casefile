import { IOC_TYPE_LABELS, defangIoc, detectIocType, hasIocShape, refangIoc } from './ioc'

/**
 * Selection transforms for the analyst's right-click menu.
 *
 * Offline by construction: the toolbox never asks anything ABOUT a value, it
 * only rewrites what the analyst already selected, so there is no network path
 * to disclose and no key to hold.
 *
 * Nothing here guesses. A decode that does not produce text returns null
 * instead of mojibake, and a bare number is not a time until someone says
 * which epoch it counts from — so `readTimestamp` hands back every reading it
 * could plausibly be with the assumption spelled out beside it, and the
 * analyst picks. That is the same rule the rest of the plugin follows: an
 * unknown stays unknown rather than being rendered as a fact.
 */

/** One transform's output, ready to drop into a note. */
export interface ToolResult {
  /** Names the transform AND what it had to assume, e.g. `base64 → UTF-16LE`. */
  title: string
  body: string
}

interface Tool {
  id: string
  name: string
  run(selection: string): ToolResult | null | Promise<ToolResult | null>
}

/**
 * Does this decode read as text, or did we just reinterpret bytes as noise?
 *
 * Scored against ASCII on purpose. UTF-8 bytes decoded as UTF-16LE come out as
 * plausible-looking CJK, and UTF-16LE bytes decoded as UTF-8 come out as text
 * with a NUL between every character — a generic "is it printable" test calls
 * both of those readable and offers the analyst two answers where there is
 * one. ponytail: the cost is that genuinely non-ASCII plaintext scores low and
 * is dropped; widen the accepted ranges if that ever bites.
 */
function readsAsText(s: string): boolean {
  if (!s) return false
  const chars = [...s]
  let ascii = 0
  for (const ch of chars) {
    const c = ch.codePointAt(0) ?? 0
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)) ascii++
  }
  return ascii / chars.length >= 0.85
}

function decodeBytes(bytes: Uint8Array, encoding: string): string | null {
  try {
    const text = new TextDecoder(encoding).decode(bytes)
    return readsAsText(text) ? text : null
  } catch {
    return null
  }
}

/** One labelled reading of the same bytes. */
export interface Decoding {
  as: string
  text: string
}

const B64_CHARS = /^[A-Za-z0-9+/\-_]+={0,2}$/

/**
 * Base64 → text, under both encodings an analyst actually meets.
 *
 * UTF-16LE is not an afterthought: PowerShell's own `-EncodedCommand` is
 * base64 of UTF-16LE, so a decoder that only tries UTF-8 hands back every
 * other character as a NUL on the single most common thing you will paste
 * into it. Accepts the URL-safe alphabet and unpadded input; returns [] rather
 * than a guess when the bytes are not text.
 */
export function decodeBase64(input: string): Decoding[] {
  const clean = input.replace(/\s+/g, '')
  if (clean.length < 8 || !B64_CHARS.test(clean)) return []
  const padded = clean.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (clean.length % 4)) % 4)
  let bytes: Uint8Array
  try {
    const binary = atob(padded)
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  } catch {
    return []
  }
  const out: Decoding[] = []
  const utf8 = decodeBytes(bytes, 'utf-8')
  const utf16 = decodeBytes(bytes, 'utf-16le')
  if (utf8) out.push({ as: 'UTF-8', text: utf8 })
  if (utf16 && utf16 !== utf8) out.push({ as: 'UTF-16LE', text: utf16 })
  return out
}

/**
 * Percent-escapes, decoded until the text stops changing (wrapped links nest
 * them several deep). `+` is deliberately left alone: it only means a space in
 * a form-encoded query, and rewriting it inside a path corrupts the value.
 */
export function decodePercentEscapes(input: string, max = 5): string {
  let text = input
  for (let i = 0; i < max; i++) {
    let next: string
    try {
      next = decodeURIComponent(text)
    } catch {
      return text
    }
    if (next === text) return text
    text = next
  }
  return text
}

/** Hex → text, tolerating `0x`, spaces, commas and colons between bytes. */
export function decodeHex(input: string): string | null {
  const clean = input.replace(/0x/gi, '').replace(/[\s,:-]/g, '')
  if (clean.length < 4 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) return null
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return decodeBytes(bytes, 'utf-8')
}

/** One way the selection could be read as a time, and what that assumes. */
export interface TimeReading {
  assumption: string
  iso: string
}

const MS_1601_TO_1970 = 11_644_473_600_000

/**
 * Every reading the value could plausibly be, each labelled with its epoch.
 *
 * Readings that land outside 1990–2100 are dropped, which is what keeps the
 * list short enough to judge: a ten-digit number read as microseconds lands in
 * 1970 and is not a candidate, it is the wrong epoch.
 */
export function readTimestamp(input: string): TimeReading[] {
  const raw = input.trim()
  if (!raw) return []
  const out: TimeReading[] = []
  const add = (assumption: string, ms: number): void => {
    const iso = plausibleIso(ms)
    if (iso) out.push({ assumption, iso })
  }
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    add('seconds since 1970 (Unix)', n * 1000)
    add('milliseconds since 1970', n)
    add('microseconds since 1970', n / 1000)
    if (raw.length >= 17) {
      const ticks = BigInt(raw)
      add('100ns ticks since 1601 (Windows FILETIME)', Number(ticks / 10_000n) - MS_1601_TO_1970)
      add('microseconds since 1601 (WebKit/Chrome)', Number(ticks / 1_000n) - MS_1601_TO_1970)
    }
    return out
  }
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) return out
  const zoned = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)
  out.push({
    assumption: zoned ? 'as written (zone stated)' : 'as written (no zone — read as this machine’s local time)',
    iso: new Date(ms).toISOString()
  })
  return out
}

function plausibleIso(ms: number): string | null {
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  const year = d.getUTCFullYear()
  if (year < 1990 || year > 2100) return null
  return d.toISOString()
}

/** Defang every line of the selection that carries an indicator; leave prose alone. */
export function defangSelection(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const value = line.trim()
      if (!value || !hasIocShape(value)) return line
      // A function replacement, not a string one: String.replace expands `$&`,
      // `$\``, `$'` and `$1` INSIDE the replacement, so a URL carrying any of
      // them came back corrupted — and a corrupted indicator is worse than an
      // undefanged one, because it looks like a real value.
      return line.replace(value, () => defangIoc(value, detectIocType(value)))
    })
    .join('\n')
}

/** Refang every line of the selection. */
export function refangSelection(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const value = line.trim()
      if (!value) return line
      return line.replace(value, () => refangIoc(value))
    })
    .join('\n')
}

/**
 * Wrap a transform's output so the note records what it is and what produced it.
 *
 * The body sits in a fence long enough to survive whatever is inside it and
 * every line is quoted, so a decode that yields markdown, a callout of its own
 * or a run of backticks cannot break out of the block and rewrite the note
 * around it. Decoded content is hostile by assumption — it came out of an
 * alert.
 */
export function derivedCallout(title: string, body: string): string {
  const text = body.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  const fence = fenceFor(text)
  return [
    `> [!note] Derived · ${title}`,
    `> ${fence}`,
    ...text.split('\n').map((line) => (line ? `> ${line}` : '>')),
    `> ${fence}`
  ].join('\n')
}

function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

async function hash(text: string, algorithm: 'SHA-256' | 'SHA-1'): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const TOOLS: Tool[] = [
  {
    id: 'defang',
    name: 'Defang indicators',
    run: (s) => {
      const out = defangSelection(s)
      if (out === s) return null
      const type = detectIocType(s.trim())
      return { title: `defanged (${IOC_TYPE_LABELS[type].toLowerCase()})`, body: out }
    }
  },
  {
    id: 'refang',
    name: 'Refang indicators',
    run: (s) => {
      const out = refangSelection(s)
      return out === s ? null : { title: 'refanged', body: out }
    }
  },
  {
    id: 'base64',
    name: 'Decode base64',
    run: (s) => {
      const readings = decodeBase64(s)
      if (!readings.length) return null
      return {
        title: `base64 → ${readings.map((r) => r.as).join(' / ')}`,
        body: readings.map((r) => (readings.length > 1 ? `${r.as}:\n${r.text}` : r.text)).join('\n\n')
      }
    }
  },
  {
    id: 'percent',
    name: 'Decode percent-escapes',
    run: (s) => {
      const out = decodePercentEscapes(s)
      return out === s ? null : { title: 'percent-escapes decoded', body: out }
    }
  },
  {
    id: 'hex',
    name: 'Decode hex',
    run: (s) => {
      const out = decodeHex(s)
      return out === null ? null : { title: 'hex → UTF-8', body: out }
    }
  },
  {
    id: 'timestamp',
    name: 'Read as a timestamp',
    run: (s) => {
      const readings = readTimestamp(s)
      if (!readings.length) return null
      return {
        title: 'timestamp readings',
        body: readings.map((r) => `${r.iso}  —  ${r.assumption}`).join('\n')
      }
    }
  },
  {
    id: 'sha256',
    name: 'Hash the selection',
    run: async (s) => ({
      title: 'hashed',
      body: `SHA-256  ${await hash(s, 'SHA-256')}\nSHA-1    ${await hash(s, 'SHA-1')}`
    })
  }
]

/** Every transform that actually applies to this selection, each with its result. */
export async function runToolbox(selection: string): Promise<{ name: string; result: ToolResult }[]> {
  const out: { name: string; result: ToolResult }[] = []
  for (const tool of TOOLS) {
    let result: ToolResult | null
    try {
      result = await tool.run(selection)
    } catch {
      // A transform that throws on hostile input is one that does not apply.
      continue
    }
    if (result) out.push({ name: tool.name, result })
  }
  return out
}
