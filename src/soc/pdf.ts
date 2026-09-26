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
 */

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
   * applied a second time by the time it is displayed.
   */
  uris: string[]
  images: PdfImage[]
  /** Where this scan is blind, said out loud. */
  notes: string[]
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

/** Longest first, so `/JavaScript` is never read as `/JS` with a tail. */
const MARKER_NAMES = [
  'OpenAction',
  'JavaScript',
  'EmbeddedFile',
  'SubmitForm',
  'RichMedia',
  'AcroForm',
  'Launch',
  'GoToR',
  'ObjStm',
  'Encrypt',
  'XFA',
  'AA',
  'JS'
]

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

  facts.notes.push(
    'This is a byte scan, not a PDF parse: it resolves nothing and counts a name wherever it appears, including ' +
      'inside a string or a comment. A name written with hex escapes (/J#61vaScript is /JavaScript to a reader) is ' +
      'not decoded here, so a marker hidden that way is not counted.',
    'Nothing above is a verdict, and no absence here is evidence of safety — what this scan cannot see, it did not look for.'
  )
  return facts
}

/**
 * Bytes as one character per byte, so an index into this string IS a byte offset.
 *
 * Deliberately not TextDecoder: UTF-8 decoding collapses a multi-byte sequence
 * into one code point, and every offset after the first non-ASCII byte in the
 * file is then short by however much collapsed. Those offsets are what slice a
 * JPEG out of a stream, so a drifting one hands the caller a picture that
 * starts in the middle of itself.
 */
function latin1(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    // apply rather than a spread: a spread walks the typed array through its
    // iterator, and on a 9.8MB file that was about seven times slower, on the
    // renderer thread, on every re-analysis.
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[])
  }
  return out
}

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
    out.push(read.value)
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
 * of a printed URL has to be one that is.
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
      return { value: out, cut } // '>'
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
 * True when `endstream` sits at `at`, allowing the single EOL a writer may put
 * between the stream data and the keyword.
 *
 * This is a CONFIRMATION, never a search: the offset comes from the declared
 * /Length, so a stream that does not close where it says it does is left
 * unextracted rather than being trimmed to wherever a keyword happens to
 * appear. That is what stops one object's bytes being handed back as another's.
 */
function closesAt(text: string, at: number): boolean {
  let i = at
  if (text.startsWith('\r\n', i)) i += 2
  else if (text[i] === '\n' || text[i] === '\r') i += 1
  while (text[i] === ' ' || text[i] === '\t') i++
  return text.startsWith('endstream', i)
}

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

/**
 * Where the data ends, when a direct /Length did not decide it.
 *
 * ponytail: found by searching for `endstream`. readImages takes a direct
 * /Length first and uses it only where closesAt confirms it; this is the
 * fallback for everything else — no /Length, an indirect one (`/Length 12 0 R`,
 * the common case), one dictBefore could not see, or one that did not land on
 * `endstream`. Resolving an indirect one means parsing the xref table and
 * following it into the object graph — a parser, which is the thing this module
 * exists not to be. Ceiling: a stream whose data happens to contain the nine
 * bytes `endstream` is cut short there. The run must then begin and end as a
 * whole image to be kept, and readImages says of every image kept this way that
 * its hash could be of a prefix. Upgrade path if real files hit it: look up
 * `12 0 obj <integer> endobj` for an indirect /Length by a byte search — a
 * lookup, not a graph walk.
 *
 * The memo is what makes every search together one pass over the file, found
 * or not. A failing search fails the same way for every later offset, so one
 * answer serves them all. A successful one from `from` that lands at `at` says
 * no `endstream` begins in between, so any start in that range lands at `at`
 * too. That second half is not optional: the caller's byte budget only counts
 * runs it keeps, so 4,096 filter names in front of one distant `endstream`,
 * each run rejected as no image, bought a 12MB search apiece — about 30
 * seconds with the UI thread held.
 */
function streamEnd(text: string, start: number, memo: { noneLeft: boolean; from: number; at: number }): number {
  if (memo.noneLeft) return -1
  let at = memo.at
  if (!(memo.from <= start && start <= memo.at)) {
    at = text.indexOf('endstream', start)
    if (at < 0) {
      memo.noneLeft = true
      return -1
    }
    memo.from = start
    memo.at = at
  }
  // The EOL before `endstream` is a delimiter the writer may insert; the spec
  // says it is not part of the data, and a trailing 0x0a appended to a JPEG
  // changes every hash of it.
  let stop = at
  if (text[stop - 1] === '\n') stop--
  if (text[stop - 1] === '\r') stop--
  return stop
}
