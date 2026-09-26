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
  /** The receiving MTA's own id for this hop — what a mail admin searches their logs by. */
  id: string
  /** The envelope recipient this hop was for; often the only place an alias is visible. */
  forWhom: string
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

/**
 * One stated comparison. `aligned` is what the comparison CAME OUT AS, carried
 * as data so the view can colour it without reading the sentence — a view that
 * greps its own prose for "differ" breaks the first time the wording changes.
 */
export interface Observation {
  text: string
  aligned: boolean
}

export interface HeaderAnalysis {
  identities: { label: string; value: string }[]
  auth: AuthResult[]
  hops: Hop[]
  /** Stated comparisons — facts about the headers, never a verdict on them. */
  observations: Observation[]
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

/** One RFC 2047 encoded word: charset, B or Q, payload. */
const ENCODED_WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g

/**
 * Encoded words with only spaces or tabs between them. RFC 2047 §6.2 drops
 * that whitespace, and mailers split a long subject or filename across words
 * at any point, so `invoice.p` + `df.exe` read as "invoice.p df.exe" and the
 * double extension the reader saw went unreported. Only a space or a tab: a
 * no-break space between two words is a character the reader sees.
 */
const ENCODED_RUN = /=\?[^?]+\?[bBqQ]\?[^?]*\?=(?:[ \t]+=\?[^?]+\?[bBqQ]\?[^?]*\?=)*/g

/**
 * Decode RFC 2047 encoded words (`=?utf-8?B?…?=`), which is how a display name
 * hides that it reads "PayPal Security" in Cyrillic lookalikes. An unknown
 * charset or malformed payload is left exactly as written rather than guessed.
 */
export function decodeEncodedWords(value: string): string {
  return value.replace(ENCODED_RUN, (run) => {
    const words = [...run.matchAll(ENCODED_WORD)].map((m) => ({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      charset: m[1].toLowerCase(),
      bytes: wordBytes(m[2], m[3])
    }))
    let out = ''
    let end = 0
    let decodedBefore = false
    for (let i = 0; i < words.length;) {
      // Neighbouring words in one charset decode as one byte string, so a
      // character split across two words comes out whole rather than as two
      // replacement characters where the look-alike was.
      const chunks: Uint8Array[] = []
      let j = i
      for (; j < words.length; j++) {
        const bytes = words[j].bytes
        if (!bytes || words[j].charset !== words[i].charset) break
        chunks.push(bytes)
      }
      if (!chunks.length) j = i + 1 // a payload that did not decode stands alone
      const text = chunks.length ? decodeCharset(words[i].charset, chunks) : null
      // The gap is dropped only between two words that both decoded. Beside a
      // word left as written, it is kept as written too.
      if (text === null || !decodedBefore) out += run.slice(end, words[i].start)
      out += text ?? run.slice(words[i].start, words[j - 1].end)
      decodedBefore = text !== null
      end = words[j - 1].end
      i = j
    }
    return out
  })
}

function wordBytes(encoding: string, payload: string): Uint8Array | null {
  if (encoding.toLowerCase() === 'q') return quotedPrintableBytes(payload.replace(/_/g, ' '))
  try {
    return Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

function decodeCharset(charset: string, chunks: Uint8Array[]): string | null {
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  try {
    // Flattened: a header value is ONE logical line by definition (RFC
    // 5322 unfolding), so a decoded one carrying CR/LF is malformed. Left
    // in, a Subject could forge whole sections of the report and whole
    // timestamped comments on the case note it lands in.
    return new TextDecoder(charset).decode(bytes).replace(/[\r\n\u2028\u2029]+/g, ' ')
  } catch {
    return null
  }
}

/**
 * `=XX` escapes to bytes. Shared with the MIME body decoder in eml.ts.
 *
 * The text arrived already decoded from the file as UTF-8, so a raw character
 * in it stands for its UTF-8 bytes. Cut to its low byte, a Cyrillic а (U+0430)
 * became "0": a link to p0ypal, a domain nowhere in the mail, in place of the
 * look-alike the reader saw. So the text is encoded first and the escapes are
 * read at the byte level; `=` and hex digits are ASCII, the same bytes either way.
 */
export function quotedPrintableBytes(text: string): Uint8Array {
  const src = new TextEncoder().encode(text)
  const out = new Uint8Array(src.length)
  let n = 0
  for (let i = 0; i < src.length; i++) {
    const high = src[i] === 0x3d && i + 2 < src.length ? hexDigit(src[i + 1]) : -1
    const low = high < 0 ? -1 : hexDigit(src[i + 2])
    if (low < 0) {
      out[n++] = src[i]
    } else {
      out[n++] = high * 16 + low
      i += 2
    }
  }
  return out.slice(0, n)
}

function hexDigit(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30
  const lower = byte | 0x20
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1
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
  const unquoted = stripComments(stripQuoted(value))
  // The last `<…>` pair, found by walking forward from each `<` to the next
  // `>`. A regex did the same, but retried from every `<` of a run with no `>`
  // after it: quadratic, seconds on a From of 40,000 of them.
  let angled: string | null = null
  for (let open = unquoted.indexOf('<'); open >= 0;) {
    const close = unquoted.indexOf('>', open + 1)
    if (close < 0) break
    angled = unquoted.slice(open + 1, close)
    open = unquoted.indexOf('<', close + 1)
  }
  return (angled ?? unquoted).trim().replace(/^mailto:/i, '')
}

/**
 * Remove every complete quoted string, in one pass: a `\` takes the next
 * character with it, and an unterminated quote ends the scan with the rest
 * kept as written. Nothing after it can close — every later `"` sits inside
 * the same open run — which is what the regex this replaces found too, after
 * retrying from each later quote: quadratic, seconds on 50,000 `\"`. The one
 * difference: a `\` before a line terminator (U+2028 or U+2029, in a header
 * value) escapes it here, where the regex's `.` refused it and paired the
 * quotes after it differently.
 */
function stripQuoted(value: string): string {
  let out = ''
  let kept = 0
  for (let open = value.indexOf('"'); open >= 0; open = value.indexOf('"', kept)) {
    let i = open + 1
    while (i < value.length && value[i] !== '"') i += value[i] === '\\' ? 2 : 1
    if (i >= value.length) break
    out += value.slice(kept, open)
    kept = i + 1
  }
  return out + value.slice(kept)
}

/**
 * Replace every RFC 5322 comment with a space, innermost first, to a fixed
 * point: comments nest. Each pass is one left-to-right scan. A comment that
 * meets another `(` before its `)` is not innermost, so the scan restarts
 * there; one that reaches the end cannot close, and neither can anything
 * after it. The regex this replaces gave the same answer, bar the same `\`
 * before a line terminator as stripQuoted, but retried from every `(` of an
 * unclosed run — seconds on 50,000 `\(`.
 */
function stripComments(value: string): string {
  let text = value
  // ponytail: six levels of nesting; deeper comments stay in the text.
  for (let pass = 0; pass < 6; pass++) {
    let out = ''
    let kept = 0
    let open = text.indexOf('(')
    while (open >= 0) {
      let i = open + 1
      while (i < text.length && text[i] !== '(' && text[i] !== ')') i += text[i] === '\\' ? 2 : 1
      if (i >= text.length) break
      if (text[i] === '(') {
        open = i
        continue
      }
      out += text.slice(kept, open) + ' '
      kept = i + 1
      open = text.indexOf('(', kept)
    }
    const next = out + text.slice(kept)
    if (next === text) break
    text = next
  }
  return text
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@')
  if (at < 0) return ''
  const domain = address.slice(at + 1).toLowerCase()
  // Trailing `>` and `.` trimmed by walking back. The regex this replaces
  // retried from every dot of a run: seconds on a domain of 80 KB of dots.
  let end = domain.length
  while (end > 0 && (domain[end - 1] === '>' || domain[end - 1] === '.')) end--
  return domain.slice(0, end)
}

/**
 * The from-clause as the receiving MTA wrote it: the name after `from` and
 * the comment right after that, which is where the MTA records the address it
 * saw. Neither half is labelled. Postfix, Sendmail and Gmail put the name the
 * sender gave first; Exim and qmail put the address or reverse name first and
 * the sender's HELO in the comment — a label right for one is false for the
 * other. The comment may hold one nested comment, Sendmail's "(may be forged)".
 */
const FROM_CLAUSE = /\bfrom\s+([^\s;()]+)(\s*\((?:[^()\\]|\\.|\((?:[^()\\]|\\.)*\))*\))?/i

function parseHop(value: string, n: number): Hop {
  // The clause words are read with comments removed. Comments are free text:
  // Postfix writes "(using TLSv1.3 with cipher …)" before `by`, which read as
  // the protocol "cipher", and its local pickup writes "(Postfix, from userid
  // 1000)", which read as a hop from "userid".
  const bare = stripComments(value)
  // ponytail: a comment holding `from <word>` ahead of the real from-clause is
  // still read as the clause; finding the one outside comments needs a
  // position-keeping comment scan, worth it if a real MTA writes that.
  const fromClause = /\bfrom\s/i.test(bare) ? FROM_CLAUSE.exec(value) : null
  const by = /\bby\s+([^\s;()]+)/i.exec(bare)
  const via = /\bwith\s+([^\s;()]+)/i.exec(bare)
  const id = /\bid\s+([^\s;()]+)/i.exec(bare)
  const forWhom = /\bfor\s+<?([^\s;()<>]+)>?/i.exec(bare)
  // The date is whatever follows the LAST semicolon: ids and `for` clauses can
  // carry semicolons of their own, and the timestamp is always the tail. A
  // trailing comment such as "(UTC)" is cut by index — from the first `(`
  // after the `)` before it — where a regex retried from every `(`.
  const trailing = value.slice(value.lastIndexOf(';') + 1).trimEnd()
  const open = trailing.endsWith(')') ? trailing.indexOf('(', trailing.lastIndexOf(')', trailing.length - 2) + 1) : -1
  const tail = (open < 0 ? trailing : trailing.slice(0, open)).trim()
  const ms = value.includes(';') ? Date.parse(tail) : Number.NaN
  return {
    n,
    from: fromClause ? fromClause[1] + (fromClause[2] ?? '') : 'not recorded',
    by: by?.[1] ?? 'not recorded',
    via: via?.[1] ?? 'not recorded',
    id: id?.[1] ?? '',
    forWhom: forWhom?.[1] ?? '',
    at: Number.isNaN(ms) ? null : new Date(ms).toISOString(),
    delaySec: null
  }
}

/**
 * An Authentication-Results value cut at its `;` — only those outside comments
 * and quoted strings. Receivers copy the envelope sender into both, so a
 * `"x;dkim=pass"@evil.test` split on every `;` gave a DKIM pass credited to
 * the receiving host. `bare` has comment text blanked to spaces, the same
 * length as `raw`, for matching; `raw` keeps "(sender IP is …)" for display.
 * One pass, so a value of 160 KB of `\(` costs what its length costs.
 */
function authSegments(value: string): { raw: string; bare: string }[] {
  const chars = value.split('')
  const cuts = [-1]
  let depth = 0
  let quoted = false
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (depth) chars[i] = ' '
    if (c === '\\') {
      if (depth && i + 1 < chars.length) chars[i + 1] = ' '
      i++
    } else if (quoted) {
      quoted = c !== '"'
    } else if (c === '(') {
      depth++
      chars[i] = ' '
    } else if (c === ')') {
      if (depth) depth--
    } else if (!depth && c === '"') {
      quoted = true
    } else if (!depth && c === ';') {
      cuts.push(i)
    }
  }
  cuts.push(value.length)
  const bare = chars.join('')
  return cuts.slice(1).map((cut, k) => ({ raw: value.slice(cuts[k] + 1, cut), bare: bare.slice(cuts[k] + 1, cut) }))
}

function parseAuth(value: string, arc = false): AuthResult[] {
  const segments = authSegments(value)
  // ARC (RFC 8617) puts the instance, `i=1;`, ahead of the host.
  if (arc && /^\s*i\s*=\s*\d+\s*$/i.test(segments[0].bare)) segments.shift()
  // Microsoft 365 writes no host at all: the value opens with a result, and
  // its first word, "spf=pass", was printed as the host that asserted it.
  const head = segments[0]?.bare.trim() ?? ''
  const servid = !head || /^[^\s=]+\s*=/.test(head) ? 'no asserting host stated' : head.split(/\s+/)[0]
  const out: AuthResult[] = []
  for (const segment of segments) {
    const hit = /^\s*(spf|dkim|dmarc|arc|compauth)\s*=\s*(\w+)/i.exec(segment.bare)
    if (!hit) continue
    out.push({
      mechanism: hit[1].toLowerCase(),
      result: hit[2].toLowerCase(),
      detail: segment.raw.slice(hit[0].length).trim(),
      assertedBy: servid
    })
  }
  return out
}

/**
 * Read a pasted header block.
 *
 * No indicators here: the phishing report builds its list from the PARSED
 * message, and a scan of this raw text ran over every attachment's base64 —
 * most of a second on a 46 MB mail, for a list nothing read.
 */
export function analyseHeaders(raw: string): HeaderAnalysis {
  const fields = parseHeaderBlock(raw)
  const first = (name: string): string =>
    decodeEncodedWords(fields.find((f) => f.name.toLowerCase() === name)?.value ?? '')
  const all = (name: string): string[] => fields.filter((f) => f.name.toLowerCase() === name).map((f) => f.value)

  const identities: { label: string; value: string }[] = []
  for (const [label, key] of [
    ['Subject', 'subject'],
    ['From', 'from'],
    // `Sender:` is who actually submitted it when that differs from the author,
    // and a mail carrying one is saying so out loud.
    ['Sender', 'sender'],
    ['Return-Path', 'return-path'],
    ['Reply-To', 'reply-to'],
    ['To', 'to'],
    ['Cc', 'cc'],
    ['Date', 'date'],
    ['Message-ID', 'message-id'],
    // The thread headers. A reply that claims a parent is the shape of a
    // hijacked thread, and until now nothing read them at all.
    ['In-Reply-To', 'in-reply-to'],
    ['References', 'references']
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
      parseAuth(v, true).map((r) => ({ ...r, assertedBy: `${r.assertedBy} (ARC — relayed claim)` }))
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
  const observations: Observation[] = []
  const compare = (aLabel: string, a: string, bLabel: string, b: string): void => {
    if (!a || !b) return
    const da = domainOf(a)
    const db = domainOf(b)
    if (!da || !db) return
    observations.push(
      da === db
        ? { text: `${aLabel} and ${bLabel} are both at ${da}.`, aligned: true }
        : { text: `${aLabel} is at ${da}; ${bLabel} is at ${db}. They differ.`, aligned: false }
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
        ? {
            text: `${result.mechanism.toUpperCase()} passed for ${signedDomain}, which is the From domain.`,
            aligned: true
          }
        : {
            text: `${result.mechanism.toUpperCase()} passed for ${signedDomain}; From is at ${fromDomain}. They differ.`,
            aligned: false
          }
    )
  }

  // Which copy of a header a client uses is not agreed between clients, so a
  // second From is not a footnote: it is a fork in what the reader is looking
  // at, and the analyst has to know it is there.
  for (const key of ['from', 'return-path', 'reply-to', 'authentication-results', 'subject'] as const) {
    const count = all(key).length
    if (count > 1) {
      observations.push({
        text:
          `There are ${count} ${key} headers. Identities show the first; ` +
          'authentication results show all of them. Mail clients do not agree on which one wins.',
        aligned: false
      })
    }
  }

  // The display name is everything before the real address. An address hiding
  // in there is the oldest trick in the file — a client shows the display name
  // and the reader never sees the domain the mail actually came from.
  const fromRaw = first('from')
  const lastAngle = fromRaw.lastIndexOf('<')
  const displayPart = lastAngle > 0 ? fromRaw.slice(0, lastAngle) : ''
  // A scan starts only where a run of address characters starts. Unanchored,
  // it restarted at every character of a long run with no `@`: seconds on a
  // 100 KB display name, even an innocent quoted one.
  const hidden = /(?:^|[^\w.+-])([\w.+-]+@[\w.-]+)/.exec(displayPart)
  const hiddenDomain = hidden ? domainOf(hidden[1]) : ''
  if (hiddenDomain && hiddenDomain !== domainOf(fromAddr)) {
    observations.push({
      text: `The display name contains an address at ${hiddenDomain}, which is not the sending domain.`,
      aligned: false
    })
  }

  // A reply that claims a parent, stated as what it is. Thread hijacking is a
  // real shape and this is the evidence for it, but a genuine reply looks
  // identical from the headers alone — so this says what the mail claims and
  // stops, and the analyst decides whether the thread was really theirs.
  const inReplyTo = first('in-reply-to')
  if (inReplyTo) {
    observations.push({
      text:
        `This message claims to reply to ${inReplyTo}. Nothing in the headers tells a genuine reply ` +
        'apart from a thread someone else joined — check whether that conversation is yours.',
      aligned: false
    })
  }

  const notes: string[] = []
  if (!fields.length) notes.push('No headers found in this paste.')
  if (!received.length) notes.push('No Received headers — the delivery path is not recorded.')
  if (!auth.length) notes.push('No Authentication-Results or Received-SPF — SPF, DKIM and DMARC are not recorded.')
  if (!returnAddr) notes.push('No Return-Path — the envelope sender is not recorded.')
  if (hops.some((h) => !h.at)) notes.push('One or more hops stated no time, so those gaps are not measurable.')

  return { identities, auth, hops, observations, notes }
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
        `${h.n}. from ${quoteUntrusted(h.from)} by ${quoteUntrusted(h.by)} with ${quoteUntrusted(h.via)}` +
          `${h.id ? ` id ${quoteUntrusted(h.id)}` : ''}${h.forWhom ? ` for ${quoteUntrusted(h.forWhom)}` : ''} — ` +
          `${h.at ?? 'no time recorded'}${formatDelay(h.delaySec)}`
      )
    }
  } else {
    lines.push('Not recorded.')
  }
  lines.push('', '### Observations', '')
  // Observations are OUR sentences, but they interpolate sender-controlled
  // domains, so they are quarantined too.
  if (a.observations.length) for (const o of a.observations) lines.push(`- ${quoteUntrusted(o.text)}`)
  else lines.push('Nothing to compare.')
  // Indicators are deliberately NOT emitted here. The phishing report builds
  // its own set from the PARSED message and emits it once; when this section
  // also printed a raw-paste scan the copied report carried two different
  // "### Indicators" headings whose contents disagreed, and the first one was
  // the scan the module's own docs say is the wrong source.
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
