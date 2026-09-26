import { type HeaderField, decodeEncodedWords, parseHeaderBlock, quotedPrintableBytes } from './emailHeaders'

/**
 * A .eml file, taken apart offline.
 *
 * The one rule that shapes everything here: the HTML body is carried as SOURCE
 * and never as markup. Nothing in this module or its callers hands it to a
 * renderer, so a tracking pixel is not fetched, a remote stylesheet is not
 * requested and a script never exists — opening a phishing mail for analysis
 * must not be the thing that tells the sender you opened it.
 *
 * Attachments are decoded to bytes but never written anywhere by this module;
 * the caller decides whether bytes reach the disk, and hashes them first.
 *
 * ASSUMPTION worth knowing: the raw text arrives already decoded from the file
 * as UTF-8, with its line breaks as LF. base64 parts therefore round-trip
 * exactly, because they are ASCII on the wire. A quoted-printable part's text
 * decodes exactly too, but its bytes are the file's only when it is pure ASCII
 * with no hard line break, which stands for a CRLF the reader has rewritten.
 * A 7bit/8bit part in a non-UTF-8 charset was decoded by the file read before
 * this module saw it and its declared charset can no longer be applied. Those
 * parts are marked so the analyst is not told a clean story about a body that
 * may be mangled, or handed a hash of bytes nobody sent.
 */

export interface Attachment {
  filename: string
  contentType: string
  /** Bytes after transfer decoding — the true size, not the encoded length. */
  size: number
  bytes: Uint8Array
  /**
   * Its own headers mark it inline or give it a Content-ID. Nothing checks
   * that the body refers to it, and Gmail gives ordinary attachments a
   * Content-ID, so this alone does not make it a logo.
   */
  inline: boolean
  /**
   * Its own Content-Disposition says `attachment`, whatever else it carries —
   * a Content-ID included. `inline` stays true for such a part, because the
   * Content-ID is a true fact about it; this is what says it was sent as a
   * file, so a picture sent that way is not filed as an inline image.
   */
  attached?: boolean
  /**
   * The transfer encoding could not be decoded, so `bytes` is empty because
   * nothing was read — NOT because the file is empty. Callers must print the
   * size and the hashes as not recorded rather than hashing nothing: the
   * SHA-256 of zero bytes is a real-looking answer to a question nobody
   * managed to ask, and pasting it into a sandbox returns "empty file", which
   * reads as a clean result for a payload no one has looked at.
   */
  undecodable: boolean
  /**
   * The bytes are the file exactly as it travelled. base64 is ASCII on the
   * wire and round-trips exactly. A 7bit/8bit part, and a quoted-printable
   * one with a hard line break or a raw non-ASCII character, reached us
   * through the reader's line normalisation or its UTF-8 decoding, so its
   * hashes may not match the sender's copy and the caller has to say so.
   */
  exact: boolean
}

export interface Eml {
  headers: HeaderField[]
  /** text/plain body, decoded. */
  text: string
  /** text/html body as SOURCE. Never rendered, never fetched from. */
  html: string
  attachments: Attachment[]
  /** Parts whose declared charset could not be honoured, named not hidden. */
  notes: string[]
}

interface RawPart {
  headers: HeaderField[]
  body: string
}

function headerValue(headers: HeaderField[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name)?.value ?? ''
}

interface Param {
  name: string
  value: string
}

/**
 * A Content-Type / Content-Disposition value's parameters, in order, names
 * lower-cased. One forward pass that consumes each quoted-string whole, with
 * its quoted-pairs unescaped, so a `;` or a `boundary=` written INSIDE another
 * parameter's quotes is never read as a parameter of its own. Scanning the
 * whole line for `boundary=` let `boundary=real; x="; boundary="fake"` choose
 * the split, and every part behind `real` — an attachment included — vanished.
 */
function params(value: string): Param[] {
  const out: Param[] = []
  const head = /;\s*([^\s=;"]+)\s*=\s*/g
  const plain = /[^"\\]*/y
  const bare = /[^;\s]*/y
  for (let m = head.exec(value); m; m = head.exec(value)) {
    let at = head.lastIndex
    let text = ''
    if (value[at] === '"') {
      // By hand, not `"((?:[^"\\]|\\.)*)"`: that regex pushes a backtrack entry
      // per character and overflows V8's stack on a 20 MB header, which the
      // scan it replaced never did. A quote left open runs to the end.
      at++
      for (;;) {
        plain.lastIndex = at
        plain.test(value)
        text += value.slice(at, plain.lastIndex)
        at = plain.lastIndex
        if (value[at] !== '\\' || at + 1 >= value.length) break
        text += value[at + 1]
        at += 2
      }
      if (value[at] === '"') at++
    } else {
      bare.lastIndex = at
      bare.test(value)
      text = value.slice(at, bare.lastIndex)
      at = bare.lastIndex
    }
    out.push({ name: m[1].toLowerCase(), value: text })
    head.lastIndex = at
  }
  return out
}

/**
 * A parameter out of a Content-Type / Content-Disposition line; the first one
 * of that name, as Python's email package reads it.
 *
 * RFC 2231 first, because that is what decides the name the victim's client
 * shows. `filename="invoice.pdf"; filename*=UTF-8''invoice.pdf.exe` is a real
 * shape: the extended form wins in Outlook, Thunderbird, Apple Mail and Gmail,
 * so the user saves the .exe while a reader that only knows the plain form
 * reports the decoy — and every check keyed on the filename goes quiet with
 * it. The continuation form (`name*0=`, `name*1=`) is the same parameter split
 * across lines and is reassembled in order.
 */
function param(value: string, key: string): string {
  const all = params(value)
  return extendedParam(all, key) || (all.find((p) => p.name === key)?.value ?? '')
}

function extendedParam(all: Param[], key: string): string {
  const pieces: { index: number; text: string; encoded: boolean }[] = []
  const pieceName = new RegExp(`^${key}\\*(\\d+)?(\\*)?$`)
  for (const p of all) {
    const m = pieceName.exec(p.name)
    if (!m) continue
    pieces.push({
      index: m[1] ? Number(m[1]) : 0,
      // A continuation piece is percent-encoded only when its own name ends
      // with `*`; an unmarked piece is literal and must not be decoded.
      encoded: Boolean(m[2]) || m[1] === undefined,
      // Untrimmed: `"invoice.pdf          "` is padding the sender chose, to
      // push `.exe` out of sight, and trimming it showed a name nobody sent.
      text: p.value
    })
  }
  if (!pieces.length) return ''
  pieces.sort((a, b) => a.index - b.index)
  // charset'language' opens the first piece, and only an encoded one (RFC 2231
  // §4). Stripped from a literal piece it ate "Mike's and Jane's travel ".
  let charset = ''
  const first = pieces[0]
  const tag = first.index === 0 && first.encoded ? /^([^']*)'[^']*'/.exec(first.text) : null
  if (tag) {
    charset = tag[1]
    first.text = first.text.slice(tag[0].length)
  }
  // A run of encoded pieces is one byte string, decoded once in its declared
  // charset. Piece by piece, a UTF-8 character split across two pieces — an
  // RLO, say — stayed as %-escapes and the override it spells went unremarked,
  // and one stray %FF left a whole piece undecoded.
  const utf8 = new TextEncoder()
  let out = ''
  let run: number[] = []
  const flush = (): void => {
    if (run.length) out += (decoderFor(charset) ?? new TextDecoder('utf-8')).decode(Uint8Array.from(run))
    run = []
  }
  for (const piece of pieces) {
    if (!piece.encoded) {
      flush()
      out += piece.text
      continue
    }
    for (const chunk of piece.text.split(/(%[0-9A-Fa-f]{2})/)) {
      if (/^%[0-9A-Fa-f]{2}$/.test(chunk)) run.push(parseInt(chunk.slice(1), 16))
      // A literal character as the UTF-8 it was read from, not its low byte:
      // U+202E cut to 0x2E is a '.', and the override would vanish.
      else for (const byte of utf8.encode(chunk)) run.push(byte)
    }
  }
  flush()
  return out
}

function splitHeadersAndBody(raw: string): RawPart {
  const text = raw.replace(/\r\n?/g, '\n')
  // A part that opens with a blank line has no headers at all — its whole
  // chunk is the body. Without this, `indexOf('\n\n')` lands on the SECOND
  // blank line and the first paragraph of the mail is parsed as a header
  // block, which silently loses it and every link in it.
  if (text.startsWith('\n')) return { headers: [], body: text.slice(1) }
  const blank = text.indexOf('\n\n')
  if (blank < 0) return { headers: parseHeaderBlock(text), body: '' }
  return { headers: parseHeaderBlock(text.slice(0, blank + 1)), body: text.slice(blank + 2) }
}

/**
 * Split a multipart body on its boundary.
 *
 * The preamble before the first boundary and the epilogue after the closing
 * one are dropped, which is what RFC 2046 says they are: text for clients that
 * cannot read MIME, not content.
 */
function splitParts(body: string, boundary: string): string[] {
  // Matched a LINE AT A TIME against the exact delimiter, not as a substring.
  // RFC 2046 says the delimiter is `--boundary` alone on its line, and holding
  // to that matters for more than tidiness: a substring split would let a
  // crafted inner boundary that merely STARTS with the outer one swallow the
  // outer split and hide a part — an attachment the analyst never sees — from
  // a tool whose whole job is to show them everything that is in the file.
  const open = `--${boundary}`
  const close = `--${boundary}--`
  const out: string[] = []
  let current: string[] | null = null
  for (const line of body.split('\n')) {
    // trimEnd, not `/\s+$/`: the regex retries from every space in a run and
    // took seconds on one attacker-written line of 80,000 spaces. Same set of
    // characters stripped, in one pass.
    const delimiter = line.trimEnd()
    if (delimiter === open) {
      if (current) out.push(current.join('\n'))
      current = []
      continue
    }
    if (delimiter === close) {
      if (current) out.push(current.join('\n'))
      return out
    }
    if (current) current.push(line)
  }
  if (current) out.push(current.join('\n'))
  return out
}

/**
 * One byte per code unit, as atob hands them back. A plain loop on purpose:
 * `Uint8Array.from` with a callback walks the string iterator and calls back
 * per byte, which made a 10 MB attachment take about 40 times longer to decode.
 */
export function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

interface Decoded {
  bytes: Uint8Array
  /**
   * The bytes came out of a transfer encoding, so the text is decoded from
   * them in the part's charset. False for 7bit/8bit, whose text the file read
   * has already decoded.
   */
  exact: boolean
  /**
   * The bytes are the file's real bytes, so a hash of them means something.
   * The same as `exact` except for quoted-printable, which decodes exactly as
   * text while its bytes may not be the file's.
   */
  hashExact?: boolean
  /** Decoding failed outright — `bytes` is empty because nothing was read. */
  failed: boolean
}

function decodeBody(body: string, encoding: string): Decoded {
  const enc = encoding.toLowerCase().trim()
  if (enc === 'base64') {
    // RFC 2045 §6.8 tells a decoder to ignore characters outside the alphabet,
    // and every mail client does, so the victim gets the file. atob is strict
    // and throws on one stray byte — which used to hand back zero bytes marked
    // exact, i.e. the empty-file hash presented as the attachment's own.
    const cleaned = body.replace(/[^A-Za-z0-9+/=]/g, '')
    // A loop, not `/=+$/`, which is quadratic on a long run of '=' followed by
    // anything else: an 81 KB part of them froze the analysis for seconds.
    let end = cleaned.length
    while (end > 0 && cleaned.charCodeAt(end - 1) === 0x3d) end--
    const padded = cleaned.slice(0, end)
    // A part that carried something but cleaned down to nothing is a part we
    // could not read — not an empty file. The difference matters: the second
    // gets hashed, and the SHA-256 of zero bytes is a real-looking answer that
    // reads as "clean" in any sandbox for a payload nobody has looked at.
    if (/\S/.test(body) && padded.length === 0) {
      return { bytes: new Uint8Array(), exact: true, failed: true }
    }
    try {
      return {
        bytes: latin1Bytes(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))),
        exact: true,
        failed: false
      }
    } catch {
      return { bytes: new Uint8Array(), exact: true, failed: true }
    }
  }
  if (enc === 'quoted-printable') {
    // Soft line breaks first: `=` at end of line means "no break here".
    const joined = body.replace(/=\n/g, '')
    return {
      bytes: quotedPrintableBytes(joined),
      exact: true,
      failed: false,
      // A hard line break stands for CRLF (RFC 2045 §6.7), which the reader has
      // already rewritten as LF, and a raw non-ASCII character came through the
      // file read's UTF-8 decoding: either way these are not the bytes that
      // were sent, and a hash of them would be quoted at a sandbox as if they were.
      hashExact: !/[\u0080-\uffff]/.test(joined) && !joined.includes('\n')
    }
  }
  // 7bit/8bit/binary: the file read already decoded these as UTF-8, so the
  // true bytes are that text re-encoded, not its code units truncated to
  // latin1 — which gave the wrong size and the wrong hash for anything
  // non-ASCII.
  return { bytes: new TextEncoder().encode(body), exact: false, failed: false }
}

/** A decoder for the declared charset, or null when this reader has none for that label. */
function decoderFor(charset: string): TextDecoder | null {
  try {
    return new TextDecoder(charset || 'utf-8')
  } catch {
    return null
  }
}

function decodeText(bytes: Uint8Array, charset: string, exact: boolean, raw: string, out: Eml, mime: string): string {
  if (!exact) return raw // already decoded by the file read; re-decoding would mangle it
  const decoder = decoderFor(charset)
  // Said, not swallowed: UTF-7 is a filter-evasion charset this reader cannot
  // decode, and read as UTF-8 its `+ADw-a href+AD0-` hides the real link while
  // a URL-shaped fragment of it lands in Indicators.
  if (!decoder) {
    out.notes.push(
      `A ${mime} part declared charset ${charset}, which this reader cannot decode; it is shown as UTF-8, ` +
        'so its text, links and indicators may be wrong or missing.'
    )
  }
  return (decoder ?? new TextDecoder('utf-8')).decode(bytes)
}

/**
 * Blank lines ahead of the first header are dropped, as parseHeaderBlock does,
 * but only when a header follows: a pasted body that opens on a blank line is
 * still body. Without it, one stray Enter before a paste made the whole
 * message a headerless body — its attachments gone and "None" said of them —
 * while the header panel read the same paste normally.
 *
 * A search, not a repeated-group regex, which overflows V8's backtrack stack on
 * a few million blank lines.
 */
export function withoutLeadingBlankLines(raw: string): string {
  const first = raw.search(/\S/)
  if (first < 0) return raw
  const start = Math.max(raw.lastIndexOf('\n', first), raw.lastIndexOf('\r', first)) + 1
  return /^[!-9;-~]+:/.test(raw.slice(start, start + 1000)) ? raw.slice(start) : raw
}

/** Take a raw .eml apart. Pure, offline, and it never renders anything. */
export function parseEml(raw: string): Eml {
  // The root only: a MIME part that opens on a blank line genuinely has no
  // headers, and splitHeadersAndBody keeps that rule for parts.
  const root = splitHeadersAndBody(withoutLeadingBlankLines(raw))
  const out: Eml = { headers: root.headers, text: '', html: '', attachments: [], notes: [] }
  walk(root, out, 0)
  // Only when nothing at all was found or noted: every note that can stand
  // beside an empty result says something was not read, and "headers only"
  // next to it contradicted it.
  if (!out.text && !out.html && !out.attachments.length && !out.notes.length) {
    out.notes.push(
      out.headers.length
        ? 'No message body in this paste — headers only.'
        : 'No headers and no body — is this an email?'
    )
  }
  return out
}

function walk(part: RawPart, out: Eml, depth: number): void {
  // Deeply nested multiparts are a real shape (forwarded chains), but a cycle
  // is not: a bound keeps a malformed file from walking forever.
  if (depth > 12) {
    out.notes.push('Stopped at 12 levels of nesting — deeper parts were not read.')
    return
  }
  const contentType = headerValue(part.headers, 'content-type')
  const mime = (contentType.split(';')[0] || 'text/plain').toLowerCase().trim()

  if (mime.startsWith('multipart/')) {
    const boundary = param(contentType, 'boundary')
    if (!boundary) {
      out.notes.push(`A ${mime} part declared no boundary, so its contents were not read.`)
      return
    }
    const parts = splitParts(part.body, boundary)
    // A body with no line opening a part — a truncated paste, or a boundary
    // that is not the one the parts use — was lost without a word, and the
    // root then called the mail "headers only". The boundary is the sender's
    // text and may well appear inside a longer line, so the note does not
    // quote it or say it is absent.
    if (!parts.length && /\S/.test(part.body)) {
      out.notes.push(
        `A ${mime} part has no line opening a part with its declared boundary, so its contents were not read.`
      )
    }
    for (const chunk of parts) walk(splitHeadersAndBody(chunk), out, depth + 1)
    return
  }

  const encoding = headerValue(part.headers, 'content-transfer-encoding')
  const disposition = headerValue(part.headers, 'content-disposition')
  const filename = decodeEncodedWords(param(disposition, 'filename')) || decodeEncodedWords(param(contentType, 'name'))
  const inline = /^inline/i.test(disposition) || Boolean(headerValue(part.headers, 'content-id'))
  // A `filename` on an explicitly INLINE part is a save-as suggestion, not a
  // disposition. Treating it as "this is an attachment" let one parameter on
  // the text/html part move the whole body out of the body: the client still
  // rendered it — the header says inline — while the analysis showed no HTML
  // source, no links, and one unremarkable row under Attachments.
  const attached = /^attachment/i.test(disposition)
  const isAttachment = attached || (Boolean(filename) && !inline)
  const { bytes, exact, failed, hashExact = exact } = decodeBody(part.body, encoding)
  if (failed) {
    out.notes.push(
      `A ${encoding.trim() || 'transfer-encoded'} part${filename ? ` named ${filename}` : ''} could not be decoded, ` +
        'so its size and hashes are not recorded.'
    )
  }

  // A forwarded message is the commonest way a reported phish reaches a SOC —
  // the user hits "forward as attachment". Walking into it is what puts the
  // real payload's name, bytes and hash in front of the analyst instead of a
  // single row reading `fwd.eml — message/rfc822`.
  if (mime === 'message/rfc822') {
    if (filename || attached) pushAttachment(out, filename, mime, bytes, inline, failed, hashExact, attached)
    walk(
      splitHeadersAndBody(decodeText(bytes, param(contentType, 'charset'), exact, part.body, out, mime)),
      out,
      depth + 1
    )
    return
  }

  if (isAttachment || !mime.startsWith('text/')) {
    pushAttachment(out, filename, mime, bytes, inline, failed, hashExact, attached)
    return
  }

  const charset = param(contentType, 'charset')
  const text = decodeText(bytes, charset, exact, part.body, out, mime)
  if (!exact && charset && charset.toLowerCase() !== 'utf-8') {
    out.notes.push(`A ${mime} part declared charset ${charset} but was not transfer-encoded, so it may be mangled.`)
  }
  // Separated, not run together: two adjacent text parts ending and starting
  // mid-token were being joined into a token that appears in neither part —
  // which invented a URL that was never in the mail.
  if (mime === 'text/html') out.html += (out.html ? '\n' : '') + text
  else out.text += (out.text ? '\n' : '') + text
}

function pushAttachment(
  out: Eml,
  filename: string,
  contentType: string,
  bytes: Uint8Array,
  inline: boolean,
  undecodable: boolean,
  exact: boolean,
  attached = false
): void {
  out.attachments.push({
    filename: filename || '(no filename given)',
    contentType,
    size: bytes.length,
    bytes,
    inline,
    attached,
    undecodable,
    exact
  })
}

/**
 * Hash an attachment, hex. Separate from parsing because it is async.
 *
 * ponytail: SHA-256 and SHA-1 only. MD5 is what several lookup services still
 * key on, but WebCrypto does not implement it and hand-rolling a broken hash
 * to save the analyst one paste is not a trade worth making. If MD5 turns out
 * to matter, it is a self-contained ~60 lines here and nothing else changes.
 */
export async function hashBytes(bytes: Uint8Array, algorithm: 'SHA-256' | 'SHA-1' = 'SHA-256'): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const digest = await crypto.subtle.digest(algorithm, buffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
