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

/** `key="value"` or `key=value` out of a Content-Type / Content-Disposition line. */
function param(value: string, key: string): string {
  const quoted = new RegExp(`;\\s*${key}\\s*=\\s*"([^"]*)"`, 'i').exec(value)
  if (quoted) return quoted[1]
  const bare = new RegExp(`;\\s*${key}\\s*=\\s*([^;\\s]+)`, 'i').exec(value)
  return bare ? bare[1] : ''
}

function splitHeadersAndBody(raw: string): RawPart {
  const text = raw.replace(/\r\n?/g, '\n')
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

function decodeBody(body: string, encoding: string): { bytes: Uint8Array; exact: boolean } {
  const enc = encoding.toLowerCase().trim()
  if (enc === 'base64') {
    try {
      return { bytes: latin1Bytes(atob(body.replace(/\s+/g, ''))), exact: true }
    } catch {
      return { bytes: new Uint8Array(), exact: true }
    }
  }
  if (enc === 'quoted-printable') {
    // Soft line breaks first: `=` at end of line means "no break here".
    return { bytes: quotedPrintableBytes(body.replace(/=\n/g, '')), exact: true }
  }
  return { bytes: latin1Bytes(body), exact: false }
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
  const isAttachment = /^attachment/i.test(disposition) || Boolean(filename)
  const { bytes, exact } = decodeBody(part.body, encoding)

  if (isAttachment || (!mime.startsWith('text/') && mime !== 'message/rfc822')) {
    out.attachments.push({
      filename: filename || '(no filename given)',
      contentType: mime,
      size: bytes.length,
      bytes,
      inline: /^inline/i.test(disposition) || Boolean(headerValue(part.headers, 'content-id'))
    })
    return
  }

  const charset = param(contentType, 'charset')
  const text = decodeText(bytes, charset, exact, part.body)
  if (!exact && charset && charset.toLowerCase() !== 'utf-8') {
    out.notes.push(`A ${mime} part declared charset ${charset} but was not transfer-encoded, so it may be mangled.`)
  }
  if (mime === 'text/html') out.html += text
  else out.text += text
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
