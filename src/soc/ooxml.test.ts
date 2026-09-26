import { describe, expect, it } from 'vitest'
import { entryNote, readZipDocument } from './ooxml'
import { concat, deflateRaw, header, padCentralDirectory, type Part, zip } from '../../test/zip'

const enc = new TextEncoder()

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://lure.test/pay?a=1&amp;b=2" TargetMode="External"/>
</Relationships>`

describe('readZipDocument', () => {
  it('reports a legacy OLE document as not a ZIP so the caller keeps its own handling', async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0, ...new Uint8Array(40)])
    expect(await readZipDocument(ole)).toBeNull()
  })

  it('returns null for bytes that are not a container at all', async () => {
    expect(await readZipDocument(enc.encode('Dear customer, please find attached.'))).toBeNull()
    expect(await readZipDocument(new Uint8Array(4))).toBeNull()
  })

  it('lists every entry by name, size and method without inflating the body', async () => {
    const body = await deflateRaw(enc.encode('x'.repeat(4096)))
    const facts = await readZipDocument(
      zip([
        { name: '[Content_Types].xml', data: enc.encode('<Types/>') },
        { name: 'word/document.xml', data: body, method: 8, size: 4096 },
        { name: 'word/vbaProject.bin', data: enc.encode('macro'), method: 8 },
        { name: 'invoice.exe', data: enc.encode('MZ'), method: 93 },
        { name: 'locked.bin', data: enc.encode('????'), flags: 1 }
      ])
    )
    expect(facts).not.toBeNull()
    expect(facts?.entries.map((e) => e.name)).toEqual([
      '[Content_Types].xml',
      'word/document.xml',
      'word/vbaProject.bin',
      'invoice.exe',
      'locked.bin'
    ])
    const document_ = facts?.entries[1]
    expect(document_?.method).toBe('deflate')
    expect(document_?.size).toBe(4096)
    expect(document_?.compressedSize).toBe(body.length)
    expect(document_?.compressedSize).toBeLessThan(4096) // the body was never inflated to learn this
    expect(facts?.entries[0]?.method).toBe('stored')
    expect(facts?.entries[3]?.method).toBe('zstd')
    expect(facts?.entries[4]?.encrypted).toBe(true)
    expect(facts?.notes.join(' ')).toContain('1 entry is encrypted')
  })

  it('names an unrecognised compression method by its number rather than guessing', async () => {
    const facts = await readZipDocument(zip([{ name: 'a.bin', data: enc.encode('x'), method: 42 }]))
    expect(facts?.entries[0]?.method).toBe('other-42')
  })

  it('pulls external relationship targets out of a deflated .rels', async () => {
    const facts = await readZipDocument(
      zip([
        { name: 'word/document.xml', data: enc.encode('<w:document/>') },
        { name: 'word/_rels/document.xml.rels', data: await deflateRaw(enc.encode(RELS)), method: 8, size: RELS.length }
      ])
    )
    expect(facts?.externalTargets).toHaveLength(1)
    const [target] = facts?.externalTargets ?? []
    expect(target?.from).toBe('word/_rels/document.xml.rels')
    expect(target?.id).toBe('rId2')
    expect(target?.mode).toBe('External')
    expect(target?.type).toContain('attachedTemplate')
    // &amp; decoded: printing the raw entity shows the analyst a different URL than Word requests.
    expect(target?.target).toBe('https://lure.test/pay?a=1&b=2')
  })

  it('reads a stored .rels too', async () => {
    const facts = await readZipDocument(zip([{ name: '_rels/.rels', data: enc.encode(RELS) }]))
    expect(facts?.externalTargets.map((t) => t.target)).toEqual(['https://lure.test/pay?a=1&b=2'])
  })

  it('finds the directory behind a ZIP comment', async () => {
    const facts = await readZipDocument(zip([{ name: 'a.txt', data: enc.encode('hello') }], 'x'.repeat(300)))
    expect(facts?.entries.map((e) => e.name)).toEqual(['a.txt'])
  })

  it('says an encrypted .rels could not be read instead of reporting no targets', async () => {
    const facts = await readZipDocument(
      zip([{ name: 'word/_rels/document.xml.rels', data: enc.encode('encrypted-bytes'), flags: 1 }])
    )
    expect(facts?.externalTargets).toHaveLength(0)
    expect(facts?.notes.join(' ')).toContain('is encrypted, so its targets could not be read')
  })

  it('says why relationship parts were skipped once per reason, not once per part', async () => {
    // Skipped before the 64-part counter, one note each: 4,000 of them put
    // 4,000 lines on the card and in the report.
    const facts = await readZipDocument(
      zip(many(4_000, (i) => ({ name: `Invoice_${i}.exe.rels`, data: enc.encode('x'), flags: 1 })))
    )
    expect(facts?.notes).toEqual([
      '4000 entries are encrypted — their contents cannot be read from here, only their names and sizes.',
      '4000 relationship parts are encrypted, so their targets could not be read: Invoice_0.exe.rels, Invoice_1.exe.rels, Invoice_2.exe.rels, Invoice_3.exe.rels, Invoice_4.exe.rels and 3995 more.',
      '4000 inner files could not be read whole here — encrypted, damaged, over 8 MB, or compressed in a way this device cannot inflate — so they are not hashed here.'
    ])

    const mixed = await readZipDocument(
      zip([
        ...many(2, (i) => ({ name: `z${i}.rels`, data: new Uint8Array(0) })),
        ...many(2, (i) => ({ name: `m${i}.rels`, data: enc.encode('x'), method: 99 + i }))
      ])
    )
    expect(mixed?.notes).toContain(
      '2 relationship parts declare a compressed size of 0 bytes, so there was nothing in them to read: z0.rels, z1.rels.'
    )
    expect(mixed?.notes).toContain(
      '2 relationship parts are compressed in a way this reader cannot inflate, so their targets could not be read: m0.rels (aes), m1.rels (other-100).'
    )
  })

  it('stops a decompression bomb at the cap and keeps what it read', async () => {
    // Four megabytes of padding that deflates to a few kilobytes, with the
    // relationship written FIRST so the test proves both halves: the cap bites
    // and the targets already read survive it.
    const bomb = `${RELS}\n<!-- ${'A'.repeat(4_000_000)} -->`
    const facts = await readZipDocument(
      zip([
        { name: 'word/_rels/document.xml.rels', data: await deflateRaw(enc.encode(bomb)), method: 8, size: bomb.length }
      ])
    )
    expect(facts?.externalTargets).toHaveLength(1)
    expect(facts?.notes.join(' ')).toContain('expanded past')
  })

  it('does not throw when a directory entry declares a name longer than the file', async () => {
    const bytes = zip([{ name: 'a.txt', data: enc.encode('hello') }])
    const view = new DataView(bytes.buffer)
    // The central directory sits right after the one local entry + payload.
    const directoryAt = 30 + 'a.txt'.length + 'hello'.length
    expect(view.getUint32(directoryAt, true)).toBe(0x02014b50)
    view.setUint16(directoryAt + 28, 60_000, true) // nameLen far past the end of the buffer
    const facts = await readZipDocument(bytes)
    expect(facts).not.toBeNull()
    expect(facts?.entries).toHaveLength(0)
    expect(facts?.notes.join(' ')).toContain('declared more data than the file contains')
  })

  it('does not throw when the central directory offset points at rubbish', async () => {
    const bytes = zip([{ name: 'a.txt', data: enc.encode('hello') }])
    const view = new DataView(bytes.buffer)
    view.setUint32(bytes.length - 22 + 16, 3, true) // cdOffset into the middle of the local header
    const facts = await readZipDocument(bytes)
    expect(facts).not.toBeNull()
    expect(facts?.entries).toHaveLength(0)
    expect(facts?.notes.length).toBeGreaterThan(0)
  })

  it('names the scan window instead of concluding the container is damaged', async () => {
    const whole = zip([{ name: 'a.txt', data: enc.encode('hello') }])
    const facts = await readZipDocument(whole.subarray(0, whole.length - 10))
    expect(facts).not.toBeNull()
    expect(facts?.entries).toHaveLength(0)
    // "The file is truncated or damaged" is a cause this cannot know: an
    // archive carrying more than EOCD_SCAN bytes of trailing data is neither,
    // and lands on this same note.
    expect(facts?.notes.join(' ')).toContain('no end-of-central-directory record was found in its last')
    expect(facts?.notes.join(' ')).toContain('unknown, not as absent')
    expect(facts?.notes.join(' ')).not.toContain('truncated or damaged')
  })

  it('stays silent rather than claiming the container holds no relationship parts', async () => {
    const facts = await readZipDocument(zip([{ name: 'a.txt', data: enc.encode('hello') }]))
    expect(facts?.externalTargets).toHaveLength(0)
    // The empty list is the whole report. "This container holds no
    // relationship parts (.rels)" is an assertion about a file, made from a
    // walk that stops at a cap, at a corrupt record or at an understated
    // count — and it was pushed in every one of those cases.
    expect(facts?.notes.join(' ')).not.toMatch(/no relationship parts|no declared targets/i)
    expect(facts?.notes.join(' ')).not.toMatch(/clean|safe|none found/i)
  })

  it('does not deny relationship parts when the entry listing stopped at the cap', async () => {
    // The bigbook.xlsx shape: 4,096 ordinary entries and a .rels holding an
    // external hyperlink as the LAST record, so the truncated listing is what
    // makes the container look like it has none.
    const many: Part[] = Array.from({ length: 4_096 }, (_, i) => ({ name: `f${i}.txt`, data: new Uint8Array(0) }))
    many.push({ name: 'xl/worksheets/_rels/sheet1.xml.rels', data: enc.encode(RELS) })
    const facts = await readZipDocument(zip(many))
    expect(facts?.entries).toHaveLength(4_096)
    expect(facts?.externalTargets).toHaveLength(0)
    expect(facts?.notes.join(' ')).toContain('Stopped after 4096 entries')
    expect(facts?.notes.join(' ')).not.toMatch(/no relationship parts|no declared targets/i)
  })

  it('degrades out loud when the device cannot inflate', async () => {
    const saved = globalThis.DecompressionStream
    Reflect.deleteProperty(globalThis, 'DecompressionStream')
    try {
      const facts = await readZipDocument(
        zip([
          { name: 'word/document.xml', data: enc.encode('<w:document/>') },
          {
            name: 'word/_rels/document.xml.rels',
            data: await deflateRaw(enc.encode(RELS)),
            method: 8,
            size: RELS.length
          }
        ])
      )
      expect(facts?.entries).toHaveLength(2)
      expect(facts?.externalTargets).toHaveLength(0)
      expect(facts?.notes.join(' ')).toContain('cannot inflate compressed data')
      expect(facts?.notes.join(' ')).toContain('unknown, not as absent')
      // It used to add "The entry list is complete" — which the walk cannot
      // promise, having its own cap and its own ways of stopping early.
      expect(facts?.notes.join(' ')).not.toContain('entry list is complete')
    } finally {
      Object.defineProperty(globalThis, 'DecompressionStream', { value: saved, configurable: true, writable: true })
    }
  })

  it('caps the number of entries it will walk', async () => {
    const many = Array.from({ length: 4_200 }, (_, i) => ({ name: `f${i}.txt`, data: new Uint8Array(0) }))
    const facts = await readZipDocument(zip(many))
    expect(facts?.entries).toHaveLength(4_096)
    expect(facts?.notes.join(' ')).toContain('Stopped after 4096 entries')
  })

  it('says nothing about the cap when the container holds exactly the cap', async () => {
    // 4,096 entries, every one of them listed. "this container holds more, and
    // they were not listed" was pushed on the count alone, so an ordinary
    // archive of exactly this size was told it was missing entries.
    const many = Array.from({ length: 4_096 }, (_, i) => ({ name: `f${i}.txt`, data: new Uint8Array(0) }))
    const facts = await readZipDocument(zip(many))
    expect(facts?.entries).toHaveLength(4_096)
    expect(facts?.notes.join(' ')).not.toContain('Stopped after')
    expect(facts?.notes.join(' ')).not.toContain('stopped at record')
    expect(facts?.notes.join(' ')).not.toContain('central directory declares')
  })

  it('does not throw when the directory offset sits at the very end of the file', async () => {
    // The EOCD only has to satisfy cdOffset + cdSize <= length, so cdSize 0
    // puts cdOffset legally at EOF — and the four-byte probe there used to run
    // off the DataView and reject the promise instead of returning facts.
    const bare = new Uint8Array(22)
    const view = new DataView(bare.buffer)
    view.setUint32(0, 0x06054b50, true)
    view.setUint32(12, 0, true) // cdSize
    view.setUint32(16, 22, true) // cdOffset === bytes.length
    expect(await readZipDocument(bare)).not.toBeNull()

    // The same four bytes flipped in a real container, one short of the end.
    for (const offset of [0, 1, 2]) {
      const bytes = zip([{ name: 'a.txt', data: enc.encode('hello') }])
      const eocd = new DataView(bytes.buffer, bytes.length - 22)
      eocd.setUint32(12, 0, true)
      eocd.setUint32(16, bytes.length - offset, true)
      const facts = await readZipDocument(bytes)
      expect(facts).not.toBeNull()
      expect(facts?.notes.length).toBeGreaterThan(0)
    }
  })

  it('says how far the entry listing got when a central record is corrupt', async () => {
    const parts = [
      { name: '[Content_Types].xml', data: enc.encode('<Types/>') },
      { name: 'word/document.xml', data: enc.encode('<w:document/>') },
      { name: 'word/vbaProject.bin', data: enc.encode('macro') },
      { name: 'oleObject1.bin', data: enc.encode('ole') },
      { name: 'invoice.exe', data: enc.encode('MZ') }
    ]
    const bytes = zip(parts)
    const view = new DataView(bytes.buffer)
    const directoryAt = parts.reduce((total, p) => total + 30 + p.name.length + p.data.length, 0)
    const thirdAt = parts.slice(0, 2).reduce((total, p) => total + 46 + p.name.length, directoryAt)
    expect(view.getUint32(thirdAt, true)).toBe(0x02014b50)
    view.setUint32(thirdAt, 0x02014b51, true) // one bit, and three entries disappear

    const facts = await readZipDocument(bytes)
    expect(facts?.entries.map((e) => e.name)).toEqual(['[Content_Types].xml', 'word/document.xml'])
    // The three that vanished must be stated, not left to look like absence.
    expect(facts?.notes.join(' ')).toContain('stopped at record 3 of the 5')
    expect(facts?.notes.join(' ')).toContain('the rest were not read')
    // …and the short listing must not then be used to deny what is in them.
    expect(facts?.notes.join(' ')).not.toMatch(/no relationship parts|no declared targets/i)
  })

  it('does not claim the directory holds no record where a record declared too much', async () => {
    // The walk stops because record 3 declares more data than the file
    // contains. "…where the central directory does not hold one" contradicts
    // the note directly above it, which says that record is there.
    const parts = [
      { name: 'a.txt', data: enc.encode('one') },
      { name: 'b.txt', data: enc.encode('two') },
      { name: 'c.txt', data: enc.encode('three') }
    ]
    const bytes = zip(parts)
    const view = new DataView(bytes.buffer)
    const directoryAt = parts.reduce((total, p) => total + 30 + p.name.length + p.data.length, 0)
    const thirdAt = parts.slice(0, 2).reduce((total, p) => total + 46 + p.name.length, directoryAt)
    expect(view.getUint32(thirdAt, true)).toBe(0x02014b50)
    view.setUint16(thirdAt + 28, 60_000, true) // nameLen far past the end of the buffer

    const facts = await readZipDocument(bytes)
    expect(facts?.entries.map((e) => e.name)).toEqual(['a.txt', 'b.txt'])
    expect(facts?.notes.join(' ')).toContain('declared more data than the file contains')
    expect(facts?.notes.join(' ')).toContain('stopped at record 3 of the 3')
    expect(facts?.notes.join(' ')).not.toContain('does not hold one')
  })

  it('reports the leftover directory bytes when the declared entry count is understated too', async () => {
    // Four records written, the third corrupted, and the EOCD count lowered to
    // match the damage — so the count reconciles and the short listing passes
    // for a complete one. The note states the two byte figures and claims
    // nothing about what is in the bytes it did not read.
    const parts = [
      { name: 'word/document.xml', data: enc.encode('<w:document/>') },
      { name: 'word/styles.xml', data: enc.encode('<w:styles/>') },
      { name: 'word/vbaProject.bin', data: enc.encode('macro') },
      { name: 'word/_rels/document.xml.rels', data: enc.encode(RELS) }
    ]
    const bytes = zip(parts)
    const view = new DataView(bytes.buffer)
    const directoryAt = parts.reduce((total, p) => total + 30 + p.name.length + p.data.length, 0)
    const thirdAt = parts.slice(0, 2).reduce((total, p) => total + 46 + p.name.length, directoryAt)
    expect(view.getUint32(thirdAt, true)).toBe(0x02014b50)
    view.setUint32(thirdAt, 0x02014b51, true)
    view.setUint16(bytes.length - 22 + 8, 2, true) // understated count, both copies
    view.setUint16(bytes.length - 22 + 10, 2, true)

    const facts = await readZipDocument(bytes)
    expect(facts?.entries).toHaveLength(2)
    expect(facts?.notes.join(' ')).toContain('central directory declares')
    expect(facts?.notes.join(' ')).toContain('room for at least one more entry record')
    expect(facts?.notes.join(' ')).not.toMatch(/no relationship parts|no declared targets/i)
  })

  it('says a relationship part could not be read rather than reporting no targets', async () => {
    const whole = await deflateRaw(enc.encode(RELS))
    const cases: Record<string, Uint8Array> = {
      'a stream cut in half': whole.subarray(0, Math.floor(whole.length / 2)),
      'a stream missing its tail': whole.subarray(0, whole.length - 8),
      'bytes that are not deflate at all': enc.encode('this is not a deflate stream, it is prose'.repeat(4))
    }
    // Asserted as one object so a failure names the shape that stayed silent
    // and prints the notes it produced instead.
    const verdict: Record<string, string> = {}
    for (const [why, data] of Object.entries(cases)) {
      const facts = await readZipDocument(
        zip([{ name: 'word/_rels/document.xml.rels', data, method: 8, size: RELS.length }])
      )
      const notes = facts?.notes.join(' ') ?? ''
      // The reassuring note must not be the only thing the analyst sees.
      verdict[why] =
        /unknown, not absent/.test(notes) && !notes.includes('no relationship parts') ? 'said out loud' : notes
    }
    expect(verdict).toEqual({
      'a stream cut in half': 'said out loud',
      'a stream missing its tail': 'said out loud',
      'bytes that are not deflate at all': 'said out loud'
    })
  })

  it('says so when a local header sends the read into some other entry', async () => {
    const bytes = zip([
      { name: '_rels/.rels', data: enc.encode(RELS) },
      { name: 'filler.bin', data: new Uint8Array(2_000).fill(0x41) }
    ])
    // The local header carries its own extra length, and it is attacker-written:
    // 300 lands `start` inside the next entry's payload.
    new DataView(bytes.buffer).setUint16(28, 300, true)
    const facts = await readZipDocument(bytes)
    expect(facts?.externalTargets).toHaveLength(0)
    // Said about the bytes read, which is all this knows. "…was not a
    // relationship part" is a verdict on the part, and the same code path is
    // reached by a genuine .rels whose declarations sit past a cap.
    expect(facts?.notes.join(' ')).toContain('No relationship declarations appear in the bytes read for _rels/.rels')
  })

  it('keeps a target whose URL holds an unescaped > character', async () => {
    // XML 1.0 permits '>' raw inside an attribute value — only '<' and '&' must
    // be escaped — so this is well-formed OPC that Word opens. Cutting the
    // element at that '>' lost TargetMode and hid the lure entirely; with the
    // attributes the other way round it reported the target as ''.
    const rels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://x/attachedTemplate" Target="https://lure.test/a?x=>y" TargetMode="External"/>
<Relationship Id="rId2" TargetMode="External" Type="http://x/oleObject" Target="https://lure.test/b?x=>y"/>
</Relationships>`
    const facts = await readZipDocument(zip([{ name: '_rels/.rels', data: enc.encode(rels) }]))
    expect(facts?.externalTargets.map((t) => t.target)).toEqual([
      'https://lure.test/a?x=>y',
      'https://lure.test/b?x=>y'
    ])
    expect(facts?.externalTargets.map((t) => t.id)).toEqual(['rId1', 'rId2'])
  })

  it('scans a relationship part with no closing bracket without stalling', async () => {
    // 1 MB holding no '>' byte at all. Every '<Relationship' start sent the old
    // [^>]*> to the end of the buffer and back a character at a time, and the
    // starts are 14 bytes apart: 31 s for one part, and four central rows may
    // point at the same payload. Measured 2 min 33 s of blocked main thread.
    const hostile = enc.encode('<Relationship '.repeat(74_899).slice(0, 1_048_576))
    expect(hostile).toHaveLength(1_048_576)
    const bytes = zip(['a', 'b', 'c', 'd'].map((letter) => ({ name: `word/_rels/${letter}.xml.rels`, data: hostile })))
    const started = performance.now()
    const facts = await readZipDocument(bytes)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(1_000)
    expect(facts?.externalTargets).toHaveLength(0)
    expect(facts?.notes.join(' ')).toContain('could not delimit')
  })

  it('still reads a well-formed part of the same size in one pass', async () => {
    // The guard against the payload above must not cost anything on real input.
    //
    // The two External relationships are what make this test able to FAIL. It
    // used to assert only that no target came back, which a scanner that finds
    // nothing at all satisfies just as well — a neutered collectTargets kept
    // it green. One of these sits at the very END of the megabyte, so finding
    // it is what proves the whole part was scanned inside the time below.
    const one = '<Relationship Id="rId1" Type="http://x/t" Target="styles.xml"/>'
    const external = (id: string, url: string) =>
      `<Relationship Id="${id}" Type="http://x/attachedTemplate" Target="${url}" TargetMode="External"/>`
    const big = enc.encode(
      `<Relationships>${one.repeat(8_000)}${external('rIdMid', 'https://lure.test/middle')}${one.repeat(
        8_000
      )}${external('rIdEnd', 'https://lure.test/end')}</Relationships>`
    )
    expect(big.length).toBeLessThan(1_048_576) // read whole, so the last target is reachable
    const started = performance.now()
    const facts = await readZipDocument(zip([{ name: '_rels/.rels', data: big }]))
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(1_000)
    expect(facts?.externalTargets.map((t) => t.target)).toEqual(['https://lure.test/middle', 'https://lure.test/end'])
    expect(facts?.notes.join(' ')).not.toContain('could not delimit')
  })

  it('matches a .rels part whose name is too long to display in full', async () => {
    // The display name is cut short with an '…', which used to break the
    // `.rels` test and make the module state it held no relationship parts.
    const facts = await readZipDocument(
      zip([
        { name: 'word/document.xml', data: enc.encode('<w:document/>') },
        { name: `word/_rels/${'a'.repeat(1_100)}.rels`, data: enc.encode(RELS) }
      ])
    )
    expect(facts?.externalTargets.map((t) => t.target)).toEqual(['https://lure.test/pay?a=1&b=2'])
    expect(facts?.notes.join(' ')).not.toContain('no relationship parts')
    expect(facts?.notes.join(' ')).toContain('cut short')
  })

  it('reports a container with data prepended rather than calling it not a ZIP', async () => {
    const inner = zip([
      { name: 'word/document.xml', data: enc.encode('<w:document/>') },
      { name: 'word/vbaProject.bin', data: enc.encode('macro') },
      { name: 'word/_rels/document.xml.rels', data: enc.encode(RELS) }
    ])
    const facts = await readZipDocument(concat([new Uint8Array(4_096).fill(0x90), inner]))
    // null carries no note, so "not a ZIP" about bytes holding vbaProject.bin
    // is the one failure this module must never produce.
    expect(facts).not.toBeNull()
    expect(facts?.notes.join(' ')).toContain('data prepended')
    expect(facts?.notes.join(' ')).toContain('unknown, not as absent')
  })

  it('states a declared size it cannot represent as not recorded rather than as -1', async () => {
    const name = enc.encode('a.txt')
    const payload = new Uint8Array(40)
    const local = header(30, (v) => {
      v.setUint32(0, 0x04034b50, true)
      v.setUint16(26, name.length, true)
    })
    const extra = header(28, (v) => {
      v.setUint16(0, 0x0001, true) // ZIP64 extended information
      v.setUint16(2, 24, true)
      v.setBigUint64(4, 0xffffffffffffffffn, true) // size
      v.setBigUint64(12, 0xffffffffffffffffn, true) // compressed size
      v.setBigUint64(20, 0xffffffffffffffffn, true) // local offset
    })
    const central = header(46, (v) => {
      v.setUint32(0, 0x02014b50, true)
      v.setUint32(20, 0xffffffff, true)
      v.setUint32(24, 0xffffffff, true)
      v.setUint16(28, name.length, true)
      v.setUint16(30, extra.length, true)
      v.setUint32(42, 0xffffffff, true)
    })
    const eocd = header(22, (v) => {
      v.setUint32(0, 0x06054b50, true)
      v.setUint16(8, 1, true)
      v.setUint16(10, 1, true)
      v.setUint32(12, central.length + name.length + extra.length, true)
      v.setUint32(16, local.length + name.length + payload.length, true)
    })
    const facts = await readZipDocument(concat([local, name, payload, central, name, extra, eocd]))
    expect(facts?.entries).toHaveLength(1)
    expect(facts?.entries[0]?.name).toBe('a.txt')
    expect(facts?.entries[0]?.size).toBeNull()
    expect(facts?.entries[0]?.compressedSize).toBeNull()
    expect(facts?.notes.join(' ')).toContain('larger than this reader can represent')
  })

  it('does not call a complete listing short when the directory holds more than entry records', async () => {
    const parts = ['[Content_Types].xml', 'word/document.xml', 'word/vbaProject.bin', 'oleObject1.bin', 'invoice.exe']
    // 0x05054b50, the PKWARE archive-signature record: legal at the end of the
    // central directory and counted in cdSize. Reconciling the walk against
    // cdSize reported "stopped at record 6 of the 5 this archive declares"
    // about this — every declared entry read, and a sentence that contradicts
    // itself in its own numbers.
    const signature = new Uint8Array([0x50, 0x4b, 0x05, 0x05, 0x00, 0x00])
    const facts = await readZipDocument(
      padCentralDirectory(zip(parts.map((name) => ({ name, data: enc.encode('x') }))), signature)
    )
    expect(facts?.entries.map((e) => e.name)).toEqual(parts)
    expect(facts?.notes.join(' ')).not.toContain('stopped at record')
  })

  it('does not call a complete listing short when cdSize overstates the directory', async () => {
    const facts = await readZipDocument(
      padCentralDirectory(zip([{ name: 'a.txt', data: enc.encode('hello') }]), new Uint8Array(16))
    )
    expect(facts?.entries.map((e) => e.name)).toEqual(['a.txt'])
    expect(facts?.notes.join(' ')).not.toContain('stopped at record')
  })

  it('states unrepresentable sizes as one counted note, not one note per entry', async () => {
    // 4,096 rows each carrying this extra field bought 4,096 identical
    // sentences from a 316 KB container. Sixty-four is the same shape.
    const count = 64
    const locals: Uint8Array[] = []
    const centrals: Uint8Array[] = []
    let offset = 0
    for (let i = 0; i < count; i++) {
      const name = enc.encode(`f${i}.bin`)
      const local = header(30, (v) => {
        v.setUint32(0, 0x04034b50, true)
        v.setUint16(26, name.length, true)
      })
      const extra = header(28, (v) => {
        v.setUint16(0, 0x0001, true)
        v.setUint16(2, 24, true)
        v.setBigUint64(4, 0xffffffffffffffffn, true)
        v.setBigUint64(12, 0xffffffffffffffffn, true)
        v.setBigUint64(20, 0xffffffffffffffffn, true)
      })
      const central = header(46, (v) => {
        v.setUint32(0, 0x02014b50, true)
        v.setUint32(20, 0xffffffff, true)
        v.setUint32(24, 0xffffffff, true)
        v.setUint16(28, name.length, true)
        v.setUint16(30, extra.length, true)
        v.setUint32(42, 0xffffffff, true)
      })
      locals.push(local, name)
      centrals.push(central, name, extra)
      offset += local.length + name.length
    }
    const directory = concat(centrals)
    const eocd = header(22, (v) => {
      v.setUint32(0, 0x06054b50, true)
      v.setUint16(8, count, true)
      v.setUint16(10, count, true)
      v.setUint32(12, directory.length, true)
      v.setUint32(16, offset, true)
    })
    const facts = await readZipDocument(concat([...locals, directory, eocd]))
    expect(facts?.entries).toHaveLength(count)
    expect(facts?.entries.every((e) => e.size === null)).toBe(true) // the fact itself is still reported
    const said = facts?.notes.filter((n) => n.includes('larger than this reader can represent')) ?? []
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('64 entries')
    expect(said[0]).toContain('f0.bin') // named, so the analyst can find one
  })

  it('keeps reading a relationship part after an element with a missing quote', async () => {
    // One stray byte — Target="styles.xml/> — flips the quote parity for
    // everything after it, and abandoning the part there lost three genuine
    // lures to it.
    const rels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://x/styles" Target="styles.xml/>
<Relationship Id="rId2" Type="http://x/attachedTemplate" Target="https://lure.test/template" TargetMode="External"/>
<Relationship Id="rId3" Type="http://x/oleObject" Target="https://lure.test/ole" TargetMode="External"/>
<Relationship Id="rId4" Type="http://x/hyperlink" Target="https://lure.test/link" TargetMode="External"/>
</Relationships>`
    const facts = await readZipDocument(zip([{ name: '_rels/.rels', data: enc.encode(rels) }]))
    expect(facts?.externalTargets.map((t) => t.target)).toEqual([
      'https://lure.test/template',
      'https://lure.test/ole',
      'https://lure.test/link'
    ])
    // Nothing is invented for the broken one: reading a '>' inside its runaway
    // attribute value reports 'styles.xml/>\n<Relationship Id=' as a target,
    // which is a wrong fact where this is a missing one.
    expect(facts?.externalTargets.map((t) => t.target).join(' ')).not.toContain('styles.xml')
    expect(facts?.notes.join(' ')).toContain('a relationship element this reader could not delimit')
  })

  it('never reads one element together with the next when a quote runs away', async () => {
    // `Z="` opens a value that is never closed, so the end scan crossed into
    // the following elements and read this INTERNAL relationship's Target with
    // a later element's TargetMode: one row, {internal.xml, External}, and the
    // genuine lure at the end reported not at all. A raw '<' cannot appear
    // inside an attribute value in XML, so it ends the element instead.
    const rels =
      '<Relationships><Relationship Id="a" Target="internal.xml" Z="<Relationship Id="b" Q="' +
      '<Relationship Id="rGood" Type="http://x/attachedTemplate" Target="https://lure.test/real" TargetMode="External"/>' +
      '</Relationships>'
    const facts = await readZipDocument(zip([{ name: '_rels/.rels', data: enc.encode(rels) }]))
    expect(facts?.externalTargets.map((t) => t.target)).toEqual(['https://lure.test/real'])
    expect(facts?.externalTargets.map((t) => t.id)).toEqual(['rGood'])
    // The internal one must not appear at all, least of all as External.
    expect(JSON.stringify(facts?.externalTargets)).not.toContain('internal.xml')
    expect(facts?.notes.join(' ')).toContain('2 relationship elements this reader could not delimit')
  })

  it('bounds the rescan when every element in a part fails to close', async () => {
    // Resynchronising costs a scan to the end of the part per failure, so this
    // is the payload that bound exists for: four quotes per element, so the
    // quote parity at the end is the same from every start, and one stray
    // quote before the only '>' in the megabyte — every element then fails,
    // and nothing is recoverable by carrying on. Unbounded that is 40,000
    // scans of 1 MB.
    const body = '<Relationship x="y" z="w" '.repeat(40_331).slice(0, 1_048_574) + '">'
    expect(body).toHaveLength(1_048_576)
    const started = performance.now()
    const facts = await readZipDocument(zip([{ name: '_rels/.rels', data: enc.encode(body) }]))
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(facts?.externalTargets).toHaveLength(0)
    // The ceiling is disclosed as the number actually counted. "More than 16"
    // is a claim about a seventeenth element that this never looked for: it
    // stops ON the sixteenth, and sixteen malformed elements followed by
    // well-formed ones is an ordinary shape.
    expect(facts?.notes.join(' ')).toContain('16 relationship elements this reader could not delimit')
    expect(facts?.notes.join(' ')).not.toContain('more than 16')
    expect(facts?.notes.join(' ')).toContain('was not read')
  })

  it('reads a relationship part that uses a namespace prefix instead of denying it is one', async () => {
    // <r:Relationship> is the same part in legal XML. It matched neither the
    // scanner nor the shape check, so its targets were missed AND the note
    // said "was not a relationship part" about one that plainly is.
    const rels = `<?xml version="1.0"?>
<r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships">
<r:Relationship Id="rId1" Type="http://x/attachedTemplate" Target="https://lure.test/prefixed" TargetMode="External"/>
</r:Relationships>`
    const facts = await readZipDocument(zip([{ name: '_rels/.rels', data: enc.encode(rels) }]))
    expect(facts?.externalTargets.map((t) => t.target)).toEqual(['https://lure.test/prefixed'])
    expect(facts?.notes.join(' ')).not.toContain('not a relationship part')
  })

  it('does not say an element never closes when reading stopped before it could', async () => {
    // The part runs past the 1 MB output cap, and the cut lands inside the
    // last element — whose quote closes a few bytes later, in the file.
    // "Never closed" is a statement about the file, and this one is false.
    const head = '<Relationships>'
    const last = '<Relationship Id="rId1" Type="http://x/t" Target="https://lure.test/cut" TargetMode="External"/>'
    const payload = head + 'A'.repeat(1_048_576 - 20 - head.length) + last
    const facts = await readZipDocument(zip([{ name: '_rels/.rels', data: enc.encode(payload) }]))
    const notes = facts?.notes.join(' ') ?? ''
    expect(notes).toContain('was read only that far') // where the read stopped, with its number
    expect(notes).toContain('could not delimit') // what happened to the element, and nothing more
    expect(notes).not.toContain('never close')
  })

  it('does not call a genuine relationship part something else when the cap cut it short', async () => {
    // A real .rels carrying a megabyte of leading comment: the declarations
    // are there, just past where reading stopped. "held no relationship
    // declarations at all, so what was read for it was not a relationship
    // part" is a verdict on the part, and it is wrong on this one.
    const payload = `<!--${'A'.repeat(1_048_600)}-->${RELS}`
    const facts = await readZipDocument(zip([{ name: '_rels/.rels', data: enc.encode(payload) }]))
    const notes = facts?.notes.join(' ') ?? ''
    expect(facts?.externalTargets).toHaveLength(0)
    expect(notes).toContain('was read only that far')
    expect(notes).toContain('No relationship declarations appear in the bytes read for _rels/.rels')
    expect(notes).not.toContain('was not a relationship part')
    expect(notes).not.toContain('held no relationship declarations at all')
  })

  it('says the external-target cap once, not once per relationship part', async () => {
    const rel = (i: number) =>
      `<Relationship Id="rId${i}" Type="http://x/t" Target="https://lure.test/${i}" TargetMode="External"/>`
    const many = `<Relationships>${Array.from({ length: 600 }, (_, i) => rel(i)).join('')}</Relationships>`
    const few = `<Relationships>${rel(9_001)}</Relationships>`
    const facts = await readZipDocument(
      zip([
        { name: '_rels/.rels', data: enc.encode(many) },
        { name: 'word/_rels/document.xml.rels', data: enc.encode(few) },
        { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(few) }
      ])
    )
    expect(facts?.externalTargets).toHaveLength(512)
    expect(facts?.notes.filter((n) => n.includes('The list of external targets stops at 512')).length).toBe(1)
  })

  it('says the target cap stopped the list, not that more external targets are declared', async () => {
    // The scan stops on the start that FOLLOWS the 512th target, and that
    // start is an internal relationship here — so "more than 512 external
    // targets are declared in this container" is a count never made.
    const rel = (i: number) =>
      `<Relationship Id="rId${i}" Type="http://x/t" Target="https://lure.test/${i}" TargetMode="External"/>`
    const xml = `<Relationships>${Array.from({ length: 512 }, (_, i) => rel(i)).join(
      ''
    )}<Relationship Id="rLast" Type="http://x/styles" Target="styles.xml"/></Relationships>`
    const facts = await readZipDocument(zip([{ name: '_rels/.rels', data: enc.encode(xml) }]))
    expect(facts?.externalTargets).toHaveLength(512)
    expect(facts?.notes.join(' ')).toContain('The list of external targets stops at 512')
    expect(facts?.notes.join(' ')).not.toMatch(/More than 512 external targets are declared/)
  })

  it('reports bytes that are not an archive but carry the signature without picking a story', async () => {
    // Four planted bytes are enough to reach this path, and the note used to
    // lead with "the file may have data prepended to it" about a JPEG. It
    // cannot tell a polyglot dropper from a coincidence, so it says so.
    const blob = new Uint8Array(4_000)
    blob.set([0xff, 0xd8, 0xff, 0xe0])
    new DataView(blob.buffer).setUint32(3_900, 0x06054b50, true)
    const facts = await readZipDocument(blob)
    expect(facts).not.toBeNull()
    const notes = facts?.notes.join(' ') ?? ''
    expect(notes).toContain('declares 0 entries and a central directory of 0 bytes')
    expect(notes).toContain('not an archive at all')
    // Bytes carrying no such signature are still null, so a caller with its
    // own legacy handling keeps it.
    expect(await readZipDocument(enc.encode('Dear customer, please find attached.'))).toBeNull()
  })

  it('reads an empty relationship part as empty instead of reading the rest of the file', async () => {
    // A 0-byte `_rels/.rels` followed by a part carrying relationship markup.
    // Treating the declared 0 as "length unknown, read to the end of the
    // container" handed the FOLLOWING entry's bytes to the XML scanner, and
    // its external target was printed as this part's — a URL declared nowhere
    // the analyst is told to look, attributed to an entry the same output
    // lists as 0 bytes.
    const facts = await readZipDocument(
      zip([
        { name: '_rels/.rels', data: new Uint8Array(0) },
        { name: 'word/embeddings/snippet.xml', data: enc.encode(RELS) }
      ])
    )
    expect(facts?.entries.map((e) => e.compressedSize)).toEqual([0, RELS.length])
    expect(facts?.externalTargets).toEqual([])
    expect(JSON.stringify(facts)).not.toContain('lure.test')
    expect(facts?.notes.join(' ')).toContain('_rels/.rels declares a compressed size of 0 bytes')
    // …and not the cap note, which was printed about a part of 0 bytes.
    expect(facts?.notes.join(' ')).not.toContain('was read only that far')
  })

  it('refuses a stored part whose length lives in a data descriptor rather than guessing it', async () => {
    // Bit 3 set: the size really is missing, not zero. A deflate stream can be
    // read without it because the stream ends itself; a stored entry has no
    // end marker, so "the rest of the file" would print the next entry's
    // targets again by another door.
    const facts = await readZipDocument(
      zip([
        { name: '_rels/.rels', data: new Uint8Array(0), flags: 8 },
        { name: 'word/embeddings/snippet.xml', data: enc.encode(RELS) }
      ])
    )
    expect(facts?.externalTargets).toEqual([])
    expect(JSON.stringify(facts)).not.toContain('lure.test')
    expect(facts?.notes.join(' ')).toContain('_rels/.rels could not be read from the bytes in this file')
  })

  it('still reads a deflated part whose compressed size is left to the data descriptor', async () => {
    // The same bit 3, where it can be honoured: the deflate stream carries its
    // own end, so nothing is guessed and the lure is still found.
    const facts = await readZipDocument(
      zip([
        {
          name: 'word/_rels/document.xml.rels',
          data: await deflateRaw(enc.encode(RELS)),
          method: 8,
          flags: 8,
          size: RELS.length
        },
        { name: 'word/document.xml', data: enc.encode('<w:document/>') }
      ])
    )
    expect(facts?.externalTargets.map((t) => t.target)).toEqual(['https://lure.test/pay?a=1&b=2'])
  })

  it('does not report an unrepresentable OFFSET as an unrecorded size', async () => {
    // ZIP64 with ordinary sizes and a 64-bit offset past MAX_SAFE_INTEGER. The
    // size note was pushed for it anyway, beside an entry row showing size 7 —
    // a note contradicting the module's own table. The offset is reported
    // where it bites: the part cannot be located, so its targets are not read.
    const name = enc.encode('word/_rels/document.xml.rels')
    const payload = new Uint8Array(7)
    const local = header(30, (v) => {
      v.setUint32(0, 0x04034b50, true)
      v.setUint32(18, 7, true)
      v.setUint32(22, 7, true)
      v.setUint16(26, name.length, true)
    })
    const extra = header(12, (v) => {
      v.setUint16(0, 0x0001, true)
      v.setUint16(2, 8, true)
      v.setBigUint64(4, 0xffffffffffffffffn, true) // offset only: the sizes are real
    })
    const central = header(46, (v) => {
      v.setUint32(0, 0x02014b50, true)
      v.setUint32(20, 7, true)
      v.setUint32(24, 7, true)
      v.setUint16(28, name.length, true)
      v.setUint16(30, extra.length, true)
      v.setUint32(42, 0xffffffff, true)
    })
    const eocd = header(22, (v) => {
      v.setUint32(0, 0x06054b50, true)
      v.setUint16(8, 1, true)
      v.setUint16(10, 1, true)
      v.setUint32(12, central.length + name.length + extra.length, true)
      v.setUint32(16, local.length + name.length + payload.length, true)
    })
    const facts = await readZipDocument(concat([local, name, payload, central, name, extra, eocd]))
    expect(facts?.entries[0]?.size).toBe(7)
    expect(facts?.entries[0]?.compressedSize).toBe(7)
    expect(facts?.notes.join(' ')).not.toContain('larger than this reader can represent')
    expect(facts?.notes.join(' ')).toContain('could not be read from the bytes in this file')
  })

  it('does not call an ordinary empty archive prepended or damaged', async () => {
    // An empty .zip is 22 bytes declaring 0 entries and a 0-byte directory, so
    // its cdOffset cannot point at a record — and it landed on the note about
    // a stale offset, which names prepended data and a damaged record and is
    // wrong about this file on both counts. The same 22 bytes can also be a
    // coincidence in a non-archive, which is why the note names that too
    // rather than calling this an empty archive outright.
    const empty = header(22, (v) => {
      v.setUint32(0, 0x06054b50, true)
    })
    const facts = await readZipDocument(empty)
    expect(facts?.entries).toHaveLength(0)
    expect(facts?.notes.join(' ')).toContain('declares 0 entries and a central directory of 0 bytes')
    expect(facts?.notes.join(' ')).toContain('not an archive at all')
    expect(facts?.notes.join(' ')).not.toContain('data prepended')
  })

  it('does not call an archive ZIP64 because a decoy record carries the sentinels', async () => {
    // 22 bytes of decoy parked after the real record, met first by the
    // backward scan. Returning out of the scan on it printed "This archive
    // uses the ZIP64 format" about an archive that does not — and lost the
    // real record, which is still inside the scan window.
    const decoy = header(22, (v) => {
      v.setUint32(0, 0x06054b50, true)
      v.setUint16(8, 0xffff, true)
      v.setUint16(10, 0xffff, true)
      v.setUint32(12, 0xffffffff, true)
      v.setUint32(16, 0xffffffff, true)
    })
    const facts = await readZipDocument(
      concat([
        zip([
          { name: 'word/document.xml', data: enc.encode('<w:document/>') },
          { name: 'word/_rels/document.xml.rels', data: enc.encode(RELS) }
        ]),
        decoy
      ])
    )
    expect(facts?.entries.map((e) => e.name)).toEqual(['word/document.xml', 'word/_rels/document.xml.rels'])
    expect(facts?.externalTargets.map((t) => t.target)).toEqual(['https://lure.test/pay?a=1&b=2'])
    expect(facts?.notes.join(' ')).not.toMatch(/ZIP64/i)
  })
})

describe('the relationship list reports only what Word would read', () => {
  const rels = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`

  it('does not report a relationship that is commented out', async () => {
    // A lure quoted as an example, or left commented in a template, is not a
    // link the document uses. The scan used to find `<Relationship` inside
    // the comment and report it as declared.
    const facts = await readZipDocument(
      zip([
        {
          name: '_rels/.rels',
          data: enc.encode(
            rels(
              '<!-- <Relationship Id="rX" Type="t/hyperlink" Target="https://commented.lure/x" TargetMode="External"/> -->' +
                '<Relationship Id="r1" Type="t/hyperlink" Target="https://real.lure/y" TargetMode="External"/>'
            )
          )
        }
      ])
    )
    expect(facts?.externalTargets.map((t) => t.target)).toEqual(['https://real.lure/y'])
  })

  it('masks a DOCTYPE whose internal subset holds a `>`, and reads the relationship after it', async () => {
    const rels = `<!DOCTYPE Relationships [<!ENTITY x "a>b"> <!-- <Relationship Target="https://hidden.test/" TargetMode="External"/> -->]>
<Relationships>
<Relationship Id="r1" Type="t/x" Target="https://a.test/" TargetMode="External"/>
</Relationships>`
    const facts = await readZipDocument(zip([{ name: '_rels/.rels', data: enc.encode(rels) }]))
    expect(facts?.externalTargets.map((t) => t.target)).toEqual(['https://a.test/'])
  })

  it('scans parts of repeated DOCTYPEs in one pass', async () => {
    // Each `<!DOCTYPE` searched for `[` to the end of the part, and there is
    // none: 104,000 searches of up to a megabyte each. Four such parts fill one
    // container's inflation budget and each attachment has its own, so two
    // containers are 3.6 s apiece on an idle machine and 48 s under load. The
    // one Relationship is what makes the scan run at all.
    const part = `${'<!DOCTYPE>'.repeat(104_000)}<Relationship Id="r1" Type="t/x" Target="https://a.test/" TargetMode="External"/>`
    const data = await deflateRaw(enc.encode(part))
    const bytes = zip(
      ['a', 'b', 'c', 'd'].map((letter) => ({
        name: `word/_rels/${letter}.xml.rels`,
        data,
        method: 8,
        size: part.length
      }))
    )
    const started = performance.now()
    const results = [await readZipDocument(bytes), await readZipDocument(bytes)]
    expect(performance.now() - started).toBeLessThan(2_000)
    for (const facts of results) expect(facts?.externalTargets).toHaveLength(4)
  })

  it('does not report a relationship inside CDATA or a processing instruction', async () => {
    const facts = await readZipDocument(
      zip([
        {
          name: '_rels/.rels',
          data: enc.encode(
            rels(
              '<![CDATA[<Relationship Id="rC" Target="https://cdata.lure/" TargetMode="External"/>]]>' +
                '<?pi <Relationship Id="rP" Target="https://pi.lure/" TargetMode="External"/> ?>'
            )
          )
        }
      ])
    )
    expect(facts?.externalTargets).toEqual([])
  })

  it('does not read text inside one attribute value as another attribute', async () => {
    // Single quotes are legal inside a double-quoted value. The old regex
    // found `TargetMode='External'` inside Target's own value and reported an
    // INTERNAL relationship as External.
    const facts = await readZipDocument(
      zip([
        {
          name: '_rels/.rels',
          // Target's double-quoted value holds a complete `TargetMode='External'`.
          // There is no TargetMode attribute on this element at all.
          data: enc.encode(rels(`<Relationship Id="r1" Type="t/x" Target="internal.xml' TargetMode='External' x='"/>`))
        }
      ])
    )
    expect(facts?.externalTargets).toEqual([])
  })

  it('still reports a genuine external relationship, prefixed or not', async () => {
    const facts = await readZipDocument(
      zip([
        {
          name: 'word/_rels/document.xml.rels',
          data: enc.encode(
            '<r:Relationships xmlns:r="x"><r:Relationship Id="rId9" Type="t/attachedTemplate" Target="https://tpl.lure/a.dotm" TargetMode="External"/></r:Relationships>'
          )
        }
      ])
    )
    expect(facts?.externalTargets).toEqual([
      {
        from: 'word/_rels/document.xml.rels',
        target: 'https://tpl.lure/a.dotm',
        mode: 'External',
        type: 't/attachedTemplate',
        id: 'rId9'
      }
    ])
  })

  it('reads a relationship part written in UTF-16, instead of saying it holds none', async () => {
    const text = rels('<Relationship Id="r1" Type="t/x" Target="https://utf16.lure/" TargetMode="External"/>')
    const body = new Uint8Array(2 + text.length * 2)
    body[0] = 0xff
    body[1] = 0xfe
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      body[2 + i * 2] = code & 0xff
      body[3 + i * 2] = code >> 8
    }
    const facts = await readZipDocument(zip([{ name: '_rels/.rels', data: body }]))
    expect(facts?.externalTargets.map((t) => t.target)).toEqual(['https://utf16.lure/'])
    expect(facts?.notes.join(' ')).not.toContain('No relationship declarations appear')
  })

  it('does not say a part failed to decompress when trailing bytes followed a complete stream', async () => {
    // A declared compressed size longer than the stream makes the decompressor
    // error on the junk AFTER it — having already produced the whole part.
    const deflated = await deflateRaw(
      enc.encode(rels('<Relationship Id="r1" Type="t/x" Target="https://whole.lure/" TargetMode="External"/>'))
    )
    const padded = concat([deflated, enc.encode('TRAILING-JUNK-AFTER-THE-STREAM')])
    const facts = await readZipDocument(zip([{ name: '_rels/.rels', data: padded, method: 8 }]))
    expect(facts?.externalTargets.map((t) => t.target)).toEqual(['https://whole.lure/'])
    expect(facts?.notes.join(' ')).not.toContain('could not be fully decompressed')
  })
})

describe('sizes the directory cannot state', () => {
  it('reports an unresolved ZIP64 marker as unknown, never as 4,294,967,295', async () => {
    // 0xffffffff means "look in the ZIP64 field". With no field there, the
    // size is unknown — printing it gave a 200-byte file a 4.29 GB entry.
    const facts = await readZipDocument(zip([{ name: 'word/vbaProject.bin', data: enc.encode('x'), size: 0xffffffff }]))
    const entry = facts?.entries.find((e) => e.name === 'word/vbaProject.bin')
    expect(entry?.size).toBeNull()
    expect(facts?.notes.join(' ')).toContain('carries the ZIP64 size marker but no ZIP64 field')
  })
})

describe('entryNote', () => {
  it('says what a name is named as, and passes ordinary parts by', () => {
    expect(entryNote('word/vbaProject.bin')).toBe('named as a VBA macro project')
    expect(entryNote('xl/embeddings/oleObject1.bin')).toBe('named as an embedded OLE object')
    expect(entryNote('xl/externalLinks/externalLink1.xml')).toBe('named as a link to an external workbook')
    expect(entryNote('word/activeX/activeX1.xml')).toBe('named as an ActiveX control')
    expect(entryNote('word/embeddings/Microsoft_Excel_Worksheet.xlsx')).toBe('stored in the embedded-files folder')
    expect(entryNote('payload/Invoice.pdf.exe')).toBe('named like an executable or script')
    expect(entryNote('word/document.xml')).toBeNull()
    expect(entryNote('word/_rels/document.xml.rels')).toBeNull()
    expect(entryNote('docProps/app.xml')).toBeNull()
  })
})

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
])

describe('pictures under media/', () => {
  it('hands back stored and deflated pictures as bytes, and nothing else', async () => {
    const facts = await readZipDocument(
      zip([
        { name: 'word/document.xml', data: enc.encode('<w:document/>') },
        { name: 'word/media/image1.png', data: PNG },
        { name: 'word/media/image2.png', data: await deflateRaw(PNG), method: 8, size: PNG.length }
      ])
    )
    expect(facts?.images.map((i) => i.name)).toEqual(['word/media/image1.png', 'word/media/image2.png'])
    expect(facts?.images[1].bytes).toEqual(PNG)
    expect(facts?.notes).toEqual([])
  })

  it('keeps a streamed picture whose deflate stream is followed by the rest of the file', async () => {
    const facts = await readZipDocument(
      zip([
        {
          name: 'word/media/image1.png',
          data: await deflateRaw(PNG),
          method: 8,
          flags: 8,
          size: PNG.length,
          compressed: 0
        },
        { name: 'word/document.xml', data: enc.encode('<w:document/>') }
      ])
    )
    expect(facts?.images.length).toBe(1)
  })

  it('counts a picture it cannot read whole instead of drawing half of it', async () => {
    const broken = (await deflateRaw(PNG)).subarray(0, 6)
    const facts = await readZipDocument(
      zip([{ name: 'xl/media/image1.png', data: broken, method: 8, size: PNG.length }])
    )
    expect(facts?.images).toEqual([])
    expect(facts?.notes.join(' ')).toContain('1 entry named as a picture could not be read whole')
  })
})

/** One local entry, and a central record per name that every one points at — the overlapping shape zip() cannot build. */
function overlapping(names: string[], data: Uint8Array, method: number, size: number): Uint8Array {
  const first = enc.encode(names[0] ?? '')
  const local = header(30, (v) => {
    v.setUint32(0, 0x04034b50, true)
    v.setUint16(8, method, true)
    v.setUint32(18, data.length, true)
    v.setUint32(22, size, true)
    v.setUint16(26, first.length, true)
  })
  const directory = concat(
    names.flatMap((n) => {
      const name = enc.encode(n)
      const central = header(46, (v) => {
        v.setUint32(0, 0x02014b50, true)
        v.setUint16(10, method, true)
        v.setUint32(20, data.length, true)
        v.setUint32(24, size, true)
        v.setUint16(28, name.length, true)
        // Local offset left at 0: every row points at the one local entry.
      })
      return [central, name]
    })
  )
  const eocd = header(22, (v) => {
    v.setUint32(0, 0x06054b50, true)
    v.setUint16(8, names.length, true)
    v.setUint16(10, names.length, true)
    v.setUint32(12, directory.length, true)
    v.setUint32(16, local.length + first.length + data.length, true)
  })
  return concat([local, first, data, directory, eocd])
}

/** Raw deflate written as stored blocks, the last one final, so a test can cut the stream exactly between two. */
function storedBlocks(...chunks: Uint8Array[]): Uint8Array {
  return concat(
    chunks.flatMap((chunk, i) => [
      header(5, (v) => {
        v.setUint8(0, i === chunks.length - 1 ? 1 : 0)
        v.setUint16(1, chunk.length, true)
        v.setUint16(3, ~chunk.length & 0xffff, true)
      }),
      chunk
    ])
  )
}

const many = <T>(count: number, make: (i: number) => T): T[] => Array.from({ length: count }, (_, i) => make(i))

describe('a picture is whole when it is as long as the directory says', () => {
  it('does not keep a cut GIF because its partial output happens to end in 0x3B', async () => {
    const gif = new Uint8Array(58)
    gif.set(enc.encode('GIF89a'))
    gif[13] = 0x3b
    gif[57] = 0x3b
    const stream = storedBlocks(gif.subarray(0, 14), gif.subarray(14))
    const facts = await readZipDocument(
      zip([{ name: 'word/media/image1.gif', data: stream, method: 8, size: gif.length, compressed: 5 + 14 }])
    )
    // The 14-byte prefix was kept, drawn and hashed as the picture.
    expect(facts?.images).toEqual([])
    expect(facts?.notes.join(' ')).toContain('1 entry named as a picture could not be read whole')
  })

  it('does not keep a cut JPEG because the cut fell on an inner FF D9', async () => {
    const jpeg = new Uint8Array(5_010)
    jpeg.set([0xff, 0xd8, 0xff, 0xe0])
    jpeg.set([0xff, 0xd9], 10) // an embedded thumbnail's end
    jpeg.set([0xff, 0xd9], jpeg.length - 2)
    const stream = storedBlocks(jpeg.subarray(0, 12), jpeg.subarray(12))
    const facts = await readZipDocument(
      zip([{ name: 'word/media/image1.jpeg', data: stream, method: 8, size: jpeg.length, compressed: 5 + 12 }])
    )
    expect(facts?.images).toEqual([])
  })

  it('keeps a streamed JPEG with bytes after its end marker, and gives no false reason', async () => {
    // Whole, inflated to exactly its declared length — then the decompressor
    // errors on the rest of the file, as it does for every streamed entry. The
    // tail check dropped it as "encrypted, damaged, over 8 MB, or …".
    const jpeg = new Uint8Array(4_064)
    jpeg.set([0xff, 0xd8, 0xff, 0xe0])
    jpeg.set([0xff, 0xd9], 4_000) // 64 bytes of padding follow
    const facts = await readZipDocument(
      zip([
        {
          name: 'word/media/image1.jpeg',
          data: await deflateRaw(jpeg),
          method: 8,
          flags: 8,
          size: jpeg.length,
          compressed: 0
        },
        { name: 'word/document.xml', data: enc.encode('<w:document/>') }
      ])
    )
    expect(facts?.images.map((i) => i.bytes)).toEqual([jpeg])
    expect(facts?.notes.join(' ')).not.toContain('could not be read whole')
  })
})

describe('every open is charged, kept or not', () => {
  it('stops 4,096 rows aimed at one small bomb in well under a second, and says why', async () => {
    // 294 KB of file, 32.8 GB of inflation when only kept pictures counted.
    const bomb = await deflateRaw(new Uint8Array(8_000_001))
    const bytes = overlapping(
      many(4_096, (i) => `word/media/image${i}.png`),
      bomb,
      8,
      8_000_001
    )
    const media = { left: 100_000_000 }
    const started = performance.now()
    const facts = await readZipDocument(bytes, media)
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(facts?.images).toEqual([])
    const notes = facts?.notes.join(' ') ?? ''
    expect(notes).toContain('4 entries named as pictures could not be read whole here')
    expect(notes).toContain(
      '4092 entries named as pictures were not opened: this reader stops once it has read 32 MB of pictures and inner files out of one file'
    )
    // Four 8 MB inflates, every byte charged though none was kept.
    expect(media.left).toBe(68_000_000)
  })

  it('stops after opening 24 when every open fails at once and costs nothing', async () => {
    // An invalid block type: each inflate errors on its first byte with no
    // output, so the byte budget never moves and only the count bounds it.
    const facts = await readZipDocument(
      overlapping(
        many(4_096, (i) => `word/media/image${i}.png`),
        Uint8Array.from([0x07, 0xff, 0xff]),
        8,
        100
      )
    )
    expect(facts?.notes.join(' ')).toContain(
      '4072 of the 4096 entries named as pictures were not opened: this reader stops after opening 24.'
    )
  })

  it('counts the cap from where the loop stopped, not from what it kept', async () => {
    // "Only the first 24 of the 29" was said about a run that opened 27 and
    // kept entries 4 to 27.
    const facts = await readZipDocument(
      zip([
        ...many(3, (i) => ({ name: `word/media/bad${i}.png`, data: PNG, flags: 1 })),
        ...many(26, (i) => ({ name: `word/media/good${i}.png`, data: PNG }))
      ])
    )
    expect(facts?.images).toHaveLength(24)
    const notes = facts?.notes.join(' ') ?? ''
    expect(notes).toContain(
      '2 of the 29 entries named as pictures were not opened: this reader stops after opening 24.'
    )
    expect(notes).toContain('3 entries named as pictures could not be read whole here — encrypted')
    expect(notes).not.toContain('first 24')
  })

  it('names the spent budget, not damage, for an intact picture that did not fit', async () => {
    // Four whole 7 MB pictures leave 4 MB of the 32; the fifth is intact,
    // unencrypted and under 8 MB, and was told it was one of those.
    const jpeg = new Uint8Array(7_000_000)
    jpeg.set([0xff, 0xd8, 0xff])
    const png = new Uint8Array(7_000_020)
    png.set(PNG)
    const deflated = await deflateRaw(png)
    const stored = zip(many(5, (i) => ({ name: `word/media/image${i}.jpeg`, data: jpeg })))
    const inflated = zip(
      many(5, (i) => ({ name: `word/media/image${i}.png`, data: deflated, method: 8, size: png.length }))
    )
    for (const bytes of [stored, inflated]) {
      const facts = await readZipDocument(bytes)
      expect(facts?.images).toHaveLength(4)
      const notes = facts?.notes.join(' ') ?? ''
      expect(notes).toContain(
        '1 entry named as a picture was not read whole: it was larger than what remained of the 32 MB of pictures and inner files this reader will read out of one file, so it is not drawn here.'
      )
      expect(notes).not.toContain('over 8 MB')
    }
  })
})

describe('pictures anywhere in the container', () => {
  it('draws pictures outside media/, as an .odt or a plain .zip keeps them', async () => {
    const facts = await readZipDocument(
      zip([
        { name: 'Pictures/1000.png', data: PNG },
        { name: 'scan.png', data: PNG }
      ])
    )
    expect(facts?.images.map((i) => i.name)).toEqual(['Pictures/1000.png', 'scan.png'])
  })

  it('says a picture in a format it does not draw was not drawn, rather than nothing', async () => {
    const facts = await readZipDocument(
      zip([
        { name: '[Content_Types].xml', data: enc.encode('<Types/>') },
        { name: 'word/document.xml', data: enc.encode('<w:document/>') },
        { name: 'word/media/image1.emf', data: enc.encode('EMF-bytes') }
      ])
    )
    expect(facts?.images).toEqual([])
    expect(facts?.notes.join(' ')).toContain(
      '1 entry is named as a picture in a format this does not draw (EMF, WMF, SVG, TIFF, BMP or WebP), so it is not drawn. Not drawn is not absent.'
    )
  })

  it('says nothing about pictures when no entry is named as one', async () => {
    const facts = await readZipDocument(
      zip([
        { name: 'a.txt', data: enc.encode('one') },
        { name: 'b.txt', data: enc.encode('two') }
      ])
    )
    expect(facts?.notes).toEqual([])
  })
})

describe('one picture budget across a whole message', () => {
  const docx = (...pictures: Part[]) =>
    zip([{ name: '[Content_Types].xml', data: enc.encode('<Types/>') }, ...pictures])

  it('stops reading pictures once the attachments before this one have used the budget', async () => {
    const media = { left: PNG.length }
    const first = await readZipDocument(docx({ name: 'word/media/image1.png', data: PNG }), media)
    const second = await readZipDocument(docx({ name: 'word/media/image1.png', data: PNG }), media)
    expect(first?.images).toHaveLength(1)
    expect(second?.images).toEqual([])
    expect(second?.notes).toEqual([
      "1 entry named as a picture was not opened: this message's budget for pictures and inner files was used up by what was read before it, so it is not drawn here. Not drawn is not absent."
    ])
    expect(media.left).toBe(0)
  })

  it('names the message budget when it is the one a picture did not fit', async () => {
    const media = { left: PNG.length + 5 }
    const facts = await readZipDocument(
      docx({ name: 'word/media/image1.png', data: PNG }, { name: 'word/media/image2.png', data: PNG }),
      media
    )
    expect(facts?.images).toHaveLength(1)
    expect(facts?.notes.join(' ')).toContain(
      "1 entry named as a picture was not read whole: it was larger than what remained of this message's budget for pictures and inner files"
    )
  })

  it('reads every picture of an ordinary message and says nothing about a budget', async () => {
    const media = { left: 64_000_000 }
    for (let i = 0; i < 12; i++) {
      const facts = await readZipDocument(docx({ name: 'word/media/image1.png', data: PNG }), media)
      expect(facts?.images).toHaveLength(1)
      expect(facts?.notes).toEqual([])
    }
    expect(media.left).toBe(64_000_000 - 12 * PNG.length)
  })
})

describe('files inside the archive', () => {
  const mz = concat([enc.encode('MZ'), new Uint8Array(100).fill(0x90)])

  it('hands back each file a plain archive carries, whole, with its first bytes', async () => {
    const html = enc.encode('<html><script>location.href="https://x.test"</script></html>')
    const js = enc.encode('WScript.Echo(1)')
    const facts = await readZipDocument(
      zip([
        { name: 'Invoice.pdf', data: mz },
        { name: 'view.html', data: await deflateRaw(html), method: 8, size: html.length },
        { name: 'run.js', data: js },
        { name: 'docs/', data: new Uint8Array(0) },
        { name: 'empty.txt', data: new Uint8Array(0) }
      ])
    )
    expect(facts?.files.map((f) => f.name)).toEqual(['Invoice.pdf', 'view.html', 'run.js'])
    expect(facts?.files[0]?.bytes).toEqual(mz)
    expect(facts?.files[0]?.head).toEqual(mz.subarray(0, 32))
    expect(facts?.files[1]?.bytes).toEqual(html)
    expect(facts?.files[2]?.head).toEqual(js) // shorter than the head: the head is the whole file
    // An empty file and a folder are not unreadable files.
    expect(facts?.notes).toEqual([])
  })

  it('reads only the non-markup parts of an Office file, and a planted [Content_Types].xml hides nothing', async () => {
    const office = await readZipDocument(
      zip([
        { name: '[Content_Types].xml', data: enc.encode('<Types/>') },
        { name: 'word/document.xml', data: enc.encode('<w:document/>') },
        { name: 'word/_rels/document.xml.rels', data: enc.encode(RELS) },
        { name: 'word/vbaProject.bin', data: enc.encode('macro-bytes') },
        { name: 'word/media/image1.png', data: PNG }
      ])
    )
    expect(office?.files.map((f) => f.name)).toEqual(['word/vbaProject.bin'])
    expect(office?.images.map((i) => i.name)).toEqual(['word/media/image1.png'])

    const planted = await readZipDocument(
      zip([
        { name: '[Content_Types].xml', data: enc.encode('<Types/>') },
        { name: 'payload.exe', data: mz }
      ])
    )
    expect(planted?.files.map((f) => f.name)).toEqual(['payload.exe'])
  })

  it('gives a file it cannot read whole its first bytes and no body', async () => {
    const big = new Uint8Array(8_000_001)
    big.set([0x4d, 0x5a])
    const facts = await readZipDocument(
      zip([{ name: 'payload/Invoice.pdf', data: await deflateRaw(big), method: 8, size: big.length }])
    )
    expect(facts?.files).toHaveLength(1)
    expect(facts?.files[0]?.bytes).toBeNull()
    expect(facts?.files[0]?.head).toEqual(big.subarray(0, 32))
    expect(facts?.notes.join(' ')).toContain(
      '1 inner file could not be read whole here — encrypted, damaged, over 8 MB, or compressed in a way this device cannot inflate — so it is not hashed here.'
    )
  })

  it('hands back no head shorter than a signature from a stream that broke early', async () => {
    // Three bytes of a shortcut are not "its first bytes" for a 20-byte check:
    // "no signature this recognises" from them would be about bytes nobody read.
    const facts = await readZipDocument(
      zip([
        {
          name: 'Invoice.lnk',
          data: storedBlocks(Uint8Array.from([0x4c, 0, 0]), new Uint8Array(40)),
          method: 8,
          size: 43,
          compressed: 5 + 3
        }
      ])
    )
    expect(facts?.files).toEqual([])
    expect(facts?.notes.join(' ')).toContain('1 inner file could not be read whole here')
  })

  it('hands back a program named as a picture as a file, not a picture', async () => {
    // By name alone it was an "embedded picture": never checked against its
    // name, and its hash never reached Indicators or the case.
    const appleDouble = Uint8Array.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00, ...new Uint8Array(40)])
    const facts = await readZipDocument(
      zip([
        { name: 'photo.jpg', data: mz },
        { name: '__MACOSX/._scan.png', data: appleDouble },
        { name: 'scan.png', data: PNG }
      ])
    )
    expect(facts?.images.map((i) => i.name)).toEqual(['scan.png'])
    expect(facts?.files.map((f) => [f.name, f.bytes])).toEqual([
      ['photo.jpg', mz],
      ['__MACOSX/._scan.png', appleDouble]
    ])
    expect(facts?.notes).toEqual([])
  })

  it('gives a program named as a picture and padded past the cap its first bytes', async () => {
    const big = new Uint8Array(8_000_001)
    big.set([0x4d, 0x5a])
    const facts = await readZipDocument(
      zip([{ name: 'photo.jpg', data: await deflateRaw(big), method: 8, size: big.length }])
    )
    expect(facts?.images).toEqual([])
    expect(facts?.files.map((f) => [f.name, f.head, f.bytes])).toEqual([['photo.jpg', big.subarray(0, 32), null]])
    // Still counted by its name, so the tally stays true about what was named what.
    expect(facts?.notes.join(' ')).toContain('1 entry named as a picture could not be read whole')
  })

  it('does not list a picture it could not read whole as a file', async () => {
    const big = new Uint8Array(8_000_001)
    big.set(PNG)
    const facts = await readZipDocument(
      zip([{ name: 'scan.png', data: await deflateRaw(big), method: 8, size: big.length }])
    )
    expect(facts?.images).toEqual([])
    expect(facts?.files).toEqual([])
    expect(facts?.notes.join(' ')).toContain('1 entry named as a picture could not be read whole')
  })

  it('leaves out an empty file however it was compressed', async () => {
    // Python's zipfile deflates an empty file to two bytes, and hashing what
    // came out put the empty-file SHA-256 into Indicators and the case.
    const deflatedEmpty = await deflateRaw(new Uint8Array(0))
    for (const keep of [
      { name: '.keep', data: new Uint8Array(0) },
      { name: '.keep', data: deflatedEmpty, method: 8, size: 0 }
    ]) {
      const facts = await readZipDocument(zip([{ name: 'run.js', data: enc.encode('WScript.Echo(1)') }, keep]))
      expect(facts?.files.map((f) => f.name)).toEqual(['run.js'])
      expect(facts?.notes).toEqual([])
    }
    // A stream that broke before its first byte is not known to be empty.
    const broken = await readZipDocument(
      zip([{ name: 'x.bin', data: Uint8Array.from([0x07, 0xff, 0xff]), method: 8, size: 0 }])
    )
    expect(broken?.files).toEqual([])
    expect(broken?.notes.join(' ')).toContain('1 inner file could not be read whole')
  })

  it('says an empty picture holds nothing, not that it could not be read', async () => {
    const deflatedEmpty = await deflateRaw(new Uint8Array(0))
    for (const image of [
      { name: 'word/media/image1.png', data: new Uint8Array(0) },
      { name: 'word/media/image1.png', data: deflatedEmpty, method: 8, size: 0 }
    ]) {
      const facts = await readZipDocument(zip([{ name: '[Content_Types].xml', data: enc.encode('<Types/>') }, image]))
      expect(facts?.images).toEqual([])
      expect(facts?.notes).toEqual(['1 entry named as a picture holds 0 bytes, so there is nothing to draw.'])
    }
    // Declared 10 and holding none is not empty: that one really was not read.
    const short = await readZipDocument(zip([{ name: 'word/media/image1.png', data: new Uint8Array(0), size: 10 }]))
    expect(short?.notes.join(' ')).toContain('1 entry named as a picture could not be read whole')
    expect(short?.notes.join(' ')).not.toContain('0 bytes')
  })

  it('opens at most 24 files and says how many were left', async () => {
    const facts = await readZipDocument(zip(many(30, (i) => ({ name: `f${i}.bin`, data: mz }))))
    expect(facts?.files).toHaveLength(24)
    expect(facts?.notes).toEqual(['6 of the 30 inner files were not opened: this reader stops after opening 24.'])
  })
})

describe('entryNote rows for what a victim double-clicks', () => {
  it('calls a disk image a disk image, not an executable', () => {
    for (const name of ['a/b.iso', 'Invoice.img', 'x.vhd', 'x.vhdx']) {
      expect(entryNote(name)).toBe('named like a disk image')
    }
    expect(entryNote('payload/Invoice.pdf.exe')).toBe('named like an executable or script')
  })

  it('names web pages, SVG and OneNote files', () => {
    for (const name of ['view.html', 'view.htm', 'a.svg', 'Notes.one']) {
      expect(entryNote(name)).toBe('named as a web page, SVG or OneNote file')
    }
  })
})
