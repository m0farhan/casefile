/**
 * What a PDF does when it is opened, and what it carries, read off the bytes.
 *
 * This is a SCAN and not a parse. It builds no object graph, resolves no
 * indirect reference and renders nothing — deliberately, because a PDF engine
 * is the thing being defended against here, and shipping one to open hostile
 * files would put the attacker's chosen parser inside the analyst's notes app.
 * What a scan can honestly answer is narrower: which action-bearing names the
 * file contains, which URLs are written into it in the clear, and which of its
 * image streams are whole files in their own right.
 *
 * The images are not a bonus. The modern PDF phish is one page-sized picture
 * holding a QR code, with no /JavaScript, no /OpenAction and nothing else for a
 * marker census to find; a reader that only counts markers reports that file as
 * unremarkable. A /DCTDecode stream IS a JPEG lying in the file, so it is handed
 * back as bytes for the caller to sniff and hash like any other attachment.
 *
 * Everything here is a statement about bytes. Nothing is scored, nothing is
 * called suspicious, and an empty result means this scan saw nothing — never
 * that the file is clean. The three places where that distinction has teeth
 * (object streams, encryption, a scan that stopped short) each push their own
 * note, because a census that quietly under-reports is worse than no census:
 * it is a false negative wearing a fact's clothes.
 *
 * readPdfObjects is the second, optional half: an object read on top of the
 * scan (pdfObjects.ts finds and parses the objects, pdfText.ts reads page text).
 * It exists because the modern PDF phish hides where the scan is blind — its
 * /OpenAction and /URI packed in a compressed object stream, its lure URL drawn
 * as page text. It still renders, fetches and runs nothing, and what it finds is
 * listed with where it was found, never scored.
 */
import { latin1Bytes } from './eml'
import {
  asArray,
  asDict,
  asInt,
  asName,
  asString,
  checkTime,
  closesAt,
  FILE_PDF_MS,
  GAP,
  latin1,
  MARKER_NAMES,
  openPdf,
  type PdfDict,
  type PdfDoc,
  type PdfObject,
  type PdfStream,
  type PdfString,
  type PdfValue,
  streamEnd,
  textString,
  ValueSpent,
  type Work,
  WORK_BUDGET,
  WorkSpent
} from './pdfObjects'
import { type PdfPage, type PdfTextResult, readPageText } from './pdfText'

export type { PdfPage, PdfPicture } from './pdfText'
export { GAP, stripGap } from './pdfObjects'

/** A whole image file lifted out of a stream, for the caller's magic-byte gate. */
export interface PdfImage {
  /** Byte offset of the stream data in the file, so a finding can be pointed at. */
  offset: number
  /**
   * A view onto the file's own bytes — not a copy. Nothing here decodes, crops
   * or re-encodes them: what the caller hashes is what is in the file, so the
   * hash means something at a sandbox.
   */
  bytes: Uint8Array
  /** The filter name matched in front of this stream — `/DCTDecode` or `/JPXDecode`. */
  filter: string
}

export interface PdfFacts {
  /** From the `%PDF-1.x` header, or '' when there is no header to read it from. */
  version: string
  /** The name /Encrypt appears in the scanned bytes. A byte match, not a resolved trailer reference. */
  encrypted: boolean
  /** Only the names this scan matched — a zero is not carried as a row saying nothing. */
  markers: { name: string; count: number }[]
  /**
   * The URL each /URI string resolves to. Escapes are decoded (`\150` is `h`,
   * `\)` is `)`) and hex strings are turned back into characters, so this is
   * the URL a reader would visit and NOT necessarily a byte run that can be
   * grepped for in the file. The CALLER defangs: defanging here would be
   * applied a second time by the time it is displayed. One cut at
   * MAX_URI_CHARS ends in a GAP.
   */
  uris: string[]
  images: PdfImage[]
  /** Where this scan is blind, said out loud. */
  notes: string[]
  /** What readPdfObjects read. Absent: the object read did not run. */
  parsed?: PdfParsed
}

/** A /URI string read from the objects. `where` is the object it was read from. */
export interface PdfLink {
  uri: string
  where: string
  /** The page whose annotation holds it; null when no page read here does. */
  page: number | null
  /** Longer than MAX_SHOWN, and shown cut there: `uri` then ends in a GAP. */
  cut: boolean
}
/** `type` is one of ACTION_TYPES, as a fixed string with its slash — never the file's own spelling. */
export interface PdfAction {
  type: string
  trigger: string
  /** Ends in a GAP when cut at MAX_SHOWN. */
  target: string
  where: string
}
/**
 * `source`: the whole decoded text, at most SCRIPT_CAP — less, and not `whole`,
 * once the file's SCRIPT_SHARE is used up. It ends in a GAP where it stops
 * mid-word, or where the decode lost its end and so whether it did is unknown.
 */
export interface PdfScript {
  where: string
  source: string
  whole: boolean
}
export interface PdfEmbeddedFile {
  /** names[0], or '' when it has none. */
  name: string
  /** Every distinct UF, F, Unix, Mac and DOS name, because a file can name itself one thing to one reader and another to the next. */
  names: string[]
  /** /Params /Size, as the file declares it. */
  size: number | null
  where: string
  /** The first HEAD decoded bytes, for sniffing; empty when not decoded. */
  head: Uint8Array
  /** Only when decoded whole: a hash of a prefix would be a real-looking hash of a file that is not in this one. */
  bytes: Uint8Array | null
}
/** `type`: '/Tx' '/Btn' '/Ch' '/Sig', or '' for anything else. */
export interface PdfField {
  name: string
  value: string
  type: string
  password: boolean
  /**
   * Set only when the field has a /V this reader does not list — a dictionary,
   * a stream or a number (a /Sig field's /V is its signature), a reference to
   * an object not read here, or an array whose elements examined list nothing
   * while more were never examined — so an empty `value` is not shown as "no
   * value set" about a field that sets one.
   */
  unread?: true
  /**
   * Set only when `value` was cut at MAX_FIELD_VALUE characters. Not inferable
   * from the length: a value of exactly MAX_FIELD_VALUE characters may be whole.
   * `value` ends in a GAP only when the cut split a word; a cut between words,
   * or between array elements, leaves every word kept whole. Array elements
   * past what this reader examines are not this: that stop falls between whole
   * elements, so it is said in a note instead.
   */
  cut?: true
}
export interface PdfInfo {
  key: string
  value: string
}
export interface PdfParsed {
  objects: number
  /** The trailer points to an /Encrypt dictionary. */
  encrypted: boolean
  /**
   * Its strings are encrypted too — false when /StrF leaves them at /Identity,
   * as encrypting only file attachments does. What decides whether a string
   * read here (a link, a target, a name, a value) is ciphertext.
   */
  stringsEncrypted: boolean
  objectStreams: { found: number; read: number }
  pageCount: number | null
  pages: PdfPage[]
  /** Object-read /URI values NOT already in facts.uris (compared as listed: after the same cut, and its GAP). */
  links: PdfLink[]
  actions: PdfAction[]
  scripts: PdfScript[]
  embeddedFiles: PdfEmbeddedFile[]
  fields: PdfField[]
  info: PdfInfo[]
  xfa: boolean
  /** The census over decoded object-stream payloads: names the byte scan could not see. */
  hiddenMarkers: { name: string; count: number }[]
  /** MARKER_NAMES written with #xx escapes, which the byte scan does not decode. */
  escapedMarkers: { name: string; count: number }[]
}

/**
 * Bounds. Every one of these is a file the attacker gets to choose the size of.
 *
 * The scan cap is the load-bearing one: it is what keeps a 400MB PDF from
 * being turned into a 400MB string on the UI thread before anything else in
 * this module gets a say.
 */
const SCAN_CAP = 16 * 1024 * 1024
const HEADER_WINDOW = 1024
const MAX_IMAGES = 24
const MAX_IMAGE_TOTAL = 12 * 1024 * 1024
const MAX_URIS = 200
const MAX_URI_CHARS = 4096
/**
 * How many bytes ALL the string readers together may walk looking for closes,
 * across one scan.
 *
 * This replaced a per-string span of four raw bytes per kept character, which
 * was wrong in both directions. Whitespace between hex digits is unbounded
 * (§7.3.4.3), so there is no per-string number that fits every legal encoding of
 * a URL: a 200-character link spaced out to 16,759 raw bytes is ordinary, legal,
 * closed — and the span dropped it and said it "was never closed", which is a
 * false statement about the file. And a span is the wrong shape of bound anyway:
 * the cost this has to stop is the TOTAL, a file of nothing but unterminated
 * strings, not any one of them.
 *
 * One scan's worth of string walking is therefore one pass over the scanned
 * bytes — the same order the census regex already costs — and any single string,
 * however spaced out, is read to its close while that lasts.
 *
 * ponytail: first come, first served, so one runaway string early in a file can
 * spend the lot and leave the rest unread. They are counted and said out loud
 * rather than dropped in silence. Upgrade path if a real file ever hits it: a
 * per-string share of what is left, instead of a single pot.
 */
const STRING_BUDGET = SCAN_CAP
/**
 * How many image-filter matches a scan will EXAMINE, as opposed to keep.
 *
 * MAX_IMAGES bounds the output, which is a different thing and was not enough on
 * its own: every match that yields nothing — a repeat, a filter name with no
 * stream after it — reaches the next iteration without moving it, so a file made
 * of nothing but those ran streamDataStart's window copy once per occurrence
 * under no bound at all. A cap has to sit in front of the cost it exists to
 * prevent, so this one counts attempts.
 *
 * readUris deliberately has no equivalent. Its per-match cost is a few
 * comparisons plus the string walk, and the walk is bounded directly by
 * STRING_BUDGET — so a count cap there bounded nothing that was not already
 * bounded, while firing on an ordinary long document (4,097 pages carrying the
 * same footer link) with an alarming note about entries "not looked at", and
 * hiding a genuinely different 4,097th link behind it.
 */
const MAX_SCAN_MATCHES = 4096
/** How far past a filter name to look for its `stream` keyword — a dictionary, not a file. */
const STREAM_LOOKAHEAD = 4096

/**
 * A name token ends at a delimiter or at whitespace (ISO 32000-1 §7.2.2).
 *
 * Spelled out rather than matched as a substring because the shorter names are
 * prefixes of ordinary ones: `/JS` as a substring matches inside `/JSName`,
 * which reports a plain dictionary key as an embedded script and puts a count
 * next to it — a fabricated fact, arrived at honestly.
 */
const NAME_END = '[\\s\\x00()<>\\[\\]{}/%]'

const MARKER_SOURCE = `/(${MARKER_NAMES.join('|')})(?=${NAME_END}|$)`
const IMAGE_FILTER_SOURCE = `/(DCTDecode|JPXDecode)(?=${NAME_END}|$)`
const URI_SOURCE = `/URI(?=${NAME_END}|$)`

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }

/** The six characters §7.2.2 calls whitespace — NUL included, and `\s` is not the same set. */
const PDF_WHITESPACE = '\0\t\n\f\r '

/**
 * `/Length` written as a direct integer, for comparing against what was
 * extracted. Built from PDF_WHITESPACE so the set is defined in one place.
 *
 * The negative lookahead is what keeps this honest: `/Length 12 0 R` is an
 * indirect reference, and reading the `12` out of it would compare an object
 * number against a byte count and call every such stream mismatched — a note
 * worse than no note. The digit count is bounded because the number is
 * attacker-chosen and only ever compared, never allocated from.
 */
const DIRECT_LENGTH = new RegExp(`/Length[${PDF_WHITESPACE}]+(\\d{1,10})(?![\\s\\d]*R)`)

/**
 * Read a PDF's structure. Returns null when the bytes are not a PDF at all.
 *
 * Never throws: a file that cannot be read produces partial facts and a note
 * saying so. An analyst who pastes a corrupt PDF needs the half of it that was
 * readable, not a stack trace.
 */
export function readPdf(bytes: Uint8Array): PdfFacts | null {
  if (bytes.length < 8) return null

  const truncated = bytes.length > SCAN_CAP
  const scan = truncated ? bytes.subarray(0, SCAN_CAP) : bytes
  const text = latin1(scan)

  // Acrobat accepts a header that is not at offset 0, so this does too — a
  // polyglot with a prefix in front of the header opens as a PDF for the
  // victim, and a reader that insists on offset 0 declines to look at exactly
  // the file that was built to be looked at twice.
  // The window bounds where the header may START. Slicing at exactly 1024 cut
  // a header beginning at byte 1020 in half, and the note then said there was
  // no header in the first 1024 bytes about a file that had one there.
  const matched = /%PDF-(\d+\.\d+)/.exec(text.slice(0, HEADER_WINDOW + 16))
  const header = matched && matched.index < HEADER_WINDOW ? matched : null
  // No header at all is still a readable PDF when the object skeleton is there
  // (hand-assembled files, and files whose header was pushed past the window).
  const structural = text.includes('endobj') && text.includes('%%EOF')
  if (!header && !structural) return null

  const facts: PdfFacts = {
    version: header ? header[1] : '',
    encrypted: false,
    markers: [],
    uris: [],
    images: [],
    notes: []
  }

  // One try per section rather than one around all three. They do not depend on
  // each other, so a structure that defeats the URL reader is no reason to hand
  // back a file's images unread — and the images are the half of this that finds
  // the QR-code phish. Whichever section fell over, the rest still report.
  let failed = false
  const section = (read: () => void): void => {
    try {
      read()
    } catch {
      failed = true
    }
  }
  section(() => {
    facts.markers = census(text)
    facts.encrypted = facts.markers.some((m) => m.name === '/Encrypt')
  })
  // Outside the sections: these are the notes that say where the scan is blind,
  // and a file big enough to be truncated must say so even if the census fell
  // over reading it.
  blindSpots(facts, header ? header.index : -1, truncated, bytes.length)
  section(() => {
    facts.uris = readUris(text, facts.notes)
  })
  section(() => {
    facts.images = readImages(scan, text, facts.notes)
  })
  if (failed) {
    facts.notes.push('This scan stopped early on a structure it could not read, so what is listed above is partial.')
  }

  facts.notes.push(SCAN_CAVEAT, NO_VERDICT)
  return facts
}

/** The scan's standing caveat. readPdfObjects swaps it for DEEP_CAVEAT, which is why it is one constant. */
const SCAN_CAVEAT =
  'This is a byte scan, not a PDF parse: it resolves nothing and counts a name wherever it appears, including ' +
  'inside a string or a comment. A name written with hex escapes (/J#61vaScript is /JavaScript to a reader) is ' +
  'not decoded here, so a marker hidden that way is not counted.'
/** Always the last note of this module's: readPdfObjects inserts its notes in front of it. */
const NO_VERDICT =
  'Nothing above is a verdict, and no absence here is evidence of safety — what this scan cannot see, it did not look for.'

function census(text: string): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  const re = new RegExp(MARKER_SOURCE, 'g')
  for (let m = re.exec(text); m; m = re.exec(text)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
  const out: { name: string; count: number }[] = []
  for (const name of MARKER_NAMES) {
    const count = counts.get(name) ?? 0
    if (count > 0) out.push({ name: `/${name}`, count })
  }
  return out
}

/** The notes that decide whether the census above can be read as a census at all. */
function blindSpots(facts: PdfFacts, headerAt: number, truncated: boolean, size: number): void {
  // Both of these say what the scan MATCHED, not what the file is. The census
  // is byte-literal, so `% /ObjStm` in a comment is one of these counts, and
  // "this file keeps objects inside 1 compressed object stream" would then be a
  // statement about the file that the bytes do not support. What follows the
  // count is conditional, which is the part an analyst actually needs.
  const objstm = facts.markers.find((m) => m.name === '/ObjStm')
  if (objstm) {
    facts.notes.push(
      `The name /ObjStm appears ${objstm.count} time(s) here. A scan cannot see inside a compressed object stream, ` +
        'so any /JavaScript, /OpenAction or /URI stored in one is missing from the list above — read that as ' +
        '"not visible", not as "not present".'
    )
  }
  if (facts.encrypted) {
    facts.notes.push(
      "The name /Encrypt appears here, so this file's strings and streams may be encrypted. Anything read above may " +
        'therefore be incomplete, and bytes that look like noise here can decode to something else in a reader.'
    )
  }
  if (truncated) {
    facts.notes.push(`This file is ${size} bytes and only the first ${SCAN_CAP} were scanned; the rest was not read.`)
  }
  if (headerAt > 0) {
    facts.notes.push(`The %PDF header is at offset ${headerAt}, not at the start of the file.`)
  }
  if (headerAt < 0) {
    facts.notes.push(
      `No %PDF header in the first ${HEADER_WINDOW} bytes. This was read as a PDF on its object structure alone, ` +
        'so the version is not recorded.'
    )
  }
}

/**
 * A string read off the file: its value, and whether that value is all of it.
 *
 * `cut` cannot be recovered from the value's length. A hex string may be spaced
 * out (`68 74 74 70 …`), so the raw bytes read and the characters kept are two
 * different counts, and only the reader knows which one ran out.
 */
interface ReadString {
  value: string
  cut: boolean
}

function readUris(text: string, notes: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = new RegExp(URI_SOURCE, 'g')
  // Shared by every string read in this scan. See STRING_BUDGET: the work that
  // needs bounding is the total walked, and bounding it there means no count cap
  // is needed here and no ordinary file trips one.
  const budget = { left: STRING_BUDGET }
  let capped = false
  let cut = false
  let unclosed = 0
  let unread = 0
  let unresolved = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let i = m.index + m[0].length
    while (i < text.length && PDF_WHITESPACE.includes(text[i])) i++
    const opener = text[i]
    // `<<` opens a dictionary, and reading one as a hex string yields a line of
    // mojibake presented as a link.
    if (opener !== '(' && !(opener === '<' && text[i + 1] !== '<')) {
      // No string here. Either it is the `/S /URI` action-type NAME — the
      // reason this key appears twice in one dictionary, with no URL going
      // unread — or it is a value this scan does not read, most often
      // `/URI 12 0 R`, and dropping that without a word reports a URL-bearing
      // file as bare. Which one is decided by afterActionType, looking behind.
      if (!afterActionType(text, m.index)) unresolved++
      continue
    }
    // null is "this string did not close in the bytes read", which is not the
    // same fact as an empty one: `/URI ()` is a closed string carrying nothing,
    // and reporting it as unterminated would put a wrong sentence in the notes.
    const read = opener === '(' ? literalString(text, i, budget) : hexString(text, i, budget)
    if (read === null) {
      // And a string the budget stopped short of is a third fact again. Calling
      // it "never closed" would be a statement about the FILE — one this scan
      // cannot support, because it stopped before the close it was looking for
      // and a close may well be sitting just past where it stopped.
      if (budget.left > 0) unclosed++
      else unread++
      continue
    }
    if (!read.value || seen.has(read.value)) continue
    if (out.length >= MAX_URIS) {
      capped = true
      break
    }
    // After the two ways out above, not before them: the note this sets says the
    // string "is listed cut short", and a string cut at the character cap that
    // then fell out at the URL cap is not listed at all.
    if (read.cut) cut = true
    seen.add(read.value)
    // A GAP after a cut one: what is left is a prefix, and a prefix of a URL can
    // name another host (`…secure.paypal.co` of `…secure.paypal.com.evil.test`).
    out.push(read.cut ? read.value + GAP : read.value)
  }
  if (capped) {
    notes.push(
      `Stopped after ${MAX_URIS} URLs; this scan stopped there, so /URI entries past that point are not listed.`
    )
  }
  if (cut) notes.push(`At least one /URI string ran past ${MAX_URI_CHARS} characters and is listed cut short.`)
  if (unclosed) {
    notes.push(
      `${unclosed} /URI string(s) were never closed before the end of the bytes this scan read; nothing from them ` +
        'is listed.'
    )
  }
  if (unread) {
    notes.push(
      `${unread} /URI string(s) were not read: this scan walks at most ${STRING_BUDGET} bytes in total looking for ` +
        'the ends of strings, and earlier strings in this file spent it. Whether those close, and what they carry, ' +
        'is unknown here — their absence from the list above says nothing about them.'
    )
  }
  if (unresolved) {
    notes.push(
      `${unresolved} /URI name(s) were followed by something this scan does not read as a string — an object ` +
        'reference (/URI 12 0 R) is one such form, and this scan follows none of them. Nothing was read at those, ' +
        'so whatever they carry is not in the list above.'
    )
  }
  return out
}

/**
 * Is this `/URI` the VALUE of an `/S` key — the action type — rather than a key
 * with a URL after it?
 *
 * Decided by what PRECEDES the name, because key order in a dictionary carries
 * no meaning: `<< /URI (…) /S /URI >>` is exactly as legal as
 * `<< /S /URI /URI (…) >>`, and both are written in the wild. Guessing forward
 * from what FOLLOWS fits only the second, and against the first it counts the
 * action-type name as a value that went unresolved — a sentence about URLs this
 * scan failed to record, printed at a file where it recorded every one of them.
 * It scales, too: sixty links written that way read as sixty missing URLs and
 * bury the one entry that really is hiding one.
 *
 * ponytail: byte-literal, like every other name test here. A literal string
 * ending in the two characters `/S` immediately before a real /URI key would
 * silence the unresolved count for that one entry. That is the survivable
 * direction — it drops a caveat, it never prints a wrong one — and the value
 * itself is unaffected: a string after the name is still read and listed.
 */
function afterActionType(text: string, at: number): boolean {
  let k = at
  while (k > 0 && PDF_WHITESPACE.includes(text[k - 1])) k--
  return k >= 2 && text[k - 2] === '/' && text[k - 1] === 'S'
}

/**
 * A literal string, from its opening `(` (§7.3.4.2).
 *
 * Parentheses nest and a backslash escapes the next character, so the closing
 * one cannot be found by searching for `)`: `(https://evil.test/a\)b)` ends at
 * the second, and a reader that stops at the first prints a URL that is not in
 * the file — and quietly drops the rest of the one that is.
 *
 * A string that is never closed returns nothing at all, not what was read so
 * far: opening one and letting it run to the end of the file made the whole
 * tail of the file into a "URL", and a link the analyst can read is a link the
 * analyst will act on. Cut short at the cap is a different thing and keeps its
 * value, because the caller says it was cut.
 *
 * Reaching the character cap therefore stops the COLLECTING and not the walk.
 * Returning there instead made the two outcomes one: an unterminated string
 * padded out past the cap came back as a URL carrying the benign "cut short"
 * note, which is the fabricated fact this function exists to refuse, reachable
 * by holding down a key. The walk that keeps looking for the close spends the
 * scan's shared STRING_BUDGET, so a file whose `(` never closes costs a slice
 * of one pass over the file and not a scan to EOF per occurrence.
 */
function literalString(text: string, open: number, budget: { left: number }): ReadString | null {
  const limit = Math.min(text.length, open + budget.left)
  let depth = 0
  let out = ''
  let cut = false
  const add = (s: string): void => {
    if (out.length < MAX_URI_CHARS) out += s
    else cut = true
  }
  for (let i = open; i < limit; i++) {
    const c = text[i]
    if (c === '\\') {
      const next = text[i + 1]
      if (next === undefined) break
      const octal = /[0-7]/.test(next) ? (/^[0-7]{1,3}/.exec(text.slice(i + 1, i + 4)) ?? [''])[0] : ''
      if (octal) {
        add(String.fromCharCode(parseInt(octal, 8)))
        i += octal.length
        continue
      }
      i += 1
      // A backslash before a line ending is a continuation: it joins the line
      // and contributes nothing, which is how a long URL is split across two.
      if (next === '\n') continue
      if (next === '\r') {
        if (text[i + 1] === '\n') i += 1
        continue
      }
      add(ESCAPES[next] ?? next)
      continue
    }
    if (c === '(') {
      depth++
      if (depth === 1) continue
    }
    if (c === ')') {
      depth--
      if (depth === 0) {
        budget.left -= i + 1 - open
        return { value: out, cut }
      }
    }
    add(c)
  }
  budget.left -= limit - open
  return null
}

/**
 * A hex string, `<68747470…>` (§7.3.4.3) — where a URL goes when it is written
 * not to be greppable. Whitespace between the digits is legal and ignored.
 *
 * Decoded a pair at a time, up to the character cap, rather than by slicing raw
 * characters and decoding whatever survives: the raw count and the character
 * count are not the same number when the digits are spaced out, so a slice of
 * raw bytes cut a 5,000-character URL down to 2,700 and told the caller nothing
 * had been cut. A trailing odd digit is dropped rather than padded with a zero
 * — half a byte is not a character that is in the file, and the last character
 * of a printed URL has to be one that is. But a reader pads it (§7.3.4.3) and
 * visits one more character, so what is kept is a prefix and ends in a GAP:
 * `…secure.paypal.co` with a trailing `7` is `…secure.paypal.cop` to a reader.
 *
 * The search for the close spends the shared STRING_BUDGET, like the literal
 * reader's, and for the same reason: `indexOf('>')` over the whole text scanned
 * to EOF once per `<`. It is a shared pot rather than a per-string span because
 * the spacing here is unbounded by the spec — this is the reader a legal
 * `<68 74 74 70 …>` with forty spaces between digits arrives at, and a span
 * sized for any fixed spacing drops it and calls it unterminated.
 */
function hexString(text: string, open: number, budget: { left: number }): ReadString | null {
  const limit = Math.min(text.length, open + budget.left)
  let out = ''
  let cut = false
  let half = -1
  for (let i = open + 1; i < limit; i++) {
    const code = text.charCodeAt(i)
    if (code === 0x3e) {
      budget.left -= i + 1 - open
      // A cut one gets its GAP from readUris; an empty one is not listed.
      return { value: half < 0 || cut || !out ? out : out + GAP, cut } // '>'
    }
    // By character code rather than a regex test: this runs once per byte of
    // every hex string in the file, and a `/[0-9A-Fa-f]/.test()` here cost more
    // than the whole rest of the scan on a file that is nothing but `<`s.
    const digit =
      code >= 0x30 && code <= 0x39
        ? code - 0x30
        : code >= 0x41 && code <= 0x46
          ? code - 0x37
          : code >= 0x61 && code <= 0x66
            ? code - 0x57
            : -1
    if (digit < 0) continue
    if (half < 0) {
      half = digit
      continue
    }
    if (out.length < MAX_URI_CHARS) out += String.fromCharCode(half * 16 + digit)
    else cut = true
    half = -1
  }
  budget.left -= limit - open
  return null
}

/**
 * Image streams that are whole files: /DCTDecode is a JPEG, /JPXDecode a JPEG 2000.
 *
 * /FlateDecode is deliberately not here. That is raw pixel data, not a file —
 * inflating it produces a byte run that no sniffer recognises and no sandbox
 * accepts, and the caller would be handed something it cannot describe.
 *
 * `/Subtype /Image` is not required either: a DCTDecode stream is a JPEG
 * whatever the object around it claims to be, and the caller gates on magic
 * bytes anyway, so a stream that is not one falls out there rather than being
 * excluded here on a dictionary key an attacker writes.
 */
/**
 * How a whole image file begins: a JPEG's SOI, the twelve-byte JP2 signature
 * box, or a raw JPEG 2000 codestream's SOC followed by SIZ, which the standard
 * requires to come next.
 */
const IMAGE_STARTS = [
  [0xff, 0xd8],
  [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a],
  [0xff, 0x4f, 0xff, 0x51]
]

/**
 * Does this byte run begin and end as a whole file of the kind the filter
 * names? JPEG is SOI…EOI; JPEG 2000 is either the JP2 signature box or a raw
 * codestream SOC, SIZ…EOC. All three end FF D9: EOI and EOC are the same two
 * bytes, and a JP2 file's codestream box normally comes last.
 *
 * The point is not to validate the image — it is to refuse a run that is only
 * bounded by a keyword. Bytes that ran past their own object into the next
 * one do not end where a picture ends. JPEG 2000 used to be taken on its first
 * two or three bytes with no look at the end at all, so a run that swallowed
 * the next object came back hashed as a picture.
 *
 * ponytail: the end check refuses a real JP2 whose last box is not the
 * codestream (an xml or uuid box after it is legal), and says so through the
 * unverified count. Upgrade path if one turns up: walk the top-level box
 * lengths and require them to add up exactly to the run.
 */
function wholeImage(scan: Uint8Array, start: number, end: number): boolean {
  if (end > scan.length || scan[end - 2] !== 0xff || scan[end - 1] !== 0xd9) return false
  // Any shape is accepted whatever the dictionary called it. The declared
  // filter is written by the sender, and a stream labelled one thing holding
  // another is a fact worth keeping rather than a reason to drop the bytes —
  // the magic-byte gate downstream is what says which it really is.
  // The `+ 2` keeps the start marker and the FF D9 from overlapping.
  return IMAGE_STARTS.some((sig) => end - start >= sig.length + 2 && sig.every((b, i) => scan[start + i] === b))
}

function readImages(scan: Uint8Array, text: string, notes: string[]): PdfImage[] {
  const out: PdfImage[] = []
  const seen = new Set<number>()
  const re = new RegExp(IMAGE_FILTER_SOURCE, 'g')
  // Shared by every streamEnd call in this scan: `endstream` is searched for
  // forwards, so one answer serves every later offset it covers. Without that,
  // a file of filter names and `stream` keywords bought a scan to EOF per
  // occurrence when there was no `endstream`, and a 12MB scan per occurrence
  // when there was one far away.
  const memo = { noneLeft: false, from: 0, at: -1 }
  let total = 0
  let examined = 0
  let overrun = false
  let capped = false
  let oversized = 0
  let missed = 0
  let empty = 0
  let unverified = 0
  let bySearch = 0
  let nested = 0
  // Where the last image taken ends. Stream starts arrive in file order, so one
  // number is enough to know whether a new one begins inside bytes already taken.
  let keptEnd = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // Before streamDataStart, not after: three of the `continue`s below reach
    // the next iteration without growing `out`, so the cap on out.length never
    // fired on input built to take them, and the two unbounded searches below
    // ran once per filter name in the file.
    if (++examined > MAX_SCAN_MATCHES) {
      overrun = true
      break
    }
    if (out.length >= MAX_IMAGES) {
      capped = true
      break
    }
    const start = streamDataStart(text, m.index + m[0].length)
    if (start < 0) {
      missed++
      continue
    }
    // A dictionary can name the same filter twice, and `/Filter [/FlateDecode
    // /DCTDecode]` reaches this loop from its own entry — one stream, one image.
    if (seen.has(start)) continue
    seen.add(start)
    // A stream whose data begins inside an image already taken. After the
    // repeat check, because a repeat of the taken image's own start is not one.
    // Every image handed back is a view over the file, so a file of 24
    // dictionaries each written inside the previous one's data, all closing at
    // one `endstream`, turned 492KB into 24 overlapping pictures and 11.8MB —
    // and a mail of 36 copies into 424MB for the caller to hash and draw.
    // Skipping these keeps each byte of the file in at most one picture, so
    // what this returns is never more than the file.
    if (start < keptEnd) {
      nested++
      continue
    }
    // Where the stream ends is decided by the declared length when there is
    // one, and only CONFIRMED by `endstream`. Where the length is an indirect
    // reference — common in real files, so refusing those would lose most real
    // images — `endstream` is searched for as before, and then the bytes must
    // prove themselves: a complete JPEG or JP2 begins and ends with its own
    // markers, so a run that swallowed the next object is not one.
    //
    // That content check is what closes the two fabrication paths. `stream`
    // matched as a bare substring yields bytes that are not an image; a stream
    // missing its own `endstream` closes at the next object's and yields bytes
    // that run past it. Neither survives "does this actually begin and end as
    // the file it claims to be".
    const declared = directLength(dictBefore(text, m.index, start))
    let end: number
    // Set when the end came from a keyword search rather than a declared
    // length, so the content check below knows the run still has to prove
    // itself. Checked AFTER the size caps: a 12MB run that is not an image
    // should report the cap it tripped, which is the true reason it was not
    // taken, rather than the check it would also have failed.
    let unconfirmed = false
    if (declared !== null && start + declared <= text.length && closesAt(text, start + declared)) {
      end = start + declared
    } else {
      end = streamEnd(text, start, memo)
      if (end < 0) {
        missed++
        continue
      }
      unconfirmed = true
    }
    // A stream whose `endstream` follows its `stream` immediately. There is
    // nothing to extract and nothing to hash, but an entry that leaves no trace
    // at all in the result is a silent drop — its two siblings above are
    // counted and this one was not.
    if (end <= start) {
      empty++
      continue
    }
    // Not clipped to the remaining budget: half a JPEG is a corrupt file
    // carrying a real file's hash, and it would be handed on as if it were the
    // picture in the document. Stop, and say that is what happened — separately
    // from the count cap, because one 13MB image produced "Stopped after 0
    // image(s) (caps: 24 images, …)", a sentence that names a cap it did not
    // reach next to a count that makes no sense of it.
    if (end - start > MAX_IMAGE_TOTAL - total) {
      oversized = end - start
      break
    }
    if (unconfirmed && end > start && !wholeImage(scan, start, end)) {
      unverified++
      continue
    }
    total += end - start
    if (unconfirmed) bySearch++
    keptEnd = end
    out.push({ offset: start, bytes: scan.subarray(start, end), filter: `/${m[1]}` })
  }
  if (overrun) {
    notes.push(
      `Stopped after examining ${MAX_SCAN_MATCHES} /DCTDecode or /JPXDecode entries; this scan stopped looking ` +
        'there, so any image stream past that point is unread rather than absent.'
    )
  }
  // What stops the loop is the 25th /DCTDecode or /JPXDecode NAME, which is not
  // the same thing as a 25th stream: it can be a repeat of a filter already
  // extracted (`/Filter [/DCTDecode /DCTDecode]`), a name in a comment, or a
  // name with no stream after it at all. Saying "further image streams were not
  // extracted" asserts they exist, and on any of those three every stream in
  // the file WAS extracted. So the note says where the scan stopped, which is
  // the part that is always true.
  if (capped) {
    notes.push(
      `Stopped after ${MAX_IMAGES} image(s), which is this scan's cap; this scan stopped looking there, so any ` +
        'image stream past that point is unread rather than absent.'
    )
  }
  if (oversized) {
    notes.push(
      `Stopped at an image stream of ${oversized} bytes: taking it would put this scan past the ${MAX_IMAGE_TOTAL} ` +
        'bytes of image data it will hold. That stream and any after it were not extracted.'
    )
  }
  if (missed) {
    notes.push(
      `${missed} /DCTDecode or /JPXDecode entr(ies) were not extracted: this scan looks for the 'stream' keyword ` +
        `within ${STREAM_LOOKAHEAD} bytes of the filter name and an 'endstream' after it, and did not find both. ` +
        `That is where this scan stopped looking, not proof there is no image there.`
    )
  }
  if (unverified) {
    notes.push(
      `${unverified} /DCTDecode or /JPXDecode entr(ies) had no usable declared length, and the bytes before the ` +
        `next 'endstream' could not be confirmed to begin and end as a complete image. They were not extracted — ` +
        `that is a stream this scan could not take safely, not a stream that is absent.`
    )
  }
  if (empty) {
    notes.push(
      `${empty} /DCTDecode or /JPXDecode entr(ies) held nothing but line-ending bytes between 'stream' and ` +
        `'endstream', so there was no image in them to extract.`
    )
  }
  // Not "they are bytes of that image, not separate streams": a reader goes
  // where the xref table points, and one pointing into another stream's data
  // opens an object there. What is known is where they begin and that they
  // were not taken, so that is what is said.
  if (nested) {
    notes.push(
      `${nested} /DCTDecode or /JPXDecode entr(ies) begin inside the data of an image already extracted. This scan ` +
        'hands back each byte of the file in at most one picture, so they were not extracted as pictures of their ' +
        'own — unread as pictures here, not absent.'
    )
  }
  // Only the images whose end was SEARCHED for. One cut at its declared
  // /Length is exact, and saying otherwise about it is a wrong fact.
  //
  // Worded for what the scan knows, not for what the file declared. This used
  // to say each image "declared no direct /Length", and two ordinary files make
  // that false: `/Length 40 /DecodeParms << … >> /Filter /DCTDecode` hides its
  // /Length behind the inner `>>` (see dictBefore), and a direct /Length that is
  // simply wrong does not land on `endstream`. Both reach this count.
  if (bySearch) {
    notes.push(
      `${bySearch} extracted image(s) had no direct /Length this scan could read (none, an indirect reference, ` +
        "or one written where this scan does not look for it), or had one that did not end at an 'endstream' " +
        "keyword, so each was cut at the next 'endstream' keyword and kept only because it begins and ends as a " +
        'complete image. One whose data held those nine bytes would still be cut there, so its hash could be of a ' +
        'prefix of the image in the document.'
    )
  }
  // Said here rather than left to whoever shows the result: an empty list from
  // a scan that only looks at two filters is not a file with no pictures, and
  // PDF writers usually store a picture that came from a PNG as /FlateDecode,
  // which this skips.
  if (!out.length) {
    notes.push(
      'Only /DCTDecode (JPEG) and /JPXDecode (JPEG 2000) streams are extracted as pictures, and none was extracted ' +
        'here. An image stored any other way, /FlateDecode included, is not read, so none drawn is not none present.'
    )
  }
  return out
}

/** A `/Length` written as a direct integer in this window, or null. */
function directLength(window: string): number | null {
  const m = DIRECT_LENGTH.exec(window)
  return m ? Number(m[1]) : null
}

/**
 * The dictionary text around a filter name, for reading its `/Length` out of.
 *
 * Opening this window at the filter name — which is what it used to do — reads
 * only the keys written after it, and key order in a dictionary is not
 * significant. Quartz writes `/Length 6625 /Filter /DCTDecode`, and against that
 * ordering no /Length was found at all: the reader worked on the half of the
 * world that happens to write the keys the other way round.
 *
 * So the window opens BEFORE the name and is cut at the nearest `obj`, `stream`
 * or `>>` in front of it. Past one of those the /Length belongs to some other
 * object or some other dictionary, and cutting these bytes at that number could
 * hand back a run that is not this stream. The cut can also land in front of a
 * /Length that IS this stream's (`/Length 40 /DecodeParms << … >> /Filter …`).
 * Then the end is searched for instead, the run has to prove itself as a whole
 * image, and the note readImages prints for it says the scan could not read a
 * /Length — never that the file declared none. That is the right way round to
 * be wrong here: a /Length missed costs a search, a /Length misread cuts another
 * object's bytes as this one's.
 */
function dictBefore(text: string, filterAt: number, dataAt: number): string {
  const from = Math.max(0, filterAt - STREAM_LOOKAHEAD)
  const before = text.slice(from, filterAt)
  // `endobj` and `endstream` are caught by their tails, which is why these three
  // are enough: any of them means a different object's dictionary ended here.
  const cut = Math.max(before.lastIndexOf('obj'), before.lastIndexOf('stream'), before.lastIndexOf('>>'))
  return text.slice(cut < 0 ? from : from + cut, dataAt)
}

/**
 * Where a stream's data begins: after the `stream` keyword and its line ending (§7.3.8.1).
 *
 * The lookahead bounds the HAYSTACK, not the answer. Filtering the result of a
 * whole-text `indexOf` with `i < limit` reads as a bound and is not one: the
 * scan to end-of-file has already happened by the time the comparison runs, so
 * a file of filter names with no `stream` in it paid 16MB per name. The window
 * is a few thousand characters, so copying it is free.
 */
function streamDataStart(text: string, from: number): number {
  const limit = Math.min(text.length, from + STREAM_LOOKAHEAD)
  const hay = text.slice(from, limit)
  for (let at = hay.indexOf('stream'); at >= 0; at = hay.indexOf('stream', at + 1)) {
    const i = from + at
    // Against the whole text, not the window: the three bytes that make this
    // `endstream` rather than `stream` can sit just before the window starts.
    if (i >= 3 && text.startsWith('end', i - 3)) continue
    let j = i + 'stream'.length
    // The spec says CRLF or LF. A bare CR is out of spec and readers take it
    // anyway, so it is taken here too: refusing it would drop the image out of
    // precisely the malformed file that is worth a second look.
    if (text[j] === '\r') j++
    if (text[j] === '\n') j++
    return j
  }
  return -1
}

// ---- the object read (readPdfObjects) ----------------------------------------

/** Caps on what is LISTED. Each one says so in a note when it is reached. */
const MAX_LINKS = 200
const MAX_ACTIONS = 200
/** Trigger texts listed per action; the rest are counted. Twenty /AA events exist, and an action rarely has more than a few. */
const MAX_TRIGGERS = 8
/** Per kind, collected before ranking: the ranking runs over a bounded list. */
const MAX_CANDIDATES = 10_000
/** Scripts decoded and quoted; those past it are counted, never read. */
const MAX_SCRIPTS = 10
const SCRIPT_CAP = 2 ** 20
/**
 * Script characters kept per file, strings and streams alike: the object
 * layer's 'script' share, which a /JS string never passes through.
 */
const SCRIPT_SHARE = 4 * 2 ** 20
const MAX_EMBEDDED = 100
const MAX_EMBEDDED_READ = 24
const EMBED_CAP = 8 * 2 ** 20
/** Decoded bytes kept for sniffing an embedded file's type. */
const HEAD = 512
const MAX_FIELDS = 100
/** Kid-array elements examined, so a shared /Kids array cannot be walked once per parent. */
const MAX_FIELD_NODES = 1_000
const MAX_FIELD_DEPTH = 16
const MAX_FIELD_VALUE = 1_000
const MAX_NAME_TREE_NODES = 1_024
const MAX_WALK_DEPTH = 32
const MAX_NEXT_CHAIN = 16
/** Characters shown of a URI, an action target or an info value. */
const MAX_SHOWN = 4_096
/** Characters shown of a file or field name. */
const MAX_SHOWN_NAME = 256
/** doc.resolve's hop limit, for the one walk that has to know which object a value came from. */
const REF_HOPS = 8

/**
 * The action types listed by name. The type printed is always one of these
 * fixed strings, never the file's own spelling of /S: a name may decode to a
 * newline and a Markdown fence, and the report prints the type.
 */
const ACTION_TYPES = new Set([
  'JavaScript',
  'Launch',
  'GoToR',
  'GoToE',
  'SubmitForm',
  'ImportData',
  'RichMediaExecute',
  'URI'
])
/** What each /AA key means, in words. A key not listed reads "on this event". */
const AA_EVENTS = new Map([
  ['O', 'when opened'],
  ['C', 'when closed, or when recalculated'],
  ['E', 'when the pointer enters'],
  ['X', 'when the pointer leaves'],
  ['D', 'when the mouse button is pressed'],
  ['U', 'when the mouse button is released'],
  ['Fo', 'when focused'],
  ['Bl', 'when focus leaves'],
  ['PO', 'when its page opens'],
  ['PC', 'when its page closes'],
  ['PV', 'when its page becomes visible'],
  ['PI', 'when its page stops being visible'],
  ['K', 'on a keystroke in the field'],
  ['F', 'before the field is formatted'],
  ['V', 'when the field value changes'],
  ['WC', 'before the document closes'],
  ['WS', 'before the document is saved'],
  ['DS', 'after the document is saved'],
  ['WP', 'before the document is printed'],
  ['DP', 'after the document is printed']
])
const FILE_NAME_KEYS = ['UF', 'F', 'Unix', 'Mac', 'DOS']
const FIELD_TYPES = new Set(['Tx', 'Btn', 'Ch', 'Sig'])
const INFO_KEYS = ['Title', 'Author', 'Producer', 'Creator', 'CreationDate', 'ModDate']

const DEEP_CAVEAT =
  'The names counted above come from a byte scan, which counts a name wherever its bytes appear — inside a ' +
  "string or a comment too. The object read parsed this file's objects, found by searching for their 'obj' " +
  'keywords rather than through the cross-reference table, and decompressed only the streams it needed. ' +
  'Nothing was rendered, fetched or run.'
const OBJECT_READ_PARTIAL = 'The object read stopped on a structure it could not read, so what it lists is partial.'

/** Where a value was read: the object's label, its position for ranking, and whether its strings are cleartext. */
interface Origin {
  where: string
  pos: number
  plain: boolean
}

/** What the walk collects, before anything is ranked, capped or decoded. */
interface Found {
  /** `dict` carries the /URI key; its holder is looked up after the walk, when every /A has been seen. */
  links: { uri: string; dict: PdfDict; at: Origin }[]
  actions: Map<PdfDict, Origin>
  /** /S /URI dicts: listed as actions only when something other than /A runs them. */
  uriActions: Map<PdfDict, Origin>
  /** Action dict -> each distinct text that runs it, with its rank. */
  triggers: Map<PdfDict, Map<string, number>>
  /** Action dict -> the dict whose /A holds it, so a link lands on its annotation's page. */
  holders: Map<PdfDict, PdfDict>
  embedded: { names: string[]; size: number | null; stream: PdfStream | null; at: Origin }[]
  xfa: boolean
  /** /AA dicts and name-tree nodes already walked: a target shared by many dicts is walked once, not once per sharer. */
  seen: Set<PdfDict>
}

/** Counts that become §5.2 notes. */
interface Tally {
  walkCapped: number
  shownCut: boolean
  scriptsNotRead: number
  scriptsUnread: number
  scriptsEncrypted: number
  /** Script sources kept in part or not at all because SCRIPT_SHARE was used up. */
  scriptsOverShare: number
  fieldsEncrypted: number
  /** Array /V values with elements past where fieldValue stopped examining. */
  fieldsPartlyRead: number
  /** Fields read from page widgets that /AcroForm does not reach. */
  fieldsOnPages: number
  /** The /AcroForm walk did not read the whole form, so whether it lists those fields is unknown. */
  formUnread: boolean
  embeddedNotRead: number
  linksCapped: boolean
  actionsCapped: boolean
  embeddedCapped: boolean
  fieldsCapped: boolean
}

function dictOf(v: PdfValue | undefined): PdfDict | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  return v.t === 'dict' ? v : v.t === 'stream' ? v.dict : undefined
}
function streamOf(v: PdfValue | undefined): PdfStream | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && v.t === 'stream' ? v : undefined
}
function stringOf(v: PdfValue | undefined): PdfString | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && v.t === 'str' ? v : undefined
}

/**
 * One unit of the file's work budget, for every element the walks examine —
 * and a look at the clock every 1,024 of them. A walk is one synchronous
 * stage and the stage boundary was the only place the deadline was read, so a
 * walk slow per unit ran on past it however long it took. Every 65,536 was
 * still too few: a walk whose units grew slower as it went ran 13 seconds past
 * the 5-second deadline between two looks.
 */
function spend(work: Work): void {
  if (--work.left < 0) throw new WorkSpent('work')
  if ((work.left & 0x3ff) === 0) checkTime(work)
}

/**
 * A cut between these two characters splits a word: neither is whitespace, as
 * pdfText.ts and phish.ts tell words apart (NaN, past either end, is).
 */
const inWord = (before: number, after: number): boolean => before > 0x20 && after > 0x20

function shown(tally: Tally, s: string, max: number): string {
  if (s.length <= max) return s
  tally.shownCut = true
  return s.slice(0, max)
}

/**
 * The object read, on top of a readPdf scan of the same bytes: actions and what
 * runs them, links, scripts, embedded files, form fields, declared information
 * and page text, each listed with the object it was read from.
 *
 * Mutates facts: sets facts.parsed and rewrites facts.notes so the scan's notes
 * no longer say "not visible" about what this read saw. Charges every decoded
 * byte to media.left and its work to `message`, the budget the message's PDFs
 * share. Never throws: each stage runs on its own, a stage that stops leaves
 * the others' findings standing, and the notes say which stopped and why.
 */
export async function readPdfObjects(
  bytes: Uint8Array,
  facts: PdfFacts,
  media: { left: number },
  message: Work
): Promise<void> {
  const start = Math.max(0, Math.min(WORK_BUDGET, message.left))
  // A file that runs out of a budget the message had already drawn down is not
  // a file that hit its own limit, and the note should not blame it for one.
  const shared = message.left < WORK_BUDGET
  const work: Work = { left: start, until: Math.min(performance.now() + FILE_PDF_MS, message.until ?? Infinity) }
  try {
    const scan = bytes.length > SCAN_CAP ? bytes.subarray(0, SCAN_CAP) : bytes
    const doc = await openPdf(scan, latin1(scan), media, work)
    await readObjects(doc, facts, shared)
  } catch {
    // Only the text conversion in front of openPdf can land here (openPdf and
    // readObjects never throw). The object read did not run, so facts.parsed
    // stays absent and the scan's own notes stand as they are.
  } finally {
    message.left -= start - Math.max(0, work.left)
  }
}

async function readObjects(doc: PdfDoc, facts: PdfFacts, shared: boolean): Promise<void> {
  let partial = false
  // One try per stage, as readPdf does: a structure that defeats the field walk
  // is no reason to drop the actions already found. WorkSpent and ValueSpent are
  // budgets doing their job, so they set the doc's flags and the notes name the
  // budget; anything else is a structure this reader could not read.
  const stage = async (run: () => void | Promise<void>): Promise<void> => {
    try {
      checkTime(doc.work)
      await run()
    } catch (error) {
      if (error instanceof WorkSpent) doc.workSpent ??= error.why
      else if (error instanceof ValueSpent) doc.valueSpent = true
      else partial = true
    }
  }
  const found: Found = {
    links: [],
    actions: new Map(),
    uriActions: new Map(),
    triggers: new Map(),
    holders: new Map(),
    embedded: [],
    xfa: false,
    seen: new Set()
  }
  const tally: Tally = {
    walkCapped: 0,
    shownCut: false,
    scriptsNotRead: 0,
    scriptsUnread: 0,
    scriptsEncrypted: 0,
    scriptsOverShare: 0,
    fieldsEncrypted: 0,
    fieldsPartlyRead: 0,
    fieldsOnPages: 0,
    formUnread: false,
    embeddedNotRead: 0,
    linksCapped: false,
    actionsCapped: false,
    embeddedCapped: false,
    fieldsCapped: false
  }
  let ranked: RankedAction[] = []
  const actions: PdfAction[] = []
  const scripts: PdfScript[] = []
  let embeddedFiles: PdfEmbeddedFile[] = []
  let text: PdfTextResult = { pages: [], pageCount: null, notes: [], annotPages: new Map() }
  const links: PdfLink[] = []
  const fields: PdfField[] = []
  const info: PdfInfo[] = []
  let hiddenMarkers: { name: string; count: number }[] = []
  let escapedMarkers: { name: string; count: number }[] = []

  await stage(() => walkObjects(doc, found, tally))
  await stage(() => {
    ranked = rankActions(doc, found)
    for (const a of ranked) {
      if (actions.length >= MAX_ACTIONS) {
        tally.actionsCapped = true
        break
      }
      actions.push({ type: a.type, trigger: a.trigger, target: actionTarget(doc, tally, a), where: a.at.where })
    }
  })
  await stage(async () => {
    const withJs = ranked.filter((a) => a.dict.v.has('JS'))
    // Counted before any is decoded, so a read that stops part way still says how many it never reached.
    tally.scriptsNotRead = Math.max(0, withJs.length - MAX_SCRIPTS)
    // A /JS string is never decoded, so the object layer's share for scripts
    // never saw one: twelve files of ten 1 MiB literals ran a message two
    // seconds past its deadline in the indicator scan. Strings and streams draw
    // on one share here, each distinct text charged once, as the scan reads it once.
    let share = SCRIPT_SHARE
    const charged = new Map<string, string>()
    // `lost`: the read stopped short of the text's end, so a GAP goes after it.
    const keep = (where: string, text: string, whole: boolean, lost: boolean): void => {
      let source = charged.get(text)
      if (source === undefined) {
        source = text.slice(0, share)
        share -= source.length
        charged.set(text, source)
      }
      const short = source.length < text.length
      if (short) tally.scriptsOverShare++
      const gap = short ? inWord(source.charCodeAt(source.length - 1), text.charCodeAt(source.length)) : lost
      if (source || !text) scripts.push({ where, source: gap ? source + GAP : source, whole: whole && !short })
    }
    for (const a of withJs.slice(0, MAX_SCRIPTS)) {
      const js = doc.resolve(a.dict.v.get('JS'))
      const str = stringOf(js)
      const stream = streamOf(js)
      if (str) {
        if (a.at.plain) keep(a.at.where, textString(str.v), !str.cut, str.cut)
        else tally.scriptsEncrypted++
      } else if (stream) {
        const d = await doc.decode(stream, SCRIPT_CAP, 'script')
        // A checksum the file wrote does not make a decode that lost its end whole.
        if (d) keep(a.at.where, textString(d.text), d.whole && !d.endLost, d.endLost)
        else tally.scriptsUnread++
      } else tally.scriptsUnread++
    }
  })
  await stage(async () => {
    // Listed first and decoded after, so a decode that stops on a budget still
    // leaves every file it found on the list, unhashed rather than missing.
    // ponytail: typed and hashed, never opened — an embedded PDF or archive is
    // listed, not read inside. Opening one needs budgets of its own; add it when
    // a real lure hides its payload a level down.
    const listed = found.embedded.slice(0, MAX_EMBEDDED)
    tally.embeddedCapped = found.embedded.length > MAX_EMBEDDED
    embeddedFiles = listed.map((c) => ({
      name: c.names[0] ?? '',
      names: c.names,
      size: c.size,
      where: c.at.where,
      head: new Uint8Array(0),
      bytes: null
    }))
    const toRead = listed.filter((c) => c.stream).length
    tally.embeddedNotRead = Math.max(0, toRead - MAX_EMBEDDED_READ)
    let read = 0
    for (let k = 0; k < listed.length && read < MAX_EMBEDDED_READ; k++) {
      const stream = listed[k].stream
      if (!stream) continue
      read++
      const d = await doc.decode(stream, EMBED_CAP, 'embedded')
      if (!d) continue
      embeddedFiles[k].head = latin1Bytes(d.text.slice(0, HEAD))
      // A hash of a prefix is a real-looking hash of a file that is not in this
      // one, and a checksum the file wrote does not prove a decode that lost its end is not one.
      embeddedFiles[k].bytes = d.whole && !d.endLost ? latin1Bytes(d.text) : null
    }
  })
  // When encrypted this runs too: its streams come back unread unless they verify, and the pages say so.
  await stage(async () => {
    text = await readPageText(doc)
  })
  await stage(() => readLinks(found, tally, text, facts.uris, links))
  await stage(() => readFields(doc, tally, text.annotPages, fields))
  await stage(() => readInfo(doc, tally, info))
  await stage(() => {
    const hidden = new Map<string, number>()
    for (const t of doc.objStmTexts) for (const m of census(t)) hidden.set(m.name, (hidden.get(m.name) ?? 0) + m.count)
    hiddenMarkers = [...hidden].map(([name, count]) => ({ name, count }))
    hiddenMarkers.sort((a, b) => MARKER_NAMES.indexOf(a.name.slice(1)) - MARKER_NAMES.indexOf(b.name.slice(1)))
    escapedMarkers = MARKER_NAMES.filter((n) => doc.escapedNames.has(n)).map((n) => ({
      name: `/${n}`,
      count: doc.escapedNames.get(n) ?? 0
    }))
  })

  facts.parsed = {
    objects: doc.objects.size,
    encrypted: doc.encrypted,
    stringsEncrypted: doc.stringsEncrypted,
    objectStreams: { ...doc.objectStreams },
    pageCount: text.pageCount,
    pages: text.pages,
    links,
    actions,
    scripts,
    embeddedFiles,
    fields,
    info,
    xfa: found.xfa,
    hiddenMarkers,
    escapedMarkers
  }
  rewriteNotes(facts, doc, [
    ...objectNotes(doc, shared),
    ...decodeNotes(doc),
    ...findingNotes(tally),
    ...text.notes,
    ...(partial ? [OBJECT_READ_PARTIAL] : [])
  ])
}

/**
 * §3.C.1: one pass over every definition — winners by position, then the
 * earlier and hidden ones — collecting candidates. It follows no reference
 * except the one-hop lookups of the keys it reads, so its cost is the values
 * the object layer already holds, one unit of work per element.
 */
function walkObjects(doc: PdfDoc, found: Found, tally: Tally): void {
  const winners = [...doc.objects]
    .sort(([na, a], [nb, b]) => a.pos - b.pos || na - nb)
    .map(([num, obj]) => ({ num, obj }))
  for (const { num, obj } of [...winners, ...doc.superseded]) {
    walkValue(doc, found, tally, obj.value, { where: doc.where(num, obj), pos: obj.pos, plain: doc.plain(obj) }, 0)
  }
}

function walkValue(doc: PdfDoc, found: Found, tally: Tally, v: PdfValue, at: Origin, depth: number): void {
  const dict = dictOf(v)
  const children = asArray(v) ?? dict?.v.values()
  if (!children) return
  if (depth >= MAX_WALK_DEPTH) {
    tally.walkCapped++
    return
  }
  if (dict) visitDict(doc, found, tally, dict, at)
  for (const child of children) {
    spend(doc.work)
    walkValue(doc, found, tally, child, at, depth + 1)
  }
}

function visitDict(doc: PdfDoc, found: Found, tally: Tally, d: PdfDict, at: Origin): void {
  const get = (key: string): PdfValue | undefined => doc.resolve(d.v.get(key))
  // A dict value is the catalog's /URI << /Base … >>, not a link.
  const uri = d.v.has('URI') ? asString(get('URI')) : undefined
  // Strings in an encrypted object are ciphertext: never a link, a target or a name.
  if (uri !== undefined && at.plain) {
    if (found.links.length < MAX_CANDIDATES) found.links.push({ uri, dict: d, at })
    else tally.walkCapped++
  }
  const s = asName(get('S'))
  if ((s !== undefined && s !== 'URI' && ACTION_TYPES.has(s)) || d.v.has('JS')) register(found.actions, tally, d, at)
  else if (s === 'URI') register(found.uriActions, tally, d, at)

  const open = dictOf(get('OpenAction'))
  if (open) trigger(found, open, 0, 'when the document opens (/OpenAction)')
  const names = asDict(get('Names'))
  if (names?.has('JavaScript')) nameTree(doc, found, tally, names.get('JavaScript'))
  const aa = dictOf(get('AA'))
  if (aa && !found.seen.has(aa)) {
    found.seen.add(aa)
    for (const [key, value] of aa.v) {
      spend(doc.work)
      const target = dictOf(doc.resolve(value))
      // The key is printed only when it is short and plain letters: it is the file's own name.
      const event = /^[A-Za-z]{1,4}$/.test(key)
        ? `${AA_EVENTS.get(key) ?? 'on this event'} (/AA /${key})`
        : 'on an /AA entry'
      if (target) trigger(found, target, 2, event)
    }
  }
  const a = dictOf(get('A'))
  if (a?.v.has('S')) {
    trigger(found, a, 3, 'when clicked or activated (/A)')
    if (!found.holders.has(a)) found.holders.set(a, d)
  }
  if (d.v.has('Next')) {
    const next = get('Next')
    const chain = asArray(next) ?? [next]
    for (let k = 0; k < chain.length; k++) {
      if (k >= MAX_NEXT_CHAIN) {
        tally.walkCapped++
        break
      }
      spend(doc.work)
      const target = dictOf(doc.resolve(chain[k]))
      if (target) trigger(found, target, 4, 'after an earlier action runs (/Next)')
    }
  }
  if (d.v.has('EF')) embeddedCandidate(doc, found, tally, d, at)
  // ponytail: the XFA XML is not read, so the report says any script or link in
  // it is unread rather than absent. Read it when a real lure hides there.
  if (d.v.has('XFA')) found.xfa = true
}

function register(map: Map<PdfDict, Origin>, tally: Tally, d: PdfDict, at: Origin): void {
  if (map.has(d)) return
  if (map.size >= MAX_CANDIDATES) tally.walkCapped++
  else map.set(d, at)
}

/**
 * Keyed by text, so a repeat costs one lookup. Searching the texts already kept
 * made one /AA dictionary of 100,000 distinct keys naming one action quadratic:
 * 25 seconds on the UI thread for a 1.1MB file, at one unit of work per key.
 */
function trigger(found: Found, d: PdfDict, rank: number, text: string): void {
  const texts = found.triggers.get(d)
  if (!texts) found.triggers.set(d, new Map([[text, rank]]))
  else if (!texts.has(text)) texts.set(text, rank)
}

/** The /Names /JavaScript tree: every script in it runs when the document opens. */
function nameTree(doc: PdfDoc, found: Found, tally: Tally, root: PdfValue | undefined): void {
  const stack: (PdfValue | undefined)[] = [root]
  let examined = 0
  while (stack.length) {
    const node = dictOf(doc.resolve(stack.pop()))
    if (!node || found.seen.has(node)) continue
    found.seen.add(node)
    const pairs = asArray(doc.resolve(node.v.get('Names'))) ?? []
    for (let k = 1; k < pairs.length; k += 2) {
      if (++examined > MAX_NAME_TREE_NODES) {
        tally.walkCapped++
        return
      }
      spend(doc.work)
      const target = dictOf(doc.resolve(pairs[k]))
      if (target) trigger(found, target, 1, 'when the document opens (document-level script in /Names /JavaScript)')
    }
    for (const kid of asArray(doc.resolve(node.v.get('Kids'))) ?? []) {
      if (++examined > MAX_NAME_TREE_NODES) {
        tally.walkCapped++
        return
      }
      spend(doc.work)
      stack.push(kid)
    }
  }
}

function embeddedCandidate(doc: PdfDoc, found: Found, tally: Tally, d: PdfDict, at: Origin): void {
  if (found.embedded.length >= MAX_CANDIDATES) {
    tally.walkCapped++
    return
  }
  const ef = asDict(doc.resolve(d.v.get('EF')))
  const stream = streamOf(doc.resolve(ef?.get('UF') ?? ef?.get('F'))) ?? null
  const params = asDict(doc.resolve(stream?.dict.v.get('Params')))
  // Every name, not the first: a file can call itself invoice.pdf to one
  // reader and invoice.exe to the one that saves it.
  const names: string[] = []
  for (const key of at.plain ? FILE_NAME_KEYS : []) {
    const name = asString(doc.resolve(d.v.get(key)))
    if (!name) continue
    const kept = shown(tally, textString(name), MAX_SHOWN_NAME)
    if (kept && !names.includes(kept)) names.push(kept)
  }
  found.embedded.push({ names, size: asInt(doc.resolve(params?.get('Size'))) ?? null, stream, at })
}

interface RankedAction {
  dict: PdfDict
  at: Origin
  /** /S as found; the printed type is `type`. */
  s: string | undefined
  type: string
  trigger: string
}

/**
 * §3.C.2: by what runs them (the document opening first), then by position. Untriggered ones last.
 *
 * Each action lists its first MAX_TRIGGERS triggers by rank and counts the rest:
 * joined whole, 20,000 /AA keys on one action made one 540KB trigger line.
 */
function rankActions(doc: PdfDoc, found: Found): RankedAction[] {
  const uriActions = [...found.uriActions].filter(([d]) =>
    [...(found.triggers.get(d)?.values() ?? [])].some((r) => r !== 3)
  )
  return [...found.actions, ...uriActions]
    .map(([dict, at]) => {
      const triggers = [...(found.triggers.get(dict) ?? [])].sort(([, x], [, y]) => x - y)
      const texts = triggers.slice(0, MAX_TRIGGERS).map(([text]) => text)
      if (triggers.length > MAX_TRIGGERS) texts.push(`and ${triggers.length - MAX_TRIGGERS} more trigger(s)`)
      const s = asName(doc.resolve(dict.v.get('S')))
      return {
        rank: triggers[0]?.[1] ?? 5,
        action: {
          dict,
          at,
          s,
          type: s !== undefined && ACTION_TYPES.has(s) ? `/${s}` : '/JavaScript',
          trigger: texts.length ? texts.join('; ') : 'no trigger found by this reader'
        }
      }
    })
    .sort((x, y) => x.rank - y.rank || x.action.at.pos - y.action.at.pos)
    .map((r) => r.action)
}

function actionTarget(doc: PdfDoc, tally: Tally, a: RankedAction): string {
  if (!a.at.plain) return ''
  const get = (key: string): PdfValue | undefined => doc.resolve(a.dict.v.get(key))
  let target = ''
  if (a.s === 'URI') target = asString(get('URI')) ?? ''
  else if (a.s === 'Launch') {
    const win = asDict(get('Win'))
    const file = asString(doc.resolve(win?.get('F')))
    const params = asString(doc.resolve(win?.get('P')))
    target =
      file !== undefined
        ? textString(file) + (params !== undefined ? ` ${textString(params)}` : '')
        : fileName(doc, get('F'))
  } else if (a.s === 'GoToR' || a.s === 'GoToE' || a.s === 'ImportData' || a.s === 'SubmitForm') {
    target = fileName(doc, get('F'))
  }
  // A GAP after a cut one, as after a cut link: what is left is a prefix.
  const kept = shown(tally, target, MAX_SHOWN)
  return kept.length < target.length ? kept + GAP : kept
}

/** A file specification as its name: a string, or the first name a filespec dict gives. */
function fileName(doc: PdfDoc, v: PdfValue | undefined): string {
  const direct = asString(v)
  if (direct !== undefined) return textString(direct)
  const spec = asDict(v)
  for (const key of FILE_NAME_KEYS) {
    const name = asString(doc.resolve(spec?.get(key)))
    if (name !== undefined) return textString(name)
  }
  return ''
}

/**
 * §3.C.6. Sorted before the repeats are dropped, so a URI that is both on page 1
 * and in an object no page draws keeps its page: dropping first kept whichever
 * the walk met first, and an orphan copy could then sort past the cap.
 *
 * ponytail: a link is placed on its page, not paired with the words drawn
 * under it, so "click here" over a different URL is not called out. Pairing
 * needs the annotation's /Rect against the text's positions.
 */
function readLinks(found: Found, tally: Tally, text: PdfTextResult, uris: string[], out: PdfLink[]): void {
  const placed = found.links.map((l) => ({ l, page: text.annotPages.get(found.holders.get(l.dict) ?? l.dict) ?? null }))
  // Infinity - Infinity is NaN, which is falsy, so two unplaced links fall through to position.
  placed.sort((x, y) => (x.page ?? Infinity) - (y.page ?? Infinity) || x.l.at.pos - y.l.at.pos)
  // Compared as listed, GAP and all (MAX_SHOWN is the scan's MAX_URI_CHARS): a
  // whole link is not a repeat of a cut one that begins with it.
  const seen = new Set(uris)
  for (const { l, page } of placed) {
    const cut = l.uri.length > MAX_SHOWN
    const uri = cut ? l.uri.slice(0, MAX_SHOWN) + GAP : l.uri
    if (!l.uri || seen.has(uri)) continue
    seen.add(uri)
    if (out.length >= MAX_LINKS) {
      tally.linksCapped = true
      return
    }
    if (cut) tally.shownCut = true
    out.push({ uri, where: l.at.where, page, cut })
  }
}

/** A value with the object it was read from — what decides whether its strings are cleartext. */
interface Owned {
  v: PdfValue | undefined
  owner: PdfObject | undefined
}

/** doc.resolve, keeping track of the object each hop lands in. */
function follow(doc: PdfDoc, v: PdfValue | undefined, owner: PdfObject | undefined): Owned {
  let out: Owned = { v, owner }
  for (
    let hops = 0;
    typeof out.v === 'object' && out.v !== null && !Array.isArray(out.v) && out.v.t === 'ref';
    hops++
  ) {
    if (hops >= REF_HOPS) return { v: undefined, owner }
    const next = doc.objects.get(out.v.num)
    out = { v: next?.value, owner: next }
  }
  return out
}

function cleartext(doc: PdfDoc, owned: Owned): boolean {
  // No object of its own (a value written into the trailer): only a file whose strings are not encrypted is safe to read.
  return owned.owner ? doc.plain(owned.owner) : !doc.stringsEncrypted
}

interface FieldState {
  name: string
  ft: string | undefined
  v: Owned | undefined
  ff: number | undefined
}

/**
 * §3.C.7: /AcroForm /Fields, down /Kids, with /FT /V /Ff inherited — then the
 * widgets on the pages read whose field that walk did not reach.
 */
function readFields(doc: PdfDoc, tally: Tally, annots: Map<PdfDict, number>, out: PdfField[]): void {
  const rootObj = doc.root ? [...doc.objects.values()].find((o) => o.value === doc.root) : undefined
  const acro = follow(doc, doc.root?.v.get('AcroForm'), rootObj)
  const top = follow(doc, asDict(acro.v)?.get('Fields'), acro.owner)
  // Cleared where the /AcroForm walk meets a reference that reached nothing
  // read here, or its depth limit: past either, a page field it was not seen to
  // list may still be listed, and the note must not say it is not.
  let whole =
    !(doc.root?.v.has('AcroForm') && acro.v === undefined) && !(asDict(acro.v)?.has('Fields') && top.v === undefined)
  const visited = new Set<PdfDict>()
  let examined = 0
  let stopped = false
  const walk = (items: PdfValue[], owner: PdfObject | undefined, parent: FieldState, depth: number): void => {
    for (const item of items) {
      if (stopped) return
      if (++examined > MAX_FIELD_NODES) {
        tally.walkCapped++
        stopped = true
        return
      }
      const node = follow(doc, item, owner)
      const d = dictOf(node.v)
      if (node.v === undefined) whole = false
      if (!d || visited.has(d)) continue
      visited.add(d)
      const get = (key: string): PdfValue | undefined => doc.resolve(d.v.get(key))
      // A name read from ciphertext is not a name (§0.3): the part is left out, as a value would be.
      const t = cleartext(doc, node) ? asString(get('T')) : undefined
      const part = t === undefined ? '' : textString(t)
      const state: FieldState = {
        name: shown(tally, parent.name && part ? `${parent.name}.${part}` : parent.name || part, MAX_SHOWN_NAME),
        ft: d.v.has('FT') ? asName(get('FT')) : parent.ft,
        v: d.v.has('V') ? follow(doc, d.v.get('V'), node.owner) : parent.v,
        ff: d.v.has('Ff') ? asInt(get('Ff')) : parent.ff
      }
      const kids = follow(doc, d.v.get('Kids'), node.owner)
      if (d.v.has('Kids') && kids.v === undefined) whole = false
      const list = asArray(kids.v) ?? []
      // A node is a field when no kid has a /T of its own; kids without one are
      // its widgets. Looked at only as far as the walk could still reach. A kid
      // not read here may have one.
      let named = false
      for (const k of list.slice(0, MAX_FIELD_NODES - examined)) {
        const kid = doc.resolve(k)
        if (kid === undefined) whole = false
        else if (dictOf(kid)?.v.has('T')) named = true
      }
      if (named) {
        if (depth + 1 >= MAX_FIELD_DEPTH) {
          tally.walkCapped++
          whole = false
        } else walk(list, kids.owner, state, depth + 1)
        continue
      }
      if (out.length >= MAX_FIELDS) {
        tally.fieldsCapped = true
        stopped = true
        return
      }
      out.push(field(doc, tally, state))
    }
  }
  const none: FieldState = { name: '', ft: undefined, v: undefined, ff: undefined }
  walk(asArray(top.v) ?? [], top.owner, none, 0)
  tally.formUnread = !whole
  // ISO 32000 makes a widget part of the form only through /AcroForm, but
  // Apple's PDFKit writes widgets carrying /T /FT /V and no /AcroForm at all,
  // and Preview shows them as fields: a /V there that no appearance draws
  // reached the case nowhere. So the page widgets go through the same walk,
  // caps and visited set, and a note says where those fields came from.
  let owners: Map<PdfDict, PdfObject> | undefined
  for (const a of annots.keys()) {
    if (stopped) return
    if (asName(doc.resolve(a.v.get('Subtype'))) !== 'Widget') continue
    const root = widgetField(doc, tally, a, visited)
    if (!root) continue
    // The owner decides cleartext in an encrypted file, and a page hands over
    // only the dictionary: looked up once, from every object, when first needed.
    if (!owners) {
      owners = new Map()
      for (const o of doc.objects.values()) {
        const d = dictOf(o.value)
        if (d) owners.set(d, o)
      }
    }
    const before = out.length
    walk([root], owners.get(root), none, 0)
    tally.fieldsOnPages += out.length - before
  }
}

/**
 * The field a page widget belongs to: its topmost /Parent with a /T, else the
 * widget itself. Undefined when /AcroForm already reached it (a dictionary on
 * the way up was visited), when nothing there names a field, or when the way
 * up runs past MAX_FIELD_DEPTH.
 *
 * ponytail: a /Parent without a /T between two with one ends the walk down from
 * the top one, as it does under /AcroForm, so the field below it is not listed.
 */
function widgetField(doc: PdfDoc, tally: Tally, widget: PdfDict, visited: Set<PdfDict>): PdfDict | undefined {
  let named: PdfDict | undefined
  const up = new Set<PdfDict>()
  for (let d: PdfDict | undefined = widget; d && !up.has(d); d = dictOf(doc.resolve(d.v.get('Parent')))) {
    if (visited.has(d)) return undefined
    if (up.size >= MAX_FIELD_DEPTH) {
      tally.walkCapped++
      return undefined
    }
    spend(doc.work)
    up.add(d)
    if (d.v.has('T')) named = d
  }
  const root = named ?? widget
  return root.v.has('T') || root.v.has('FT') || root.v.has('V') ? root : undefined
}

function field(doc: PdfDoc, tally: Tally, state: FieldState): PdfField {
  const type = state.ft !== undefined && FIELD_TYPES.has(state.ft) ? `/${state.ft}` : ''
  const password = state.ft === 'Tx' && ((state.ff ?? 0) & 0x2000) !== 0
  let read: FieldValue | undefined
  // A /V whose reference reached nothing read here — an object packed in an
  // object stream that was not opened — is unknown, not unset. /V null is unset.
  let unread = state.v !== undefined && state.v.v === undefined
  if (state.v && state.v.v !== undefined && state.v.v !== null) {
    if (cleartext(doc, state.v)) {
      read = fieldValue(doc, tally, state.v.v)
      unread = read === undefined
    } else tally.fieldsEncrypted++
  }
  return {
    name: state.name,
    value: read?.value ?? '',
    type,
    password,
    ...(unread ? { unread: true as const } : {}),
    ...(read?.cut ? { cut: true as const } : {})
  }
}

/** `cut`: `value` was cut short — said here because a value of exactly MAX_FIELD_VALUE may be whole. */
interface FieldValue {
  value: string
  cut: boolean
}

/**
 * undefined when /V holds nothing this lists — a dictionary, a stream, a number,
 * an array of those, or an array whose elements examined list nothing while
 * more went unexamined — which is a value unread, not a value unset.
 */
function fieldValue(doc: PdfDoc, tally: Tally, v: PdfValue): FieldValue | undefined {
  const s = asString(v)
  if (s !== undefined) return cutAt(tally, textString(s))
  const name = asName(v)
  if (name !== undefined) return { value: `/${name}`, cut: false }
  const list = asArray(v)
  if (!list) return undefined
  let out = ''
  let listed = list.length === 0
  // The `, ` between two elements starts exactly where cutAt cuts.
  let boundary = false
  let k = 0
  // Elements examined are bounded too: an array of a million numbers adds nothing and still costs the walk.
  // Run past the cap rather than up to it, so a value that fills it exactly is told from one that goes on.
  for (; k < list.length && k < MAX_FIELD_VALUE && out.length <= MAX_FIELD_VALUE; k++) {
    const e = doc.resolve(list[k])
    const es = asString(e)
    const en = asName(e)
    const part = es !== undefined ? textString(es) : en !== undefined ? `/${en}` : undefined
    if (part === undefined) continue
    listed = true
    if (out.length === MAX_FIELD_VALUE) boundary = true
    out += out ? `, ${part}` : part
  }
  // Elements left unexamined may hold more of the value. That stop falls between
  // whole elements, so it is a note and not `cut` or a GAP: the word beside a GAP
  // is left out of the indicators, and here it is a whole element — a whole URL.
  const more = k < list.length
  if (more) tally.fieldsPartlyRead++
  // Empty strings examined and the rest not: unknown, not "no value set".
  return listed && (out || !more) ? cutAt(tally, out, boundary) : undefined
}

/**
 * A GAP after a cut that splits a word, so the phishing analyser leaves that
 * word out. Only then: a cut between words, or where the `, ` between array
 * elements starts (`boundary`), keeps every word whole, and a GAP there would
 * drop a whole URL.
 */
function cutAt(tally: Tally, whole: string, boundary = false): FieldValue {
  const value = shown(tally, whole, MAX_FIELD_VALUE)
  const cut = value.length < whole.length
  const split = cut && !boundary && inWord(value.charCodeAt(value.length - 1), whole.charCodeAt(value.length))
  return { value: split ? value + GAP : value, cut }
}

/** §3.C.8: what the file says about itself. Card and report only, and never from ciphertext. */
function readInfo(doc: PdfDoc, tally: Tally, out: PdfInfo[]): void {
  const info = follow(doc, doc.trailer?.v.get('Info'), undefined)
  const d = asDict(info.v)
  if (!d || !cleartext(doc, info)) return
  for (const key of INFO_KEYS) {
    const value = asString(doc.resolve(d.get(key)))
    if (value !== undefined) out.push({ key, value: shown(tally, textString(value), MAX_SHOWN) })
  }
}

/** §5.1: what the object layer could not reach, and which reading it chose. */
function objectNotes(doc: PdfDoc, shared: boolean): string[] {
  const out: string[] = []
  const s = doc.stats
  if (s.objectsCapped || s.headersCapped) {
    out.push(
      'The object read stopped at its limit of 50000 objects (or 262144 object headers); objects past that point ' +
        'in the file were not read — unread, not absent.'
    )
  }
  if (s.objStmCapped) {
    out.push(
      'Only the first 1024 object streams were opened; objects packed in the rest were not read — unread, not absent.'
    )
  }
  if (doc.workSpent === 'work' && shared) {
    out.push(
      'The PDFs in this message used up the reading budget they share before this file was finished; what was not ' +
        'reached is unread, not absent.'
    )
  } else if (doc.workSpent === 'work') {
    out.push(
      `The object read stopped after ${WORK_BUDGET} steps of reading this file's structure and decompressed data, ` +
        'its limit for one file; what it had not reached by then is unread, not absent.'
    )
  }
  if (doc.workSpent === 'time') {
    out.push(
      "The object read stopped at its time limit (5 seconds for one file, 15 for this message's PDFs); what it had " +
        'not reached by then is unread, not absent.'
    )
  }
  if (doc.valueSpent) {
    out.push(
      'The object read stopped at its limit of 2000000 values held for one file; objects past that point were not ' +
        'read — unread, not absent.'
    )
  }
  if (s.unreadable) {
    out.push(
      `${s.unreadable} object(s) could not be parsed (nested more than 64 deep, never closed, or running into later ` +
        'objects further than this reader follows) and were skipped — unread, not absent.'
    )
  }
  if (s.looseHeaders) {
    out.push(
      `${s.looseHeaders} 'obj' keyword(s) follow a number but not in a form this reader accepts as an object header; ` +
        "if the file's cross-reference table points there, what they hold is unread, not absent."
    )
  }
  if (s.duplicates) {
    out.push(
      `${s.duplicates} object number(s) are defined more than once (an edit appended to the file, or a file built to ` +
        'show different readers different things). Each was resolved to its last definition in the file, which a ' +
        'reader following the latest cross-reference usually uses — not certainly — and the earlier definitions ' +
        'were searched too: anything listed from one says so.'
    )
  }
  if (s.shadows) {
    out.push(
      `${s.shadows} object header(s) sit inside another object's value or stream data. A reader following the ` +
        'cross-reference table can read them there, so they were read too and are marked "found inside object N"; ' +
        `${s.shadowsUsed} of them are the only definition of their number and were used as it.`
    )
  }
  if (s.supersededCapped) {
    out.push(
      'More than 10000 earlier or hidden definitions exist; those past that point were not searched — unread, not absent.'
    )
  }
  if (doc.rootFrom === 'catalog') {
    out.push(
      'No trailer read here names the document catalog, so it was taken from the last object marked /Type /Catalog.'
    )
  }
  if (doc.trailerFrom === 'guessed') {
    out.push(
      "No cross-reference section was found where the file's last startxref points (or the file was longer than the " +
        'part read), so the trailer was taken from the last one found by searching; a reader may use a different one.'
    )
  }
  return out
}

/** §5.1 decode tally: why a stream this reader needed was not read, or not read whole. */
function decodeNotes(doc: PdfDoc): string[] {
  const out: string[] = []
  const t = doc.tally
  if (t.noInflate) {
    out.push(
      // What such streams can hold, not what these held: one counter for every
      // use cannot say, and "page text among them" was false beside a page read whole.
      `This device cannot decompress /FlateDecode data, so ${t.noInflate} compressed stream(s) this reader needed ` +
        'were not read; such streams can hold page text, scripts, embedded files or objects packed in object ' +
        'streams. Treat what they hold as unknown, not as absent.'
    )
  }
  if (t.unsupported.size) {
    const keys = [...t.unsupported.keys()]
    // The keys are filter names the file chose (cut to 32 by the object layer), plus two labels of this reader's own.
    const names = keys.slice(0, 5).map((k) => (k.startsWith('(') || k === 'other' ? k : `/${k}`))
    const n = [...t.unsupported.values()].reduce((a, b) => a + b, 0)
    out.push(
      `${n} stream(s) use a filter this reader does not decode (${names.join(', ')}${keys.length > 5 ? ', …' : ''}), ` +
        'so what they hold was not read — unread, not absent.'
    )
  }
  if (t.predictor) {
    out.push(
      `${t.predictor} stream(s) declare a /Predictor, which this reader does not undo, so they were not read — ` +
        'unread, not absent.'
    )
  }
  if (t.notZlib) {
    out.push(
      `${t.notZlib} /FlateDecode stream(s) are neither zlib nor raw deflate data this reader can decompress, so ` +
        'they were not read — unread, not absent.'
    )
  }
  if (t.rawDeflate) {
    out.push(
      `${t.rawDeflate} /FlateDecode stream(s) have no zlib header; they were decompressed as raw deflate data, as ` +
        'some readers accept.'
    )
  }
  if (t.partial) {
    out.push(
      `${t.partial} stream(s) stopped decompressing with an error and did not end with a matching checksum, so only ` +
        'their first part may have been read. Text or objects past the break are unread, not absent.'
    )
  }
  if (t.checksumOnly) {
    out.push(
      `${t.checksumOnly} stream(s) stopped decompressing with an error but end with a checksum that matches what came ` +
        "out, so they were taken as read to the end. That checksum is the file's own word, not the decoder's, so the " +
        'word at the end of each was left out of the indicators.'
    )
  }
  if (t.capped) {
    out.push(
      `${t.capped} stream(s) decompress to more than this reader keeps for that use (4194304 bytes of page content ` +
        'or object stream, 1048576 of a font map or script, 8388608 of an embedded file); only the first part of ' +
        'each was read.'
    )
  }
  // Apart from t.budget and t.messageBudget below, which count streams never
  // read: these were read, but only up to where the budget ran out.
  if (t.shortened) {
    out.push(
      `${t.shortened} stream(s) were cut short when a decompression budget ran out (this message's budget for ` +
        "pictures, inner files and decompressed PDF data, or this file's share for that use); only their first " +
        'part was read — the rest is unread, not absent.'
    )
  }
  if (t.budget) {
    out.push(
      "Stopped decompressing at this reader's limits for one file (2048 decompressions, 67108864 bytes in, and per " +
        'use 16777216 bytes out for object streams, 12582912 for page text, 4194304 for scripts, 8388608 for ' +
        `embedded files); ${t.budget} further stream(s) it needed were not read — unread, not absent.`
    )
  }
  if (t.messageBudget) {
    out.push(
      `${t.messageBudget} stream(s) were not decompressed: this message's budget for pictures, inner files and ` +
        'decompressed PDF data was used up by what was read before them — unread, not absent.'
    )
  }
  if (t.encrypted) {
    out.push(
      `${t.encrypted} stream(s) were not read because this file is encrypted and they did not decompress to data ` +
        'with a matching checksum.'
    )
  }
  if (t.verified) {
    out.push(
      `${t.verified} stream(s) in this encrypted file decompressed with a matching checksum and were read: they are ` +
        'stored unencrypted (as an /Identity crypt filter or attachment-only encryption allows), or the trailer ' +
        'read here is not the one a reader uses.'
    )
  }
  return out
}

/** §5.2: the findings' own caps and blind spots. */
function findingNotes(t: Tally): string[] {
  const out: string[] = []
  if (t.scriptsNotRead) {
    out.push(
      `${t.scriptsNotRead} further JavaScript action(s) were not decompressed, quoted or scanned for indicators; ` +
        'this reader reads at most 10.'
    )
  }
  if (t.scriptsUnread) {
    out.push(
      `${t.scriptsUnread} JavaScript action(s) point to source this reader did not find or could not decompress; ` +
        'that source is unread, not absent.'
    )
  }
  if (t.scriptsEncrypted) {
    out.push(
      `${t.scriptsEncrypted} JavaScript source(s) are strings stored encrypted in this file, so they are not quoted.`
    )
  }
  if (t.scriptsOverShare) {
    out.push(
      `${t.scriptsOverShare} JavaScript source(s) were quoted and scanned for indicators only in part, or not at all: ` +
        `this reader takes at most ${SCRIPT_SHARE} characters of JavaScript from one file, each distinct source ` +
        'counted once, and what lies past that is unread, not absent.'
    )
  }
  if (t.fieldsEncrypted) {
    out.push(`${t.fieldsEncrypted} form field value(s) are stored encrypted in this file and are not listed.`)
  }
  if (t.fieldsPartlyRead) {
    out.push(
      `${t.fieldsPartlyRead} form field value(s) are arrays this reader stopped examining part way, after ` +
        `${MAX_FIELD_VALUE} elements or once the value listed ran past ${MAX_FIELD_VALUE} characters; the elements ` +
        'after that point are unread, not absent.'
    )
  }
  if (t.fieldsOnPages && t.formUnread) {
    out.push(
      `${t.fieldsOnPages} form field(s) were read from widget annotations on the pages; the document's /AcroForm ` +
        'could not be read whole here, so whether it lists them is unknown. If it does not, a reader that follows ' +
        "the standard may not treat them as form fields; Apple's PDFKit, and Preview with it, does."
    )
  } else if (t.fieldsOnPages) {
    out.push(
      `${t.fieldsOnPages} form field(s) were read from widget annotations on the pages that the document's ` +
        '/AcroForm does not list (or the file has no /AcroForm). A reader that follows the standard may not treat ' +
        "them as form fields; Apple's PDFKit, and Preview with it, does."
    )
  }
  if (t.embeddedNotRead) {
    out.push(
      `${t.embeddedNotRead} embedded file(s) were not decompressed, typed or hashed; this reader reads at most 24 ` +
        'per file.'
    )
  }
  if (t.walkCapped) {
    out.push(
      `The object walk stopped at one of its limits in ${t.walkCapped} place(s) (nesting, name tree, /Next chain, ` +
        'form fields, or more than 10000 candidates of one kind); anything past those is unread, not absent.'
    )
  }
  if (t.shownCut) {
    out.push(
      'Some strings read from the objects were longer than this reader lists (4096 characters, 1000 for a form ' +
        'field value, 256 for names) and are shown cut short.'
    )
  }
  const capped = (hit: boolean, what: string): void => {
    if (hit) out.push(`Stopped after ${what} read from the objects; any past that point are not listed.`)
  }
  capped(t.linksCapped, `${MAX_LINKS} links`)
  capped(t.actionsCapped, `${MAX_ACTIONS} actions`)
  capped(t.embeddedCapped, `${MAX_EMBEDDED} embedded files`)
  capped(t.fieldsCapped, `${MAX_FIELDS} form fields`)
  return out
}

const OBJSTM_NOTE = 'The name /ObjStm appears'
const ENCRYPT_NOTE = 'The name /Encrypt appears here'

/**
 * §5.4. The scan's notes about object streams and encryption were written for a
 * reader that could see neither, so they are replaced by what this read found;
 * SCAN_CAVEAT becomes DEEP_CAVEAT, and the new notes go in front of NO_VERDICT,
 * which stays last.
 */
function rewriteNotes(facts: PdfFacts, doc: PdfDoc, deep: string[]): void {
  const { found, read } = doc.objectStreams
  const objstm =
    found === 0
      ? 'The name /ObjStm appears in the bytes, but no object stream was found among the objects read; one this ' +
        'reader could not reach is not ruled out.'
      : read < found
        ? `${found - read} of ${found} compressed object stream(s) could not be read; any /JavaScript, /OpenAction or ` +
          '/URI packed in those is unread, not absent. The reasons are in the notes that follow.'
        : `${found} compressed object stream(s) were decompressed, and the objects packed in them read along with the rest.`
  const encrypt = !doc.encrypted
    ? "The name /Encrypt appears in this file's bytes, but the trailer read here does not point to an /Encrypt " +
      'dictionary, so its streams were read as unencrypted.'
    : doc.stringsEncrypted
      ? `This file's trailer points to an /Encrypt dictionary (${doc.encryptFilter}), so its strings and streams are ` +
        'encrypted. Nothing was decrypted here: streams were read only where they decompressed with a matching ' +
        'checksum, which an encrypted stream does not, and strings outside those streams — any /URI listed from the ' +
        'byte scan among them — were read from their encrypted bytes, are not what a reader shows, and are not sent ' +
        'to the case as indicators. Whether it opens without a password is not checked.'
      : `This file's trailer points to an /Encrypt dictionary (${doc.encryptFilter}) that leaves its strings ` +
        'unencrypted (/StrF is /Identity or absent, as encrypting only file attachments writes it), so its strings, ' +
        'links among them, were read as written. Its streams may be encrypted: nothing was decrypted here, and ' +
        'streams were read only where they decompressed with a matching checksum, which an encrypted stream does ' +
        'not. Whether it opens without a password is not checked.'
  let sawObjStm = false
  let sawEncrypt = false
  const notes = facts.notes.map((n) => {
    if (n.startsWith(OBJSTM_NOTE)) {
      sawObjStm = true
      return objstm
    }
    if (n.startsWith(ENCRYPT_NOTE)) {
      sawEncrypt = true
      return encrypt
    }
    return n === SCAN_CAVEAT ? DEEP_CAVEAT : n
  })
  // The byte scan cannot see a name written with #-escapes, so it can miss both
  // of these. When it did and this read found them, the sentence is still owed.
  const owed = [...(!sawObjStm && found > 0 ? [objstm] : []), ...(!sawEncrypt && doc.encrypted ? [encrypt] : [])]
  const at = notes.lastIndexOf(NO_VERDICT)
  notes.splice(at < 0 ? notes.length : at, 0, ...owed, ...deep)
  facts.notes = notes
}
