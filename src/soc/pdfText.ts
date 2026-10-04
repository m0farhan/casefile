/**
 * Page text, read from each page's content streams through its fonts.
 *
 * The lure of a PDF phish is usually the words on its page — "your invoice is
 * ready, sign in at …" — and no byte scan sees them: they sit in a compressed
 * content stream as glyph codes, and only the page's font says which character
 * each code stands for. This module follows the page tree, runs each page's
 * text operators through a small interpreter and maps every code through its
 * font. Nothing is drawn.
 *
 * What comes back is what the file CLAIMS its text is. A font can map any glyph
 * to any character, nothing is laid out (the order is the order the page writes
 * its text in), and text a reader does not show — invisible render modes, zero
 * size, hidden annotations — is kept apart rather than mixed in, because hiding
 * text from the reader is itself something a phish does. Every count in a PDF
 * is the sender's to choose, so every loop here has a bound, and every bound
 * that is reached leaves a note.
 */
import {
  asArray,
  asDict,
  asInt,
  asName,
  asNumber,
  asString,
  Broken,
  checkTime,
  type Decoded,
  GAP,
  Lexer,
  type PdfDict,
  type PdfDoc,
  type PdfOp,
  type PdfRef,
  type PdfStream,
  type PdfString,
  type PdfValue,
  stripGap,
  ValueSpent,
  type Work,
  WorkSpent
} from './pdfObjects'

/** A picture a page draws. `offset`: its stream data's offset in the file (null for an inline image). */
export interface PdfPicture {
  filter: string
  width: number | null
  height: number | null
  where: string
  offset: number | null
}
export interface PdfPage {
  /** 1-based page-tree order; null = a /Type /Page object the tree read here does not list. */
  number: number | null
  /** doc.where of the page object. */
  where: string
  /**
   * Visible. A GAP marks each place text may be missing — a piece not read, a
   * cap inside a word, a glyph not decoded — so the words touching it may be
   * only parts of words.
   */
  text: string
  /** Text a reader does not show: invisible render modes, zero size, hidden annotations. Marked the same way. */
  hidden: string
  /** `text` stopped at a cap inside a word (a GAP marks the cut), so its last word is only the first part of one. */
  textCut: boolean
  /** The same for `hidden`. */
  hiddenCut: boolean
  /** Content pieces, forms or appearances that were not found, not decoded, or stopped early. */
  unread: number
  /** Characters of `text` shown as U+FFFD. */
  undecoded: number
  /** Characters of `text` read through an assumed encoding. */
  assumed: number
  /** The same two counts for `hidden`, kept apart so each buffer's label speaks only for itself. */
  hiddenUndecoded: number
  hiddenAssumed: number
  /** At most MAX_PICTURES. */
  pictures: PdfPicture[]
}
export interface PdfTextResult {
  pages: PdfPage[]
  pageCount: number | null
  notes: string[]
  /** Annotation dict -> page number, for tree pages. */
  annotPages: Map<PdfDict, number>
}

const MiB = 2 ** 20
const MAX_PAGES = 500
/** Kid-array elements examined, over the whole tree: a shared /Kids array is examined once per node that names it. */
const MAX_TREE_ELEMENTS = 8_192
const MAX_TREE_DEPTH = 32
const MAX_PARENT_HOPS = 32
const MAX_CONTENT_PIECES = 1_024
/** Decoded bytes kept per content stream, form or appearance. */
const CONTENT_CAP = 4 * MiB
const CMAP_CAP = MiB
/** Characters kept per buffer (visible, hidden) and page. */
const PAGE_TEXT_CAP = 20_000
/** Characters kept per file over every buffer, shared out evenly once exceeded. */
const MAX_TEXT_CHARS = 60_000
const MAX_FORM_DEPTH = 8
/** Forms and annotation appearances run per file. */
const MAX_FORM_RUNS = 2_000
const MAX_FONTS = 1_024
const MAX_CMAP_ENTRIES = 65_536
const MAX_CMAP_TOTAL = 262_144
/**
 * Entries every font keeps even once the file's total is spent, so other
 * fonts' oversized maps never cost a simple font its one-byte map (a font
 * past its own cap shows unmapped codes as �, never through its encoding).
 */
const CMAP_FONT_RESERVE = 256
/**
 * Codespace ranges kept per CMap. Every code is matched against them, so their
 * number multiplies the cost of every character; real CMaps declare a handful.
 */
const MAX_CODESPACE = 64
const MAX_WIDTH_ENTRIES = 65_536
const MAX_WIDTH_TOTAL = 262_144
const MAX_OPERANDS = 1_024
/** Value units held between two operators: what bounds the memory of one 2,000,000-element TJ array. */
const LIVE_VALUES = 1_000_000
const MAX_GSTATE = 64
const MAX_ANNOTS = 256
const MAX_PICTURES = 24
/** Gaps in ems (the text's height): wider than SPACE_GAP is a space, a jump back past BACK_GAP too. */
const SPACE_GAP = 0.2
const LINE_GAP = 0.5
const BACK_GAP = 2
/** Lists of pages in notes name this many, then say how many more. */
const LISTED = 10

type Token = PdfValue | PdfOp | undefined
type Resources = Map<string, PdfValue> | undefined

function tagged(v: Token, t: string): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && v.t === t
}
const isOp = (v: Token): v is PdfOp => tagged(v, 'op')
const isDict = (v: Token): v is PdfDict => tagged(v, 'dict')
const isStream = (v: Token): v is PdfStream => tagged(v, 'stream')
const isRef = (v: Token): v is PdfRef => tagged(v, 'ref')
const isWhite = (c: number): boolean => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00
/**
 * A cut between these two characters splits a word: neither is whitespace, as
 * phish.ts tells words apart (NaN, past either end of a string, is). A cut
 * between words leaves the last word whole, and needs no GAP.
 */
const inWord = (before: number, after: number): boolean => before > 0x20 && after > 0x20
const GAP_CODE = GAP.charCodeAt(0)

/** `s` kept to its first `n` characters, with a GAP after them where that splits a word. */
function trim(s: string, n: number): string {
  const kept = s.slice(0, n)
  return inWord(s.charCodeAt(n - 1), s.charCodeAt(n)) && !kept.endsWith(GAP) ? kept + GAP : kept
}

function spend(work: Work, n: number): void {
  if ((work.left -= n) < 0) throw new WorkSpent('work')
}

// ---- glyph names ------------------------------------------------------------

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
/** The glyph names of 0x20–0x7E, in order. */
const ASCII_NAMES = [
  ...'space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at'.split(
    ' '
  ),
  ...LETTERS,
  ...'bracketleft backslash bracketright asciicircum underscore grave'.split(' '),
  ...LETTERS.toLowerCase(),
  ...'braceleft bar braceright asciitilde'.split(' ')
]
/** The glyph names of 0xA1–0xFF, in order. */
const LATIN1_NAMES =
  'exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot hyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis'.split(
    ' '
  )
/** Name, then UTF-16 code unit in hex. */
const GLYPH_EXTRAS =
  'bullet 2022 endash 2013 emdash 2014 quoteleft 2018 quoteright 2019 quotedblleft 201C quotedblright 201D quotesinglbase 201A quotedblbase 201E ellipsis 2026 dagger 2020 daggerdbl 2021 perthousand 2030 guilsinglleft 2039 guilsinglright 203A trademark 2122 Euro 20AC florin 0192 circumflex 02C6 tilde 02DC OE 0152 oe 0153 Scaron 0160 scaron 0161 Zcaron 017D zcaron 017E Ydieresis 0178 fraction 2044 dotlessi 0131 Lslash 0141 lslash 0142 breve 02D8 dotaccent 02D9 ring 02DA ogonek 02DB caron 02C7 hungarumlaut 02DD minus 2212 nbspace 00A0 sfthyphen 00AD'.split(
    ' '
  )
/** StandardEncoding above 0x7E: code in hex, then glyph name. */
const STANDARD_HIGH =
  'A1 exclamdown A2 cent A3 sterling A4 fraction A5 yen A6 florin A7 section A8 currency A9 quotesingle AA quotedblleft AB guillemotleft AC guilsinglleft AD guilsinglright AE fi AF fl B1 endash B2 dagger B3 daggerdbl B4 periodcentered B6 paragraph B7 bullet B8 quotesinglbase B9 quotedblbase BA quotedblright BB guillemotright BC ellipsis BD perthousand BF questiondown C1 grave C2 acute C3 circumflex C4 tilde C5 macron C6 breve C7 dotaccent C8 dieresis CA ring CB cedilla CD hungarumlaut CE ogonek CF caron D0 emdash E1 AE E3 ordfeminine E8 Lslash E9 Oslash EA OE EB ordmasculine F1 ae F5 dotlessi F8 lslash F9 oslash FA oe FB germandbls'.split(
    ' '
  )

/** Glyph name to text. First occurrence wins, so `hyphen` is U+002D and `grave` U+0060, as in the ASCII range. */
const GLYPHS = new Map<string, string>()
const glyph = (name: string, text: string): void => {
  if (!GLYPHS.has(name)) GLYPHS.set(name, text)
}
ASCII_NAMES.forEach((name, i) => glyph(name, String.fromCharCode(0x20 + i)))
LATIN1_NAMES.forEach((name, i) => glyph(name, String.fromCharCode(0xa1 + i)))
for (let i = 0; i < GLYPH_EXTRAS.length; i += 2) {
  glyph(GLYPH_EXTRAS[i], String.fromCharCode(parseInt(GLYPH_EXTRAS[i + 1], 16)))
}
for (const ligature of ['fi', 'fl', 'ff', 'ffi', 'ffl']) glyph(ligature, ligature)

// Glyph names are at most 127 characters (the lexer's cap), so these anchored
// patterns run on short strings only, never on file text.
const UNI_NAME = /^uni((?:[0-9A-F]{4})+)$/
const U_NAME = /^u([0-9A-F]{4,6})$/

/** `uniXXXX…` (no surrogates) or `uXXXX`–`uXXXXXX`, as the Adobe Glyph List spells a code point. */
function glyphCode(name: string): string | undefined {
  const uni = UNI_NAME.exec(name)
  if (uni) {
    let out = ''
    for (let i = 0; i < uni[1].length; i += 4) {
      const unit = parseInt(uni[1].slice(i, i + 4), 16)
      if (unit > 0xd7ff && unit < 0xe000) return undefined
      out += String.fromCharCode(unit)
    }
    return out
  }
  const u = U_NAME.exec(name)
  if (!u) return undefined
  const point = parseInt(u[1], 16)
  return point <= 0x10ffff && (point < 0xd800 || point > 0xdfff) ? String.fromCodePoint(point) : undefined
}

/** The text a glyph name stands for: known names, code-point names, then `a.sc` and `f_f_i` by their parts. */
function glyphText(name: string): string | undefined {
  const direct = GLYPHS.get(name) ?? glyphCode(name)
  if (direct !== undefined) return direct
  const dot = name.indexOf('.')
  const parts = (dot < 0 ? name : name.slice(0, dot)).split('_')
  if (dot < 0 && parts.length === 1) return undefined
  let out = ''
  for (const part of parts) {
    const text = GLYPHS.get(part) ?? glyphCode(part)
    if (text === undefined) return undefined
    out += text
  }
  return out || undefined
}

// ---- encodings --------------------------------------------------------------

type Table = (string | undefined)[]

const control = (c: number): boolean => c < 0x20 || (c >= 0x7f && c <= 0x9f)

const STANDARD_NAMES: (string | undefined)[] = []
ASCII_NAMES.forEach((name, i) => (STANDARD_NAMES[0x20 + i] = name))
STANDARD_NAMES[0x27] = 'quoteright'
STANDARD_NAMES[0x60] = 'quoteleft'
for (let i = 0; i < STANDARD_HIGH.length; i += 2) STANDARD_NAMES[parseInt(STANDARD_HIGH[i], 16)] = STANDARD_HIGH[i + 1]
const STANDARD: Table = Array.from({ length: 256 }, (_, code) => {
  const name = STANDARD_NAMES[code]
  return name === undefined ? undefined : glyphText(name)
})

/** A single-byte encoding as text per code, C0 and C1 controls left undefined; null where this engine lacks it. */
function byteTable(label: string): Table | null {
  try {
    const text = new TextDecoder(label).decode(Uint8Array.from({ length: 256 }, (_, i) => i))
    return Array.from(text, (c) => (control(c.charCodeAt(0)) ? undefined : c))
  } catch {
    return null
  }
}
const WIN_ANSI = byteTable('windows-1252')
const MAC_ROMAN = byteTable('macintosh')

/** A base encoding by name. Any other name, or one this engine cannot decode, is read as Standard and counted as assumed. */
function baseEncoding(name: string | undefined): { table: Table; assumed: boolean } {
  const table =
    name === 'WinAnsiEncoding'
      ? WIN_ANSI
      : name === 'MacRomanEncoding'
        ? MAC_ROMAN
        : name === 'StandardEncoding'
          ? STANDARD
          : null
  return table ? { table, assumed: false } : { table: STANDARD, assumed: true }
}

const STANDARD_14_LATIN = new Set([
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique'
])
const SUBSET_PREFIX = /^[A-Z]{6}\+/
/** Predefined CMaps whose codes ARE the UCS-2 / UTF-16 code units. */
const UCS2_CMAP = /^Uni.*-(UCS2|UTF16)-[HV]$/

// ---- fonts ------------------------------------------------------------------

/** A codespace range: same-length byte strings, compared byte by byte. */
interface Range {
  lo: number[]
  hi: number[]
}
interface CMap {
  map: Map<number, string>
  ranges: Range[]
  /** Mappings past the caps were dropped, so a code missing from `map` may still be one the file maps. */
  capped: boolean
}

interface Font {
  /** Bytes per code, or 0 to match each code against `ranges`. */
  bytes: number
  ranges: Range[]
  /** What a code that matches no range takes: the shortest range, at least 1. */
  shortest: number
  unicode: Map<number, string> | null
  /** Its /ToUnicode map was not kept whole: a code it lacks is not decoded (see emit). */
  capped: boolean
  /** Simple fonts: text per code; undefined where the code has none this reader can use. */
  table: Table | null
  /** Simple fonts: 1 where the table's text comes from an encoding assumed rather than declared. */
  assumed: Uint8Array | null
  /** A Type0 font whose CMap's codes are UCS-2 / UTF-16 code units. */
  ucs2: boolean
  /** Advance of a code in glyph units, multiplied by `scale` for text space. */
  width: (code: number) => number
  scale: number
}

/** A font that is missing or past MAX_FONTS: 1-byte codes, none of them decoded. */
const NO_FONT: Font = {
  bytes: 1,
  ranges: [],
  shortest: 1,
  unicode: null,
  capped: false,
  table: null,
  assumed: null,
  ucs2: false,
  width: () => 500,
  scale: 0.001
}

/**
 * The bytes the code at `i` takes. The ranges are sorted shortest first, so the
 * first match is the shortest length that fits, and one code examines each range
 * at most once: what show() charges it.
 */
function codeLength(font: Font, s: string, i: number): number {
  if (font.bytes) return font.bytes
  for (const r of font.ranges) {
    const n = r.lo.length
    let k = 0
    while (k < n && i + k < s.length && s.charCodeAt(i + k) >= r.lo[k] && s.charCodeAt(i + k) <= r.hi[k]) k++
    if (k === n) return n
  }
  return font.shortest
}

/** Bytes as a big-endian code, for strings of 1–4 bytes. */
function codeOf(s: string | undefined): number | undefined {
  if (s === undefined || s.length < 1 || s.length > 4) return undefined
  let code = 0
  for (let i = 0; i < s.length; i++) code = code * 256 + s.charCodeAt(i)
  return code
}

const byteList = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0))

/** A /ToUnicode destination as UTF-16 code units (an odd byte count read as latin1), at most 64. */
function units(s: string): number[] {
  const out: number[] = []
  const odd = s.length % 2 === 1
  for (let i = 0; i < s.length && out.length < 64; i += odd ? 1 : 2) {
    out.push(odd ? s.charCodeAt(i) : (s.charCodeAt(i) << 8) | s.charCodeAt(i + 1))
  }
  return out
}

/**
 * Ligatures (U+FB00–FB06) and Kangxi radicals (U+2F00–2FD5) as the letters and
 * ideographs they draw, as glyph names already read here and as PDFKit and
 * pdf.js read them. Quartz writes fi as MacRoman 0xDE, and as U+FB01 the
 * indicator scan stops there and lists "delity.example.com". NFKC maps no other
 * radical: the CJK Radicals Supplement (U+2E80–2EFF) stays as drawn, all but
 * U+2E9F and U+2EF3. Only these characters are folded, never the page, so
 * fullwidth or lookalike text a reader shows stays as drawn.
 * ponytail: NFKC is the whole table; the Supplement would take Unicode's
 * EquivalentUnifiedIdeograph data, about 115 entries, if those radicals matter.
 */
const COMPAT = /[\ufb00-\ufb06\u2e80-\u2fdf]/g
/** Those folded, and a GAP a font maps a code to made U+FFFD: only this reader marks a gap. */
const letters = (s: string): string => stripGap(s.replace(COMPAT, (c) => c.normalize('NFKC')))

const CMAP_SECTIONS = new Set(['begincodespacerange', 'beginbfchar', 'beginbfrange'])

// ---- the page interpreter ---------------------------------------------------

/** One of a page's two text buffers, and where its last text ended, for the gap arithmetic. */
class Sink {
  s = ''
  lastEndX = 0
  lastEndY = 0
  lastH = 1
  /**
   * The next text starts a new line. 'form': a line break a page-level form's
   * edge puts in, not one its position calls for (see separate).
   */
  breakNext: boolean | 'form' = false
  /** Something since its last text was not read, so the next word starts from a GAP (see Painter.skip). */
  gap = false
  /** It ends in a U+FFFD this reader wrote for a code it could not decode (see Painter.write). */
  unknown = false
  /** The cap it stopped at; 0 while it has room. */
  stopped = 0
}

/** A character phish.ts counts as part of a word, as its gap rule does. */
const WORD = /\S/

/** A GAP at the buffer's end, unless it ends in one: one mark per place. */
function mark(sink: Sink): void {
  if (sink.s.charCodeAt(sink.s.length - 1) !== GAP_CODE) sink.s += GAP
}

const IDENTITY = [1, 0, 0, 1, 0, 0]

/**
 * What q and Q save. The text matrices are not in it: BT resets them. `ctm` is
 * replaced, never changed in place, so a shallow copy saves it.
 */
interface TextState {
  font: Font
  size: number
  tc: number
  tw: number
  th: number
  tl: number
  tr: number
  ctm: number[]
}
const freshState = (): TextState => ({ font: NO_FONT, size: 0, tc: 0, tw: 0, th: 1, tl: 0, tr: 0, ctm: IDENTITY })

/** The matrix product a × b, both as PDF's [a b c d e f]: apply a, then b. */
function mul(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5]
  ]
}

/** A page to read, and its resources: null when they come from its /Parent chain rather than a tree walk. */
interface Target {
  dict: PdfDict
  num: number | null
  resources: Resources | null
  number: number | null
}

function firstFilter(v: PdfValue | undefined, doc: PdfDoc): string {
  const name = asName(doc.resolve(Array.isArray(v) ? v[0] : v))
  return name === undefined ? '(none)' : `/${name}`
}

/**
 * One page's text operators, run in content-stream order.
 *
 * Only what moves the text matrix, the CTM (`cm`) or picks a font is
 * interpreted. Positions are taken on the page, through the CTM — WebKit, AppKit
 * and CoreText place every run with `cm` and draw it at Tm 0 0 — and compared
 * only to tell a space or a line break, never to lay text out.
 *
 * ponytail: a form's /Matrix is not applied. Its text is set off by line breaks
 * anyway and a uniform scale changes no gap, but a /Matrix that shrinks it to
 * nothing still reads as visible. Upgrade: multiply it into `ctm` in form().
 */
class Painter {
  readonly visible = new Sink()
  readonly hidden = new Sink()
  private st = freshState()
  private tm = [...IDENTITY]
  private tlm = [...IDENTITY]
  private gstack: TextState[] = []
  /** Saves past MAX_GSTATE, not kept: the Q matching one restores nothing. */
  private dropped = 0
  /** A save was not kept, so no state after it is trusted: text it would hide is kept visible (see show). */
  private stateLost = false
  private operands: PdfValue[] = []
  private readonly running = new Set<PdfStream>()
  private hiddenAnnot = false
  /** Where the string show() is reading starts, until it draws its first character (see write). */
  private lead: { on: number[]; h: number } | undefined

  constructor(
    private readonly r: Reader,
    private readonly page: PdfPage
  ) {}

  async paint(t: Target): Promise<void> {
    const doc = this.r.doc
    const resources = t.resources === null ? this.r.inherited(t.dict) : t.resources
    checkTime(doc.work)
    const raw = t.dict.v.get('Contents')
    const contents = doc.resolve(raw)
    const pieces = Array.isArray(contents) ? contents : raw === undefined ? [] : [raw]
    if (pieces.length > MAX_CONTENT_PIECES) this.r.contentCapped.add(this.page)
    // One interpreter over every piece in turn: the spec splits /Contents only
    // at token boundaries, so an operator's operands can sit in the piece before.
    // Joining the pieces into one string instead would let a hundred thousand
    // references to one stream build a string of all of them.
    for (const piece of pieces.slice(0, MAX_CONTENT_PIECES)) {
      checkTime(doc.work)
      const s = doc.resolve(piece)
      if (!isStream(s)) {
        this.r.missing++
        this.skip()
        continue
      }
      const d = await doc.decode(s, CONTENT_CAP, 'text')
      if (d) await this.run(d, resources, 0)
      else this.skip()
    }
    // What the pieces past the cap draw is missing after the last one run.
    if (pieces.length > MAX_CONTENT_PIECES) this.skip()
    await this.annotations(t, resources)
  }

  private async annotations(t: Target, resources: Resources): Promise<void> {
    const doc = this.r.doc
    const annots = asArray(doc.resolve(t.dict.v.get('Annots'))) ?? []
    if (annots.length > MAX_ANNOTS) this.r.annotsCapped.add(this.page)
    for (const raw of annots.slice(0, MAX_ANNOTS)) {
      const a = doc.resolve(raw)
      if (!isDict(a)) continue
      if (this.page.number !== null) this.r.annotPages.set(a, this.page.number)
      const normal = doc.resolve(asDict(doc.resolve(a.v.get('AP')))?.get('N'))
      const state = asName(doc.resolve(a.v.get('AS')))
      const ap = isStream(normal) ? normal : state === undefined ? undefined : doc.resolve(asDict(normal)?.get(state))
      if (!isStream(ap)) continue
      // Hidden (2) and NoView (32): a reader does not draw it.
      const flags = asInt(doc.resolve(a.v.get('F'))) ?? 0
      // An appearance is drawn on its own: no word from the page, or from
      // another appearance, goes on into it, whatever was not read before it.
      this.visible.gap = this.hidden.gap = false
      await this.form(ap, resources, 0, (flags & 34) !== 0)
    }
  }

  /**
   * A form XObject, or an annotation appearance when `hiddenAnnot` is given. An
   * appearance is drawn on its own, so it starts from the default text state; a
   * form inherits the state it is drawn in. Either way that state comes back
   * unchanged, and its text is set off by a line break on both sides — in each
   * buffer it writes to, marked where a form's goes straight on from the page's
   * (see separate). One it writes nothing to is left as it was, so
   * `(…microsoftonline.co) Tj ET /Empty Do BT … (m.evil-split.com/owa) Tj` is
   * one address, as a reader draws it.
   */
  private async form(s: PdfStream, resources: Resources, depth: number, hiddenAnnot?: boolean): Promise<void> {
    const r = this.r
    // Every run, not only the first: decode is cached, so a form drawn 1,999
    // times from one piece reaches decode's own check once.
    checkTime(r.doc.work)
    const capped = depth >= MAX_FORM_DEPTH || this.running.has(s) || r.formRuns >= MAX_FORM_RUNS
    if (capped) r.formsSkipped++
    else r.formRuns++
    const d = capped ? null : await r.doc.decode(s, CONTENT_CAP, 'text')
    if (!d) {
      // Its text would be on lines of its own, so it cut no word before it. An
      // appearance's cut none after it either: nothing but another appearance,
      // on its own lines, follows it.
      if (hiddenAnnot === undefined) this.skip(true)
      else this.page.unread++
      return
    }
    const sinks = [this.visible, this.hidden]
    const before = sinks.map((sink) => ({ length: sink.s.length, breakNext: sink.breakNext }))
    const saved = {
      st: this.st,
      tm: this.tm,
      tlm: this.tlm,
      gstack: this.gstack,
      dropped: this.dropped,
      operands: this.operands,
      hiddenAnnot: this.hiddenAnnot
    }
    this.st = hiddenAnnot === undefined ? { ...this.st } : freshState()
    this.tm = [...this.tm]
    this.tlm = [...this.tlm]
    this.gstack = []
    this.dropped = 0
    this.operands = []
    if (hiddenAnnot !== undefined) this.hiddenAnnot = hiddenAnnot
    this.running.add(s)
    // An appearance's text is on lines of its own; a form's may go straight on (see separate).
    const edge = hiddenAnnot === undefined ? 'form' : true
    for (const sink of sinks) sink.breakNext = edge
    try {
      await this.run(d, asDict(r.doc.resolve(s.dict.v.get('Resources'))) ?? resources, depth + 1)
    } finally {
      this.running.delete(s)
      ;({
        st: this.st,
        tm: this.tm,
        tlm: this.tlm,
        gstack: this.gstack,
        dropped: this.dropped,
        operands: this.operands
      } = saved)
      this.hiddenAnnot = saved.hiddenAnnot
      sinks.forEach((sink, i) => {
        if (sink.s.length === before[i].length) sink.breakNext = before[i].breakNext
      })
    }
    // Not after an error: the page stops where it fell, and read() marks the gap there.
    sinks.forEach((sink, i) => {
      if (sink.s.length > before[i].length) sink.breakNext = edge
    })
  }

  /** One piece of content. A value that cannot be parsed stops this piece, not the page. */
  private async run(d: Decoded, resources: Resources, depth: number): Promise<void> {
    const text = d.text
    // Live values are reset at every operand clear, so this bounds what one
    // stretch between two operators can hold, not the stream.
    const values: Work = { left: LIVE_VALUES }
    const lx = new Lexer(text, 0, text.length, { work: this.r.doc.work, values })
    try {
      for (let t = lx.read(); t !== undefined; t = lx.read()) {
        if (!isOp(t)) {
          if (this.operands.length >= MAX_OPERANDS) this.clear(values)
          this.operands.push(t)
          continue
        }
        if (t.v === 'BI') {
          if (!this.inlineImage(lx, text)) break
        } else {
          // Only a font load or a form returns a promise; every other operator
          // stays synchronous, so a stream of millions of them does not pay a
          // microtask each.
          const pending = this.op(t.v, resources, depth)
          if (pending) await pending
        }
        this.clear(values)
      }
    } catch (error) {
      // A spent budget, or an error no rule here expected, stops the page
      // wherever it falls, and read() marks the gap there.
      if (!(error instanceof Broken) && !(error instanceof ValueSpent)) throw error
      this.r.brokenPieces++
      this.skip()
    }
    // Not when only /Length was unconfirmed and the data ended at `endstream`:
    // nothing is missing there, for any reader.
    if (d.endLost) this.skip()
  }

  /**
   * Something the page draws was not read here: a piece or form not found, not
   * decoded or skipped, the rest of one after a value that stops it or an
   * error, or what its decode lost at the end. So each buffer's last word may
   * be only the first part of one — `https://login.microsoftonline.co`, where
   * the file goes on `m.evil-split.test/owa` — and the next text may finish a
   * word the missing part began. Both are kept and marked: a GAP right after the
   * last word, and the next word starts from one — the same mark where it goes
   * straight on, a new one after the space or break its position calls for —
   * so phish.ts leaves them out of the indicators. No GAP after a word a form's
   * line break closed, or before a `form` not run (its text would start on a
   * new line here), but the next text still starts from one; none in a buffer
   * the cap stopped, whose cut put() marked.
   */
  skip(form = false): void {
    this.page.unread++
    for (const sink of [this.visible, this.hidden]) {
      if (sink.stopped) continue
      if (!form && !sink.breakNext && sink.s.charCodeAt(sink.s.length - 1) > 0x20) mark(sink)
      sink.gap = true
    }
  }

  private clear(values: Work): void {
    this.operands.length = 0
    values.left = LIVE_VALUES
  }

  private op(name: string, resources: Resources, depth: number): Promise<void> | undefined {
    const ops = this.operands
    /** The k-th operand from the end, as a number. */
    const num = (k: number): number | undefined => asNumber(ops[ops.length - k])
    const last = ops[ops.length - 1]
    const st = this.st
    switch (name) {
      case 'BT':
        this.tm = [...IDENTITY]
        this.tlm = [...IDENTITY]
        break
      case 'Td':
        this.move(num(2), num(1))
        break
      case 'TD': {
        const ty = num(1)
        if (ty !== undefined) st.tl = -ty
        this.move(num(2), ty)
        break
      }
      case 'T*':
        this.move(0, -st.tl)
        break
      case 'Tm': {
        const m = [6, 5, 4, 3, 2, 1].map(num)
        if (m.every((v) => v !== undefined)) {
          this.tm = m
          this.tlm = [...this.tm]
        }
        break
      }
      case 'Tc':
        st.tc = num(1) ?? st.tc
        break
      case 'Tw':
        st.tw = num(1) ?? st.tw
        break
      case 'Tz': {
        const z = num(1)
        if (z !== undefined) st.th = z / 100
        break
      }
      case 'TL':
        st.tl = num(1) ?? st.tl
        break
      case 'Tr':
        st.tr = num(1) ?? st.tr
        break
      case 'Tf': {
        st.size = num(1) ?? st.size
        const font = asName(ops[ops.length - 2])
        return font === undefined ? undefined : this.setFont(font, resources)
      }
      case 'Tj':
        this.showString(last)
        break
      case "'":
        this.move(0, -st.tl)
        this.showString(last)
        break
      case '"':
        st.tw = num(3) ?? st.tw
        st.tc = num(2) ?? st.tc
        this.move(0, -st.tl)
        this.showString(last)
        break
      case 'TJ':
        this.showArray(asArray(last))
        break
      case 'cm': {
        const m = [6, 5, 4, 3, 2, 1].map(num)
        if (m.every((v) => v !== undefined)) st.ctm = mul(m, st.ctm)
        break
      }
      case 'q':
        if (this.gstack.length < MAX_GSTATE) this.gstack.push({ ...st })
        else {
          this.dropped++
          if (!this.stateLost) {
            this.stateLost = true
            this.page.unread++
            this.r.stateCapped.add(this.page)
          }
        }
        break
      case 'Q':
        if (this.dropped) this.dropped--
        else this.st = this.gstack.pop() ?? st
        break
      case 'Do':
        return this.draw(last, resources, depth)
      default:
    }
    return undefined
  }

  private move(tx: number | undefined, ty: number | undefined): void {
    if (tx === undefined || ty === undefined) return
    const m = this.tlm
    this.tlm = [m[0], m[1], m[2], m[3], m[4] + tx * m[0] + ty * m[2], m[5] + tx * m[1] + ty * m[3]]
    this.tm = [...this.tlm]
  }

  private setFont(name: string, resources: Resources): Promise<void> | undefined {
    const doc = this.r.doc
    const dict = doc.resolve(asDict(doc.resolve(resources?.get('Font')))?.get(name))
    if (!isDict(dict)) {
      this.r.missing++
      this.st.font = NO_FONT
      return undefined
    }
    const cached = this.r.fonts.get(dict)
    if (cached) {
      this.st.font = cached
      return undefined
    }
    return this.loadFont(dict)
  }

  private async loadFont(dict: PdfDict): Promise<void> {
    const st = this.st
    st.font = await this.r.font(dict)
  }

  private draw(nameValue: PdfValue | undefined, resources: Resources, depth: number): Promise<void> | undefined {
    const doc = this.r.doc
    const name = asName(nameValue)
    if (name === undefined) return undefined
    const xobjects = asDict(doc.resolve(resources?.get('XObject')))
    const raw = xobjects?.get(name)
    const xo = doc.resolve(raw)
    if (!isStream(xo)) {
      this.r.missing++
      // A name a /XObject dict that was read does not hold draws nothing, in any
      // reader; nor does any name, where /Resources were read and have no /XObject.
      if (raw !== undefined || resources === undefined || (resources.has('XObject') && !xobjects)) this.skip(true)
      return undefined
    }
    const dict = xo.dict.v
    const subtype = asName(doc.resolve(dict.get('Subtype')))
    if (subtype === 'Form') return this.form(xo, resources, depth)
    if (subtype === 'Image') {
      this.picture({
        filter: firstFilter(doc.resolve(dict.get('Filter')), doc),
        width: asInt(doc.resolve(dict.get('Width'))) ?? null,
        height: asInt(doc.resolve(dict.get('Height'))) ?? null,
        where: isRef(raw) ? doc.where(raw.num) : '',
        offset: xo.start
      })
    }
    return undefined
  }

  private picture(p: PdfPicture): void {
    if (this.page.pictures.length < MAX_PICTURES) this.page.pictures.push(p)
    else this.r.picturesCapped.add(this.page)
  }

  /** `BI … ID data EI`. False when the data has no end this reader can find: the rest of the piece is unread. */
  private inlineImage(lx: Lexer, text: string): boolean {
    const doc = this.r.doc
    const dict = new Map<string, PdfValue>()
    for (;;) {
      const key = lx.read()
      if (key === undefined) return this.unclosed()
      if (isOp(key)) {
        if (key.v === 'ID') break
        continue
      }
      const k = asName(key)
      if (k === undefined) continue
      const v = lx.read()
      if (v === undefined) return this.unclosed()
      if (isOp(v)) {
        if (v.v === 'ID') break
        continue
      }
      dict.set(k, v)
    }
    let at = lx.pos
    if (isWhite(text.charCodeAt(at))) at++
    this.picture({
      filter: firstFilter(dict.get('F') ?? dict.get('Filter'), doc),
      width: asInt(dict.get('W') ?? dict.get('Width')) ?? null,
      height: asInt(dict.get('H') ?? dict.get('Height')) ?? null,
      where: 'inline image',
      offset: null
    })
    // A declared length counts only where it lands on `EI`: one too short would
    // read image data as drawing instructions.
    const n = asInt(dict.get('L') ?? dict.get('Length'))
    let end = -1
    if (n !== undefined) {
      end = at + n
      while (isWhite(text.charCodeAt(end))) end++
      spend(doc.work, end - at - n)
      if (!text.startsWith('EI', end) || (end + 2 < text.length && !isWhite(text.charCodeAt(end + 2)))) end = -1
    }
    // The data ends at the first `EI` between whitespace, as pdf.js and PDFKit
    // find it, or at the declared one where that comes first (`\x80EI`): one
    // that lands on a later image's EI would skip the text a reader draws
    // between them. Its `EI` stops the search, so it scans no further.
    // ponytail: binary data holding ` EI ` ends early there, as in pdf.js.
    // Upgrade: work the length out from /W, /H, /BPC and the colour space.
    for (let from = at; ;) {
      const j = text.indexOf('EI', from)
      spend(doc.work, (j < 0 ? text.length : j + 2) - from)
      if (j < 0) return this.unclosed()
      if (j === end || (isWhite(text.charCodeAt(j - 1)) && (j + 2 >= text.length || isWhite(text.charCodeAt(j + 2))))) {
        lx.pos = j + 2
        return true
      }
      from = j + 1
    }
  }

  private unclosed(): false {
    this.r.inlineUnclosed++
    this.skip()
    return false
  }

  private showString(v: PdfValue | undefined): void {
    const s = asString(v)
    if (s === undefined) return
    this.show(s)
    // The lexer kept its first MiB: what the string draws past that is unread here.
    if ((v as PdfString).cut) {
      this.r.stringsCut++
      this.skip()
    }
  }

  private showArray(items: PdfValue[] | undefined): void {
    for (const item of items ?? []) {
      if (typeof item !== 'number') {
        this.showString(item)
        continue
      }
      const k = (-item / 1000) * this.st.size * this.st.th
      this.tm[4] += k * this.tm[0]
      this.tm[5] += k * this.tm[1]
    }
  }

  private show(bytes: string): void {
    const st = this.st
    const tm = this.tm
    // On the page, through the CTM. Glyph advances stay in text space; only the
    // ends of a run are mapped.
    const on = mul(tm, st.ctm)
    const h = Math.abs(st.size) * Math.hypot(on[2], on[3])
    // Once a saved state is lost, a mode or size it may have restored is not trusted to hide text.
    const unseen = (st.tr === 3 || st.tr === 7 || h === 0) && !this.stateLost
    const sink = unseen || this.hiddenAnnot ? this.hidden : this.visible
    const hEff = h || 1
    // The space or break before the string goes in with its first character,
    // so one that draws none — `() Tj`, or codes a font maps to no text —
    // changes nothing: it splits no word and uses up no gap.
    this.lead = { on, h: hEff }
    const font = st.font
    const work = this.r.doc.work
    // Matching a code examines up to every codespace range, so that is what it
    // costs: charged 1, 64 ranges would make each step 20 times slower than the
    // budget assumes, and the budget would no longer bound the time.
    const cost = font.bytes ? 1 : 1 + font.ranges.length
    for (let i = 0; i < bytes.length;) {
      const n = Math.min(codeLength(font, bytes, i), bytes.length - i)
      let code = 0
      for (let k = 0; k < n; k++) code = code * 256 + bytes.charCodeAt(i + k)
      i += n
      spend(work, cost)
      // Past the cap the text is dropped, but the codes still move the matrix,
      // or the other buffer's spacing would drift.
      if (!sink.stopped) this.emit(sink, font, code)
      const tx = (font.width(code) * font.scale * st.size + st.tc + (n === 1 && code === 32 ? st.tw : 0)) * st.th
      tm[4] += tx * tm[0]
      tm[5] += tx * tm[1]
    }
    if (this.lead) {
      this.lead = undefined
      return
    }
    const end = mul(tm, st.ctm)
    sink.lastEndX = end[4]
    sink.lastEndY = end[5]
    sink.lastH = hEff
  }

  private emit(sink: Sink, font: Font, code: number): void {
    const page = this.page
    const hidden = sink === this.hidden
    const mapped = font.unicode?.get(code)
    if (mapped !== undefined) {
      this.write(sink, letters(mapped))
      return
    }
    // Not past a map cut short: the part not kept may map the code, and the
    // encoding is no stand-in for what the file's map says.
    const fromTable = font.capped ? undefined : font.table?.[code]
    if (fromTable !== undefined) {
      if (this.write(sink, letters(fromTable)) && font.assumed?.[code]) {
        if (hidden) page.hiddenAssumed++
        else page.assumed++
      }
      return
    }
    if (font.ucs2 && !font.capped) {
      this.write(sink, letters(String.fromCharCode(code)))
      return
    }
    if (this.write(sink, '�', true)) {
      if (hidden) page.hiddenUndecoded++
      else page.undecoded++
    }
  }

  /**
   * A code's text. The first a string draws brings the space or break before
   * it, and a GAP goes in where one is due:
   * - before the first word after a gap. Spaces alone close no word there: what
   *   was not read may be drawn anywhere.
   * - on both sides of a run of U+FFFD this reader writes for codes it could
   *   not decode (`unknown`), where a word touches it. That is the reader's own
   *   loss — `secure.paypal.co�.verify-acct.net` would list a host the file
   *   never names — unlike a U+FFFD the file maps, which is its own claim.
   */
  private write(sink: Sink, text: string, unknown = false): boolean {
    if (!text || sink.stopped) return false
    if (this.lead) {
      this.separate(sink, this.lead.on, this.lead.h)
      this.lead = undefined
      // A cap that stopped it there cut between words: nothing to mark.
      if (sink.stopped) return false
    }
    if (unknown) {
      if (sink.gap || (!sink.unknown && sink.s.charCodeAt(sink.s.length - 1) > 0x20)) mark(sink)
      sink.gap = false
      const kept = this.put(sink, text)
      sink.unknown = true
      return kept
    }
    if (sink.unknown && WORD.test(text.charAt(0))) mark(sink)
    if (!sink.gap) return this.put(sink, text)
    const at = text.search(WORD)
    if (at < 0) return this.put(sink, text)
    if (at > 0 && !this.put(sink, text.slice(0, at))) return false
    mark(sink)
    sink.gap = false
    return this.put(sink, text.slice(at))
  }

  /** The space or line break between the sink's last text and a string drawn at `on`, `h` high, if any. */
  private separate(sink: Sink, on: number[], h: number): void {
    if (sink.s.length) {
      // Along the run's own direction and across it, so text the CTM or Tm
      // turns is spaced as if it were drawn upright.
      const len = Math.hypot(on[0], on[1]) || 1
      const dx = on[4] - sink.lastEndX
      const dy = on[5] - sink.lastEndY
      const along = (dx * on[0] + dy * on[1]) / len
      const across = (dy * on[0] - dx * on[1]) / len
      const newLine = Math.abs(across) > LINE_GAP * Math.max(h, sink.lastH)
      const space = along > SPACE_GAP * h || along < -BACK_GAP * h
      const lastWord = sink.s.charCodeAt(sink.s.length - 1) > 0x20
      if (sink.breakNext || newLine) {
        // A form's edge is not the page's line break: where its text goes
        // straight on from the page's, or the page's from its, a reader may
        // draw one word, so both sides are marked.
        if (sink.breakNext === 'form' && !newLine && !space && lastWord) {
          mark(sink)
          sink.gap = true
        }
        this.put(sink, '\n')
      } else if (space && lastWord) this.put(sink, ' ')
    }
    sink.breakNext = false
  }

  /** False when the sink is full; from then on its text is dropped, and a cut inside a word is marked. */
  private put(sink: Sink, text: string): boolean {
    if (sink.stopped) return false
    sink.unknown = false
    const cap = Math.min(PAGE_TEXT_CAP, this.r.share)
    if (sink.s.length + text.length <= cap) {
      sink.s += text
      return true
    }
    const room = Math.max(0, cap - sink.s.length)
    sink.s += text.slice(0, room)
    sink.stopped = cap
    if (inWord(sink.s.charCodeAt(sink.s.length - 1), text.charCodeAt(room))) {
      // Past the cap: a GAP is a mark, not text.
      mark(sink)
      if (sink === this.hidden) this.page.hiddenCut = true
      else this.page.textCut = true
    }
    return false
  }
}

/** Split into lines, trim each line's end, keep at most one blank line in a row, trim both ends. */
function tidy(s: string): string {
  return s
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A character that is neither U+FFFD, a GAP (U+E000) nor whitespace: text this reader could decode. */
const DECODED = /[^\s�\ue000]/
/**
 * Right-to-left script: Hebrew through Arabic Extended-A, and their presentation
 * forms. ponytail: noted, not reordered — that takes the bidi algorithm, and
 * reversing runs alone leaves the word order wrong.
 */
const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/

function pageList(pages: Iterable<PdfPage>): string {
  const labels = [...pages].map((p) => (p.number === null ? p.where : String(p.number)))
  const shown = labels.slice(0, LISTED).join(', ')
  return labels.length > LISTED ? `${shown} and ${labels.length - LISTED} more` : shown
}

// ---- the file ---------------------------------------------------------------

/** What one file's page read shares across pages: fonts, CMaps, budgets, and the counts behind the notes. */
class Reader {
  readonly pages: PdfPage[] = []
  readonly annotPages = new Map<PdfDict, number>()
  readonly fonts = new Map<PdfDict, Font>()
  private readonly cmaps = new Map<PdfStream, CMap | null>()
  /** The per-buffer cap: PAGE_TEXT_CAP until the file's text outgrows MAX_TEXT_CHARS, then the fair share. */
  share = PAGE_TEXT_CAP
  formRuns = 0
  pageCount: number | null = null
  private cmapLeft = MAX_CMAP_TOTAL
  private widthLeft = MAX_WIDTH_TOTAL
  private targets = 0
  private orphans = 0
  private fallback = false
  private treeCapped = false
  private textCapped = false
  fontsCapped = 0
  missing = 0
  cmapDropped = 0
  widthsDropped = 0
  formsSkipped = 0
  inlineUnclosed = 0
  brokenPieces = 0
  stringsCut = 0
  readonly contentCapped = new Set<PdfPage>()
  readonly stateCapped = new Set<PdfPage>()
  readonly annotsCapped = new Set<PdfPage>()
  readonly picturesCapped = new Set<PdfPage>()
  private readonly pageCut = new Set<PdfPage>()

  constructor(readonly doc: PdfDoc) {}

  async read(): Promise<void> {
    const targets = this.collect()
    for (const t of targets.slice(0, MAX_PAGES)) {
      const page: PdfPage = {
        number: t.number,
        where: t.num === null ? '' : this.doc.where(t.num),
        text: '',
        hidden: '',
        textCut: false,
        hiddenCut: false,
        unread: 0,
        undecoded: 0,
        assumed: 0,
        hiddenUndecoded: 0,
        hiddenAssumed: 0,
        pictures: []
      }
      this.pages.push(page)
      const painter = new Painter(this, page)
      let stop = false
      try {
        await painter.paint(t)
      } catch (error) {
        // What was read before the stop is kept, and marked where it stops.
        // Anything but a spent budget is a structure no rule above expected; it
        // costs this page only.
        painter.skip()
        if (error instanceof WorkSpent) {
          this.doc.workSpent = error.why
          stop = true
        }
      }
      page.text = tidy(painter.visible.s)
      page.hidden = tidy(painter.hidden.s)
      if (painter.visible.stopped === PAGE_TEXT_CAP || painter.hidden.stopped === PAGE_TEXT_CAP) this.pageCut.add(page)
      this.fairShare()
      if (stop) break
    }
  }

  /** Tree pages in tree order, then page objects the tree does not reach; or every page object, when there is no tree. */
  private collect(): Target[] {
    const doc = this.doc
    const rawTop = doc.root?.v.get('Pages')
    const top = doc.resolve(rawTop)
    const found: Target[] = []
    const visited = new Set<PdfDict>()
    if (isDict(top)) {
      this.pageCount = asInt(doc.resolve(top.v.get('Count'))) ?? null
      try {
        this.walk(top, isRef(rawTop) ? rawTop.num : null, found, visited)
      } catch (error) {
        if (!(error instanceof WorkSpent)) throw error
        doc.workSpent = error.why
      }
    }
    const byPosition: { pos: number; target: Target }[] = []
    for (const [num, obj] of doc.objects) {
      const v = obj.value
      if (!isDict(v) || visited.has(v) || asName(doc.resolve(v.v.get('Type'))) !== 'Page') continue
      byPosition.push({ pos: obj.pos, target: { dict: v, num, resources: null, number: null } })
    }
    const loose = byPosition.sort((a, b) => a.pos - b.pos).map((p) => p.target)
    let targets: Target[]
    if (found.length) {
      found.forEach((t, k) => (t.number = k + 1))
      this.orphans = loose.length
      targets = [...found, ...loose]
    } else {
      this.fallback = loose.length > 0
      loose.forEach((t, k) => (t.number = k + 1))
      targets = loose
    }
    this.targets = targets.length
    return targets
  }

  /**
   * Depth first, children taken one element at a time: kid arrays can be shared
   * between nodes and millions long, so nothing is copied, and every element
   * examined counts toward one cap for the whole tree.
   */
  private walk(top: PdfDict, num: number | null, out: Target[], visited: Set<PdfDict>): void {
    const doc = this.doc
    const stack: { kids: PdfValue[]; index: number; num: number | null; resources: Resources; depth: number }[] = []
    const visit = (node: PdfDict, n: number | null, inherited: Resources, depth: number): void => {
      visited.add(node)
      const resources = asDict(doc.resolve(node.v.get('Resources'))) ?? inherited
      const kids = asArray(doc.resolve(node.v.get('Kids')))
      if (!kids) out.push({ dict: node, num: n, resources, number: null })
      else if (depth >= MAX_TREE_DEPTH) this.treeCapped = true
      else stack.push({ kids, index: 0, num: n, resources, depth })
    }
    visit(top, num, undefined, 0)
    let examined = 0
    while (stack.length) {
      const frame = stack[stack.length - 1]
      if (frame.index >= frame.kids.length) {
        stack.pop()
        continue
      }
      if (examined >= MAX_TREE_ELEMENTS) {
        this.treeCapped = true
        return
      }
      examined++
      spend(doc.work, 1)
      const raw = frame.kids[frame.index++]
      const kid = doc.resolve(raw)
      if (isDict(kid) && !visited.has(kid)) {
        visit(kid, isRef(raw) ? raw.num : frame.num, frame.resources, frame.depth + 1)
      }
    }
  }

  /** A page's own /Resources, or the nearest one up its /Parent chain. */
  inherited(page: PdfDict): Resources {
    const seen = new Set<PdfDict>()
    let node: PdfValue | undefined = page
    for (let hops = 0; hops <= MAX_PARENT_HOPS && isDict(node) && !seen.has(node); hops++) {
      seen.add(node)
      const resources = asDict(this.doc.resolve(node.v.get('Resources')))
      if (resources) return resources
      node = this.doc.resolve(node.v.get('Parent'))
    }
    return undefined
  }

  /**
   * Once the text kept passes MAX_TEXT_CHARS, every buffer is trimmed to the
   * largest share q that fits, and later buffers are read up to q. The result
   * equals trimming at the end, but memory stays bounded — and three pages of
   * filler cannot push the fourth page's lure out of the file's text.
   */
  private fairShare(): void {
    let total = 0
    let longest = 0
    for (const p of this.pages) {
      total += p.text.length + p.hidden.length
      longest = Math.max(longest, p.text.length, p.hidden.length)
    }
    if (total <= MAX_TEXT_CHARS) return
    const kept = (q: number): number => {
      let n = 0
      for (const p of this.pages) n += Math.min(p.text.length, q) + Math.min(p.hidden.length, q)
      return n
    }
    let lo = 0
    let hi = longest
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (kept(mid) <= MAX_TEXT_CHARS) lo = mid
      else hi = mid - 1
    }
    // Set, not added to: what a buffer ends in is now this cut, whatever an
    // earlier one split.
    for (const p of this.pages) {
      if (p.text.length > lo) {
        p.textCut = inWord(p.text.charCodeAt(lo - 1), p.text.charCodeAt(lo))
        p.text = trim(p.text, lo)
      }
      if (p.hidden.length > lo) {
        p.hiddenCut = inWord(p.hidden.charCodeAt(lo - 1), p.hidden.charCodeAt(lo))
        p.hidden = trim(p.hidden, lo)
      }
    }
    this.share = Math.min(this.share, lo)
    this.textCapped = true
  }

  async font(dict: PdfDict): Promise<Font> {
    const cached = this.fonts.get(dict)
    if (cached) return cached
    if (this.fonts.size >= MAX_FONTS) {
      this.fontsCapped++
      return NO_FONT
    }
    const toUnicode = this.doc.resolve(dict.v.get('ToUnicode'))
    const unicode = isStream(toUnicode) ? await this.cmap(toUnicode) : null
    const d = dict.v
    const font =
      asName(this.doc.resolve(d.get('Subtype'))) === 'Type0' ? await this.type0(d, unicode) : this.simple(d, unicode)
    this.fonts.set(dict, font)
    return font
  }

  private async type0(d: Map<string, PdfValue>, unicode: CMap | null): Promise<Font> {
    const doc = this.doc
    const encoding = doc.resolve(d.get('Encoding'))
    const name = asName(encoding)
    const identity = name === 'Identity-H' || name === 'Identity-V'
    const ucs2 = name !== undefined && UCS2_CMAP.test(name)
    let ranges: Range[] = []
    if (!identity && !ucs2) {
      ranges = isStream(encoding) ? ((await this.cmap(encoding))?.ranges ?? []) : (unicode?.ranges ?? [])
    }
    const cid = asDict(doc.resolve(asArray(doc.resolve(d.get('DescendantFonts')))?.[0]))
    const dw = asNumber(doc.resolve(cid?.get('DW'))) ?? 1000
    // The CID is the code only for Identity; any other CMap would need its CID ranges, so /DW stands in.
    const widths = identity ? this.cidWidths(asArray(doc.resolve(cid?.get('W')))) : new Map<number, number>()
    return {
      bytes: ranges.length ? 0 : 2,
      ranges,
      shortest: ranges.length ? Math.min(...ranges.map((r) => r.lo.length)) : 2,
      unicode: unicode?.map ?? null,
      capped: unicode?.capped ?? false,
      table: null,
      assumed: null,
      ucs2,
      width: (code) => widths.get(code) ?? dw,
      scale: 0.001
    }
  }

  private simple(d: Map<string, PdfValue>, unicode: CMap | null): Font {
    const doc = this.doc
    const descriptor = asDict(doc.resolve(d.get('FontDescriptor')))
    const encoding = doc.resolve(d.get('Encoding'))
    const encodingDict = isDict(encoding) ? encoding.v : undefined
    let base: { table: Table; assumed: boolean }
    if (encodingDict) base = baseEncoding(asName(doc.resolve(encodingDict.get('BaseEncoding'))))
    else if (asName(encoding) !== undefined) base = baseEncoding(asName(encoding))
    else {
      // No /Encoding at all: the font's own built-in one, which only the font
      // program knows. Standard is right for the Latin standard 14 and an
      // assumption for everything else — except symbol fonts, whose codes are
      // not letters at all.
      const fontName = (asName(doc.resolve(d.get('BaseFont'))) ?? '').replace(SUBSET_PREFIX, '')
      const flags = asInt(doc.resolve(descriptor?.get('Flags'))) ?? 0
      const symbolic = (flags & 4) !== 0 && (flags & 32) === 0 && !unicode
      if (STANDARD_14_LATIN.has(fontName)) base = { table: STANDARD, assumed: false }
      else if (fontName.startsWith('Symbol') || fontName.startsWith('ZapfDingbats') || symbolic) {
        base = { table: [], assumed: false }
      } else base = { table: STANDARD, assumed: true }
    }
    const table = base.table.slice()
    const assumed = new Uint8Array(256).fill(base.assumed ? 1 : 0)
    let code = -1
    for (const item of asArray(doc.resolve(encodingDict?.get('Differences'))) ?? []) {
      spend(doc.work, 1)
      if (typeof item === 'number') {
        code = Number.isSafeInteger(item) && item >= 0 && item <= 255 ? item : -1
        continue
      }
      const name = asName(item)
      if (name === undefined || code < 0 || code > 255) continue
      table[code] = glyphText(name)
      assumed[code] = 0
      code++
    }
    const widths = asArray(doc.resolve(d.get('Widths')))
    const first = asInt(doc.resolve(d.get('FirstChar'))) ?? 0
    const missing = asNumber(doc.resolve(descriptor?.get('MissingWidth'))) ?? 500
    const matrix = asArray(doc.resolve(d.get('FontMatrix')))
    const type3 = asName(doc.resolve(d.get('Subtype'))) === 'Type3'
    return {
      bytes: 1,
      ranges: [],
      shortest: 1,
      unicode: unicode?.map ?? null,
      capped: unicode?.capped ?? false,
      table,
      assumed,
      ucs2: false,
      width: (c) => asNumber(doc.resolve(widths?.[c - first])) ?? missing,
      scale: type3 ? (asNumber(doc.resolve(matrix?.[0])) ?? 0.001) : 0.001
    }
  }

  /** A CIDFont's /W, both `c [w …]` and `c1 c2 w`, one unit of work per entry. */
  private cidWidths(w: PdfValue[] | undefined): Map<number, number> {
    const doc = this.doc
    const out = new Map<number, number>()
    let room = Math.min(MAX_WIDTH_ENTRIES, this.widthLeft)
    let dropped = false
    const set = (cid: number, width: number | undefined): boolean => {
      if (room <= 0) {
        dropped = true
        return false
      }
      spend(doc.work, 1)
      room--
      this.widthLeft--
      if (width !== undefined) out.set(cid, width)
      return true
    }
    const items = w ?? []
    for (let i = 0; i < items.length;) {
      const first = asInt(doc.resolve(items[i]))
      const next = doc.resolve(items[i + 1])
      if (Array.isArray(next)) {
        if (first !== undefined) {
          for (let k = 0; k < next.length; k++) if (!set(first + k, asNumber(doc.resolve(next[k])))) break
        }
        i += 2
        continue
      }
      const last = asInt(next)
      if (first !== undefined && last !== undefined) {
        const width = asNumber(doc.resolve(items[i + 2]))
        for (let c = first; c <= last; c++) if (!set(c, width)) break
      }
      i += 3
    }
    if (dropped) this.widthsDropped++
    return out
  }

  private async cmap(s: PdfStream): Promise<CMap | null> {
    if (this.cmaps.has(s)) return this.cmaps.get(s) ?? null
    const d = await this.doc.decode(s, CMAP_CAP, 'text')
    const out = d ? this.parseCMap(d.text) : null
    this.cmaps.set(s, out)
    return out
  }

  /**
   * The parts of a CMap this reader uses: codespace ranges and bf mappings.
   * `usecmap` and everything else is ignored. A value it cannot parse ends the
   * CMap there, keeping what came before it.
   */
  private parseCMap(text: string): CMap {
    const work = this.doc.work
    const map = new Map<number, string>()
    const ranges: Range[] = []
    const values: Work = { left: LIVE_VALUES }
    const lx = new Lexer(text, 0, text.length, { work, values })
    let section = ''
    let entries = 0
    let dropped = false
    let capped = false
    const args: PdfValue[] = []
    // ponytail: keyed by the code's value only, so in a CMap mixing code lengths
    // <0041> and <41> collide. Upgrade: key by len * 2 ** 32 + value.
    const room = (): number =>
      Math.min(MAX_CMAP_ENTRIES - entries, Math.max(this.cmapLeft, CMAP_FONT_RESERVE - entries))
    const took = (n: number): void => {
      spend(work, n)
      entries += n
      this.cmapLeft -= n
    }
    try {
      for (let t = lx.read(); t !== undefined; t = lx.read()) {
        if (isOp(t)) {
          section = CMAP_SECTIONS.has(t.v) ? t.v : ''
          args.length = 0
          values.left = LIVE_VALUES
          continue
        }
        if (!section) continue
        args.push(t)
        if (args.length < (section === 'beginbfrange' ? 3 : 2)) continue
        const [a, b, c] = args
        args.length = 0
        values.left = LIVE_VALUES
        if (section === 'begincodespacerange') {
          const lo = asString(a)
          const hi = asString(b)
          const kept =
            lo !== undefined && hi !== undefined && lo.length === hi.length && lo.length >= 1 && lo.length <= 4
          if (!kept) continue
          if (ranges.length < MAX_CODESPACE) ranges.push({ lo: byteList(lo), hi: byteList(hi) })
          else dropped = true
          continue
        }
        const lo = codeOf(asString(a))
        if (section === 'beginbfchar') {
          const dst = asString(b)
          if (lo === undefined || dst === undefined) continue
          if (room() < 1) capped = true
          else {
            took(1)
            map.set(lo, String.fromCharCode(...units(dst)))
          }
          continue
        }
        const hi = codeOf(asString(b))
        if (lo === undefined || hi === undefined || lo > hi) continue
        const count = hi - lo + 1
        if (Array.isArray(c)) {
          const want = Math.min(c.length, count)
          const n = Math.min(want, room())
          if (n < want) capped = true
          took(n)
          for (let k = 0; k < n; k++) {
            const dst = asString(c[k])
            if (dst !== undefined) map.set(lo + k, String.fromCharCode(...units(dst)))
          }
          continue
        }
        const dst = asString(c)
        const u = dst === undefined ? [] : units(dst)
        if (!u.length) continue
        const prefix = String.fromCharCode(...u.slice(0, -1))
        const lastUnit = u[u.length - 1]
        const n = Math.min(count, room())
        if (n < count) capped = true
        took(n)
        for (let k = 0; k < n; k++) map.set(lo + k, prefix + String.fromCharCode(lastUnit + k))
      }
    } catch (error) {
      if (!(error instanceof Broken) && !(error instanceof ValueSpent)) throw error
    }
    if (dropped || capped) this.cmapDropped++
    // Shortest first, the order codeLength relies on.
    return { map, ranges: ranges.sort((a, b) => a.lo.length - b.lo.length), capped }
  }

  /** §5.3, in that order. */
  notes(): string[] {
    const out: string[] = []
    const pages = this.pages
    if (this.fallback) {
      out.push(
        "The page tree could not be followed from the document catalog, so pages were taken in file order from objects marked /Type /Page; page numbers here may not match a reader's."
      )
    }
    if (!this.targets) {
      const { found, read } = this.doc.objectStreams
      const unread =
        read < found
          ? `${found - read} compressed object stream(s) could not be read`
          : this.doc.stats.objStmCapped
            ? 'only the first 1024 object streams were opened'
            : ''
      out.push(
        unread
          ? `No page object was found among the objects read; ${unread}, so pages packed there are unread, not absent.`
          : 'No page objects were found, so no page text was read.'
      )
    }
    if (this.treeCapped) {
      out.push(
        'The page tree was followed only through its first 8192 entries or 32 levels; pages past that were not read — unread, not absent.'
      )
    }
    if (this.orphans) {
      out.push(
        `${this.orphans} object(s) marked /Type /Page are not in the page tree read here; their text was read and is listed apart, because a reader following that tree does not show them.`
      )
    }
    if (this.targets > MAX_PAGES) {
      const declared = this.pageCount ? `; the document declares ${this.pageCount}` : ''
      out.push(`Text was read from the first 500 pages only${declared}. The rest is unread, not absent.`)
    }
    if (this.textCapped) {
      out.push(
        `Page text was cut to 60000 characters for this file, shared evenly: each page's text (and invisible text) was kept up to its first ${this.share} characters. The rest is not kept here — not absent.`
      )
    }
    if (this.pageCut.size) {
      out.push(
        `The text or invisible text of page(s) ${pageList(this.pageCut)} ran past 20000 characters and stops there.`
      )
    }
    const unread = pages.filter((p) => p.unread > 0)
    if (unread.length) {
      out.push(
        `The drawing instructions of page(s) ${pageList(unread)} could not all be read (the reasons are in the notes around this one), so text on them is unread, not absent.`
      )
    }
    const undecoded = pages.filter((p) => p.undecoded + p.hiddenUndecoded > 0)
    if (undecoded.length) {
      const n = undecoded.reduce((sum, p) => sum + p.undecoded + p.hiddenUndecoded, 0)
      out.push(
        `${n} character(s) on page(s) ${pageList(undecoded)} are drawn in fonts with no /ToUnicode map and no encoding this reader can use (a CID font such as Identity-H without a map, a symbol font, a font whose /ToUnicode map this reader did not keep whole, or a font this reader did not find or did not keep), so they are shown as � — not decoded, not absent.`
      )
    }
    const assumed = pages.reduce((sum, p) => sum + p.assumed + p.hiddenAssumed, 0)
    if (assumed) {
      out.push(
        `${assumed} character(s) are drawn in fonts that declare neither a /ToUnicode map nor an /Encoding; they were read as the standard Latin encoding, which is an assumption — where such a font was built with its own encoding, those letters may not be the ones the page shows.`
      )
    }
    if (this.fontsCapped) out.push('This file uses more than 1024 fonts; text in the fonts past that was not decoded.')
    if (this.cmapDropped) {
      out.push(
        "A font's /ToUnicode map was larger than this reader keeps (65536 codes per font, 262144 per file); characters in such a font that the part kept does not map are shown as � — not decoded, not absent."
      )
    }
    if (this.widthsDropped) {
      out.push(
        "A font's width table was larger than this reader keeps (65536 entries per font, 262144 per file); spaces between words drawn in it may be missing or extra."
      )
    }
    if (this.contentCapped.size) {
      out.push(
        `Page(s) ${pageList(this.contentCapped)} list more than 1024 content streams; those past that were not read — unread, not absent.`
      )
    }
    if (this.annotsCapped.size) {
      out.push(
        `Page(s) ${pageList(this.annotsCapped)} list more than 256 annotations; those past that were not read — unread, not absent.`
      )
    }
    if (this.formsSkipped) {
      out.push(
        `${this.formsSkipped} Form XObject(s) or annotation appearance(s) were not read: nested deeper than 8, drawn from inside themselves, or past 2000 drawings for this file. Text inside them is unread, not absent.`
      )
    }
    if (this.inlineUnclosed) {
      out.push(
        `${this.inlineUnclosed} content stream(s) held an inline image whose end this reader could not find, so text after it on that page was not read.`
      )
    }
    if (this.brokenPieces) {
      out.push(
        `${this.brokenPieces} content stream(s) held a value this reader could not parse (never closed, nested more than 64 deep, or more than 1000000 values between two drawing instructions), so text after it in that stream was not read — unread, not absent.`
      )
    }
    if (this.stringsCut) {
      out.push(
        `${this.stringsCut} string(s) the pages draw are longer than 1 MiB; only the first MiB of each was read, so text past that is unread, not absent.`
      )
    }
    if (this.stateCapped.size) {
      out.push(
        `Page(s) ${pageList(this.stateCapped)} save the graphics state (q) more than 64 levels deep; the states past that were not kept, so from there on text in an invisible mode or at zero size is listed as visible, and its spacing may be misread.`
      )
    }
    if (this.missing) {
      out.push(
        `${this.missing} content stream(s), font(s) or form(s) the pages name were not found among the objects read, or were found as another kind of object, so what they hold is not listed.`
      )
    }
    if (this.picturesCapped.size) {
      out.push(`Page(s) ${pageList(this.picturesCapped)} draw more than 24 pictures; only the first 24 are listed.`)
    }
    const whole = pages.filter((p) => p.number !== null && p.unread === 0)
    if (whole.length && !whole.some((p) => DECODED.test(p.text) || DECODED.test(p.hidden))) {
      const pics = whole
        .filter((p) => p.pictures.length)
        .slice(0, 3)
        .map((p) => {
          const f = p.pictures[0]
          const size = f.width !== null && f.height !== null ? `, ${f.width}×${f.height}` : ''
          return `Page ${p.number} draws ${p.pictures.length} picture(s) (${f.filter}${size}, ${f.where})`
        })
        .join('; ')
      out.push(
        `No page read whole drew text this reader could decode.${pics ? ` ${pics}.` : ''} A picture of text or of a code — a scanned letter, a QR code — is not read for words here.`
      )
    }
    const rtl = pages.filter((p) => RTL.test(p.text) || RTL.test(p.hidden))
    if (rtl.length) {
      out.push(
        `Page(s) ${pageList(rtl)} hold right-to-left script (Hebrew, Arabic and the like). Files draw it left to right, glyph by glyph, and it is listed here as drawn, so its letters and words read reversed from reading order; left-to-right runs inside it, such as addresses and numbers, read as written.`
      )
    }
    if (pages.length) {
      out.push(
        "Page text is what the file's fonts say their characters are, in the order the page's drawing instructions write them: usually, not always, reading order. A file can map a glyph to any character, so this is what the file claims its text is, not a reading of the page as drawn. Spaces and line breaks are inferred from positions, so an address the page wraps across two lines is read as two pieces, and two words drawn close together can read as one; indicators taken from page text can be cut or joined there. Text drawn out of sight — white on white, off the page, under a picture, or in optional content switched off — is not told apart here; only the invisible text mode (/Tr 3 and 7), zero-size text and hidden annotations are, and that text is listed separately."
      )
    }
    return out
  }
}

/**
 * The text of every page this reader can reach, in content-stream order, with
 * notes on everything it could not. Never throws; a spent work budget or
 * deadline sets `doc.workSpent` and keeps the pages read so far.
 *
 * ponytail: nothing is laid out or sorted, optional content is not tracked, and
 * text under a link is not paired with its URI; PT-CAVEAT says what that costs.
 */
export async function readPageText(doc: PdfDoc): Promise<PdfTextResult> {
  const reader = new Reader(doc)
  try {
    await reader.read()
  } catch (error) {
    // The page loop catches per page; this only backs the never-throws contract
    // for the tree walk, whose only expected stop is a spent budget.
    if (error instanceof WorkSpent) doc.workSpent = error.why
  }
  return { pages: reader.pages, pageCount: reader.pageCount, notes: reader.notes(), annotPages: reader.annotPages }
}
