/**
 * Showing an analyst what is inside an attachment, without running it.
 *
 * One rule decides everything here: a file is rendered ONLY when its own bytes
 * say it is a raster image. Not when the filename says so, not when the
 * Content-Type says so — both are written by the sender, and a .png that
 * begins `MZ` is the whole reason the magic-byte check exists. A raster image
 * decoded from bytes already in the message cannot reach the network, cannot
 * run a script and cannot phone home, which is what makes it the one safe
 * thing to actually draw.
 *
 * Everything else is shown as SOURCE or as bytes. SVG in particular is an
 * image to most people and a script container to a browser, so it lands in the
 * text branch and is read, never drawn. HTML likewise.
 */

export type PreviewKind = 'image' | 'text' | 'binary'

/** Raster formats that are safe to draw: no scripting, no external references. */
const DRAWABLE = /^(JPEG|PNG|GIF) image$/

/**
 * How to show this attachment.
 *
 * `sniffed` is the magic-byte reading and is the ONLY thing that can promote a
 * file to `image`. `contentType` and `filename` only ever help decide between
 * text and binary, where the worst case is showing bytes to someone expecting
 * words.
 */
export function previewKind(contentType: string, filename: string, sniffed: string, bytes: Uint8Array): PreviewKind {
  if (DRAWABLE.test(sniffed)) return 'image'
  // A recognised non-text signature settles it — an OLE document is bytes even
  // though half of it reads as words.
  if (sniffed) return 'binary'
  if (/^text\//i.test(contentType) || /^(application\/)?(json|xml|javascript|x-sh)$/i.test(contentType)) return 'text'
  if (/\.(txt|log|csv|tsv|json|xml|html?|htm|svg|eml|md|ics|vcf|js|css|ps1|bat|sh|yml|yaml)$/i.test(filename)) {
    return 'text'
  }
  return looksLikeText(bytes) ? 'text' : 'binary'
}

/** Mostly-printable, and no NUL in the first stretch: the usual cheap test. */
function looksLikeText(bytes: Uint8Array): boolean {
  if (!bytes.length) return false
  const sample = bytes.subarray(0, 1024)
  let printable = 0
  for (const byte of sample) {
    if (byte === 0) return false
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127)) printable++
  }
  return printable / sample.length >= 0.9
}

/** The media type to draw with — taken from the bytes, never from the message. */
export function drawableType(sniffed: string): string {
  if (sniffed.startsWith('JPEG')) return 'image/jpeg'
  if (sniffed.startsWith('PNG')) return 'image/png'
  if (sniffed.startsWith('GIF')) return 'image/gif'
  return ''
}

/** Largest image we will build a data URL for. Beyond it, the bytes are listed instead. */
export const IMAGE_CAP = 8_000_000

/**
 * A `data:` URL for the image.
 *
 * Built in chunks: `String.fromCharCode(...bytes)` on a multi-megabyte array
 * overflows the call stack, which on this path would take the whole modal down
 * on exactly the large attachment an analyst most wants to look at.
 */
export function imageDataUrl(bytes: Uint8Array, sniffed: string): string {
  const type = drawableType(sniffed)
  if (!type || !bytes.length || bytes.length > IMAGE_CAP) return ''
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:${type};base64,${btoa(binary)}`
}

/** Decoded text for the source view, capped and told when it was cut. */
export function previewText(bytes: Uint8Array, limit = 20_000): { text: string; truncated: boolean } {
  const slice = bytes.subarray(0, limit)
  let text = ''
  try {
    text = new TextDecoder('utf-8').decode(slice)
  } catch {
    text = ''
  }
  return { text, truncated: bytes.length > limit }
}

/**
 * The first bytes, as an analyst reads them: offset, hex, ASCII.
 *
 * Bytes are what is left when nothing else can be said honestly about a file,
 * and the header is where the answer usually is.
 */
export function hexDump(bytes: Uint8Array, limit = 512): string {
  const end = Math.min(bytes.length, limit)
  const lines: string[] = []
  for (let offset = 0; offset < end; offset += 16) {
    const row = bytes.subarray(offset, Math.min(offset + 16, end))
    const hex = [...row]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(47, ' ')
    const ascii = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`)
  }
  return lines.join('\n')
}
