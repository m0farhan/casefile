import { IOC_TYPE_LABELS, defangIoc, detectIocType, hasIocShape, refangIoc, stripProseTail } from './ioc'
import { latin1Bytes } from './eml'

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
    bytes = latin1Bytes(atob(padded))
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
 * them several deep). Each run of escapes decodes on its own, so one stray `%`
 * or a `%TEMP%` in a command line no longer stops every other escape in the
 * selection from decoding. A run that is not valid UTF-8 (the overlong
 * `%c0%af` of an IIS traversal) keeps its bytes as written, never a guessed
 * character; only its ASCII escapes, which are valid on their own, decode.
 * `+` is deliberately left alone: it only means a space in a form-encoded
 * query, and rewriting it inside a path corrupts the value.
 */
export function decodePercentEscapes(input: string, max = 5): string {
  let text = input
  for (let i = 0; i < max; i++) {
    const next = text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run)
      } catch {
        return run.replace(/%[0-7][0-9a-f]/gi, (e) => decodeURIComponent(e))
      }
    })
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

const LOCAL = 'as written (no zone — read as this machine’s local time)'

/**
 * ISO 8601 as logs write it: a T or a space between date and time, optional
 * seconds and fraction, and an optional zone (Z, UTC, GMT or an offset).
 */
const ISO_STAMP = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?\s?(Z|UTC|GMT|[+-]\d{2}:?\d{2})?)?$/i

/** A month by its name or its abbreviation. Not a prefix: V8 reads 'Decode 2019 12' as 12 December. */
const MONTH_NAME =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i

/**
 * A zone the parser reads, at the end of a written date, with an optional
 * '(PDT)' comment after it. The parser applies a short offset too ('GMT+2',
 * ' -5'), so one is a stated zone; the sign must follow a space, GMT or UTC,
 * or the year in '21-Sep-2026' reads as an offset it is not.
 */
const STATED_ZONE = /(?:\dZ|(?:\s|GMT|UTC)[+-]\d{1,2}(?::?\d{2})?|\b(?:UTC?|GMT|Z|[ECMP][SD]T))(?:\s*\([^)]*\))?$/i

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
  // ponytail: a written time is short, so a long selection is not one, and the
  // patterns below never run over a large one.
  if (raw.length > 80) return out
  const iso = ISO_STAMP.exec(raw)
  if (iso) {
    const [, date, time, frac, zone] = iso
    // The written day is checked on its own first: V8 rolls 2026-02-30 over to
    // 2 March rather than refusing it, a date nobody wrote.
    if (plausibleIso(Date.parse(`${date}T00:00Z`))?.slice(0, 10) !== date) return out
    const offset = !zone ? '' : /^[+-]/.test(zone) ? `${zone.slice(0, 3)}:${zone.slice(-2)}` : 'Z'
    // Rebuilt in the one form ECMAScript defines, so every platform reads a
    // real day alike: a date alone is UTC midnight, a time with no zone local.
    const strict = time ? `${date}T${time}${frac ? frac.slice(0, 4).padEnd(4, '0') : ''}${offset}` : date
    add(!time ? 'date only (read as UTC midnight)' : zone ? 'as written (zone stated)' : LOCAL, Date.parse(strict))
    return out
  }
  // Anything else goes to the legacy parser only when a month name, a year and
  // a day are all written. Given anything, it reads the syslog stamp
  // 'Sep 26 14:03:11' as 2001 and 'Server 2019' as 1 January: dates nobody
  // wrote. An all-numeric 09/10/2026 is refused too; which order it means is
  // not in the text.
  // ponytail: the legacy parse is implementation-defined, so iOS may read or
  // refuse a form V8 reads differently; every form it gets states its own year.
  const month = MONTH_NAME.exec(raw)
  if (!month || !/\b\d{4}\b/.test(raw) || !/\b\d{1,2}\b/.test(raw)) return out
  // An impossible day rolls over too ('Sep 31' is 1 October), so the month
  // read must be the month written. Compared as wall-clock time with the zone
  // taken off, since a stated zone may rightly move the UTC month.
  const wall = new Date(Date.parse(raw.replace(STATED_ZONE, (z) => (/^\d/.test(z) ? z[0] : ''))))
  const named = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(month[0].slice(0, 3).toLowerCase())
  if (wall.getMonth() * 3 !== named) return out
  add(STATED_ZONE.test(raw) ? 'as written (zone stated)' : LOCAL, Date.parse(raw))
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

/**
 * A list marker and a short label ('- ', '2. ', 'url: ') in front of a value,
 * kept as written. The label needs whitespace after its colon, so a scheme
 * (javascript:x) or a drive (C:\x) is never taken for one.
 */
const LINE_PREFIX = /^\s*(?:(?:[-*+]|\d{1,3}[.)])\s+)?(?:[\w.-][\w .-]{0,29}:\s+)?/

/**
 * Is this an indicator defangIoc has work on: an indicator shape, a UNC path,
 * or a value with a scheme of two or more letters (one letter is a drive).
 */
function carriesIndicator(value: string): boolean {
  return hasIocShape(value) || /^\\\\[^\s\\]/.test(value) || /^[a-z][a-z0-9+.-]+:\S/i.test(value)
}

/** The defanged selection, and the values that changed. */
function defangLines(text: string): { out: string; changed: string[] } {
  const changed: string[] = []
  const out = text
    .split('\n')
    .map((line) => {
      const prefix = LINE_PREFIX.exec(line)?.[0] ?? ''
      const rest = line.slice(prefix.length)
      const value = rest.trimEnd()
      // Already defanged: again would bracket the brackets (172[[.]]16).
      if (!value || refangIoc(value) !== value || !carriesIndicator(value)) return line
      const shown = defangIoc(value, detectIocType(value))
      if (shown === value) return line
      changed.push(value)
      // Spliced at the prefix, not found with line.replace, which hit the first
      // copy (a label spelled like the value) and expanded `$&` in a URL.
      return prefix + shown + rest.slice(value.length)
    })
    .join('\n')
  return { out, changed }
}

/**
 * Defang every line of the selection that carries an indicator, after any list
 * marker or label; leave prose alone.
 */
export function defangSelection(text: string): string {
  return defangLines(text).out
}

/** What a token's indicator is wrapped in: brackets, quotes (ASCII or typographic), inline code, braces, emphasis. */
const WRAP_OPEN = '("\'<[`“‘*{'
const WRAP_CLOSE = ')"\'>].,;:!?`”’*}'

/**
 * An indicator inside a longer token: a URL with a scheme, an email address or
 * an IPv4 address in attr="…", [text](…), url(…) or mailto:…. The email starts
 * only at the beginning of its run, as RE_EMAIL does, so a long word with no @
 * costs one pass rather than one per character. An IPv4 address stands alone
 * among dots, digits and slashes, so a version (Firefox/115.0.2.1) or an OID
 * (1.3.6.1.5.5.7.3.1) is not one. Captured, not looked behind: iOS before
 * 16.4 cannot compile a lookbehind.
 */
const EMBEDDED =
  /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>(){}`\\]+|(^|[^\w.+-])([\w.+-]+@[\w-]+(?:\.[\w-]+)+)|(^|[^\w./])((?:\d{1,3}\.){3}\d{1,3})(?!\.?\d)/gi

/** A defang mark already in a token: defanging around it again would not be undone by one refang. */
const DEFANGED = /\[(?:\.|:|at|@|:\/\/)\]|hxxps?:/i

/** The defanged IP, URL or email, or null when `core` is none of them or is already defanged. */
function defangOne(core: string): string | null {
  if (!core || refangIoc(core) !== core || !hasIocShape(core)) return null
  const type = detectIocType(core)
  return type === 'ip' || type === 'url' || type === 'email' ? defangIoc(core, type) : null
}

/**
 * Defang for pasting outside the vault (the right-click Defang): every
 * indicator line as defangSelection does it, and inside prose the tokens that
 * can be nothing else — an IP address, a URL with a scheme, an email address —
 * whether bare, wrapped, or embedded in a longer token. A bare word with a dot
 * in prose ('e.g.', 'report.pdf') is left as written, and so is anything
 * already defanged.
 */
export function defangText(text: string): string {
  return defangSelection(text).replace(/\S+/g, (token) => {
    // Walked from both ends rather than a lazy regex, which retried the
    // closing class from every character of a long punctuation run.
    let start = 0
    while (start < token.length && WRAP_OPEN.includes(token[start])) start++
    let end = token.length
    while (end > start && WRAP_CLOSE.includes(token[end - 1])) end--
    const whole = defangOne(token.slice(start, end))
    if (whole !== null) return token.slice(0, start) + whole + token.slice(end)
    if (DEFANGED.test(token)) return token
    return token.replace(EMBEDDED, (m: string, mailBefore?: string, _mail?: string, ipBefore?: string) => {
      const before = mailBefore ?? ipBefore ?? ''
      const hit = m.slice(before.length)
      const core = stripProseTail(hit)
      return before + (defangOne(core) ?? core) + hit.slice(core.length)
    })
  })
}

/**
 * Refang every token of the selection. Per token rather than per line: the
 * hxxp and [\\] steps are anchored to the start of a value, so a bullet or a
 * label in front of one left '- hxxp://a[.]example/x' half refanged under a
 * 'refanged' title. The second pass catches a scheme behind an opening bracket
 * or quote, as in '(hxxp://…)'.
 */
export function refangSelection(text: string): string {
  return text
    .replace(/\S+/g, (t) => refangIoc(t))
    .replace(/\bhxxp(?=s?:\/\/)/gi, (h) => (h === 'HXXP' ? 'HTTP' : 'http'))
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
      const { out, changed } = defangLines(s)
      if (out === s) return null
      // The kind is named only for one value whose shape says what it is. A
      // list is several kinds, and a UNC path or a bare scheme is not a
      // domain just because detectIocType falls through to it.
      const [one] = changed
      const kind =
        changed.length === 1 && hasIocShape(one) && !one.startsWith('\\\\')
          ? ` (${IOC_TYPE_LABELS[detectIocType(one)].toLowerCase()})`
          : ''
      return { title: `defanged${kind}`, body: out }
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
      if (out === s) return null
      // An escape still in the output was left as written (not valid UTF-8,
      // or nested deeper than the decoder goes), so the title says partly.
      const partly = /%[0-9a-f]{2}/i.test(out)
      return {
        title: partly ? 'percent-escapes partly decoded (some left as written)' : 'percent-escapes decoded',
        body: out
      }
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
