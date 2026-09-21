import { extractIocsFromText, formatIocLine } from './ioc'

/**
 * Email headers, read as stated facts.
 *
 * This module reports what the headers SAY and nothing else. It never calls a
 * message phishing, benign or suspicious: SPF failed or it did not, the From
 * domain matches the Return-Path domain or it does not, and the analyst draws
 * the conclusion. The same rule as the rest of the plugin — a header that is
 * absent prints as "not recorded", never as a pass.
 *
 * Everything here is offline and pure. Nothing is resolved, nothing is looked
 * up, and the text is treated as hostile throughout: it arrived in an email.
 */

export interface HeaderField {
  name: string
  value: string
}

/** One Received hop, oldest first once the chain is reversed. */
export interface Hop {
  n: number
  from: string
  by: string
  via: string
  /** ISO, or null when the hop stated no time. */
  at: string | null
  /** Seconds this hop took, or null when either end has no time. */
  delaySec: number | null
}

export interface AuthResult {
  mechanism: string
  result: string
  detail: string
  /**
   * The authserv-id: the host claiming this result. It is the whole trust
   * question. A sender can put `Authentication-Results: spf=pass` in their own
   * message and it parses identically to the receiving MTA's — only the
   * asserting host tells them apart, so it is never dropped.
   */
  assertedBy: string
}

export interface HeaderAnalysis {
  identities: { label: string; value: string }[]
  auth: AuthResult[]
  hops: Hop[]
  /** Stated comparisons — facts about the headers, never a verdict on them. */
  observations: string[]
  /** Defanged, asset-marked, ready to paste into a case's indicators. */
  indicators: string[]
  /** What this paste does not contain, said out loud. */
  notes: string[]
}

/**
 * Split a header block into fields, joining RFC 5322 continuation lines.
 *
 * Stops at the first blank line, because that is where headers end — anything
 * after it is the body, and parsing the body as headers is how a quoted
 * "From:" inside a forwarded mail ends up impersonating the real sender.
 */
export function parseHeaderBlock(raw: string): HeaderField[] {
  const out: HeaderField[] = []
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1].value += ' ' + line.trim()
      continue
    }
    if (!line.trim()) {
      if (out.length) break
      continue
    }
    const match = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line)
    if (match) out.push({ name: match[1], value: match[2].trim() })
  }
  return out
}

/**
 * Decode RFC 2047 encoded words (`=?utf-8?B?…?=`), which is how a display name
 * hides that it reads "PayPal Security" in Cyrillic lookalikes. An unknown
 * charset or malformed payload is left exactly as written rather than guessed.
 */
export function decodeEncodedWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (whole, charset: string, encoding: string, text: string) => {
      try {
        const bytes =
          encoding.toLowerCase() === 'b'
            ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
            : quotedPrintableBytes(text.replace(/_/g, ' '))
        // Flattened: a header value is ONE logical line by definition (RFC
        // 5322 unfolding), so a decoded one carrying CR/LF is malformed. Left
        // in, a Subject could forge whole sections of the report and whole
        // timestamped comments on the case note it lands in.
        return new TextDecoder(charset).decode(bytes).replace(/[\r\n\u2028\u2029]+/g, ' ')
      } catch {
        return whole
      }
    }
  )
}

/** `=XX` escapes to bytes. Shared with the MIME body decoder in eml.ts. */
export function quotedPrintableBytes(text: string): Uint8Array {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '=' && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(text.charCodeAt(i) & 0xff)
    }
  }
  return Uint8Array.from(bytes)
}

/**
 * The real address: the LAST angle-bracketed one, after quoted display names
 * have been removed.
 *
 * Both halves matter. `"PayPal Security <service@paypal.test>" <billing@paypa1.test>`
 * is a live trick — the address a mail client shows is the decoration, and
 * taking the first `<…>` hands back exactly the domain the sender wants you to
 * read. Strip the quoted part, then take the last bracketed address.
 */
export function addressOf(value: string): string {
  // Quotes first (a '(' inside a quoted display name is literal), then
  // comments. An address parked in a comment is legal anywhere RFC 5322 allows
  // CFWS and every client shows the addr-spec instead — so
  // `From: (<bounce@mailer.test>) security@microsoft.com` used to be read as
  // the bouncer's domain, and the From/Return-Path panel reported alignment
  // on a mail that had none. Comments nest, so the strip runs to a fixed point.
  let unquoted = value.replace(/"(?:[^"\\]|\\.)*"/g, '')
  for (let i = 0; i < 6; i++) {
    const next = unquoted.replace(/\((?:[^()\\]|\\.)*\)/g, ' ')
    if (next === unquoted) break
    unquoted = next
  }
  const angled = [...unquoted.matchAll(/<([^>]*)>/g)]
  const raw = (angled.length ? angled[angled.length - 1][1] : unquoted).trim()
  return raw.replace(/^mailto:/i, '')
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@')
  return at < 0
    ? ''
    : address
        .slice(at + 1)
        .toLowerCase()
        .replace(/[>.]+$/, '')
}

function parseHop(value: string, n: number): Hop {
  const bracketed = /\[([0-9a-f.:]+)\]/i.exec(value)
  const fromName = /\bfrom\s+([^\s;()]+)/i.exec(value)
  const by = /\bby\s+([^\s;()]+)/i.exec(value)
  const via = /\bwith\s+([^\s;()]+)/i.exec(value)
  // The date is whatever follows the LAST semicolon: ids and `for` clauses can
  // carry semicolons of their own, and the timestamp is always the tail.
  const tail = value
    .slice(value.lastIndexOf(';') + 1)
    .replace(/\([^)]*\)\s*$/, '')
    .trim()
  const ms = value.includes(';') ? Date.parse(tail) : Number.NaN
  return {
    n,
    from: [fromName?.[1], bracketed ? `[${bracketed[1]}]` : ''].filter(Boolean).join(' ') || 'not recorded',
    by: by?.[1] ?? 'not recorded',
    via: via?.[1] ?? 'not recorded',
    at: Number.isNaN(ms) ? null : new Date(ms).toISOString(),
    delaySec: null
  }
}

function parseAuth(value: string, assertedBy = ''): AuthResult[] {
  const segments = value.split(';')
  const servid = assertedBy || segments[0].trim().split(/\s+/)[0] || 'not stated'
  const out: AuthResult[] = []
  for (const part of segments) {
    const hit = /\b(spf|dkim|dmarc|arc|compauth)=(\w+)/i.exec(part)
    if (!hit) continue
    out.push({
      mechanism: hit[1].toLowerCase(),
      result: hit[2].toLowerCase(),
      detail: part.slice(hit.index + hit[0].length).trim(),
      assertedBy: servid
    })
  }
  return out
}

/** Read a pasted header block. `owned` marks the analyst's own estate as assets. */
export function analyseHeaders(raw: string, owned: string[] = []): HeaderAnalysis {
  const fields = parseHeaderBlock(raw)
  const first = (name: string): string =>
    decodeEncodedWords(fields.find((f) => f.name.toLowerCase() === name)?.value ?? '')
  const all = (name: string): string[] => fields.filter((f) => f.name.toLowerCase() === name).map((f) => f.value)

  const identities: { label: string; value: string }[] = []
  for (const [label, key] of [
    ['Subject', 'subject'],
    ['From', 'from'],
    ['Return-Path', 'return-path'],
    ['Reply-To', 'reply-to'],
    ['To', 'to'],
    ['Date', 'date'],
    ['Message-ID', 'message-id']
  ] as const) {
    identities.push({ label, value: first(key) || 'not recorded' })
  }

  // Received headers are written newest-first; the delivery path reads the
  // other way round, so the chain is reversed and numbered from the origin.
  const received = all('received')
  const hops = received
    .map((v, i) => parseHop(v, i))
    .reverse()
    .map((hop, i) => ({ ...hop, n: i + 1 }))
  for (let i = 1; i < hops.length; i++) {
    const prev = hops[i - 1].at
    const here = hops[i].at
    if (prev && here) hops[i].delaySec = Math.round((Date.parse(here) - Date.parse(prev)) / 1000)
  }

  // ARC results are an intermediary's claim about what SOMEONE ELSE saw, not
  // the receiver's own check, so they are labelled as such rather than mixed
  // in as if the delivering MTA had asserted them.
  const auth = [
    ...all('authentication-results').flatMap((v) => parseAuth(v)),
    ...all('arc-authentication-results').flatMap((v) =>
      parseAuth(v).map((r) => ({ ...r, assertedBy: `${r.assertedBy} (ARC — relayed claim)` }))
    )
  ]
  const receivedSpf = first('received-spf')
  if (receivedSpf && !auth.some((a) => a.mechanism === 'spf')) {
    const word = /^\s*(\w+)/.exec(receivedSpf)
    if (word) {
      auth.push({
        mechanism: 'spf',
        result: word[1].toLowerCase(),
        detail: receivedSpf.slice(word[0].length).trim(),
        assertedBy: 'Received-SPF, no asserting host stated'
      })
    }
  }

  const fromAddr = addressOf(first('from'))
  const returnAddr = addressOf(first('return-path'))
  const replyAddr = addressOf(first('reply-to'))
  const observations: string[] = []
  const compare = (aLabel: string, a: string, bLabel: string, b: string): void => {
    if (!a || !b) return
    const da = domainOf(a)
    const db = domainOf(b)
    if (!da || !db) return
    observations.push(
      da === db
        ? `${aLabel} and ${bLabel} are both at ${da}.`
        : `${aLabel} is at ${da}; ${bLabel} is at ${db}. They differ.`
    )
  }
  compare('From', fromAddr, 'Return-Path', returnAddr)
  compare('From', fromAddr, 'Reply-To', replyAddr)

  // A pass is a pass FOR A DOMAIN. SPF and DKIM passing for the bulk sender
  // that delivered the mail says nothing about the name in the From line, and
  // a pane reading `SPF pass / DKIM pass` with no domain beside it is the
  // single easiest way to wave a lookalike through.
  const fromDomain = domainOf(fromAddr)
  for (const result of auth) {
    if (result.result !== 'pass' || !fromDomain) continue
    const signed = /(?:header\.d|smtp\.mailfrom|header\.from|envelope-from)=<?([^\s;>]+)/i.exec(result.detail)
    if (!signed) continue
    const signedDomain = domainOf(signed[1].includes('@') ? signed[1] : `x@${signed[1]}`)
    if (!signedDomain) continue
    observations.push(
      signedDomain === fromDomain
        ? `${result.mechanism.toUpperCase()} passed for ${signedDomain}, which is the From domain.`
        : `${result.mechanism.toUpperCase()} passed for ${signedDomain}; From is at ${fromDomain}. They differ.`
    )
  }

  // Which copy of a header a client uses is not agreed between clients, so a
  // second From is not a footnote: it is a fork in what the reader is looking
  // at, and the analyst has to know it is there.
  for (const key of ['from', 'return-path', 'reply-to', 'authentication-results', 'subject'] as const) {
    const count = all(key).length
    if (count > 1) {
      observations.push(
        `There are ${count} ${key} headers. Only the first is shown above; mail clients do not agree on which one wins.`
      )
    }
  }

  // The display name is everything before the real address. An address hiding
  // in there is the oldest trick in the file — a client shows the display name
  // and the reader never sees the domain the mail actually came from.
  const fromRaw = first('from')
  const lastAngle = fromRaw.lastIndexOf('<')
  const displayPart = lastAngle > 0 ? fromRaw.slice(0, lastAngle) : ''
  const hidden = /([\w.+-]+@[\w.-]+)/.exec(displayPart)
  const hiddenDomain = hidden ? domainOf(hidden[1]) : ''
  if (hiddenDomain && hiddenDomain !== domainOf(fromAddr)) {
    observations.push(`The display name contains an address at ${hiddenDomain}, which is not the sending domain.`)
  }

  const notes: string[] = []
  if (!fields.length) notes.push('No headers found in this paste.')
  if (!received.length) notes.push('No Received headers — the delivery path is not recorded.')
  if (!auth.length) notes.push('No Authentication-Results or Received-SPF — SPF, DKIM and DMARC are not recorded.')
  if (!returnAddr) notes.push('No Return-Path — the envelope sender is not recorded.')
  if (hops.some((h) => !h.at)) notes.push('One or more hops stated no time, so those gaps are not measurable.')

  const indicators = extractIocsFromText(raw, []).map((ioc) => formatIocLine(ioc, owned))

  return { identities, auth, hops, observations, indicators, notes }
}

/** The analysis as markdown, for the clipboard or a case note. */
/**
 * Quarantine an untrusted value inside inline code.
 *
 * Everything this module reports — a subject, a filename, a header value, a
 * hop's own text — was written by the sender, and the report it lands in gets
 * written into a note that Obsidian renders as markdown. Left bare, a Subject
 * of `![[secret-note]]` embeds another note into the case, `<img src=...>`
 * fires a request the moment the case is opened (which is exactly the beacon
 * this whole feature exists to avoid), and a `[[link]]` rewires the graph.
 *
 * Inline code renders none of those. The fence is a backtick run one longer
 * than the longest inside the value, so the value cannot close its own
 * quoting, and newlines are flattened because inline code cannot span lines.
 */
export function quoteUntrusted(value: string): string {
  const flat = value.replace(/[\r\n\u2028\u2029]+/g, ' ')
  if (!flat) return '(empty)'
  let longest = 0
  for (const run of flat.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const fence = '`'.repeat(longest + 1)
  // A value starting or ending with a backtick needs a space inside the fence.
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${flat}${pad}${fence}`
}

/** The analysis as markdown. Every sender-controlled value is quarantined. */
export function formatHeaderReport(a: HeaderAnalysis): string {
  const lines: string[] = ['## Email headers', '', '### Identities', '']
  for (const id of a.identities) lines.push(`- ${id.label}: ${quoteUntrusted(id.value)}`)
  lines.push('', '### Authentication', '')
  if (a.auth.length) {
    for (const r of a.auth) {
      lines.push(
        `- ${r.mechanism.toUpperCase()}: ${r.result} — asserted by ${quoteUntrusted(r.assertedBy)}` +
          `${r.detail ? ` — ${quoteUntrusted(r.detail)}` : ''}`
      )
    }
  } else {
    lines.push('Not recorded.')
  }
  lines.push('', '### Path', '')
  if (a.hops.length) {
    for (const h of a.hops) {
      lines.push(
        `${h.n}. from ${quoteUntrusted(h.from)} by ${quoteUntrusted(h.by)} with ${quoteUntrusted(h.via)} — ` +
          `${h.at ?? 'no time recorded'}${formatDelay(h.delaySec)}`
      )
    }
  } else {
    lines.push('Not recorded.')
  }
  lines.push('', '### Observations', '')
  // Observations are OUR sentences, but they interpolate sender-controlled
  // domains, so they are quarantined too.
  if (a.observations.length) for (const o of a.observations) lines.push(`- ${quoteUntrusted(o)}`)
  else lines.push('Nothing to compare.')
  lines.push('', '### Indicators', '')
  if (a.indicators.length) for (const i of a.indicators) lines.push(`- ${quoteUntrusted(i)}`)
  else lines.push('None found.')
  if (a.notes.length) {
    lines.push('', '### Not in this paste', '')
    for (const n of a.notes) lines.push(`- ${quoteUntrusted(n)}`)
  }
  return lines.join('\n')
}

/**
 * A hop gap, rendered. A negative one is a fact about the headers — forged
 * hops and skewed clocks both produce it — so it is named rather than printed
 * as the nonsense "(+-3600s)".
 */
export function formatDelay(delaySec: number | null): string {
  if (delaySec === null) return ''
  if (delaySec < 0) return ` (${Math.abs(delaySec)}s EARLIER than the hop before it — clock skew or a forged hop)`
  return ` (+${delaySec}s)`
}
