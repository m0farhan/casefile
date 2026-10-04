/**
 * The objects of a PDF, read without rendering, fetching or running any of them.
 *
 * pdf.ts scans bytes and says so. That is not enough on its own, because the
 * modern PDF phish hides exactly where a byte scan cannot look: its /OpenAction
 * and /URI packed inside a compressed object stream, its action names written
 * with #-escapes, its lure URL drawn as page text through a font. This module
 * is the smallest reader that can see those: it finds objects, parses their
 * values, resolves references and decompresses the streams a caller asks for.
 *
 * It is still not a PDF engine, and that line is deliberate. The xref table is
 * never parsed (objects are found by their `obj` keywords), nothing is drawn,
 * no script is run, no filter beyond Flate and the two ASCII ones is decoded
 * and nothing is decrypted. Every stage is bounded — index work linear in the
 * file, decode work and output per file and per message, a deadline, a memory
 * budget for parsed values — because every size in a PDF is the sender's to
 * choose, and this runs on the analyst's UI thread.
 *
 * Where this reader chooses one reading over another (the last definition of
 * an object, the trailer the file's last `startxref` points at), it keeps the
 * other readings too and says which one it used, because a file built to show
 * different readers different things is precisely what is being looked for.
 */
import { inflate } from './ooxml'

/** A budget of steps, and optionally a `performance.now()` deadline. */
export interface Work {
  left: number
  until?: number
}

/** A stage stopped on its step budget or its deadline. */
export class WorkSpent extends Error {
  constructor(readonly why: 'work' | 'time') {
    super(`PDF read stopped: ${why}`)
  }
}

/** The per-file budget for values held in memory is used up. */
export class ValueSpent extends Error {}

/** A value that could not be parsed: `end` reached the range's end before it closed, `depth` nested too deep. */
export class Broken extends Error {
  constructor(readonly why: 'end' | 'depth') {
    super(`PDF value broken: ${why}`)
  }
}

/** Throws WorkSpent('time') once the deadline has passed. Checked at async boundaries, where time can go. */
export function checkTime(work: Work): void {
  if (work.until !== undefined && performance.now() > work.until) throw new WorkSpent('time')
}

/** Longest first, so `/JavaScript` is never read as `/JS` with a tail. */
export const MARKER_NAMES: readonly string[] = [
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
const MARKER_SET = new Set(MARKER_NAMES)

const MiB = 2 ** 20

/** Per file: object-stream member lexing, filters, content streams, CMaps. Taken as min(this, the message's). */
export const WORK_BUDGET = 64 * MiB
/** Per-file deadline, min'd with the message's. */
export const FILE_PDF_MS = 5_000

/**
 * Values held per file, in units: a scalar, name or string is 1, an array 4, a
 * dict 8. Measured at about 232 MiB per million empty dicts, so this bounds a
 * file built of nothing but `<<>>` to roughly 60 MB. A string or name costs 1
 * however long, because it is built flat (see STRINGS) and so never holds more
 * than the text it was read from, which is in memory already.
 */
const VALUE_BUDGET = 2_000_000
/** Valid object headers kept. Failed candidates do not count, so a file of bare `obj`s cannot fill it. */
const MAX_OBJ_HEADERS = 262_144
/** Distinct object numbers. */
const MAX_OBJECTS = 50_000
/** Earlier definitions and losing shadows kept for the findings walk. */
const MAX_SUPERSEDED = 10_000
/** Characters one value may span. */
const MAX_OBJECT_WALK = 4 * MiB
/** Characters kept per string; the walk still runs to its close. */
const MAX_STRING = MiB
const MAX_NAME = 127
const MAX_KEYWORD = 64
const MAX_DEPTH = 64
const REF_HOPS = 8
const MAX_TRAILERS = 1_024
const MAX_OBJSTM = 1_024
const MAX_OBJSTM_MEMBERS = 10_000
const OBJSTM_CAP = 4 * MiB
const MAX_FILTERS = 8
/** Inflate or decode starts per file, counted before the cost (each ladder try counts). */
const DECODE_OPENS = 2_048
/** Bytes handed to decoders per file, charged before `inflate` copies them. */
const DECODE_INPUT_TOTAL = 64 * MiB
/** Decoded output per file and use. One use cannot starve the others: a file of script bombs still gets its page text. */
const DECODE_SHARE: Record<DecodeUse, number> = { objstm: 16 * MiB, text: 12 * MiB, script: 4 * MiB, embedded: 8 * MiB }
/**
 * Input allowed past `cap + cap/1024`. Deflate never shrinks data by less than
 * a stored block's few bytes of framing, so an input longer than that already
 * holds more than `cap` bytes of output, and copying the rest buys nothing.
 */
const INFLATE_SLACK = 65_536
/** Unsupported-filter keys kept apart before the rest are counted as 'other'. */
const MAX_FILTER_KEYS = 16
const LONG_CHAIN = '(a chain of more than 8 filters)'

export type PdfValue = null | boolean | number | PdfName | PdfString | PdfRef | PdfValue[] | PdfDict | PdfStream
/** `#xx` decoded, no leading slash. */
export interface PdfName {
  t: 'name'
  v: string
}
/** One character per byte (latin1). */
export interface PdfString {
  t: 'str'
  v: string
  cut: boolean
}
export interface PdfRef {
  t: 'ref'
  num: number
  gen: number
}
/** Duplicate key: last wins. */
export interface PdfDict {
  t: 'dict'
  v: Map<string, PdfValue>
}
/** `confirmed`: the end came from /Length and `endstream` sits there. */
export interface PdfStream {
  t: 'stream'
  dict: PdfDict
  start: number
  end: number
  confirmed: boolean
}
/** A keyword that is not true/false/null, or a stray `>>` `]` `>` `)` `{` `}`. */
export interface PdfOp {
  t: 'op'
  v: string
}

export interface LexerBudgets {
  work: Work
  values: Work
  escaped?: Map<string, number>
}

export interface PdfObject {
  value: PdfValue
  /** Byte offset of the header's object number (the container's, for a packed object). */
  pos: number
  /** The object stream it was packed in. */
  container: number | null
  /** The object whose value or stream data holds its header (a shadow). */
  inside: number | null
}
/**
 * `text`: latin1. `whole`: every stage ended where it should, nothing was capped.
 * `endLost`: the output stops short of what the stream holds — a cap or budget
 * cut it, or a decoder broke off or may have dropped output — so the last word
 * kept may be part of one. False when the only doubt is an end found by
 * searching for `endstream`: the data ends there for every reader. Decided by
 * the decoder ending cleanly, never by a checksum or size the file writes.
 */
export interface Decoded {
  text: string
  whole: boolean
  endLost: boolean
}
export type DecodeUse = 'objstm' | 'text' | 'script' | 'embedded'
export interface DecodeTally {
  /** At most 16 keys plus 'other'. */
  unsupported: Map<string, number>
  predictor: number
  notZlib: number
  rawDeflate: number
  partial: number
  capped: number
  /** Cut short by the message's budget or the file's share for its use: the first part was read, the rest was not. */
  shortened: number
  /** Not read: the file's share or decode budgets were spent. */
  budget: number
  /** Not read: the message's budget was spent. */
  messageBudget: number
  noInflate: number
  /** Not accepted: the file is encrypted and the output did not verify. */
  encrypted: number
  /** Accepted in an encrypted file because the checksum verified. */
  verified: number
  /**
   * Read whole only by the checksum the file writes: no try ended cleanly, so
   * the decoder never vouched for the end (counted in an encrypted file too).
   */
  checksumOnly: number
}
export interface PdfDoc {
  /** The definition this reader resolves, per number. */
  objects: Map<number, PdfObject>
  /** Earlier definitions and losing shadows, at most MAX_SUPERSEDED. */
  superseded: { num: number; obj: PdfObject }[]
  root: PdfDict | null
  rootFrom: 'trailer' | 'catalog' | null
  trailer: PdfDict | null
  trailerFrom: 'startxref' | 'guessed' | null
  /** The trailer's /Encrypt resolves to a dict with a /Filter name. */
  encrypted: boolean
  /** That /Filter name, '' when not encrypted. */
  encryptFilter: string
  /** Encrypted, and its strings too: false when /V 4 or 5 leaves /StrF at /Identity, as attachment-only encryption does. */
  stringsEncrypted: boolean
  objectStreams: { found: number; read: number }
  /** Decoded object-stream payloads (latin1), for the caller's census. */
  objStmTexts: string[]
  /** MARKER_NAMES spelled with '#', decoded -> count. */
  escapedNames: Map<string, number>
  stats: {
    headers: number
    definitions: number
    duplicates: number
    shadows: number
    shadowsUsed: number
    unreadable: number
    looseHeaders: number
    headersCapped: boolean
    objectsCapped: boolean
    objStmCapped: boolean
    supersededCapped: boolean
  }
  work: Work
  values: Work
  /** Any stage may set it on catching WorkSpent. */
  workSpent: 'work' | 'time' | null
  valueSpent: boolean
  tally: DecodeTally
  /** Follows refs up to REF_HOPS; undefined if missing or a cycle. */
  resolve(v: PdfValue | undefined): PdfValue | undefined
  where(num: number, obj?: PdfObject): string
  /** Its strings are cleartext: the file's strings are not encrypted, or it is packed in an object stream that verified. */
  plain(obj: PdfObject): boolean
  /** null = not decoded, and the tally says why. */
  decode(s: PdfStream, cap: number, use: DecodeUse): Promise<Decoded | null>
}

// ---- values -----------------------------------------------------------------

function isObj(v: PdfValue | PdfOp | undefined): v is PdfName | PdfString | PdfRef | PdfDict | PdfStream | PdfOp {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
const isOp = (v: PdfValue | PdfOp | undefined): v is PdfOp => isObj(v) && v.t === 'op'
const isRef = (v: PdfValue | undefined): v is PdfRef => isObj(v) && v.t === 'ref'
const isStream = (v: PdfValue | undefined): v is PdfStream => isObj(v) && v.t === 'stream'
const isDict = (v: PdfValue | PdfOp | undefined): v is PdfDict => isObj(v) && v.t === 'dict'

/** A dict, or a stream's dict. */
export function asDict(v: PdfValue | undefined): Map<string, PdfValue> | undefined {
  return isDict(v) ? v.v : isStream(v) ? v.dict.v : undefined
}
export function asName(v: PdfValue | undefined): string | undefined {
  return isObj(v) && v.t === 'name' ? v.v : undefined
}
export function asNumber(v: PdfValue | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined
}
/** A safe integer ≥ 0, else undefined: every length and offset read from the file goes through this. */
export function asInt(v: PdfValue | undefined): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined
}
export function asString(v: PdfValue | undefined): string | undefined {
  return isObj(v) && v.t === 'str' ? v.v : undefined
}
export function asArray(v: PdfValue | undefined): PdfValue[] | undefined {
  return Array.isArray(v) ? v : undefined
}

/**
 * Where this reader marks that text may be missing between two pieces it kept
 * (it stopped, skipped or lost part of what is drawn, or cut a value mid-word).
 * A private-use character, which stripGap keeps out of everything read from the
 * file, so only this reader can write one.
 */
export const GAP = '\uE000'

/** Text from the file, with any GAP it carries made U+FFFD: a file cannot forge a gap to hide an indicator. */
export function stripGap(s: string): string {
  return s.replaceAll(GAP, '\uFFFD')
}

/** PDFDocEncoding where it is not Latin-1 (§D.2): 0x18–0x1F, and 0x80–0xA0 (0x9F undefined). */
const PDFDOC_LOW = '˘ˇˆ˙˝˛˚˜'
const PDFDOC_HIGH = '•†‡…—–ƒ⁄‹›−‰„“”‘’‚™ﬁﬂŁŒŠŸŽıłœšž\uFFFD€'

/**
 * A PDF text string (§7.9.2.2): UTF-16BE or UTF-8 with a byte-order mark, else
 * PDFDocEncoding. Only the first two can spell U+E000, so only they are stripped
 * of a GAP.
 */
export function textString(s: string): string {
  if (s.startsWith('\xFE\xFF')) {
    let out = ''
    const units: number[] = []
    // An odd last byte is half a code unit: dropped, not guessed at.
    for (let i = 2; i + 1 < s.length; i += 2) {
      units.push(((s.charCodeAt(i) & 0xff) << 8) | (s.charCodeAt(i + 1) & 0xff))
      if (units.length === 0x2000) {
        out += String.fromCharCode(...units)
        units.length = 0
      }
    }
    return stripGap(out + String.fromCharCode(...units))
  }
  if (s.startsWith('\xEF\xBB\xBF')) {
    return stripGap(new TextDecoder('utf-8').decode(Uint8Array.from(s.slice(3), (c) => c.charCodeAt(0) & 0xff)))
  }
  // Joined once (see STRINGS): appended a mapped character at a time, four
  // 1 MiB scripts of 0x80 bytes held 225 MiB.
  const parts: string[] = []
  let run = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const mapped = c >= 0x18 && c <= 0x1f ? PDFDOC_LOW[c - 0x18] : c >= 0x80 && c <= 0xa0 ? PDFDOC_HIGH[c - 0x80] : ''
    if (!mapped) continue
    parts.push(s.slice(run, i), mapped)
    run = i + 1
  }
  if (!parts.length) return s
  parts.push(s.slice(run))
  return parts.join('')
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
export function latin1(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    // apply rather than a spread: a spread walks the typed array through its
    // iterator, and on a 9.8MB file that was about seven times slower, on the
    // renderer thread, on every re-analysis.
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[])
  }
  return out
}

/**
 * True when `endstream` sits at `at`, allowing the single EOL a writer may put
 * between the stream data and the keyword.
 *
 * This is a CONFIRMATION, never a search: the offset comes from the declared
 * /Length, so a stream that does not close where it says it does is left
 * unextracted rather than being trimmed to wherever a keyword happens to
 * appear. That is what stops one object's bytes being handed back as another's.
 */
export function closesAt(text: string, at: number): boolean {
  let i = at
  if (text.startsWith('\r\n', i)) i += 2
  else if (text[i] === '\n' || text[i] === '\r') i += 1
  while (text[i] === ' ' || text[i] === '\t') i++
  return text.startsWith('endstream', i)
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
export function streamEnd(text: string, start: number, memo: { noneLeft: boolean; from: number; at: number }): number {
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

// ---- lexer ------------------------------------------------------------------

const REGULAR = 0
const WHITE = 1
const DELIMITER = 2
const CLASS = new Uint8Array(256)
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) CLASS[c] = WHITE
for (const c of '()<>[]{}/%') CLASS[c.charCodeAt(0)] = DELIMITER

/** NaN (charCodeAt past the end) is the end of a token, like a delimiter, and never a regular character. */
function kind(c: number): number {
  return c <= 0xff ? CLASS[c] : c > 0xff ? REGULAR : DELIMITER
}
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39
const isNumberChar = (c: number): boolean => isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e
function hexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30
  if (c >= 0x41 && c <= 0x46) return c - 0x37
  if (c >= 0x61 && c <= 0x66) return c - 0x57
  return -1
}

/** Past whitespace and `%` comments, never beyond `to`. */
function skipSpace(s: string, from: number, to: number): number {
  let i = from
  while (i < to) {
    const c = s.charCodeAt(i)
    if (c === 0x25) {
      while (i < to && s.charCodeAt(i) !== 0x0a && s.charCodeAt(i) !== 0x0d) i++
    } else if (kind(c) === WHITE) i++
    else break
  }
  return i
}

/** Escapes of §7.3.4.2 other than the ones that stand for themselves (`\(` `\)` `\\`, and any unknown `\x` is `x`). */
const ESCAPES = new Map([
  [0x6e, '\n'],
  [0x72, '\r'],
  [0x74, '\t'],
  [0x62, '\b'],
  [0x66, '\f']
])

// Structural tokens are shared: they carry no data, and a content stream
// produces millions of them.
const OPEN_ARRAY: PdfOp = { t: 'op', v: '[' }
const OPEN_DICT: PdfOp = { t: 'op', v: '<<' }
const CLOSE_ARRAY: PdfOp = { t: 'op', v: ']' }
const CLOSE_DICT: PdfOp = { t: 'op', v: '>>' }
const PUNCTUATION = new Map<number, PdfOp>([
  [0x5d, CLOSE_ARRAY],
  [0x29, { t: 'op', v: ')' }],
  [0x7b, { t: 'op', v: '{' }],
  [0x7d, { t: 'op', v: '}' }]
])
const STRAY_GT: PdfOp = { t: 'op', v: '>' }

/**
 * PDF tokens and values over `[from, to)` of a latin1 string (§7.2–7.3).
 *
 * Every loop is a charCode loop, and no regex ever runs on file text: the input
 * is attacker-written and can be megabytes of one token. Characters consumed are
 * charged to `work` a token at a time (a token is bounded by `to`, so the
 * overshoot is too), and values built are charged to `values`, which is what
 * bounds the memory a file of nested empty dicts can take.
 *
 * STRINGS: names, strings and text strings are sliced or joined once, never
 * appended to a character at a time. V8 keeps such a string as one 32-byte
 * node per character until something reads it, so seven 1 MiB hex strings
 * held 224 MiB of heap and four arrays of long names 459 MiB, from 16 MiB files
 * that used a handful of the value budget's units.
 */
export class Lexer {
  pos: number
  private readonly src: string
  private readonly to: number
  private readonly work: Work
  private readonly values: Work
  private readonly escaped: Map<string, number> | undefined

  constructor(src: string, from: number, to: number, budgets: LexerBudgets) {
    const clamp = (n: number): number => Math.min(src.length, Math.max(0, Math.trunc(n) || 0))
    this.src = src
    this.pos = clamp(from)
    this.to = Math.max(this.pos, clamp(to))
    this.work = budgets.work
    this.values = budgets.values
    this.escaped = budgets.escaped
  }

  /** Next complete value (arrays and dicts fully built, `N G R` assembled) or operator; undefined at `to`. */
  read(): PdfValue | PdfOp | undefined {
    return this.value(0)
  }

  private value(depth: number): PdfValue | PdfOp | undefined {
    const token = this.token()
    if (token === OPEN_ARRAY) return this.array(depth + 1)
    if (token === OPEN_DICT) return this.dict(depth + 1)
    return token
  }

  // Recursion is bounded by MAX_DEPTH, so no input can overflow the stack.
  private array(depth: number): PdfValue[] {
    if (depth > MAX_DEPTH) throw new Broken('depth')
    this.hold(4)
    const out: PdfValue[] = []
    for (;;) {
      const v = this.value(depth)
      if (v === undefined) throw new Broken('end')
      if (v === CLOSE_ARRAY) return out
      if (!isOp(v)) out.push(v)
    }
  }

  private dict(depth: number): PdfDict {
    if (depth > MAX_DEPTH) throw new Broken('depth')
    this.hold(8)
    const out: PdfDict = { t: 'dict', v: new Map() }
    for (;;) {
      const key = this.value(depth)
      if (key === undefined) throw new Broken('end')
      if (key === CLOSE_DICT) return out
      if (!isObj(key) || key.t !== 'name') continue
      const v = this.value(depth)
      if (v === undefined) throw new Broken('end')
      if (v === CLOSE_DICT) return out
      if (!isOp(v)) out.v.set(key.v, v)
    }
  }

  private charge(n: number): void {
    if ((this.work.left -= n) < 0) throw new WorkSpent('work')
  }

  private hold(n: number): void {
    if ((this.values.left -= n) < 0) throw new ValueSpent()
  }

  private token(): PdfValue | PdfOp | undefined {
    const start = this.pos
    try {
      return this.scan()
    } finally {
      // Also on a throw: a string that never closed walked to `to`, and that
      // walk is the work a flood of unclosed strings is made of.
      this.charge(this.pos - start)
    }
  }

  private scan(): PdfValue | PdfOp | undefined {
    const s = this.src
    const to = this.to
    const i = skipSpace(s, this.pos, to)
    this.pos = i
    if (i >= to) return undefined
    const c = s.charCodeAt(i)
    if (c === 0x2f) return this.name()
    if (c === 0x28) return this.literal()
    if (c === 0x3c) {
      if (i + 1 < to && s.charCodeAt(i + 1) === 0x3c) {
        this.pos = i + 2
        return OPEN_DICT
      }
      return this.hex()
    }
    if (c === 0x3e) {
      const pair = i + 1 < to && s.charCodeAt(i + 1) === 0x3e
      this.pos = i + (pair ? 2 : 1)
      return pair ? CLOSE_DICT : STRAY_GT
    }
    if (c === 0x5b) {
      this.pos = i + 1
      return OPEN_ARRAY
    }
    const punctuation = PUNCTUATION.get(c)
    if (punctuation) {
      this.pos = i + 1
      return punctuation
    }
    return isNumberChar(c) ? this.number() : this.keyword()
  }

  private keyword(): PdfValue | PdfOp {
    const s = this.src
    let j = this.pos
    while (j < this.to && kind(s.charCodeAt(j)) === REGULAR) j++
    const word = s.slice(this.pos, Math.min(j, this.pos + MAX_KEYWORD))
    this.pos = j
    if (word === 'true' || word === 'false' || word === 'null') {
      this.hold(1)
      return word === 'null' ? null : word === 'true'
    }
    return { t: 'op', v: word }
  }

  private number(): number | PdfRef {
    const s = this.src
    let j = this.pos
    while (j < this.to && isNumberChar(s.charCodeAt(j))) j++
    const token = s.slice(this.pos, Math.min(j, this.pos + 32))
    this.pos = j
    this.hold(1)
    let n = Number(token)
    if (!Number.isFinite(n)) n = parseFloat(token)
    if (!Number.isFinite(n)) n = 0
    return Number.isSafeInteger(n) && n >= 0 ? (this.ref(n) ?? n) : n
  }

  /**
   * `N G R`, peeked without recursion: the generation is a digit run of at most
   * ten, and `R` must end its token — `0 0 RG` is a colour operator, not a
   * reference. On no match the position is left where it was.
   */
  private ref(num: number): PdfRef | undefined {
    const s = this.src
    const to = this.to
    let i = skipSpace(s, this.pos, to)
    const digits = i
    while (i < to && i - digits <= 10 && isDigit(s.charCodeAt(i))) i++
    if (i === digits || i - digits > 10) return undefined
    const gen = Number(s.slice(digits, i))
    i = skipSpace(s, i, to)
    if (i >= to || s.charCodeAt(i) !== 0x52) return undefined
    if (i + 1 < to && kind(s.charCodeAt(i + 1)) === REGULAR) return undefined
    this.pos = i + 1
    return { t: 'ref', num, gen }
  }

  private name(): PdfName {
    const s = this.src
    const to = this.to
    let i = this.pos + 1
    // Codes, made a string once (see STRINGS): at most MAX_NAME of them.
    const codes: number[] = []
    let escaped = false
    while (i < to) {
      const c = s.charCodeAt(i)
      if (kind(c) !== REGULAR) break
      if (c === 0x23) {
        escaped = true
        const hi = i + 2 < to ? hexDigit(s.charCodeAt(i + 1)) : -1
        const lo = hi >= 0 ? hexDigit(s.charCodeAt(i + 2)) : -1
        if (lo >= 0) {
          if (codes.length < MAX_NAME) codes.push(hi * 16 + lo)
          i += 3
          continue
        }
      }
      if (codes.length < MAX_NAME) codes.push(c)
      i++
    }
    const out = String.fromCharCode(...codes)
    this.pos = i
    this.hold(1)
    // Only the marker names are recorded, so a file of ten million distinct
    // escaped names cannot grow this map past thirteen keys.
    if (escaped && this.escaped && MARKER_SET.has(out)) this.escaped.set(out, (this.escaped.get(out) ?? 0) + 1)
    return { t: 'name', v: out }
  }

  private literal(): PdfString {
    const s = this.src
    const to = this.to
    // Pieces, joined once at the close (see STRINGS).
    const parts: string[] = []
    let kept = 0
    let cut = false
    const keep = (part: string): void => {
      if (cut || !part) return
      const room = MAX_STRING - kept
      if (part.length <= room) {
        parts.push(part)
        kept += part.length
      } else {
        parts.push(part.slice(0, room))
        kept = MAX_STRING
        cut = true
      }
    }
    let depth = 1
    let i = this.pos + 1
    let run = i
    for (;;) {
      if (i >= to) {
        this.pos = to
        throw new Broken('end')
      }
      const c = s.charCodeAt(i)
      if (c !== 0x5c && c !== 0x28 && c !== 0x29 && c !== 0x0d) {
        i++
        continue
      }
      keep(s.slice(run, i))
      if (c === 0x28) {
        depth++
        keep('(')
        i++
      } else if (c === 0x29) {
        i++
        if (--depth === 0) break
        keep(')')
      } else if (c === 0x0d) {
        // An unescaped CR or CRLF is a line end, and reads as one \n.
        keep('\n')
        i += i + 1 < to && s.charCodeAt(i + 1) === 0x0a ? 2 : 1
      } else {
        i++
        if (i >= to) {
          this.pos = to
          throw new Broken('end')
        }
        const e = s.charCodeAt(i)
        if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30
          i++
          for (let k = 0; k < 2 && i < to && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x37; k++, i++) {
            v = v * 8 + s.charCodeAt(i) - 0x30
          }
          keep(String.fromCharCode(v & 0xff))
        } else if (e === 0x0a) i++
        else if (e === 0x0d) i += i + 1 < to && s.charCodeAt(i + 1) === 0x0a ? 2 : 1
        else {
          keep(ESCAPES.get(e) ?? s[i])
          i++
        }
      }
      run = i
    }
    this.pos = i
    this.hold(1)
    // One plain run, the usual string, stays the slice it is.
    return { t: 'str', v: parts.length === 1 ? parts[0] : parts.join(''), cut }
  }

  private hex(): PdfString {
    const s = this.src
    const to = this.to
    // One character per byte, joined once at the close (see STRINGS).
    const parts: string[] = []
    let cut = false
    let half = -1
    let i = this.pos + 1
    for (;;) {
      if (i >= to) {
        this.pos = to
        throw new Broken('end')
      }
      const c = s.charCodeAt(i++)
      if (c === 0x3e) break
      const d = hexDigit(c)
      if (d < 0) continue
      if (half < 0) half = d
      else {
        if (parts.length < MAX_STRING) parts.push(String.fromCharCode(half * 16 + d))
        else cut = true
        half = -1
      }
    }
    if (half >= 0) {
      if (parts.length < MAX_STRING) parts.push(String.fromCharCode(half * 16))
      else cut = true
    }
    this.pos = i
    this.hold(1)
    return { t: 'str', v: parts.join(''), cut }
  }
}

// ---- decoding ---------------------------------------------------------------

type Stage = 'FlateDecode' | 'ASCIIHexDecode' | 'ASCII85Decode'
const ABBREVIATIONS = new Map([
  ['Fl', 'FlateDecode'],
  ['AHx', 'ASCIIHexDecode'],
  ['A85', 'ASCII85Decode']
])

/** Which bound set a decode's output cap: the caller's, the file's share for that use, or the message's media budget. */
interface Room {
  cap: number
  by: 'cap' | 'share' | 'media'
}

interface StageOut {
  out: Uint8Array
  whole: boolean
  endLost: boolean
}

function adler32(b: Uint8Array): number {
  let a = 1
  let s = 0
  for (const byte of b) {
    a = (a + byte) % 65521
    s = (s + a) % 65521
  }
  return ((s << 16) | a) >>> 0
}

const be32 = (d: Uint8Array, i: number): number => ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0

/** How far from the end of a stream's data its deflate body is looked for: a /Length that ran long by that much at most. */
const JUNK_TAIL = 64

/** Where the checksum is written big-endian in the last JUNK_TAIL bytes (the first such place, else -1): where a zlib stream's body ends, give or take junk after it. */
function adlerAt(data: Uint8Array, sum: number): number {
  for (let i = Math.max(0, data.length - JUNK_TAIL); i <= data.length - 4; i++) if (be32(data, i) === sum) return i
  return -1
}

/** RFC 1950's header: deflate, a window of at most 32 KiB, the check bits, and no preset dictionary. */
function zlibHeader(data: Uint8Array): boolean {
  if (data.length < 2) return false
  const b0 = data[0]
  const b1 = data[1]
  return (b0 & 0x0f) === 8 && b0 >> 4 <= 7 && ((b0 << 8) | b1) % 31 === 0 && (b1 & 0x20) === 0
}

interface TextStage {
  out: Uint8Array
  /** Bytes consumed, for the work charge. */
  used: number
  ended: boolean
  bad: boolean
  truncated: boolean
}

/** /ASCIIHexDecode: whitespace skipped, `>` ends, an odd last digit padded with 0. */
function asciiHex(data: Uint8Array, cap: number): TextStage {
  const out = new Uint8Array(Math.min(cap, (data.length >> 1) + 1))
  let n = 0
  let half = -1
  let i = 0
  let ended = false
  let bad = false
  let truncated = false
  for (; i < data.length; i++) {
    const c = data[i]
    if (c === 0x3e) {
      ended = true
      i++
      break
    }
    if (CLASS[c] === WHITE) continue
    const d = hexDigit(c)
    if (d < 0) {
      bad = true
      break
    }
    if (half < 0) half = d
    else if (n < cap) {
      out[n++] = half * 16 + d
      half = -1
    } else {
      truncated = true
      break
    }
  }
  if (half >= 0 && !truncated) {
    if (n < cap) out[n++] = half * 16
    else truncated = true
  }
  return { out: out.subarray(0, n), used: i, ended, bad, truncated }
}

/** /ASCII85Decode: `z` is four zeros between groups, `~` ends, a short last group is padded with `u`. */
function ascii85(data: Uint8Array, cap: number): TextStage {
  const out = new Uint8Array(Math.min(cap, data.length * 4 + 4))
  let n = 0
  /** False when the cap stopped it. */
  const put = (v: number, count: number): boolean => {
    for (let b = 0; b < count; b++) {
      if (n >= cap) return false
      out[n++] = (v >>> (24 - 8 * b)) & 0xff
    }
    return true
  }
  let group = 0
  let count = 0
  let ended = false
  let bad = false
  let truncated = false
  let i = 0
  for (; i < data.length; i++) {
    const c = data[i]
    if (c === 0x7e) {
      ended = true
      i++
      break
    }
    if (CLASS[c] === WHITE) continue
    if (c === 0x7a && count === 0) {
      if (put(0, 4)) continue
      truncated = true
      break
    }
    if (c < 0x21 || c > 0x75) {
      bad = true
      break
    }
    group = group * 85 + c - 0x21
    if (++count < 5) continue
    if (group > 0xffffffff) {
      bad = true
      break
    }
    if (!put(group, 4)) {
      truncated = true
      break
    }
    group = 0
    count = 0
  }
  if (count > 0 && !bad && !truncated) {
    // One leftover character encodes no whole byte, so it is an error, not a short group.
    if (count === 1) bad = true
    else {
      for (let k = count; k < 5; k++) group = group * 85 + 84
      if (group > 0xffffffff) bad = true
      else truncated = !put(group, count - 1)
    }
  }
  return { out: out.subarray(0, n), used: i, ended, bad, truncated }
}

// ---- the document -----------------------------------------------------------

/** An object header, as the scan found it. */
interface Header {
  num: number
  start: number
  valueFrom: number
}

/** One definition: an object header and the value parsed from it, or a member of an object stream. */
interface Def extends PdfObject {
  num: number
  /** Where its value, or its stream data, ends. */
  spanEnd: number
  /** Tie-break among definitions at one position (members of one container), later wins. */
  seq: number
}

interface PendingLength {
  def: Def
  stream: PdfStream
  ref: PdfRef
}

class Doc implements PdfDoc {
  objects = new Map<number, Def>()
  superseded: { num: number; obj: PdfObject }[] = []
  root: PdfDict | null = null
  rootFrom: 'trailer' | 'catalog' | null = null
  trailer: PdfDict | null = null
  trailerFrom: 'startxref' | 'guessed' | null = null
  encrypted = false
  encryptFilter = ''
  stringsEncrypted = false
  objectStreams = { found: 0, read: 0 }
  objStmTexts: string[] = []
  escapedNames = new Map<string, number>()
  stats = {
    headers: 0,
    definitions: 0,
    duplicates: 0,
    shadows: 0,
    shadowsUsed: 0,
    unreadable: 0,
    looseHeaders: 0,
    headersCapped: false,
    objectsCapped: false,
    objStmCapped: false,
    supersededCapped: false
  }
  values: Work = { left: VALUE_BUDGET }
  workSpent: 'work' | 'time' | null = null
  valueSpent = false
  tally: DecodeTally = {
    unsupported: new Map(),
    predictor: 0,
    notZlib: 0,
    rawDeflate: 0,
    partial: 0,
    capped: 0,
    shortened: 0,
    budget: 0,
    messageBudget: 0,
    noInflate: 0,
    encrypted: 0,
    verified: 0,
    checksumOnly: 0
  }

  /** Top-level definitions in position order, after the containment sweep. */
  defs: Def[] = []
  /** Members of object streams. */
  members: Def[] = []
  /** Index budgets: their own, never the file's `work`, and linear in the scan by construction. */
  private readonly indexWork: Work
  private readonly retryWork: Work
  /** Escaped names seen by the parse in progress, merged only once it succeeds, so a retried parse is not counted twice. */
  private readonly pendingEscapes = new Map<string, number>()
  private readonly cache = new Map<PdfStream, { cap: number; p: Promise<Decoded | null> }>()
  private readonly spent: Record<DecodeUse, number> = { objstm: 0, text: 0, script: 0, embedded: 0 }
  private opens = 0
  private inputTotal = 0

  constructor(
    private readonly bytes: Uint8Array,
    private readonly text: string,
    private readonly media: { left: number },
    readonly work: Work
  ) {
    this.indexWork = { left: 2 * text.length }
    this.retryWork = { left: text.length }
  }

  resolve(v: PdfValue | undefined): PdfValue | undefined {
    let out = v
    for (let hops = 0; isRef(out); hops++) {
      if (hops >= REF_HOPS) return undefined
      out = this.objects.get(out.num)?.value
    }
    return out
  }

  where(num: number, obj: PdfObject | undefined = this.objects.get(num)): string {
    let out = `object ${num}`
    if (!obj) return out
    if (obj.container !== null) out += `, packed in object stream ${obj.container}`
    else if (obj.inside !== null) out += `, found inside object ${obj.inside}`
    // A shadow that lost is not "replaced later": its own label already says where it sits.
    if (obj.inside === null && obj !== this.objects.get(num)) {
      out += ', an earlier definition replaced later in the file'
    }
    return out
  }

  plain(obj: PdfObject): boolean {
    return !this.stringsEncrypted || obj.container !== null
  }

  decode(s: PdfStream, cap: number, use: DecodeUse): Promise<Decoded | null> {
    // Keyed by stream and cap together: a small decode cached first must not
    // stand in for a larger one asked for later (a script read at 1 MiB, then
    // the same stream as page text at 4 MiB). A larger cap decodes again.
    const hit = this.cache.get(s)
    if (hit && cap <= hit.cap) return hit.p
    const p = this.decodeNow(s, cap, use)
    this.cache.set(s, { cap, p })
    return p
  }

  // ---- index (§3.A.2) ----

  index(): void {
    const headers = this.scanHeaders()
    this.stats.headers = headers.length
    const pending: PendingLength[] = []
    const retry: Header[] = []
    const defs: Def[] = []
    const memo = { noneLeft: false, from: 0, at: -1 }
    const len = this.text.length
    // 2b: each value is parsed only up to the next header, so the parses cover
    // disjoint ranges and cost one pass together.
    let stopped = false
    for (let k = 0; k < headers.length && !stopped; k++) {
      const h = headers[k]
      const next = k + 1 < headers.length ? headers[k + 1].start : len
      const to = Math.max(h.valueFrom, Math.min(next, h.valueFrom + MAX_OBJECT_WALK))
      try {
        const def = this.parseDef(h, to, this.indexWork, memo, pending)
        if (def) defs.push(def)
      } catch (error) {
        if (error instanceof Broken && error.why === 'end') retry.push(h)
        else if (error instanceof Broken) this.stats.unreadable++
        else if (error instanceof WorkSpent) {
          this.stats.unreadable += headers.length - k + retry.length
          retry.length = 0
          stopped = true
        } else if (error instanceof ValueSpent) {
          // File-wide, so nothing later could be held either: stop parsing here.
          // What follows is the VALUES note's to report; what was queued for a
          // second parse is unreadable.
          this.valueSpent = true
          this.stats.unreadable += retry.length
          retry.length = 0
          stopped = true
        } else throw error
      }
    }
    // 2c: a value that ran into the next header gets one more parse, from a
    // budget of its own. A header it swallows becomes a shadow in 2e.
    const retryMemo = { noneLeft: false, from: 0, at: -1 }
    for (let k = 0; k < retry.length; k++) {
      const h = retry[k]
      try {
        const def = this.parseDef(h, Math.min(len, h.valueFrom + MAX_OBJECT_WALK), this.retryWork, retryMemo, pending)
        if (def) defs.push(def)
      } catch (error) {
        if (error instanceof Broken) this.stats.unreadable++
        else if (error instanceof WorkSpent) {
          this.stats.unreadable += retry.length - k
          break
        } else if (error instanceof ValueSpent) {
          this.valueSpent = true
          this.stats.unreadable += retry.length - k
          break
        } else throw error
      }
    }
    defs.sort((a, b) => a.pos - b.pos)
    this.resolveLengths(defs, pending)
    this.defs = defs.filter((d) => d.spanEnd >= 0)
    // 2e: a header that lies inside another object's value or stream data is a shadow.
    let maxEnd = -1
    let owner = -1
    this.defs.forEach((d, seq) => {
      d.seq = seq
      if (d.pos < maxEnd) {
        d.inside = owner
        this.stats.shadows++
      }
      if (d.spanEnd > maxEnd) {
        maxEnd = d.spanEnd
        owner = d.num
      }
    })
    this.choose(this.defs)
  }

  /**
   * 2a. Every `obj` keyword with `N G` in front of it. The back-walk never
   * crosses the previous keyword, so all of them together read the text once.
   *
   * ponytail: objects are found by keyword, never through the xref table or an
   * xref stream (whose entries would need predictors undone). An object only the
   * xref can reach — one whose header is written in a form this scan rejects —
   * is counted as a loose header, not read. Add xref parsing when a real file
   * hides an object that way.
   */
  private scanHeaders(): Header[] {
    const text = this.text
    const len = text.length
    const out: Header[] = []
    let floor = 0
    for (let i = text.indexOf('obj'); i >= 0; i = text.indexOf('obj', floor)) {
      const lo = floor
      floor = i + 3
      if (i >= 3 && text.startsWith('end', i - 3)) continue
      if (i + 3 < len && kind(text.charCodeAt(i + 3)) === REGULAR) continue
      const header = this.headerBefore(i, lo)
      if (!header) {
        if (looseBefore(text, i, lo)) this.stats.looseHeaders++
        continue
      }
      if (out.length >= MAX_OBJ_HEADERS) {
        this.stats.headersCapped = true
        break
      }
      out.push(header)
    }
    return out
  }

  /** `N G obj`, walked back from the keyword: 0–256 spaces, 1–32 digits, 1–256 spaces, 1–32 digits. */
  private headerBefore(i: number, lo: number): Header | null {
    const text = this.text
    const spaces = (from: number): number => {
      let j = from
      while (j > lo && from - j <= 256 && kind(text.charCodeAt(j - 1)) === WHITE) j--
      return j
    }
    const digits = (from: number): number => {
      let j = from
      while (j > lo && from - j <= 32 && isDigit(text.charCodeAt(j - 1))) j--
      return j
    }
    const genEnd = spaces(i)
    const genStart = digits(genEnd)
    const numEnd = spaces(genStart)
    const numStart = digits(numEnd)
    this.indexWork.left -= i - numStart
    if (i - genEnd > 256 || genEnd === genStart || genEnd - genStart > 32) return null
    if (genStart === numEnd || genStart - numEnd > 256) return null
    if (numEnd === numStart || numEnd - numStart > 32) return null
    const gen = digitValue(text.slice(genStart, genEnd))
    const num = digitValue(text.slice(numStart, numEnd))
    if (gen > 65_535 || num > 2_147_483_647) return null
    return { num, start: numStart, valueFrom: i + 3 }
  }

  /** One value from a header, and its stream data when a `stream` keyword follows it. */
  private parseDef(h: Header, to: number, work: Work, memo: StreamMemo, pending: PendingLength[]): Def | null {
    const text = this.text
    const lx = this.lexer(h.valueFrom, to, work)
    const read = lx.read()
    this.mergeEscapes()
    const value: PdfValue = read === undefined || isOp(read) ? null : read
    if (isDict(value)) {
      // Peeked with startsWith, never read(): stream data is not tokens.
      const at = skipSpace(text, lx.pos, to)
      if (at < to && text.startsWith('stream', at) && kind(text.charCodeAt(at + 6)) !== REGULAR) {
        let start = at + 6
        if (text.charCodeAt(start) === 0x0d) start++
        if (text.charCodeAt(start) === 0x0a) start++
        const length = value.v.get('Length')
        const n = asInt(length)
        const stream: PdfStream = { t: 'stream', dict: value, start, end: start, confirmed: false }
        const def: Def = {
          num: h.num,
          pos: h.start,
          value: stream,
          spanEnd: start,
          container: null,
          inside: null,
          seq: 0
        }
        if (n !== undefined && start + n <= text.length && closesAt(text, start + n)) {
          stream.end = start + n
          stream.confirmed = true
        } else if (isRef(length)) {
          pending.push({ def, stream, ref: length })
          return def
        } else {
          const end = streamEnd(text, start, memo)
          if (end < 0) {
            this.stats.unreadable++
            return null
          }
          stream.end = Math.max(start, end)
        }
        def.spanEnd = stream.end
        return def
      }
    }
    return {
      num: h.num,
      pos: h.start,
      value,
      spanEnd: Math.max(lx.pos, h.valueFrom),
      container: null,
      inside: null,
      seq: 0
    }
  }

  /**
   * 2d. `/Length N 0 R` against a provisional map (last definition by position),
   * so data holding the bytes `endstream` no longer leaves objects inside it
   * looking top-level: the containment sweep runs after this.
   */
  private resolveLengths(defs: Def[], pending: PendingLength[]): void {
    if (!pending.length) return
    const text = this.text
    const last = new Map<number, Def>()
    for (const d of defs) last.set(d.num, d)
    const memo = { noneLeft: false, from: 0, at: -1 }
    pending.sort((a, b) => a.stream.start - b.stream.start)
    for (const { def, stream, ref } of pending) {
      const n = asInt(last.get(ref.num)?.value)
      if (n !== undefined && stream.start + n <= text.length && closesAt(text, stream.start + n)) {
        stream.end = stream.start + n
        stream.confirmed = true
      } else {
        const end = streamEnd(text, stream.start, memo)
        if (end < 0) {
          this.stats.unreadable++
          def.spanEnd = -1
          continue
        }
        stream.end = Math.max(stream.start, end)
      }
      def.spanEnd = stream.end
    }
  }

  /**
   * 2f. One winner per number: a definition not inside another beats a shadow,
   * then the later one wins — what a reader following the latest
   * cross-reference section usually resolves. Everything else is kept, labelled.
   */
  private choose(all: Def[]): void {
    const best = new Map<number, Def>()
    const losers: Def[] = []
    const seen = new Set<number>()
    const dupes = new Set<number>()
    this.stats.objectsCapped = false
    this.stats.supersededCapped = false
    const lose = (d: Def): void => {
      if (losers.length < MAX_SUPERSEDED) losers.push(d)
      else this.stats.supersededCapped = true
    }
    for (const d of all) {
      if (d.inside === null) {
        if (seen.has(d.num)) dupes.add(d.num)
        else seen.add(d.num)
      }
      const current = best.get(d.num)
      if (!current) {
        if (best.size >= MAX_OBJECTS) {
          this.stats.objectsCapped = true
          continue
        }
        best.set(d.num, d)
      } else if (d.inside === null || current.inside !== null) {
        best.set(d.num, d)
        lose(current)
      } else lose(d)
    }
    this.objects = best
    this.superseded = losers.sort(byPosition).map((obj) => ({ num: obj.num, obj }))
    this.stats.duplicates = dupes.size
    this.stats.shadowsUsed = 0
    for (const d of best.values()) if (d.inside !== null) this.stats.shadowsUsed++
    this.stats.definitions = all.length
  }

  private lexer(from: number, to: number, work: Work, text = this.text): Lexer {
    this.pendingEscapes.clear()
    return new Lexer(text, from, to, { work, values: this.values, escaped: this.pendingEscapes })
  }

  private mergeEscapes(): void {
    for (const [name, n] of this.pendingEscapes) this.escapedNames.set(name, (this.escapedNames.get(name) ?? 0) + n)
    this.pendingEscapes.clear()
  }

  // ---- trailer (§3.A.3) ----

  findTrailer(): void {
    try {
      const found = this.viaStartxref()
      if (found) {
        this.trailer = found
        this.trailerFrom = 'startxref'
        return
      }
      const guessed = this.guessTrailer()
      if (guessed) {
        this.trailer = guessed
        this.trailerFrom = 'guessed'
      }
    } catch (error) {
      // The index budget ran out: that is a trailer not found, not the file's
      // work spent, and the notes must not say the latter.
      if (!(error instanceof WorkSpent)) throw error
    }
  }

  /**
   * The trailer the file's last `startxref` points at. Tried on whatever part of
   * the file was scanned: in a file longer than that, the last 1,024 characters
   * read are not the file's end, so no `startxref` is usually found there and
   * the guess takes over, with its note.
   */
  private viaStartxref(): PdfDict | null {
    const text = this.text
    const tailFrom = Math.max(0, text.length - 1024)
    const at = text.slice(tailFrom).lastIndexOf('startxref')
    if (at < 0) return null
    let i = skipSpace(text, tailFrom + at + 9, text.length)
    const digits = i
    while (i < text.length && i - digits <= 10 && isDigit(text.charCodeAt(i))) i++
    if (i === digits || i - digits > 10) return null
    const off = Number(text.slice(digits, i))
    // Acrobat counts offsets from the %PDF header when there is junk in front
    // of it, so a file built that way points there, not at byte `off`.
    const header = text.slice(0, 1029).indexOf('%PDF-')
    const places = header > 0 && header < 1024 ? [off, off + header] : [off]
    for (const place of places) {
      let p = place
      while (p < text.length && p - place < 256 && kind(text.charCodeAt(p)) === WHITE) p++
      if (p >= text.length) continue
      if (text.startsWith('xref', p)) {
        const t = text.indexOf('trailer', p)
        if (t < 0) continue
        if ((this.indexWork.left -= t - p) < 0) return null
        const dict = this.trailerAt(t)
        if (dict) return dict
        continue
      }
      for (const d of this.defs) {
        if (d.pos === p && isStream(d.value) && asName(d.value.dict.v.get('Type')) === 'XRef') return d.value.dict
      }
    }
    return null
  }

  /** The dictionary after a `trailer` keyword, or null. */
  private trailerAt(t: number): PdfDict | null {
    const from = t + 'trailer'.length
    if (from < this.text.length && kind(this.text.charCodeAt(from)) === REGULAR) return null
    try {
      const v = this.lexer(from, Math.min(this.text.length, from + MAX_OBJECT_WALK), this.indexWork).read()
      this.mergeEscapes()
      return isDict(v) ? v : null
    } catch (error) {
      if (error instanceof Broken) return null
      throw error
    }
  }

  /**
   * The last trailer-shaped dictionary that is not inside an object's value or
   * stream data and not commented out: what a reader that rebuilds a broken
   * file's cross-reference would most likely settle on. Said so in a note.
   */
  private guessTrailer(): PdfDict | null {
    const text = this.text
    const spans = this.spanIndex()
    let best: { pos: number; dict: PdfDict } | null = null
    let from = text.length
    for (let examined = 0; examined < MAX_TRAILERS && from >= 0; examined++) {
      const t = text.lastIndexOf('trailer', from)
      if (t < 0) break
      from = t - 1
      if (spans(t) || commentedOut(text, t)) continue
      const dict = this.trailerAt(t)
      if (dict) {
        best = { pos: t, dict }
        break
      }
    }
    for (const d of this.defs) {
      if (d.inside !== null || !isStream(d.value) || asName(d.value.dict.v.get('Type')) !== 'XRef') continue
      if (best && d.pos < best.pos) continue
      if (!commentedOut(text, d.pos)) best = { pos: d.pos, dict: d.value.dict }
    }
    return best?.dict ?? null
  }

  /** Whether a position lies inside some definition's value or stream data. */
  private spanIndex(): (at: number) => boolean {
    const defs = this.defs
    const reach: number[] = []
    let max = -1
    for (const d of defs) reach.push((max = Math.max(max, d.spanEnd)))
    return (at) => {
      let lo = 0
      let hi = defs.length - 1
      let found = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (defs[mid].pos <= at) {
          found = mid
          lo = mid + 1
        } else hi = mid - 1
      }
      return found >= 0 && reach[found] > at
    }
  }

  findEncryption(): void {
    const encrypt = this.resolve(this.trailer?.v.get('Encrypt'))
    if (!isDict(encrypt)) return
    const filter = asName(this.resolve(encrypt.v.get('Filter')))
    if (filter === undefined) return
    this.encrypted = true
    this.encryptFilter = filter
    // With crypt filters (/V 4 and 5) strings use the one /StrF names, and it
    // defaults to /Identity (§7.6.5, Table 20): Acrobat's "encrypt only file
    // attachments" writes every string as it is. Read as ciphertext, that
    // file's links were kept off the case and called stored encrypted.
    const v = asInt(this.resolve(encrypt.v.get('V')))
    const strF = this.resolve(encrypt.v.get('StrF'))
    const identity = strF === undefined || strF === null || asName(strF) === 'Identity'
    this.stringsEncrypted = !((v === 4 || v === 5) && identity)
  }

  findRoot(): void {
    const root = this.resolve(this.trailer?.v.get('Root'))
    if (isDict(root)) {
      this.root = root
      this.rootFrom = 'trailer'
      return
    }
    let last: Def | undefined
    for (const d of this.objects.values()) {
      if (!isDict(d.value) || asName(this.resolve(d.value.v.get('Type'))) !== 'Catalog') continue
      if (!last || byPosition(d, last) > 0) last = d
    }
    if (last && isDict(last.value)) {
      this.root = last.value
      this.rootFrom = 'catalog'
    }
  }

  // ---- object streams (§3.A.4) ----

  async readObjectStreams(): Promise<void> {
    const streams: Def[] = []
    for (const d of this.defs) {
      if (!isStream(d.value) || asName(this.resolve(d.value.dict.v.get('Type'))) !== 'ObjStm') continue
      if (streams.length >= MAX_OBJSTM) {
        this.stats.objStmCapped = true
        break
      }
      streams.push(d)
    }
    // Counted before any is opened, so a read that stops part way still says how many there were.
    this.objectStreams.found = streams.length
    for (const container of streams) {
      const s = container.value as PdfStream
      const d = await this.decode(s, OBJSTM_CAP, 'objstm')
      if (!d) continue
      this.objectStreams.read++
      this.objStmTexts.push(d.text)
      this.unpack(container, s, d.text)
    }
  }

  private unpack(container: Def, s: PdfStream, payload: string): void {
    const n = Math.min(asInt(this.resolve(s.dict.v.get('N'))) ?? 0, MAX_OBJSTM_MEMBERS)
    const first = asInt(this.resolve(s.dict.v.get('First')))
    if (first === undefined || first > payload.length) {
      this.stats.unreadable++
      return
    }
    const pairs: { num: number; off: number }[] = []
    try {
      const lx = this.lexer(0, first, this.work, payload)
      for (let k = 0; k < n; k++) {
        const num = asInt(lx.read() as PdfValue)
        const off = asInt(lx.read() as PdfValue)
        if (num === undefined || off === undefined) break
        if (num <= 2_147_483_647 && first + off <= payload.length) pairs.push({ num, off })
      }
      this.mergeEscapes()
    } catch (error) {
      if (!(error instanceof Broken)) throw error
    }
    // Sorted and de-duplicated so the ranges never overlap: each member's bytes
    // are read once, whatever order and repeats the header claims.
    pairs.sort((a, b) => a.off - b.off)
    const kept = pairs.filter((p, k) => k === 0 || p.off !== pairs[k - 1].off)
    for (let k = 0; k < kept.length; k++) {
      const to = k + 1 < kept.length ? first + kept[k + 1].off : payload.length
      try {
        const lx = this.lexer(first + kept[k].off, to, this.work, payload)
        let v = lx.read()
        while (isOp(v)) v = lx.read()
        this.mergeEscapes()
        this.members.push({
          num: kept[k].num,
          value: v ?? null,
          pos: container.pos,
          container: container.num,
          inside: container.inside,
          spanEnd: container.pos,
          seq: this.defs.length + this.members.length
        })
      } catch (error) {
        if (error instanceof Broken) this.stats.unreadable++
        else throw error
      }
    }
  }

  /** The final winners, members of object streams competing by their container's position. */
  settle(): void {
    if (this.members.length) this.choose([...this.defs, ...this.members].sort(byPosition))
  }

  // ---- decode (§3.A.5) ----

  private async decodeNow(s: PdfStream, cap: number, use: DecodeUse): Promise<Decoded | null> {
    checkTime(this.work)
    const dict = s.dict.v
    const filter = this.resolve(dict.get('Filter'))
    const listed = filter === undefined || filter === null ? [] : Array.isArray(filter) ? filter : [filter]
    if (listed.length > MAX_FILTERS) {
      this.unsupported(LONG_CHAIN)
      return null
    }
    const decodeParms = this.resolve(dict.get('DecodeParms'))
    const parms = (k: number): Map<string, PdfValue> | undefined =>
      asDict(this.resolve(Array.isArray(decodeParms) ? decodeParms[k] : k === 0 ? decodeParms : undefined))
    // ponytail: no predictors, which xref streams and some images use; add when a
    // real file hides text or objects behind one.
    for (let k = 0; k < listed.length; k++) {
      if ((asNumber(this.resolve(parms(k)?.get('Predictor'))) ?? 1) > 1) {
        this.tally.predictor++
        return null
      }
    }
    const stages: Stage[] = []
    for (let k = 0; k < listed.length; k++) {
      const raw = asName(this.resolve(listed[k]))
      const name = raw === undefined ? undefined : (ABBREVIATIONS.get(raw) ?? raw)
      if (name === 'Crypt') {
        const which = asName(this.resolve(parms(k)?.get('Name')))
        if (which === undefined || which === 'Identity') continue
      }
      if (name !== 'FlateDecode' && name !== 'ASCIIHexDecode' && name !== 'ASCII85Decode') {
        // ponytail: LZW, RunLength and the image filters are counted, not decoded.
        this.unsupported(name === undefined ? '(not a name)' : name.slice(0, 32))
        return null
      }
      stages.push(name)
    }
    let data = this.bytes.subarray(Math.min(s.start, this.bytes.length), Math.min(s.end, this.bytes.length))
    // ponytail: nothing is decrypted — not even a file that opens without a
    // password (RC4 or AES under the empty user password). That check is the
    // first follow-up; it needs its own RC4 test oracle, since Node has none.
    // What is read from an encrypted file is only Flate
    // output whose own checksum verifies — an Identity crypt filter, an
    // attachment-only encryption, or a trailer chosen wrongly — which ciphertext
    // passes with a probability of about one in four billion.
    if (this.encrypted && (stages.length !== 1 || stages[0] !== 'FlateDecode' || !zlibHeader(data))) {
      this.tally.encrypted++
      return null
    }
    if (stages.length && this.opens >= DECODE_OPENS) {
      this.tally.budget++
      return null
    }
    const first = this.room(cap, use)
    if (first.cap <= 0) return this.refuse()
    if (stages.includes('FlateDecode') && typeof DecompressionStream !== 'function') {
      this.tally.noInflate++
      return null
    }
    if (!stages.length) {
      const out = data.subarray(0, first.cap)
      this.charge(use, out.length)
      const short = data.length > out.length
      if (short) this.cut(first.by)
      return { text: latin1(out), whole: s.confirmed && !short, endLost: short }
    }
    let whole = true
    let endLost = false
    for (const stage of stages) {
      const room = this.room(cap, use)
      if (room.cap <= 0) return this.refuse()
      let out: StageOut | null
      if (stage === 'FlateDecode') out = await this.flate(data, room, use)
      else {
        this.opens++
        const r = stage === 'ASCIIHexDecode' ? asciiHex(data, room.cap) : ascii85(data, room.cap)
        if ((this.work.left -= r.used) < 0) throw new WorkSpent('work')
        this.charge(use, r.out.length)
        if (r.truncated) this.cut(room.by)
        else if (r.bad || !r.ended) this.tally.partial++
        const ok = !r.truncated && !r.bad && r.ended
        out = { out: r.out, whole: ok, endLost: !ok }
      }
      if (!out) return null
      data = out.out
      whole &&= out.whole
      endLost ||= out.endLost
    }
    return { text: latin1(data), whole, endLost }
  }

  /**
   * The two-try ladder (decision 1). Try A is the exact deflate body of a
   * well-formed zlib stream, which ends without an error on every engine
   * measured — Chromium 152 drops the tail of a stream fed its checksum as
   * junk. Try B keeps the checksum, for a /Length that ran a few bytes long.
   *
   * A /Length that counts the EOL in front of `endstream` leaves it on the
   * data, where it fails every try as junk after a whole stream — a raw
   * deflate one with no other try, or a zlib one whose checksum is wrong. So
   * when the data ends in an EOL, try A (or the raw try) without it comes
   * second. One EOL, as closesAt allows: stripping every CR and LF would eat
   * a checksum byte that is one. Ending cleanly there is the decoder's word
   * that nothing was lost, which no checksum the file writes can give (see
   * Decoded.endLost).
   *
   * A /Length that counts more junk than that is cut off once, where the
   * stream seems to end: before the byte whose one-byte write Chromium failed
   * (inflate's junkAt), or, on an engine that fails only the close, as Node
   * does, before the checksum of what came out where it sits in a zlib
   * stream's tail. Only within JUNK_TAIL of the end, so bytes that are not
   * deflate data and fail early cost no pass. Either place is only a guess;
   * the decoder ending cleanly there is what vouches for the end, so a
   * checksum the file writes picks where to look and decides nothing. A cut
   * that does not end cleanly met bad data, not an end, and every try holds
   * the same bytes there: one per stream.
   */
  private async flate(data: Uint8Array, room: Room, use: DecodeUse): Promise<StageOut | null> {
    const n = data.length
    const zlib = zlibHeader(data)
    const from = zlib ? 2 : 0
    const tries = zlib ? (n >= 6 ? [data.subarray(2, n - 4), data.subarray(2)] : [data.subarray(2)]) : [data]
    const e = n - (data[n - 1] === 0x0a ? (data[n - 2] === 0x0d ? 2 : 1) : data[n - 1] === 0x0d ? 1 : 0)
    if (e < n && e >= (zlib ? 6 : 1)) tries.splice(1, 0, zlib ? data.subarray(2, e - 4) : data.subarray(0, e))
    const limit = room.cap + (room.cap >> 10) + INFLATE_SLACK
    const endOf = (input: Uint8Array): number => input.byteOffset - data.byteOffset + input.length
    let out: Uint8Array = new Uint8Array(0)
    /** `end`: where in `data` the input of the try that stopped ended. */
    let stopped: { end: number; truncated: boolean } | null = null
    let lossy = false
    /** Where in `data` each input decoded so far ended: none is decoded twice. */
    const ran: number[] = []
    let cut = false
    /** Decodes `input`, keeping the longest output. `ended`: without an error, or at the cap. */
    const pass = async (input: Uint8Array): Promise<{ ended: boolean; junkAt: number; truncated: boolean }> => {
      this.inputTotal += input.length
      this.opens++
      // inflate's second pass costs what a first does, so it is only taken
      // while both budgets still hold it. Whether one is needed is inflate's
      // call, by where a write failed: never this stream's checksum, which the
      // file writes.
      const spare = this.opens < DECODE_OPENS && this.inputTotal + input.length <= DECODE_INPUT_TOTAL
      const r = await inflate(input, room.cap, () => spare)
      if (r.retried) {
        this.opens++
        this.inputTotal += input.length
      }
      lossy ||= r.lossy
      this.charge(use, r.bytes.length)
      checkTime(this.work)
      if (r.bytes.length > out.length) out = r.bytes
      ran.push(endOf(input))
      return { ended: !r.failed || r.truncated, junkAt: r.junkAt, truncated: r.truncated }
    }
    for (const t of tries) {
      const input = t.subarray(0, limit)
      if (ran.includes(endOf(input))) continue
      if (this.inputTotal + input.length > DECODE_INPUT_TOTAL) {
        this.tally.budget++
        return null
      }
      const r = await pass(input)
      if (r.ended) {
        stopped = { end: endOf(input), truncated: r.truncated }
        break
      }
      if (cut) continue
      const near = r.junkAt > 0 && r.junkAt >= input.length - JUNK_TAIL
      const at = near ? from + r.junkAt : zlib ? adlerAt(data, adler32(out)) : -1
      if (at <= from || ran.includes(at) || at - from > limit) continue
      if (this.opens >= DECODE_OPENS || this.inputTotal + at - from > DECODE_INPUT_TOTAL) continue
      cut = true
      const c = await pass(data.subarray(from, at))
      if (c.ended) {
        stopped = { end: at, truncated: c.truncated }
        break
      }
    }
    if (this.encrypted) {
      const sum = adler32(out)
      // A try that stopped must have the checksum right where its deflate body ended.
      const verified = stopped
        ? !stopped.truncated && stopped.end + 4 <= n && sum === be32(data, stopped.end)
        : !lossy && adlerAt(data, sum) >= 0
      if (!verified) {
        this.tally.encrypted++
        return null
      }
      this.tally.verified++
      if (!stopped) this.tally.checksumOnly++
      return { out, whole: true, endLost: !stopped }
    }
    if (stopped) {
      if (!zlib) this.tally.rawDeflate++
      if (stopped.truncated) this.cut(room.by)
      return { out, whole: !stopped.truncated, endLost: stopped.truncated }
    }
    // Raw deflate is taken only when a try ended cleanly. Bytes that are not
    // deflate data at all can come out a few at a time before the decoder sees
    // so (58 of 299 random 200-byte streams did on test/pdf.ts's Chromium
    // model), and "read in part" is false of them.
    if (!zlib) {
      this.tally.notZlib++
      return null
    }
    // Every try ended in an error. The stream is still whole when its own
    // checksum over what came out sits where a zlib stream ends — unless a
    // write that failed may have lost output and the budgets left no second
    // pass to get it back. The file writes that checksum, and one of what
    // Chromium kept had a cut stream read as whole. Being the file's word, it
    // never says the end was not lost, and it is counted apart for its note.
    if (!lossy && adlerAt(data, adler32(out)) >= 0) {
      this.tally.checksumOnly++
      return { out, whole: true, endLost: true }
    }
    this.tally.partial++
    return { out, whole: false, endLost: true }
  }

  private room(cap: number, use: DecodeUse): Room {
    const share = DECODE_SHARE[use] - this.spent[use]
    const media = this.media.left
    const room = Math.min(cap, share, media)
    return { cap: room, by: room === cap ? 'cap' : room === media ? 'media' : 'share' }
  }

  /** Output charged to the file's share for its use and to the message's media budget. */
  private charge(use: DecodeUse, n: number): void {
    this.spent[use] += n
    this.media.left -= n
  }

  private refuse(): null {
    if (this.media.left <= 0) this.tally.messageBudget++
    else this.tally.budget++
    return null
  }

  /**
   * A decode cut short, its first part kept and used. Counted apart from
   * refuse()'s: "not decompressed" about a stream whose text and links were
   * just read is false.
   */
  private cut(by: Room['by']): void {
    if (by === 'cap') this.tally.capped++
    else this.tally.shortened++
  }

  private unsupported(key: string): void {
    const map = this.tally.unsupported
    const other = map.has('other') ? 1 : 0
    const k = map.has(key) || map.size - other < MAX_FILTER_KEYS ? key : 'other'
    map.set(k, (map.get(k) ?? 0) + 1)
  }
}

type StreamMemo = { noneLeft: boolean; from: number; at: number }

function byPosition(a: Def, b: Def): number {
  return a.pos - b.pos || a.seq - b.seq
}

/** A run of digits as a number, from its significant digits so leading zeros pass; Infinity when too long. */
function digitValue(run: string): number {
  let i = 0
  while (i < run.length - 1 && run.charCodeAt(i) === 0x30) i++
  return run.length - i > 10 ? Infinity : Number(run.slice(i))
}

/**
 * A failed header whose keyword follows a number all the same — `12 0 %c\nobj`
 * is a header to a reader following the xref, which skips the comment. Walked
 * back no further than the previous keyword or 256 characters.
 */
function looseBefore(text: string, i: number, lo: number): boolean {
  const floor = Math.max(lo, i - 256)
  let j = i
  while (j > floor) {
    const c = text.charCodeAt(j - 1)
    if (kind(c) === WHITE) {
      j--
      continue
    }
    if (isDigit(c)) return true
    // Not a digit: perhaps the tail of a comment. Find where this line starts,
    // then the first `%` on it, and carry on from in front of that.
    let line = j - 1
    while (line > floor && text.charCodeAt(line - 1) !== 0x0a && text.charCodeAt(line - 1) !== 0x0d) line--
    let percent = line
    while (percent < j && text.charCodeAt(percent) !== 0x25) percent++
    if (percent >= j) return false
    j = percent
  }
  return false
}

/** A `%` earlier on the same line, within 256 characters. */
function commentedOut(text: string, at: number): boolean {
  for (let i = at - 1; i >= Math.max(0, at - 256); i--) {
    const c = text.charCodeAt(i)
    if (c === 0x0a || c === 0x0d) return false
    if (c === 0x25) return true
  }
  return false
}

/**
 * Open a PDF's objects. Never throws: whatever stops a stage, the doc it
 * returns is usable, and its flags and counts say what was not reached.
 *
 * `bytes` is the part of the file being read and `text` its latin1 string.
 * `media` is the message's byte budget for decoded data, charged by every decode.
 */
export async function openPdf(bytes: Uint8Array, text: string, media: { left: number }, work: Work): Promise<PdfDoc> {
  const doc = new Doc(bytes, text, media, work)
  const stage = async (run: () => void | Promise<void>): Promise<void> => {
    try {
      await run()
    } catch (error) {
      if (error instanceof WorkSpent) doc.workSpent = error.why
      else if (error instanceof ValueSpent) doc.valueSpent = true
      else doc.stats.unreadable++
    }
  }
  await stage(() => doc.index())
  await stage(() => doc.findTrailer())
  // Before any object stream is opened: whether their output must verify depends on it.
  await stage(() => doc.findEncryption())
  await stage(() => doc.readObjectStreams())
  await stage(() => doc.settle())
  // After the object streams: a catalog packed in one is the ObjStm-only lure's.
  await stage(() => doc.findRoot())
  return doc
}
