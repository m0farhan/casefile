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
 * as UTF-8. base64 and quoted-printable parts therefore round-trip exactly,
 * because they are ASCII on the wire, but a 7bit/8bit part in a non-UTF-8
 * charset was decoded by the file read before this module saw it and its
 * declared charset can no longer be applied. Those parts are marked so the
 * analyst is not told a clean story about a body that may be mangled.
 */

export interface Attachment {
  filename: string
  contentType: string
  /** Bytes after transfer decoding — the true size, not the encoded length. */
  size: number
  bytes: Uint8Array
  /** Referenced from the HTML body (a logo) rather than offered as a file. */
  inline: boolean
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
   * The bytes are the file exactly as it travelled. base64 and quoted-printable
   * are ASCII on the wire and round-trip exactly; a 7bit/8bit part reached us
   * through the reader's line normalisation, so its hashes will not match the
   * sender's copy and the caller has to say so.
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

/**
 * A parameter out of a Content-Type / Content-Disposition line.
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
  const extended = extendedParam(value, key)
  if (extended) return extended
  const quoted = new RegExp(`;\\s*${key}\\s*=\\s*"([^"]*)"`, 'i').exec(value)
  if (quoted) return quoted[1]
  const bare = new RegExp(`;\\s*${key}\\s*=\\s*([^;\\s]+)`, 'i').exec(value)
  return bare ? bare[1] : ''
}

function extendedParam(value: string, key: string): string {
  const pieces: { index: number; text: string; encoded: boolean }[] = []
  const re = new RegExp(`;\\s*${key}\\*(\\d+)?(\\*)?\\s*=\\s*(?:"([^"]*)"|([^;]+))`, 'gi')
  for (const m of value.matchAll(re)) {
    pieces.push({
      index: m[1] ? Number(m[1]) : 0,
      // A continuation piece is percent-encoded only when its own name ends
      // with `*`; an unmarked piece is literal and must not be decoded.
      encoded: Boolean(m[2]) || m[1] === undefined,
      text: (m[3] ?? m[4] ?? '').trim()
    })
  }
  if (!pieces.length) return ''
  pieces.sort((a, b) => a.index - b.index)
  let out = ''
  for (const piece of pieces) {
    // charset'language'text — only ever on the first piece.
    const text = piece.index === 0 ? piece.text.replace(/^[^']*'[^']*'/, '') : piece.text
    if (!piece.encoded) {
      out += text
      continue
    }
    try {
      out += decodeURIComponent(text)
    } catch {
      out += text
    }
  }
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
    const delimiter = line.replace(/\s+$/, '')
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

function latin1Bytes(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff)
}

interface Decoded {
  bytes: Uint8Array
  /** The bytes are the file's real bytes, so a hash of them means something. */
  exact: boolean
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
    const padded = cleaned.replace(/=+$/, '')
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
    return { bytes: quotedPrintableBytes(body.replace(/=\n/g, '')), exact: true, failed: false }
  }
  // 7bit/8bit/binary: the file read already decoded these as UTF-8, so the
  // true bytes are that text re-encoded, not its code units truncated to
  // latin1 — which gave the wrong size and the wrong hash for anything
  // non-ASCII.
  return { bytes: new TextEncoder().encode(body), exact: false, failed: false }
}

function decodeText(bytes: Uint8Array, charset: string, exact: boolean, raw: string): string {
  if (!exact) return raw // already decoded by the file read; re-decoding would mangle it
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** Take a raw .eml apart. Pure, offline, and it never renders anything. */
export function parseEml(raw: string): Eml {
  const root = splitHeadersAndBody(raw)
  const out: Eml = { headers: root.headers, text: '', html: '', attachments: [], notes: [] }
  walk(root, out, 0)
  if (!out.text && !out.html && !out.attachments.length) {
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
    for (const chunk of splitParts(part.body, boundary)) walk(splitHeadersAndBody(chunk), out, depth + 1)
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
  const isAttachment = /^attachment/i.test(disposition) || (Boolean(filename) && !inline)
  const { bytes, exact, failed } = decodeBody(part.body, encoding)
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
    if (filename || /^attachment/i.test(disposition)) {
      pushAttachment(out, filename, mime, bytes, inline, failed, exact)
    }
    walk(splitHeadersAndBody(decodeText(bytes, param(contentType, 'charset'), exact, part.body)), out, depth + 1)
    return
  }

  if (isAttachment || !mime.startsWith('text/')) {
    pushAttachment(out, filename, mime, bytes, inline, failed, exact)
    return
  }

  const charset = param(contentType, 'charset')
  const text = decodeText(bytes, charset, exact, part.body)
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
  exact: boolean
): void {
  out.attachments.push({
    filename: filename || '(no filename given)',
    contentType,
    size: bytes.length,
    bytes,
    inline,
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
