/**
 * What is inside a .docx / .xlsx / .pptx / .zip, read from the container only.
 *
 * The document body is never inflated. Entry NAMES live uncompressed in the
 * central directory, which is the whole point of reading a ZIP this way: a
 * `word/vbaProject.bin`, an `oleObject1.bin`, an `externalLink1.xml` or an
 * `.exe` sitting inside a .docx are all visible for the cost of a pointer
 * walk, with nothing attacker-controlled fed to a decompressor.
 *
 * The one exception is `.rels`. A phishing document's lure does not live in
 * the text — it lives in a relationship with TargetMode="External", and so
 * does a remote-template injection and a linked OLE object. Those parts are a
 * few hundred bytes each, so they are inflated under a hard output cap and
 * nothing else is.
 *
 * Same standing rule as the rest of the SOC modules: this states what the
 * bytes say and stops. No score, no rating, no "suspicious". An entry list
 * with no external targets is reported as an entry list with no external
 * targets — never as a clean document, because whether it is clean is the
 * analyst's call and their name goes on it.
 *
 * Nothing here fetches, resolves or expands anything. Every byte read came
 * from the array the caller passed in.
 *
 * ponytail: `.rels` is the only part inflated, so the ceiling is a target
 * that is not declared as a relationship — a URL hard-coded in an embedded
 * OLE stream, or one built at run time by a macro in `vbaProject.bin`. Those
 * entries are still LISTED by name, which is the fact that matters; reading
 * inside them means inflating attacker-chosen document parts, and that is a
 * deliberate next step, not an oversight.
 */

/** One row of the central directory, as written — not as inflated. */
export interface ZipEntry {
  name: string
  /**
   * Uncompressed size, as the directory declares it. Not verified: nothing is
   * inflated to check. `null` when the directory declares a number too large
   * for this reader to represent exactly — stated as not recorded rather than
   * printed as a sentinel, because a made-up size is a wrong fact and absence
   * is the honest one.
   */
  size: number | null
  compressedSize: number | null
  /** The compression method as a word — 'stored', 'deflate', … or 'other-N' for one we cannot name. */
  method: string
  /** General purpose bit 0. An encrypted entry's contents cannot be read from here. */
  encrypted: boolean
}

/** A relationship that points outside the container. */
export interface ExternalTarget {
  /** The .rels part it was declared in. */
  from: string
  /** The Target attribute, XML entities decoded, exactly as written otherwise. */
  target: string
  /** The TargetMode attribute — always 'External' for anything reported here. */
  mode: string
  /** The relationship Type URI: what the document wanted the target FOR. */
  type: string
  id: string
}

export interface OfficeFacts {
  entries: ZipEntry[]
  externalTargets: ExternalTarget[]
  /** Everything that could not be read, said out loud rather than left to look like absence. */
  notes: string[]
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOCATOR = 0x07064b50

/** A uint16 comment length plus the 22-byte record — the furthest from the end the EOCD can legally sit. */
const EOCD_SCAN = 65_557

/**
 * Bounds. Every one of these exists because the input is a file an attacker
 * sent on purpose, and each names what it costs when it bites.
 */

/** A real Office document has tens of entries. 4,096 is a generous ceiling on a directory built to be walked forever. */
const MAX_ENTRIES = 4_096
/** A name is a uint16 by spec, so 4,096 of them could be 256 MB. Names over this are truncated and said to be. */
const MAX_NAME_BYTES = 1_024
/** A document has a handful of .rels parts. Sixty-four is a ceiling on a container padded with them. */
const MAX_RELS_PARTS = 64
/** Per-part output cap: a .rels is a few KB, so 1 MB out of the decompressor is already a lie about what it is. */
const MAX_RELS_BYTES = 1_048_576
/**
 * Per-part INPUT cap. A streamed entry records compressed size 0, so the
 * honest fallback is "the rest of the file" — and handing the rest of a 50 MB
 * container to the decompressor to read one relationship part copies 50 MB to
 * find a few hundred bytes. No genuine .rels compresses to more than this.
 */
const MAX_RELS_INPUT = 1_048_576
/** Total output cap across every .rels — the bomb that arrives as sixty-four small parts rather than one big one. */
const MAX_RELS_TOTAL = 4_194_304
/** A document with more than this many external targets is telling us something the list itself no longer adds to. */
const MAX_TARGETS = 512

/**
 * ponytail: the methods that turn up, not the full APPNOTE table. Anything
 * unlisted reports as `other-N` with its real number, which is honest and
 * still greppable; add a row when a real sample shows one. 99 is WinZip AES,
 * where the true method hides in an extra field — it is named rather than
 * decoded because an AES entry cannot be read from here anyway.
 */
const METHODS: Record<number, string> = {
  0: 'stored',
  1: 'shrunk',
  6: 'imploded',
  8: 'deflate',
  9: 'deflate64',
  12: 'bzip2',
  14: 'lzma',
  93: 'zstd',
  95: 'xz',
  98: 'ppmd',
  99: 'aes'
}

/** The central-directory row, plus the fields the caller never sees but we need to find the bytes. */
interface CentralRecord extends ZipEntry {
  methodCode: number
  localOffset: number
  /** Decided on the RAW name bytes, so a name too long to display still matches. */
  isRels: boolean
  /**
   * General purpose bit 3: the sizes were written to a data descriptor AFTER
   * the data, so this row's compressed size is legitimately 0 and the length
   * has to come from the stream itself. Without this bit a declared 0 is just
   * a 0 — and reading "the rest of the file" for an entry that really is empty
   * printed the FOLLOWING entries' bytes as this part's XML.
   */
  streamed: boolean
}

/** What the end-of-central-directory record says is there — including the two counts used to check the walk against it. */
interface EndRecord {
  cdOffset: number
  cdSize: number
  /** Total entries the archive declares, or null when the field held the ZIP64 sentinel and the real count could not be read. */
  entryCount: number | null
}

function methodWord(method: number): string {
  return METHODS[method] ?? `other-${method}`
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return bytes.length >= magic.length && magic.every((byte, i) => bytes[i] === byte)
}

/**
 * Find the end-of-central-directory record, scanning backwards.
 *
 * Backwards, because the record is at the end and because an archive with two
 * of them — a real shape when one ZIP is appended to another — should be read
 * as the outer one. The candidate is validated before it is believed: a bare
 * 0x06054b50 turns up inside compressed data often enough that trusting the
 * first hit walks the "central directory" straight into a deflate stream.
 */
function findEocd(bytes: Uint8Array, view: DataView): EndRecord | null {
  const floor = Math.max(0, bytes.length - EOCD_SCAN)
  for (let at = bytes.length - 22; at >= floor; at--) {
    if (view.getUint32(at, true) !== SIG_EOCD) continue
    const commentLength = view.getUint16(at + 20, true)
    // The comment is the only reason this record is not at a fixed distance
    // from the end, so a declared comment that runs past the end of the file
    // is the tell that this 0x06054b50 is data, not a record.
    if (at + 22 + commentLength > bytes.length) continue

    let cdSize = view.getUint32(at + 12, true)
    let cdOffset = view.getUint32(at + 16, true)
    const declared = view.getUint16(at + 10, true)
    // The declared entry count is carried out of here rather than dropped: it
    // is the only way to tell a directory walk that finished from one that
    // stopped on a corrupt byte three records in.
    let entryCount: number | null = declared
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || declared === 0xffff) {
      const wide = readZip64(bytes, view, at)
      // Moves to the next candidate like every other validation failure here,
      // and says nothing. These three sentinels also sit in a decoy 22-byte
      // record parked after the real one, where the backward scan meets them
      // first — and "this archive uses the ZIP64 format" about an archive that
      // does not is a false fact bought with 22 bytes of padding. Carrying on
      // finds the real record, which is still inside the scan window.
      if (!wide) continue
      cdOffset = wide.cdOffset
      cdSize = wide.cdSize
      entryCount = wide.entryCount
    }

    if (cdOffset + cdSize > bytes.length) continue
    return { cdOffset, cdSize, entryCount }
  }
  return null
}

/** The ZIP64 locator sits immediately before the EOCD and points at the real record. */
function readZip64(bytes: Uint8Array, view: DataView, eocdAt: number): EndRecord | null {
  const locator = eocdAt - 20
  if (locator < 0 || view.getUint32(locator, true) !== SIG_EOCD64_LOCATOR) return null
  const recordAt = Number(view.getBigUint64(locator + 8, true))
  // A 64-bit offset is a length field like any other: check it against the
  // buffer we actually hold before reading a single byte at it.
  if (!Number.isSafeInteger(recordAt) || recordAt < 0 || recordAt + 56 > bytes.length) return null
  if (view.getUint32(recordAt, true) !== SIG_EOCD64) return null
  const cdSize = Number(view.getBigUint64(recordAt + 40, true))
  const cdOffset = Number(view.getBigUint64(recordAt + 48, true))
  if (!Number.isSafeInteger(cdSize) || !Number.isSafeInteger(cdOffset) || cdOffset < 0 || cdSize < 0) return null
  const entries = Number(view.getBigUint64(recordAt + 32, true))
  return { cdOffset, cdSize, entryCount: Number.isSafeInteger(entries) ? entries : null }
}

/**
 * The ZIP64 extra field, read only for the fields the 32-bit row gave up on.
 *
 * Without this a sentinel size prints as 4,294,967,295 bytes and a sentinel
 * offset sends the .rels read to a byte that is not there. Both are wrong
 * facts rather than missing ones, which is the kind this module does not ship.
 * The three values appear in a fixed order and ONLY when their 32-bit field
 * held the sentinel, so the cursor advances per field, not per slot.
 *
 * A 64-bit value past Number.MAX_SAFE_INTEGER cannot be carried exactly, and
 * that is the sizes' own problem rather than the caller's: they come back null
 * and are said to be, because "-1 bytes" on an entry table is the same class of
 * invented fact this function exists to stop.
 */
function applyZip64Extra(view: DataView, at: number, length: number, entry: CentralRecord): boolean {
  let cursor = at
  const end = at + length
  while (cursor + 4 <= end) {
    const id = view.getUint16(cursor, true)
    const size = view.getUint16(cursor + 2, true)
    const body = cursor + 4
    if (body + size > end) return false
    if (id === 0x0001) {
      let field = body
      let unrepresentable = false
      const take = (): number | null => {
        const value = Number(view.getBigUint64(field, true))
        field += 8
        if (Number.isSafeInteger(value)) return value
        unrepresentable = true
        return null
      }
      if (entry.size === 0xffffffff && field + 8 <= body + size) entry.size = take()
      if (entry.compressedSize === 0xffffffff && field + 8 <= body + size) entry.compressedSize = take()
      // Only the SIZES are reported as unrecorded. An unrepresentable OFFSET
      // beside a size table that is correct produced "declares a size larger
      // than this reader can represent" next to a row reading size 7 — a note
      // contradicting the module's own output. The offset keeps -1, which
      // locateData rejects outright, so it is reported where it actually bites.
      const sizesUnrepresentable = unrepresentable
      if (entry.localOffset === 0xffffffff && field + 8 <= body + size) entry.localOffset = take() ?? -1
      // Reported by the CALLER, as a count. One sentence per entry is free
      // flooding: 4,096 rows each carrying this extra field bought 4,096
      // identical notes, and `notes` is this module's whole output surface —
      // thousands of lines is the same as none. Every other finding in the
      // walk aggregates; this one now does too.
      return sizesUnrepresentable
    }
    cursor = body + size
  }
  return false
}

/**
 * Does this name end in `.rels`, judged on the RAW bytes?
 *
 * A name past MAX_NAME_BYTES is displayed cut short with an `…` on the end, and
 * testing that display string means a 1,025-byte name hides a relationship part
 * completely — the container then states it "holds no relationship parts" about
 * one that does, which is a flat falsehood an attacker buys with free padding.
 * The `…` belongs in what is shown, never in the predicate. Five bytes read, so
 * this stays bounded however long the name is; `.rels` is ASCII, so a slice
 * landing mid-sequence can only fail to match, never match wrongly.
 */
function endsWithRels(bytes: Uint8Array, at: number, length: number): boolean {
  if (length < 5) return false
  return utf8.decode(bytes.subarray(at + length - 5, at + length)).toLowerCase() === '.rels'
}

/**
 * ponytail: names are decoded as UTF-8 whether or not general purpose bit 11
 * says so. A pre-2007 archiver wrote CP437 there, so a legacy non-ASCII name
 * can come back with replacement characters — ASCII, which is every name that
 * matters in an OOXML container, is identical in both. The upgrade is a CP437
 * table behind the bit-11 check.
 */
const utf8 = new TextDecoder('utf-8')

function walkCentralDirectory(bytes: Uint8Array, view: DataView, end: EndRecord, notes: string[]): CentralRecord[] {
  const records: CentralRecord[] = []
  let at = end.cdOffset
  let truncatedName = false
  let unrepresentable = 0
  let firstUnrepresentable = ''
  while (records.length < MAX_ENTRIES) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== SIG_CENTRAL) break
    const flags = view.getUint16(at + 8, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const nameAt = at + 46
    // Every one of these three lengths is attacker-written. A name that runs
    // past the end of the buffer stops the walk here rather than slicing
    // whatever happens to follow in memory.
    if (nameAt + nameLength + extraLength + commentLength > bytes.length) {
      notes.push('A directory entry declared more data than the file contains, so the listing stops there.')
      break
    }
    const readable = Math.min(nameLength, MAX_NAME_BYTES)
    if (readable < nameLength) truncatedName = true
    const entry: CentralRecord = {
      name: utf8.decode(bytes.subarray(nameAt, nameAt + readable)) + (readable < nameLength ? '…' : ''),
      size: view.getUint32(at + 24, true),
      compressedSize: view.getUint32(at + 20, true),
      method: methodWord(view.getUint16(at + 10, true)),
      encrypted: (flags & 1) === 1,
      methodCode: view.getUint16(at + 10, true),
      localOffset: view.getUint32(at + 42, true),
      isRels: endsWithRels(bytes, nameAt, nameLength),
      streamed: (flags & 8) === 8
    }
    if (
      (entry.size === 0xffffffff || entry.compressedSize === 0xffffffff || entry.localOffset === 0xffffffff) &&
      applyZip64Extra(view, nameAt + nameLength, extraLength, entry)
    ) {
      unrepresentable++
      if (firstUnrepresentable === '') firstUnrepresentable = entry.name
    }
    records.push(entry)
    at = nameAt + nameLength + extraLength + commentLength
  }
  // The count alone is not the question. An archive holding EXACTLY MAX_ENTRIES
  // records was listed in full, and saying "this container holds more" about it
  // is a false fact on an ordinary file — so the next record has to actually be
  // there before the cap is announced.
  const more = records.length === MAX_ENTRIES && at + 46 <= bytes.length && view.getUint32(at, true) === SIG_CENTRAL
  if (more) {
    notes.push(
      `Stopped after ${MAX_ENTRIES} entries: another entry record begins at offset ${at}, and nothing from there on was read.`
    )
  } else {
    // The walk ends on a byte that is not a record signature, and a directory
    // that ran out is indistinguishable at that byte from one corrupted three
    // records in. One corrupt byte can cut the entry list to any prefix, and
    // the entry names are what this module exists to report, so a short list
    // must never pass for a complete one.
    //
    // Both checks below state ARITHMETIC and nothing else. The earlier wording
    // ended "…where the central directory does not hold one", which the walk
    // cannot guarantee: it also stops on a record that declares more data than
    // the file contains, and the note directly above that one says the record
    // IS there. A pair of notes contradicting each other is worse than one
    // fact fewer, so the clause is gone rather than qualified.
    const consumed = at - end.cdOffset
    if (end.entryCount !== null && records.length < end.entryCount) {
      notes.push(
        `The entry listing stopped at record ${records.length + 1} of the ${end.entryCount} this archive declares, so the rest were not read.`
      )
    } else if (end.cdSize > 0 && consumed + 46 <= end.cdSize) {
      // The second reading of the same question, for the archive whose
      // declared COUNT matches a walk that stopped early — understate the
      // count to match the damage and the count check sees nothing wrong.
      // The central directory legally holds more than entry records (APPNOTE
      // 4.3.13's archive-signature record sits inside it and is counted in
      // cdSize, and writers pad it), so leftover bytes are not evidence of a
      // lost entry and this says no such thing: it reports the two numbers
      // and stops. One record's fixed 46 bytes is the floor, so ordinary
      // padding and a signature record stay silent.
      notes.push(
        `The central directory declares ${end.cdSize} bytes; the entry listing read ${consumed} of them and stopped, leaving ${
          end.cdSize - consumed
        } bytes — room for at least one more entry record — unread.`
      )
    }
  }
  if (truncatedName) {
    notes.push(
      `One or more entry names were longer than ${MAX_NAME_BYTES} bytes and are shown cut short, marked with …`
    )
  }
  if (unrepresentable === 1) {
    notes.push(
      `${firstUnrepresentable} declares a size larger than this reader can represent exactly, so it is not recorded. The entry is real; only its declared size is unknown.`
    )
  } else if (unrepresentable > 1) {
    notes.push(
      `${unrepresentable} entries, starting with ${firstUnrepresentable}, declare sizes larger than this reader can represent exactly, so those sizes are not recorded. The entries are real; only their declared sizes are unknown.`
    )
  }
  const encrypted = records.filter((r) => r.encrypted).length
  if (encrypted > 0) {
    notes.push(
      `${encrypted} ${encrypted === 1 ? 'entry is' : 'entries are'} encrypted — their contents cannot be read from here, only their names and sizes.`
    )
  }
  return records
}

/**
 * Where an entry's bytes actually start.
 *
 * The local header carries its OWN name and extra lengths, and the extra
 * field routinely differs from the central directory's copy — so the data
 * offset has to be computed from the local header, never assumed to be a
 * fixed distance from it. The signature is checked first because the central
 * directory's offset is an attacker-written pointer like any other.
 */
function locateData(bytes: Uint8Array, view: DataView, entry: CentralRecord): { start: number; length: number } | null {
  const at = entry.localOffset
  if (at < 0 || at + 30 > bytes.length || view.getUint32(at, true) !== SIG_LOCAL) return null
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true)
  if (start >= bytes.length) return null
  const available = bytes.length - start
  const declared = entry.compressedSize
  if (declared !== null && declared > 0 && declared <= available) return { start, length: declared }
  // A declared 0 with no data descriptor (bit 3) is not a missing length — it
  // is a length, and it is zero. Reading "the rest of the file" for it handed
  // the FOLLOWING entries' bytes to the XML scanner, which printed their
  // external targets as this part's: twenty URLs attributed to a part the same
  // output lists as 0 bytes, none of them declared where the analyst is told
  // to look. Fabricating a target is the worst thing this module can do, so an
  // empty entry now reads as empty.
  if (declared === 0 && !entry.streamed) return { start, length: 0 }
  // What is left is a length that is missing (bit 3) or a lie (longer than the
  // file). Only a deflate stream can be read without a trustworthy length,
  // because the stream carries its own end; for a stored entry there is no end
  // marker, and "the rest of the file" is the same fabrication by another door.
  return entry.methodCode === 8 ? { start, length: available } : null
}

/**
 * Inflate under a hard output cap, stopping the stream at the cap instead of
 * buffering first. `failed` is the difference between "this part declares
 * nothing" and "this part could not be read", which the caller cannot tell
 * from empty output alone.
 */
async function inflate(
  data: Uint8Array,
  cap: number
): Promise<{ bytes: Uint8Array; truncated: boolean; failed: boolean }> {
  const stream = new DecompressionStream('deflate-raw')
  const writer = stream.writable.getWriter()
  // Not awaited: a decompressor applies backpressure, so writing the whole
  // input before reading a byte of output deadlocks on anything non-trivial.
  void (async () => {
    try {
      // Copied into its own buffer: a view onto the caller's array is typed as
      // possibly shared, which a stream will not take. The slice is already
      // capped by MAX_RELS_INPUT, so the copy is bounded too.
      await writer.write(new Uint8Array(data))
      await writer.close()
    } catch {
      // Cancelling the reader at the cap rejects the pending write. The read
      // side already knows what happened and reports it; this must not become
      // an unhandled rejection.
    }
  })()

  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  let failed = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (total + value.length > cap) {
        chunks.push(value.subarray(0, cap - total))
        total = cap
        truncated = true
        await reader.cancel()
        break
      }
      chunks.push(value)
      total += value.length
    }
  } catch {
    // A malformed deflate stream is a fact about the file, not a crash: keep
    // whatever came out before it broke and REPORT the break. Swallowing it
    // here made a part that failed to decompress look exactly like a part that
    // honestly declares nothing, which is the one confusion this module exists
    // to prevent.
    failed = true
  }
  const out = new Uint8Array(total)
  let cursor = 0
  for (const chunk of chunks) {
    out.set(chunk, cursor)
    cursor += chunk.length
  }
  return { bytes: out, truncated, failed }
}

/**
 * Relationships, found with a regex and delimited by hand.
 *
 * Deliberately not a parser. There is no DOM here, and building a document out
 * of attacker XML is the thing we are trying not to do — DOCTYPE, entity
 * expansion and external entities are all attacks a parser accepts and this
 * cannot perform.
 *
 * The regex finds the START only. Finding the END with `[^>]*>` was wrong
 * twice over. It is wrong on correct XML: XML 1.0 lets `>` sit unescaped
 * inside an attribute value (only `<` and `&` must be escaped), so one `>` in
 * a lure URL cut the element short, TargetMode was never seen and the external
 * target vanished with no note — or, with the attributes the other way round,
 * was reported as the empty string. And it is wrong on hostile input: a
 * `<Relationship` with no `>` after it sends `[^>]*` to the end of the buffer
 * and back a character at a time, once per start, and the starts can be 14
 * bytes apart. Measured 31 s on 1 MB and 2 min 33 s end to end — on a
 * single-threaded host that is the whole app.
 *
 * So the end is found by a single forward scan that tracks quoting, and the
 * next search resumes where the last element ended. Every byte is visited a
 * fixed number of times, whatever the input, and a `>` inside quotes is a
 * character like any other.
 *
 * An element the scan cannot delimit is SKIPPED, not the rest of the part.
 * One missing quote — `Target="styles.xml/>` — flips the quote parity for
 * everything after it, and abandoning the part there cost every genuine
 * external target that followed: four real lures lost to one stray byte,
 * which is the false negative this reader exists to prevent. The scan stops
 * at the next `<` instead, which a runaway attribute value cannot legally
 * contain, so the elements after the damage read correctly from a clean quote
 * state. The malformed one is dropped rather than guessed at — reading a `>`
 * inside its runaway value reports `styles.xml/>\n<Relationship Id=` as an
 * external target, and a fabricated fact is worse than a missing one.
 *
 * Both element names are matched with an optional namespace prefix.
 * `<r:Relationship>` is legal XML for the same part, and the unprefixed
 * pattern both missed its targets AND then stated the part "was not a
 * relationship part" about one that plainly is.
 */
const RELATIONSHIP_START = /<(?:[A-Za-z_][\w.-]*:)?Relationship\b/gi

/** Every real relationship part contains this, if only in its own `<Relationships>` root. */
const RELATIONSHIP_SHAPE = /<(?:[A-Za-z_][\w.-]*:)?Relationship/i

/**
 * Undelimitable elements to skip past before giving up on a part. Since the
 * scan stops at the next `<` rather than running to the end of the buffer,
 * each skip costs only the bytes between two elements and the whole part is
 * one pass either way — so this is no longer what bounds the work, only what
 * bounds how much malformed XML is worth walking. A genuine relationship part
 * has none.
 */
const MAX_UNCLOSED = 16

/**
 * Said about the LIST, not about the container. The scan stops on the start
 * that follows the 512th target, and that start need not be an external
 * relationship at all — so "more than 512 external targets are declared" is a
 * count this reader never actually made.
 */
const TARGETS_CAPPED = `The list of external targets stops at ${MAX_TARGETS}; anything declared after that point was not read.`

/**
 * Where the element starting at `from` stops.
 *
 * `closed` is the first `>` that is not inside an attribute value — the real
 * end of the element. Anything else is a `<`, and XML 1.0 forbids a raw `<`
 * inside an attribute value, so one found while this scan believes it is
 * inside a quote proves the quote was never really opened. The element is then
 * undelimitable and the scan stops AT that `<`, which is where the next
 * element starts.
 *
 * Running the quote state on past it instead is how one element's Target got
 * read together with another element's TargetMode: `Target="internal.xml" Z="`
 * swallowed the next two elements and reported an INTERNAL relationship as
 * External, while the real external lure further on was never reported at all.
 * A wrong target is worse than a missing one, and here the `<` rule loses
 * neither — it costs only elements that no conforming XML writer can produce.
 *
 * null when neither follows: no `>` and no `<` after this point means no later
 * element in this part can close or even begin, so there is nothing to resume.
 */
function elementEnd(xml: string, from: number): { at: number; closed: boolean } | null {
  let quote = ''
  for (let at = from + 1; at < xml.length; at++) {
    const char = xml[at]
    if (char === '<') return { at, closed: false }
    if (quote !== '') {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '>') return { at, closed: true }
  }
  return null
}
const ATTR_ID = /\bId\s*=\s*(?:"([^"]*)"|'([^']*)')/i
const ATTR_TYPE = /\bType\s*=\s*(?:"([^"]*)"|'([^']*)')/i
const ATTR_TARGET = /\bTarget\s*=\s*(?:"([^"]*)"|'([^']*)')/i
const ATTR_MODE = /\bTargetMode\s*=\s*(?:"([^"]*)"|'([^']*)')/i

function attr(element: string, pattern: RegExp): string {
  const found = pattern.exec(element)
  return found ? (found[1] ?? found[2] ?? '') : ''
}

/**
 * The five predefined XML entities and numeric references, and nothing else.
 *
 * `&amp;` is ordinary in a lure URL and printing it raw shows the analyst a
 * different string than the one Word requests. A custom `&foo;` is left
 * exactly as written: resolving one means reading a DOCTYPE, and reading a
 * DOCTYPE is how billion-laughs gets in.
 */
function xmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
    const key = name.toLowerCase()
    if (key === 'amp') return '&'
    if (key === 'lt') return '<'
    if (key === 'gt') return '>'
    if (key === 'quot') return '"'
    if (key === 'apos') return "'"
    const code = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10)
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

/**
 * Every sentence this can push is about THIS part and the elements actually
 * scanned in it. Nothing here reasons about the document, and nothing here
 * reasons about the bytes that were not read — the cap that cut them off says
 * so itself, at the call site, with its own numbers.
 */
function collectTargets(from: string, xml: string, out: ExternalTarget[], notes: string[]): void {
  RELATIONSHIP_START.lastIndex = 0
  let undelimited = 0
  let stopped = false
  for (let found = RELATIONSHIP_START.exec(xml); found !== null; found = RELATIONSHIP_START.exec(xml)) {
    if (out.length >= MAX_TARGETS) {
      // Identical to the sentence every other capped part would push: said
      // once, because sixty-four copies of one line is noise, not disclosure.
      // `stopped` stays as it is: it belongs to the undelimited note below,
      // which points at an element. The target cap stopped the scan somewhere
      // else entirely, and TARGETS_CAPPED is the sentence that says so.
      if (!notes.includes(TARGETS_CAPPED)) notes.push(TARGETS_CAPPED)
      break
    }
    const scan = elementEnd(xml, found.index)
    if (scan === null) {
      // No `>` and no `<` after this point, so no later element in this part
      // can close or even begin: resynchronising cannot recover anything.
      undelimited++
      stopped = true
      break
    }
    if (!scan.closed) {
      undelimited++
      if (undelimited >= MAX_UNCLOSED) {
        stopped = true
        break
      }
      // At the `<` the scan stopped on, which is past this element's own `<`,
      // so the search always advances and the next element is read with a
      // clean quote state.
      RELATIONSHIP_START.lastIndex = scan.at
      continue
    }
    const end = scan.at
    const element = xml.slice(found.index, end + 1)
    // Resume past the element just read. This is what bounds the scan: for
    // every element that DOES close, the search and the end-scan cover
    // disjoint ranges, so a well-formed part costs one pass however long it
    // is. Only an element that fails to close is scanned over twice, and
    // MAX_UNCLOSED is what bounds that. `end` is always at least 13 bytes on
    // from the start (`<Relationship` holds no `>`), so this always advances.
    RELATIONSHIP_START.lastIndex = end + 1
    const mode = attr(element, ATTR_MODE)
    if (mode.toLowerCase() !== 'external') continue
    out.push({
      from,
      target: xmlText(attr(element, ATTR_TARGET)),
      mode,
      type: xmlText(attr(element, ATTR_TYPE)),
      id: attr(element, ATTR_ID)
    })
  }
  if (undelimited === 0) return
  const one = undelimited === 1
  // The COUNTED number, never "more than" it. Stopping at the sixteenth
  // failure is not evidence of a seventeenth: sixteen malformed elements
  // followed by well-formed ones is an ordinary shape for this scan, and
  // "more than 16" about exactly 16 is the same off-by-one as a cap note
  // that fires on a container holding exactly its cap.
  //
  // "could not be delimited" is also all that is known. "Never closes" is a
  // claim about the file, and it is wrong for an element whose `>` sits two
  // bytes past where reading stopped, and wrong again for one carrying a raw
  // `<` that this scan cuts at.
  const subject = one ? 'a relationship element' : `${undelimited} relationship elements`
  const tail = stopped
    ? 'Reading this part stopped there, so anything declared past that point was not read.'
    : `Reading carried on past ${one ? 'it' : 'them'}, so the targets around ${
        one ? 'it' : 'them'
      } are listed; what ${one ? 'it declares' : 'they declare'} was not read.`
  notes.push(`${from} holds ${subject} this reader could not delimit. ${tail}`)
}

async function readRelationships(
  bytes: Uint8Array,
  view: DataView,
  records: CentralRecord[],
  facts: OfficeFacts
): Promise<void> {
  const rels = records.filter((r) => r.isRels)
  // Nothing is said here. "This container holds no relationship parts" is an
  // assertion about a whole file, and the walk that produced `records` may
  // have stopped at a cap, at a corrupt record, or at a count the archive
  // understated — the sentence then denies a relationship part the same output
  // admits it never reached. An empty target list is the honest report, and
  // every reason the listing could be short already has its own note above.
  if (rels.length === 0) return
  // eslint-disable-next-line obsidianmd/no-global-this -- feature detection, not a window lookup: this module is pure and must not reach for a window that may not exist (tests run in node)
  if (typeof globalThis.DecompressionStream !== 'function') {
    facts.notes.push(
      'This device cannot inflate compressed data, so no relationship targets were read. Treat the external links in this container as unknown, not as absent.'
    )
    return
  }

  let budget = MAX_RELS_TOTAL
  let read = 0
  for (const entry of rels) {
    if (read >= MAX_RELS_PARTS) {
      // Counted against the entries LISTED, which is the only population this
      // function has: `rels.length` is not a count of what the container
      // holds. Not "the first 64" either — `read` counts successful reads, so
      // an encrypted or unlocatable part in between is skipped without
      // counting, and each of those has said so in its own note.
      facts.notes.push(
        `Reading stopped after ${MAX_RELS_PARTS} relationship parts; ${rels.length} appear among the entries listed.`
      )
      break
    }
    if (entry.encrypted) {
      facts.notes.push(`${entry.name} is encrypted, so its targets could not be read.`)
      continue
    }
    const located = locateData(bytes, view, entry)
    if (!located) {
      // Covers a local header that is not there, an offset outside the file,
      // and a length that is missing or longer than the file holds. Which of
      // those it was is not claimed, because reading the bytes to find out is
      // the read that just failed.
      facts.notes.push(`${entry.name} could not be read from the bytes in this file, so no targets were read from it.`)
      continue
    }
    if (located.length === 0) {
      facts.notes.push(`${entry.name} declares a compressed size of 0 bytes, so there was nothing in it to read.`)
      continue
    }
    if (budget <= 0) {
      facts.notes.push('The total inflation budget was used up before every relationship part was read.')
      break
    }

    const cap = Math.min(MAX_RELS_BYTES, budget)
    let xml: string
    if (entry.methodCode === 0) {
      // A stored .rels is already plain: slice it, still under the cap.
      const length = Math.min(located.length, cap)
      if (length < located.length) {
        facts.notes.push(`${entry.name} is larger than ${cap} bytes and was read only that far.`)
      }
      xml = utf8.decode(bytes.subarray(located.start, located.start + length))
      budget -= length
    } else if (entry.methodCode === 8) {
      const input = Math.min(located.length, MAX_RELS_INPUT)
      const out = await inflate(bytes.subarray(located.start, located.start + input), cap)
      if (out.truncated) {
        facts.notes.push(
          `${entry.name} expanded past ${cap} bytes; reading stopped there and anything declared beyond that point was not read.`
        )
      }
      if (out.failed) {
        // What broke the stream is not claimed. A cut stream, bytes that were
        // never deflate and a damaged tail are indistinguishable from here,
        // and the analyst acts on the same fact either way.
        facts.notes.push(
          `${entry.name} could not be fully decompressed. Anything past the break is unknown, not absent.`
        )
      }
      xml = utf8.decode(out.bytes)
      budget -= out.bytes.length
    } else {
      facts.notes.push(`${entry.name} is compressed with ${entry.method}, which this reader cannot inflate.`)
      continue
    }
    read++
    // One check for three different failures that all end in an empty target
    // list: a stream that broke before the first element, a local header whose
    // lengths sent the read into some other entry's payload, and an entry that
    // is simply not a relationship part. Without it, every one of them is
    // indistinguishable from a document that honestly declares nothing.
    //
    // It says only what the BYTES READ hold. The earlier sentence — "held no
    // relationship declarations at all, so what was read for it was not a
    // relationship part" — is a verdict on the part, and a genuine .rels
    // carrying a megabyte of leading comment is one it gets wrong: the
    // declarations are there, just past where reading stopped.
    if (!RELATIONSHIP_SHAPE.test(xml)) {
      facts.notes.push(`No relationship declarations appear in the bytes read for ${entry.name}.`)
      continue
    }
    collectTargets(entry.name, xml, facts.externalTargets, facts.notes)
  }
}

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]

/**
 * Read a ZIP container.
 *
 * Returns null when no end-of-central-directory record can be found at all —
 * a legacy OLE .doc/.xls, prose, an image — so a caller with its own handling
 * for those keeps it rather than being handed this reader's guess.
 *
 * Once such a record IS found the answer is facts, even when nothing could be
 * listed, because null carries no note and absence would then read as safety
 * at the outermost boundary of the module. The contract is therefore narrower
 * than "not a ZIP": bytes that are not an archive but happen to carry those
 * four signature bytes in their last 64 KB come back as a damaged container,
 * and the note says so rather than picking one explanation.
 */
export async function readZipDocument(bytes: Uint8Array): Promise<OfficeFacts | null> {
  // A legacy OLE compound file is emphatically not a ZIP, and it is the one
  // non-ZIP a caller is most likely to send here by accident.
  if (startsWith(bytes, OLE_MAGIC)) return null
  if (bytes.length < 22) return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const hasPkMagic = bytes[0] === 0x50 && bytes[1] === 0x4b
  const facts: OfficeFacts = { entries: [], externalTargets: [], notes: [] }

  const end = findEocd(bytes, view)
  if (!end) {
    if (!hasPkMagic) return null
    // Names the window rather than the cause. "The file is truncated or
    // damaged" is a conclusion this cannot reach: an archive with more than
    // EOCD_SCAN bytes of trailing data is neither, and lands here anyway.
    facts.notes.push(
      `This begins with the ZIP signature, but no end-of-central-directory record was found in its last ${EOCD_SCAN} bytes, so nothing inside it could be listed. Treat the contents as unknown, not as absent.`
    )
    return facts
  }

  // An archive that declares nothing has no central directory to point at, so
  // the probe below finds no record there and pushes a note about a stale or
  // damaged offset — which is wrong about an ordinary empty .zip, and this is
  // what one is. The two fields are read straight off the record; which of the
  // two shapes produced them is not decided, because from 22 bytes of zeros it
  // cannot be.
  if (end.entryCount === 0 && end.cdSize === 0) {
    facts.notes.push(
      'The end-of-central-directory record here declares 0 entries and a central directory of 0 bytes, so nothing was listed. An empty archive looks exactly like this, and so do those four signature bytes falling by chance in a file that is not an archive at all.'
    )
    return facts
  }

  // Bounded BEFORE it is read, not caught after. findEocd only guarantees
  // cdOffset + cdSize is inside the buffer, which cdSize 0 satisfies with
  // cdOffset at the very end of the file — and this four-byte probe then ran
  // off the DataView and threw straight out of this function, past the try
  // below and past the contract at the bottom of it. Widening the try would
  // also stop the throw, but it would report "malformed data" for what is
  // really "the directory offset points past the end", so the guard belongs
  // here, on the read itself.
  const directoryLooksReal = end.cdOffset + 4 <= bytes.length && view.getUint32(end.cdOffset, true) === SIG_CENTRAL
  if (!directoryLooksReal) {
    // Once an end-of-central-directory record has been found, "this is not a
    // ZIP" has stopped being a true statement — and null carries no note, so
    // returning it here lets absence read as safety at the outermost boundary
    // of the module. A stub prepended to an archive (a polyglot, a dropper)
    // lands exactly here, with word/vbaProject.bin plainly inside.
    //
    // ponytail: prepending shifts every stored offset by one constant, so
    // scanning for the real directory and rebasing by that delta would list
    // such a container properly. That delta has to reach locateData too, so it
    // is a deliberate next step rather than part of this guard.
    facts.notes.push(
      `An end-of-central-directory record was found, but there is no central directory at offset ${end.cdOffset} where it points, so nothing inside could be listed. That is what data prepended to an archive looks like — it leaves every stored offset stale — and a damaged record looks the same, and so do bytes that are not an archive at all with those four signature bytes falling where they did. Treat the contents as unknown, not as absent.`
    )
    return facts
  }

  try {
    const records = walkCentralDirectory(bytes, view, end, facts.notes)
    facts.entries = records.map(({ name, size, compressedSize, method, encrypted }) => ({
      name,
      size,
      compressedSize,
      method,
      encrypted
    }))
    if (records.length === 0) {
      facts.notes.push('No readable entries were found where the central directory said they would be.')
      return facts
    }
    await readRelationships(bytes, view, records, facts)
  } catch (error) {
    // Nothing in here reaches the caller as a throw. An analyst who opened a
    // hostile attachment still gets the rows that were read before the byte
    // that broke, with the break named.
    facts.notes.push(
      `Reading stopped on malformed data (${error instanceof Error ? error.message : String(error)}); everything listed was read before that point.`
    )
  }
  return facts
}
