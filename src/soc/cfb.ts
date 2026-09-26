/**
 * Which storages and streams a legacy .doc / .xls / .ppt / .msg holds, read
 * from its compound-file directory and nothing else.
 *
 * An OLE compound file is a small file system: a header, then fixed-size
 * sectors, an allocation table (the FAT) chaining them together, and a
 * directory of 128-byte entries naming every storage (a folder) and stream (a
 * file) inside. A `Macros` or `_VBA_PROJECT_CUR` storage, or an
 * `\x01Ole10Native` package stream, is visible from its directory entry for
 * the cost of following one sector chain. The header on its own never shows
 * one, because the directory starts in the first sector after it. No stream is
 * opened.
 *
 * Same standing rule as the rest of the SOC modules: this states what the
 * directory says and stops. No score, no rating, no "suspicious". A directory
 * with no macro-named entry is reported as a directory with no macro-named
 * entry — never as a document without macros, because a .ppt keeps its VBA
 * inside the `PowerPoint Document` stream and an Excel 4.0 macro sheet lives
 * inside `Workbook`, and neither has a name of its own here.
 *
 * The walk is flat: every allocated slot in the directory's sectors is listed,
 * in the order it sits, whether or not the storage tree still links to it. So
 * the list is what the directory holds — which can be more than Office would
 * open, never less.
 *
 * Nothing here fetches, resolves or expands anything. Every byte read came
 * from the array the caller passed in.
 *
 * ponytail: the allocation table is read only from the sectors named in the
 * header's 109 slots. That covers about 7 MB of a file with 512-byte sectors
 * and about 457 MB of one with 4,096-byte sectors, and a directory chain that
 * runs past it says so in a note. Following the DIFAT sector chain lifts the
 * ceiling; the mini-FAT, needed to open a small stream such as a .msg's
 * transport headers, is the step after that.
 */

/** One allocated slot of the directory, as written. */
export interface CfbEntry {
  /**
   * The name as the directory writes it, decoded from UTF-16LE. Written by
   * whoever built the file, so it can hold control characters — `\x01Ole10Native`
   * is a real one — and the caller escapes it for display. A code unit that is
   * half of a surrogate pair with no other half decodes as U+FFFD, the
   * standard mark for "not text".
   */
  name: string
  type: 'storage' | 'stream' | 'root'
  /**
   * Stream size in bytes, as the directory declares it. Not verified: no
   * stream chain is followed to check. For the root this is the size of the
   * mini stream that holds the small streams. `null` for a storage, which is a
   * folder and records no size — a "0 bytes" beside `Macros` would read as an
   * empty macro storage — and `null` when the declared number is too large for
   * this reader to represent exactly, because a made-up size is a wrong fact.
   */
  size: number | null
}

export interface CfbFacts {
  entries: CfbEntry[]
  /** Everything that could not be read, said out loud rather than left to look like absence. */
  notes: string[]
}

/** All eight bytes, the same test the attachment sniffer uses to call a file OLE. */
const MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const HEADER_BYTES = 512
/** Sector numbers above this are markers (end of chain, free, FAT, DIFAT), not places in the file. */
const MAX_REGULAR_SECTOR = 0xfffffffa
const END_OF_CHAIN = 0xfffffffe
const HEADER_FAT_SLOTS = 109
const ENTRY_BYTES = 128
/** The name field is 64 bytes: 31 UTF-16 code units and the terminator. */
const NAME_BYTES = 64
const TYPES: Record<number, CfbEntry['type']> = { 1: 'storage', 2: 'stream', 5: 'root' }

/**
 * Bounds. The input is a file an attacker sent on purpose, and each of these
 * names what it costs when it bites.
 */

/** A real document has tens of entries, a .msg with many attachments a few hundred. Past this, the rest are unknown and said to be. */
const MAX_ENTRIES = 4_096
/**
 * The visited set already stops a chain that loops, but a chain of thousands
 * of distinct sectors holding only unallocated slots never reaches the entry
 * cap. At 512-byte sectors, 1,024 of them hold 4,096 slots — the entry cap.
 */
const MAX_DIRECTORY_SECTORS = 1_024

const utf16 = new TextDecoder('utf-16le')

/**
 * Read an OLE compound file's directory.
 *
 * Returns null only when the eight-byte OLE signature is absent, so a caller
 * with its own handling for other files keeps it. Once the signature is
 * there, the answer is facts, even when nothing could be listed, because null
 * carries no note and absence would then read as safety.
 */
export function readCfb(bytes: Uint8Array): CfbFacts | null {
  if (bytes.length < MAGIC.length || MAGIC.some((b, i) => bytes[i] !== b)) return null
  const facts: CfbFacts = { entries: [], notes: [] }
  if (bytes.length < HEADER_BYTES) {
    facts.notes.push(
      `This begins with the compound-file signature but is ${bytes.length} bytes long, shorter than the ${HEADER_BYTES}-byte header, so nothing inside it could be listed. Treat the contents as unknown, not as absent.`
    )
    return facts
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const shift = view.getUint16(0x1e, true)
  if (shift !== 9 && shift !== 12) {
    facts.notes.push(
      `The header declares a sector shift of ${shift}, and this reader follows only 9 and 12 (512- and 4,096-byte sectors), so nothing inside could be listed. Treat the contents as unknown, not as absent.`
    )
    return facts
  }
  const sectorBytes = 2 ** shift

  // Sector n starts one sector in, because the header takes the place of
  // sector -1 — padded out to 4,096 bytes when the sectors are that size.
  // Multiplied, not shifted: a 32-bit shift would wrap a hostile sector number
  // back into the file.
  const sectorStart = (n: number): number | null => {
    const start = (n + 1) * sectorBytes
    return n <= MAX_REGULAR_SECTOR && start + sectorBytes <= bytes.length ? start : null
  }

  // The FAT sectors the header names, in order, up to the count it declares.
  // Only up to that count: a slot past it should be free, and a stale number
  // left there would have ordinary data read as links. The first slot that
  // names no sector inside the file ends the table: skipping it instead would
  // shift every later FAT sector into the wrong place in the table.
  const fatStarts: number[] = []
  const fatCount = Math.min(view.getUint32(0x2c, true), HEADER_FAT_SLOTS)
  for (let i = 0; i < fatCount; i++) {
    const start = sectorStart(view.getUint32(0x4c + i * 4, true))
    if (start === null) break
    fatStarts.push(start)
  }
  const linksPerSector = sectorBytes / 4
  const nextLink = (n: number): number | null => {
    const start = fatStarts[Math.floor(n / linksPerSector)]
    return start === undefined ? null : view.getUint32(start + (n % linksPerSector) * 4, true)
  }

  const visited = new Set<number>()
  let last: number | null = null
  let unrecognised = 0
  const stopped = (reason: string): void => {
    facts.notes.push(
      last === null
        ? `The directory could not be read from its first sector: ${reason}. Its entries are unknown, not absent.`
        : `The directory was not read past sector ${last}: ${reason}. Entries after that point are unknown, not absent.`
    )
  }

  let sector = view.getUint32(0x30, true)
  while (sector !== END_OF_CHAIN) {
    if (sector > MAX_REGULAR_SECTOR) {
      const value = `0x${sector.toString(16).toUpperCase()}`
      stopped(
        `${last === null ? `the header gives ${value} for it` : `its next link reads ${value}`}, which names no sector`
      )
      break
    }
    if (visited.has(sector)) {
      stopped(`it links back to sector ${sector}, which was already read`)
      break
    }
    if (visited.size >= MAX_DIRECTORY_SECTORS) {
      stopped(`${MAX_DIRECTORY_SECTORS} directory sectors were read, the most this reader follows`)
      break
    }
    const start = sectorStart(sector)
    if (start === null) {
      stopped(`sector ${sector} lies past the end of the file`)
      break
    }
    visited.add(sector)

    let full = false
    for (let at = start; at < start + sectorBytes; at += ENTRY_BYTES) {
      const code = bytes[at + 0x42]
      // Type 0 is an unallocated slot: a sector's spare room, not an entry.
      if (code === 0) continue
      const type = TYPES[code]
      if (!type) {
        unrecognised++
        continue
      }
      if (facts.entries.length >= MAX_ENTRIES) {
        full = true
        break
      }
      facts.entries.push({
        name: nameAt(bytes, view, at),
        type,
        size: type === 'storage' ? null : sizeAt(view, at, shift)
      })
    }
    if (full) {
      facts.notes.push(
        `Only the first ${MAX_ENTRIES} directory entries are listed; the directory was not read past sector ${sector}, so the rest are unknown, not absent.`
      )
      break
    }

    last = sector
    const link = nextLink(sector)
    if (link === null) {
      stopped(
        'its next link lies in a part of the allocation table this reader does not read — only the table sectors named in the file header, and found inside the file, are read'
      )
      break
    }
    sector = link
  }

  if (unrecognised) {
    facts.notes.push(
      `${unrecognised} directory ${unrecognised === 1 ? 'entry carries an object type' : 'entries carry object types'} this reader does not recognise, so ${unrecognised === 1 ? 'it is' : 'they are'} not listed. Not listed is not absent.`
    )
  }
  if (!facts.entries.length && !facts.notes.length) {
    facts.notes.push(
      'No allocated entries were found where the header said the directory would be, and a compound file always holds at least its root entry. Treat the contents as unknown, not as absent.'
    )
  }
  return facts
}

/**
 * The entry's name. The length field counts bytes and includes the two-byte
 * terminator; a hostile value past the 64-byte field is held to the field, so
 * no name can be longer than 31 code units.
 */
function nameAt(bytes: Uint8Array, view: DataView, at: number): string {
  const units = Math.max(0, (Math.min(view.getUint16(at + 0x40, true), NAME_BYTES) >> 1) - 1)
  return utf16.decode(bytes.subarray(at, at + units * 2))
}

function sizeAt(view: DataView, at: number, shift: number): number | null {
  const low = view.getUint32(at + 0x78, true)
  // With 512-byte sectors no stream can pass 2 GB, and the format's
  // specification tells readers to ignore the high half there, because old
  // writers left it uninitialised.
  if (shift === 9) return low
  const high = view.getUint32(at + 0x7c, true)
  // Past 2^53 a number stops being exact, so the size is stated as not recorded.
  return high < 0x20_0000 ? high * 0x1_0000_0000 + low : null
}

/**
 * Names Office treats as code or as a door to another file. Keys are upper
 * case because the format compares names that way, so `MACROS` is the same
 * storage to Word as `Macros`. `Macros` is Word's VBA storage and
 * `_VBA_PROJECT_CUR` Excel's; `VBA`, `_VBA_PROJECT` and `PROJECT` sit inside
 * either.
 */
const NOTABLE_NAMES = new Map([
  ['MACROS', 'named as VBA macro storage'],
  ['VBA', 'named as VBA macro storage'],
  ['_VBA_PROJECT', 'named as VBA macro storage'],
  ['_VBA_PROJECT_CUR', 'named as VBA macro storage'],
  ['PROJECT', 'named as VBA macro storage'],
  ['\u0001OLE10NATIVE', 'named as an embedded OLE package'],
  ['OBJECTPOOL', 'named as embedded objects']
])

/**
 * Why one directory entry name deserves the analyst's eye, or null.
 *
 * A statement about the NAME and nothing more, in the same words as the ZIP
 * reader's entry notes: a `Macros` storage could be empty, and — as the module
 * comment says — macros can live inside a stream with an ordinary name, so the
 * wording is "named as" and never "contains", and null never means "no macros".
 */
export function cfbNote(name: string): string | null {
  return NOTABLE_NAMES.get(name.toUpperCase()) ?? null
}
