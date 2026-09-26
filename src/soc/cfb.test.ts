import { describe, expect, it } from 'vitest'
import { cfbNote, readCfb } from './cfb'

const MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const FREE = 0xffffffff
const END = 0xfffffffe
const FAT_SECTOR = 0xfffffffd

/**
 * A compound file built by hand: the header, then `count` zeroed sectors.
 * `fat` names the FAT sectors (sector 0 alone unless a test needs more) and
 * sector 1 is the directory, one sector long until a test relinks it. Every
 * other link is free.
 */
function compound(count: number, shift: 9 | 12 = 9, fat = [0]) {
  const size = 2 ** shift
  const bytes = new Uint8Array((count + 1) * size)
  const view = new DataView(bytes.buffer)
  bytes.set(MAGIC)
  view.setUint16(0x1e, shift, true)
  view.setUint32(0x2c, fat.length, true)
  view.setUint32(0x30, 1, true)
  for (let i = 0; i < 109; i++) view.setUint32(0x4c + i * 4, fat[i] ?? FREE, true)
  const at = (n: number) => (n + 1) * size
  const perSector = size / 4
  const link = (n: number, next: number) =>
    view.setUint32(at(fat[Math.floor(n / perSector)]) + (n % perSector) * 4, next, true)
  for (let n = 0; n < fat.length * perSector; n++) link(n, FREE)
  for (const n of fat) link(n, FAT_SECTOR)
  link(1, END)
  /** Write a directory entry into slot `slot` of sector `sector`. */
  const entry = (sector: number, slot: number, name: string, type: number, low = 0, high = 0) => {
    const e = at(sector) + slot * 128
    for (let i = 0; i < name.length; i++) view.setUint16(e + i * 2, name.charCodeAt(i), true)
    view.setUint16(e + 0x40, (name.length + 1) * 2, true)
    bytes[e + 0x42] = type
    view.setUint32(e + 0x78, low, true)
    view.setUint32(e + 0x7c, high, true)
  }
  return { bytes, view, link, entry }
}

describe('readCfb', () => {
  it('returns null only when the eight-byte OLE signature is absent', () => {
    expect(readCfb(new TextEncoder().encode('Dear customer, please find attached.'))).toBeNull()
    expect(readCfb(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, ...new Uint8Array(600)]))).toBeNull()
    expect(readCfb(new Uint8Array(0))).toBeNull()
  })

  it('lists the storages and streams a macro .doc carries, across a two-sector directory', () => {
    // The 512-byte header can never show these names: the directory starts at
    // offset 512 at the earliest, which is why the hex view never had them.
    const f = compound(3)
    f.link(1, 2)
    f.link(2, END)
    f.entry(1, 0, 'Root Entry', 5, 1_536)
    f.entry(1, 1, 'Macros', 1, 999)
    f.entry(1, 2, 'VBA', 1)
    f.entry(1, 3, '\u0001Ole10Native', 2, 70_000, 0xdeadbeef)
    // Slot 0 of the second sector is left unallocated, as a sector's spare room is.
    f.entry(2, 1, '_VBA_PROJECT', 2, 1_024)
    f.entry(2, 2, 'WordDocument', 2, 4_096)
    const facts = readCfb(f.bytes)
    expect(facts).toEqual({
      entries: [
        { name: 'Root Entry', type: 'root', size: 1_536 },
        // A storage records no size, so none is printed, whatever its field holds.
        { name: 'Macros', type: 'storage', size: null },
        { name: 'VBA', type: 'storage', size: null },
        // With 512-byte sectors the high half of the size is ignored, as the specification says.
        { name: '\u0001Ole10Native', type: 'stream', size: 70_000 },
        { name: '_VBA_PROJECT', type: 'stream', size: 1_024 },
        { name: 'WordDocument', type: 'stream', size: 4_096 }
      ],
      notes: []
    })
    expect(facts?.entries.map((e) => cfbNote(e.name))).toEqual([
      null,
      'named as VBA macro storage',
      'named as VBA macro storage',
      'named as an embedded OLE package',
      'named as VBA macro storage',
      null
    ])
  })

  it('reads a version 4 file, whose header is padded to a 4,096-byte sector', () => {
    const f = compound(2, 12)
    f.entry(1, 0, 'Root Entry', 5)
    f.entry(1, 31, 'Workbook', 2, 5, 1)
    f.entry(1, 30, 'Huge', 2, 0, 0x20_0000)
    expect(readCfb(f.bytes)?.entries).toEqual([
      { name: 'Root Entry', type: 'root', size: 0 },
      // Past 2^53 the number is no longer exact, so it is stated as not recorded.
      { name: 'Huge', type: 'stream', size: null },
      { name: 'Workbook', type: 'stream', size: 2 ** 32 + 5 }
    ])
  })

  it('stops on a directory chain that loops, lists each entry once and says where it stopped', () => {
    const f = compound(3)
    f.link(1, 2)
    f.link(2, 1)
    f.entry(1, 0, 'Root Entry', 5)
    f.entry(2, 0, 'Macros', 1)
    const facts = readCfb(f.bytes)
    expect(facts?.entries.map((e) => e.name)).toEqual(['Root Entry', 'Macros'])
    expect(facts?.notes).toEqual([
      'The directory was not read past sector 2: it links back to sector 1, which was already read. Entries after that point are unknown, not absent.'
    ])

    // A sector that names itself as the next one is the same loop.
    const self = compound(2)
    self.link(1, 1)
    self.entry(1, 0, 'Root Entry', 5)
    expect(readCfb(self.bytes)?.notes).toEqual([
      'The directory was not read past sector 1: it links back to sector 1, which was already read. Entries after that point are unknown, not absent.'
    ])
  })

  it('says so when the chain needs a part of the allocation table the header does not name', () => {
    // One FAT sector covers sectors 0-127; the directory sits at 128, so its
    // next link is in a FAT sector that was never read. The second slot is
    // declared but points past the end of the file.
    const f = compound(129)
    f.view.setUint32(0x2c, 2, true)
    f.view.setUint32(0x4c + 4, 5_000, true)
    f.view.setUint32(0x30, 128, true)
    f.entry(128, 0, 'Root Entry', 5)
    f.entry(128, 1, 'ObjectPool', 1)
    const facts = readCfb(f.bytes)
    expect(facts?.entries.map((e) => e.name)).toEqual(['Root Entry', 'ObjectPool'])
    expect(facts?.notes).toEqual([
      'The directory was not read past sector 128: its next link lies in a part of the allocation table this reader does not read — only the table sectors named in the file header, and found inside the file, are read. Entries after that point are unknown, not absent.'
    ])
  })

  it('names the sector when a link points outside the file or at no sector at all', () => {
    const past = compound(2)
    past.link(1, 50)
    past.entry(1, 0, 'Root Entry', 5)
    expect(readCfb(past.bytes)?.notes).toEqual([
      'The directory was not read past sector 1: sector 50 lies past the end of the file. Entries after that point are unknown, not absent.'
    ])

    const free = compound(2)
    free.link(1, FREE)
    free.entry(1, 0, 'Root Entry', 5)
    expect(readCfb(free.bytes)?.notes).toEqual([
      'The directory was not read past sector 1: its next link reads 0xFFFFFFFF, which names no sector. Entries after that point are unknown, not absent.'
    ])

    const first = compound(2)
    first.view.setUint32(0x30, 9, true)
    expect(readCfb(first.bytes)).toEqual({
      entries: [],
      notes: [
        'The directory could not be read from its first sector: sector 9 lies past the end of the file. Its entries are unknown, not absent.'
      ]
    })
  })

  it('answers with a note, not null, when the header itself cannot be used', () => {
    const short = new Uint8Array(100)
    short.set(MAGIC)
    expect(readCfb(short)).toEqual({
      entries: [],
      notes: [
        'This begins with the compound-file signature but is 100 bytes long, shorter than the 512-byte header, so nothing inside it could be listed. Treat the contents as unknown, not as absent.'
      ]
    })

    const shift = compound(2)
    shift.view.setUint16(0x1e, 30, true)
    expect(readCfb(shift.bytes)?.notes).toEqual([
      'The header declares a sector shift of 30, and this reader follows only 9 and 12 (512- and 4,096-byte sectors), so nothing inside could be listed. Treat the contents as unknown, not as absent.'
    ])

    // Every slot unallocated: an empty list with nothing said would read as a clean file.
    expect(readCfb(compound(2).bytes)?.notes).toEqual([
      'No allocated entries were found where the header said the directory would be, and a compound file always holds at least its root entry. Treat the contents as unknown, not as absent.'
    ])
  })

  it('counts entries of an unknown object type instead of listing or hiding them', () => {
    const f = compound(2)
    f.entry(1, 0, 'Root Entry', 5)
    f.entry(1, 1, 'Odd', 3)
    f.entry(1, 2, 'Odder', 0x7f)
    expect(readCfb(f.bytes)).toEqual({
      entries: [{ name: 'Root Entry', type: 'root', size: 0 }],
      notes: [
        '2 directory entries carry object types this reader does not recognise, so they are not listed. Not listed is not absent.'
      ]
    })
  })

  it('holds a hostile name length to the 64-byte field', () => {
    const f = compound(2)
    f.entry(1, 0, 'R'.repeat(40), 5)
    f.view.setUint16(2 * 512 + 0x40, 0xffff, true)
    expect(readCfb(f.bytes)?.entries[0].name).toBe('R'.repeat(31))
  })

  it('stops listing at 4096 entries and says the rest are unknown', () => {
    // 4,096-byte sectors hold 32 entries each: 128 full sectors reach the cap,
    // and the 129th sector's entries are the ones not listed.
    const f = compound(131, 12)
    for (let s = 1; s <= 129; s++) {
      f.link(s, s === 129 ? END : s + 1)
      for (let slot = 0; slot < 32; slot++) f.entry(s, slot, `S${s}-${slot}`, 2)
    }
    const facts = readCfb(f.bytes)
    expect(facts?.entries).toHaveLength(4096)
    expect(facts?.entries.at(-1)?.name).toBe('S128-31')
    expect(facts?.notes).toEqual([
      'Only the first 4096 directory entries are listed; the directory was not read past sector 129, so the rest are unknown, not absent.'
    ])
  })

  it('stops following a long chain of empty sectors at 1024', () => {
    // Nothing allocated, so the entry cap never bites; the sector cap has to.
    const f = compound(1_100, 12, [0, 1_099])
    for (let s = 1; s < 1_050; s++) f.link(s, s + 1)
    f.entry(1, 0, 'Root Entry', 5)
    const facts = readCfb(f.bytes)
    expect(facts?.entries).toHaveLength(1)
    expect(facts?.notes).toEqual([
      'The directory was not read past sector 1024: 1024 directory sectors were read, the most this reader follows. Entries after that point are unknown, not absent.'
    ])
  })
})

describe('cfbNote', () => {
  it('names the macro, package and object-pool storages, ignoring letter case as the format does', () => {
    for (const name of ['Macros', 'VBA', '_VBA_PROJECT', '_VBA_PROJECT_CUR', 'PROJECT', 'MACROS', 'vba']) {
      expect(cfbNote(name)).toBe('named as VBA macro storage')
    }
    expect(cfbNote('\u0001Ole10Native')).toBe('named as an embedded OLE package')
    expect(cfbNote('ObjectPool')).toBe('named as embedded objects')
  })

  it('says nothing about ordinary names or a name that only contains a notable one', () => {
    for (const name of [
      'Root Entry',
      'WordDocument',
      'Workbook',
      '1Table',
      'Macros2',
      'Ole10Native',
      '\u0005SummaryInformation'
    ]) {
      expect(cfbNote(name)).toBeNull()
    }
  })
})
