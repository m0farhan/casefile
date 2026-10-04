import { describe, expect, it, vi } from 'vitest'
import { GAP, type PdfFacts, type PdfParsed, readPdf, readPdfObjects, stripGap } from './pdf'
import { FILE_PDF_MS, type Work } from './pdfObjects'
import { type BuildOptions, buildPdf, bytes, fixture, type Obj, objStm, onePage, zlib } from '../../test/pdf'

/**
 * Fixtures are built byte by byte here: a PDF is a text skeleton with binary
 * poured into the middle of it, and the binary is half of what is being tested
 * — a JPEG that survives a round trip through a text-only fixture is not the
 * JPEG this reader has to cope with.
 */
function pdf(...parts: (string | Uint8Array)[]): Uint8Array {
  const chunks = parts.map((p) => (typeof p === 'string' ? Uint8Array.from(p, (c) => c.charCodeAt(0) & 0xff) : p))
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** A JPEG carrying the bytes `)`, `end` and `obj` — the things a lazy scanner stops at. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x29, 0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a, 0xff, 0xd9])

/** The twelve-byte JP2 signature box every JPEG 2000 file of that shape begins with. */
const JP2 = Uint8Array.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a])

const TRAILER = '\ntrailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF\n'

/** Word for word, because the card and the copied report both print it. */
const NONE_EXTRACTED =
  'Only /DCTDecode (JPEG) and /JPXDecode (JPEG 2000) streams are extracted as pictures, and none was extracted ' +
  'here. An image stored any other way, /FlateDecode included, is not read, so none drawn is not none present.'

describe('readPdf', () => {
  it('declines bytes that are not a PDF rather than reporting an empty one', () => {
    expect(readPdf(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]))).toBeNull()
    expect(readPdf(Uint8Array.from([]))).toBeNull()
    expect(readPdf(pdf('just an ordinary text file, nothing structural in it at all'))).toBeNull()
  })

  it('reads the version out of the header', () => {
    const facts = readPdf(pdf('%PDF-1.7\n1 0 obj\n<< >>\nendobj', TRAILER))
    expect(facts?.version).toBe('1.7')
  })

  it('takes a file with no header but a real object skeleton, and does not guess a version', () => {
    const facts = readPdf(pdf('1 0 obj\n<< /OpenAction << /S /JavaScript >> >>\nendobj', TRAILER))
    expect(facts?.version).toBe('')
    expect(facts?.notes.join(' ')).toContain('No %PDF header')
    expect(facts?.markers).toContainEqual({ name: '/OpenAction', count: 1 })
  })

  it('says when the header is not at the start of the file', () => {
    const facts = readPdf(pdf('GIF89a-prefix-and-then-', '%PDF-1.4\n1 0 obj\nendobj', TRAILER))
    expect(facts?.version).toBe('1.4')
    expect(facts?.notes.join(' ')).toContain('offset 23')
  })
})

describe('the marker census', () => {
  it('counts a name only where the token ends, so /JS is not found inside /JSName', () => {
    const facts = readPdf(
      pdf('%PDF-1.5\n<< /JSName 1 /JavaScriptish 2 /Launcher 3 /JS 4 0 R /JavaScript 5 0 R >>', TRAILER)
    )
    expect(facts?.markers).toContainEqual({ name: '/JS', count: 1 })
    expect(facts?.markers).toContainEqual({ name: '/JavaScript', count: 1 })
    expect(facts?.markers.find((m) => m.name === '/Launch')).toBeUndefined()
  })

  it('counts repeats and lists only the names that are present', () => {
    const facts = readPdf(pdf('%PDF-1.5\n<< /AA 1 /AA 2 /AA 3 /Launch (cmd.exe) >>', TRAILER))
    expect(facts?.markers).toEqual([
      { name: '/Launch', count: 1 },
      { name: '/AA', count: 3 }
    ])
  })

  it('reports an /Encrypt entry and warns that what it read may be incomplete', () => {
    const facts = readPdf(pdf('%PDF-1.6\n<< /Encrypt 9 0 R >>', TRAILER))
    expect(facts?.encrypted).toBe(true)
    expect(facts?.notes.join(' ')).toContain('may be encrypted')
    expect(facts?.notes.join(' ')).toContain('incomplete')
  })

  it('is honest about compressed object streams instead of silently under-reporting', () => {
    // The whole point of the note: this file's census says nothing about
    // JavaScript, and the reason is that the scan cannot see where it lives.
    const facts = readPdf(
      pdf('%PDF-1.5\n5 0 obj\n<< /Type /ObjStm /N 40 /First 300 >>\nstream\n...\nendstream', TRAILER)
    )
    expect(facts?.markers).toContainEqual({ name: '/ObjStm', count: 1 })
    const notes = facts?.notes.join(' ') ?? ''
    expect(notes).toContain('compressed object stream')
    expect(notes).toContain('not visible')
  })

  it('never leaves the standing caveat off a clean-looking file', () => {
    const facts = readPdf(pdf('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj', TRAILER))
    expect(facts?.markers).toEqual([])
    expect(facts?.notes.join(' ')).toContain('no absence here is evidence of safety')
  })
})

describe('URLs', () => {
  it('reads a literal string and keeps nested and escaped parens', () => {
    const facts = readPdf(pdf('%PDF-1.4\n<< /S /URI /URI (https://evil.test/a\\)b?x=(1)&y=2) >>', TRAILER))
    // Not defanged and not percent-decoded — the caller defangs. PDF escapes,
    // though, ARE resolved: see the contract test below for what that costs.
    expect(facts?.uris).toEqual(['https://evil.test/a)b?x=(1)&y=2'])
  })

  it('hands back the URL a reader would visit, which is not always a byte run that is in the file', () => {
    // The docstring used to promise "URL strings exactly as written" and argue
    // that anything else "cannot be searched for in the file". The value has
    // always been the decoded one — which is the right value to report, because
    // it is where the victim's click goes — so the promise was the wrong half.
    // Pinned as a contract: decoded value, and no claim that it is greppable.
    const source = '%PDF-1.4\n/URI (https://a.test/\\150\\151?x=1\\)y)'
    const facts = readPdf(pdf(source, TRAILER))
    expect(facts?.uris).toEqual(['https://a.test/hi?x=1)y'])
    expect(source).not.toContain('https://a.test/hi?x=1)y')
  })

  it('joins a URL split across lines with a backslash continuation', () => {
    const facts = readPdf(pdf('%PDF-1.4\n/URI (https://evil.test/very\\\nlong/path)', TRAILER))
    expect(facts?.uris).toEqual(['https://evil.test/verylong/path'])
  })

  it('decodes a hex string, which is where a URL goes when it is written not to be greppable', () => {
    const hex = [...'https://evil.test/qr'].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')
    const facts = readPdf(pdf(`%PDF-1.4\n/URI <${hex}>`, TRAILER))
    expect(facts?.uris).toEqual(['https://evil.test/qr'])
  })

  it('does not read a dictionary as a hex string, and does not invent a URL from /S /URI alone', () => {
    const facts = readPdf(pdf('%PDF-1.4\n<< /S /URI /Next << /Type /Action >> >>', TRAILER))
    expect(facts?.uris).toEqual([])
  })

  it('lists a repeated link once', () => {
    const facts = readPdf(
      pdf('%PDF-1.4\n/URI (https://evil.test/go)\n/URI (https://evil.test/go)\n/URI (https://other.test/)', TRAILER)
    )
    expect(facts?.uris).toEqual(['https://evil.test/go', 'https://other.test/'])
  })

  it('drops a string that is never closed rather than calling the rest of the file a URL', () => {
    // The bug this pins: the reader ran to the end of the file and listed the
    // trailer, the xref and everything else as one link, which reads on screen
    // as a URL an analyst would go and look up.
    const facts = readPdf(pdf('%PDF-1.4\n/URI (https://evil.test/never-closed', TRAILER))
    expect(facts?.uris).toEqual([])
    expect(facts?.notes.join(' ')).toContain('never closed')
  })

  it('stops after the URL cap and says it stopped', () => {
    const many = Array.from({ length: 260 }, (_, i) => `/URI (https://evil.test/${i})`).join('\n')
    const facts = readPdf(pdf('%PDF-1.4\n', many, TRAILER))
    expect(facts?.uris).toHaveLength(200)
    expect(facts?.notes.join(' ')).toContain('Stopped after 200 URLs')
  })
})

describe('the header window', () => {
  it('finds a header that starts inside the first 1024 bytes but ends past them', () => {
    // Slicing at exactly 1024 cut this header in half and the note then said
    // there was no header in the first 1024 bytes.
    const facts = readPdf(pdf('x'.repeat(1019), '%PDF-1.4\n1 0 obj << >> endobj\n%%EOF'))
    expect(facts?.version).toBe('1.4')
    expect(facts?.notes.join(' ')).not.toContain('No %PDF header')
  })
})

describe('images', () => {
  const head = '%PDF-1.5\n4 0 obj\n<< /Type /XObject /Subtype /Image /Filter /DCTDecode /Length 15 >>\nstream\n'

  it('lifts a DCTDecode stream out whole, bytes and offset exact', () => {
    const facts = readPdf(pdf(head, JPEG, '\nendstream\nendobj', TRAILER))
    expect(facts?.images).toHaveLength(1)
    const image = facts?.images[0]
    expect(image?.filter).toBe('/DCTDecode')
    expect(image?.offset).toBe(head.length)
    // Byte-for-byte, including the `)` and `endobj` inside the JPEG and with
    // the EOL that the writer put before `endstream` left off: an extra 0x0a
    // changes every hash of the file the analyst is about to look up.
    expect([...(image?.bytes ?? [])]).toEqual([...JPEG])
  })

  it('refuses a run that only a keyword bounded, because that is how bytes from the next object got in', () => {
    // The fabrication this closes: `stream` matched as a bare substring, or a
    // stream missing its own `endstream`, produced bytes that are not a file in
    // this document. A complete JPEG begins FFD8 and ends FFD9; a run that
    // swallowed its neighbour does not.
    const facts = readPdf(
      pdf(
        '%PDF-1.5\n<< /Filter /DCTDecode >>\nstream\n',
        Uint8Array.from([0x41, 0x42, 0x43, 0x44]),
        '\nendstream\nendobj',
        TRAILER
      )
    )
    expect(facts?.images).toEqual([])
    expect(facts?.notes.join(' ')).toContain('could not be confirmed to begin and end as a complete image')
  })

  it('still takes a whole JPEG bounded only by the keyword, so an indirect /Length loses nothing', () => {
    const whole = Uint8Array.from([0xff, 0xd8, 0x00, 0x11, 0xff, 0xd9])
    const facts = readPdf(
      pdf('%PDF-1.5\n<< /Filter /DCTDecode /Length 7 0 R >>\nstream\n', whole, '\nendstream\nendobj', TRAILER)
    )
    expect(facts?.images).toHaveLength(1)
    expect([...(facts?.images[0]?.bytes ?? [])]).toEqual([...whole])
  })

  it('takes JPXDecode the same way', () => {
    const facts = readPdf(pdf('%PDF-1.5\n<< /Filter /JPXDecode >>\nstream\r\n', JPEG, '\r\nendstream', TRAILER))
    expect(facts?.images).toHaveLength(1)
    expect(facts?.images[0]?.filter).toBe('/JPXDecode')
    expect([...(facts?.images[0]?.bytes ?? [])]).toEqual([...JPEG])
  })

  it('refuses a JPEG 2000 run that swallowed the next object, or that only begins like one', () => {
    // No `endstream` of its own and an indirect /Length, so the search stops at
    // the next object's and the run spans both. JPEG 2000 used to be kept on its
    // first two or three bytes, so this came back hashed as a picture under a
    // note saying it began and ended as one.
    const nextObject = '\nendobj\n2 0 obj << /Length 22 >>\nstream\nBT (other object) Tj ET\nendstream\nendobj'
    const swallowed = readPdf(
      pdf(
        '%PDF-1.7\n1 0 obj << /Subtype /Image /Filter /JPXDecode /Length 9 0 R >>\nstream\n',
        JP2,
        nextObject,
        TRAILER
      )
    )
    expect(swallowed?.images).toEqual([])
    expect(swallowed?.notes.join(' ')).toContain('1 /DCTDecode or /JPXDecode entr(ies) had no usable declared length')
    // The start has to be the whole signature too: three NULs, or SOC without
    // the SIZ that must follow it, is not JPEG 2000 however the run ends.
    for (const start of [
      [0x00, 0x00, 0x00, 0x41],
      [0xff, 0x4f, 0x41, 0x42]
    ]) {
      const facts = readPdf(
        pdf(
          '%PDF-1.7\n<< /Filter /JPXDecode >>\nstream\n',
          Uint8Array.from([...start, 0xff, 0xd9]),
          '\nendstream',
          TRAILER
        )
      )
      expect(facts?.images).toEqual([])
    }
  })

  it('takes a JPEG 2000 run bounded only by the keyword when it begins and ends as one, in either shape', () => {
    const jp2 = pdf(JP2, 'jp2c', Uint8Array.from([0xff, 0x4f, 0xff, 0x51, 0xff, 0xd9]))
    const codestream = Uint8Array.from([0xff, 0x4f, 0xff, 0x51, 0x00, 0x29, 0xff, 0xd9])
    for (const body of [jp2, codestream]) {
      const facts = readPdf(
        pdf('%PDF-1.7\n<< /Filter /JPXDecode /Length 9 0 R >>\nstream\n', body, '\nendstream\nendobj', TRAILER)
      )
      expect([...(facts?.images[0]?.bytes ?? [])]).toEqual([...body])
    }
  })

  it('says which streams it extracts when it extracted none, so an empty list is not read as no pictures', () => {
    // A picture that came from a PNG is stored as /FlateDecode, which this
    // skips. With nothing said, "no images" read as "this file has none".
    const facts = readPdf(
      pdf('%PDF-1.5\n<< /Subtype /Image /Filter /FlateDecode /Length 4 >>\nstream\nABCD\nendstream\nendobj', TRAILER)
    )
    expect(facts?.images).toEqual([])
    expect(facts?.notes).toContain(NONE_EXTRACTED)
    const withImage = readPdf(pdf(head, JPEG, '\nendstream\nendobj', TRAILER))
    expect(withImage?.notes).not.toContain(NONE_EXTRACTED)
  })

  it('leaves FlateDecode alone — that is pixel data, not a file', () => {
    const facts = readPdf(
      pdf('%PDF-1.5\n<< /Subtype /Image /Filter /FlateDecode >>\nstream\n', JPEG, '\nendstream', TRAILER)
    )
    expect(facts?.images).toEqual([])
  })

  it('counts one image when the dictionary names the filter in an array beside another', () => {
    const facts = readPdf(
      pdf('%PDF-1.5\n<< /Filter [/DCTDecode /DCTDecode] >>\nstream\n', JPEG, '\nendstream', TRAILER)
    )
    expect(facts?.images).toHaveLength(1)
    // The second name reaches the same start, which is the image itself and
    // not a stream beginning inside it.
    expect(facts?.notes.join(' ')).not.toContain('begin inside the data')
  })

  it('takes bytes into one picture only, so 24 nested dictionaries are not 24 pictures', () => {
    // Each dictionary is written inside the previous stream's data, and each
    // declares a /Length that lands on the one `endstream` they all share, so
    // every one confirmed. All 24 came back, overlapping views over the same
    // bytes: 24 times the file, which a mail of copies multiplied again.
    const soi = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])
    let data = pdf(soi, 'x'.repeat(1000), Uint8Array.from([0xff, 0xd9]))
    for (let k = 0; k < 23; k++) {
      data = pdf(soi, `<< /Filter /DCTDecode /Length ${data.length} >>\nstream\n`, data)
    }
    const file = pdf(
      '%PDF-1.5\n1 0 obj\n',
      `<< /Filter /DCTDecode /Length ${data.length} >>\nstream\n`,
      data,
      '\nendstream\nendobj\n2 0 obj\n<< /Filter /DCTDecode /Length 15 >>\nstream\n',
      JPEG,
      '\nendstream\nendobj',
      TRAILER
    )
    const facts = readPdf(file)
    // The outer image whole, and the ordinary one after the shared endstream
    // still taken: the skip is for streams inside a picture, not after one.
    expect(facts?.images.map((i) => [...i.bytes])).toEqual([[...data], [...JPEG]])
    const notes = facts?.notes.join(' ') ?? ''
    expect(notes).toContain('23 /DCTDecode or /JPXDecode entr(ies) begin inside the data of an image already extracted')
    expect(notes).toContain('unread as pictures here, not absent')
    const total = facts?.images.reduce((n, i) => n + i.bytes.length, 0) ?? 0
    expect(total).toBeLessThanOrEqual(file.length)
  })

  it('says so when a stream has no endstream, instead of returning half a file', () => {
    const facts = readPdf(pdf('%PDF-1.5\n<< /Filter /DCTDecode >>\nstream\n', JPEG, TRAILER.replace('%%EOF', '')))
    expect(facts?.images).toEqual([])
    expect(facts?.notes.join(' ')).toContain('not proof there is no image there')
  })

  it('stops at the image cap and names the cap', () => {
    const one = ['<< /Filter /DCTDecode >>\nstream\n', JPEG, '\nendstream\n'] as const
    const facts = readPdf(pdf('%PDF-1.5\n', ...Array.from({ length: 40 }, () => one).flat(), TRAILER))
    expect(facts?.images).toHaveLength(24)
    expect(facts?.notes.join(' ')).toContain('Stopped after 24 image(s)')
  })
})

describe('hostile bytes', () => {
  it('scans only the head of a huge file and says where it stopped', () => {
    const big = new Uint8Array(17 * 1024 * 1024).fill(0x20)
    big.set(
      Uint8Array.from('%PDF-1.7\n', (c) => c.charCodeAt(0)),
      0
    )
    // Past the cap, so this must NOT be counted — that is the bound being tested.
    big.set(
      Uint8Array.from('/JavaScript ', (c) => c.charCodeAt(0)),
      big.length - 64
    )
    const facts = readPdf(big)
    expect(facts?.markers).toEqual([])
    expect(facts?.notes.join(' ')).toContain('only the first 16777216 were scanned')
  })

  it('does not throw on truncated or contradictory structure', () => {
    expect(() => readPdf(pdf('%PDF-1.4\n<< /Filter /DCTDecode /Length 99999999 >>\nstream\n'))).not.toThrow()
    expect(() => readPdf(pdf('%PDF-1.4\n/URI <deadbee', TRAILER))).not.toThrow()
    expect(() => readPdf(pdf('%PDF-1.4\n((((((((((/URI (', TRAILER))).not.toThrow()
    expect(() =>
      readPdf(
        pdf(
          '%PDF-1.4\n',
          Uint8Array.from({ length: 4096 }, (_, i) => i & 0xff),
          TRAILER
        )
      )
    ).not.toThrow()
  })

  it('never allocates from a declared length: a lying /Length does not reach the slice', () => {
    // /Length says 9,999,999 bytes; the stream is fifteen. The reader finds the
    // end by looking for it, so the image is the fifteen bytes that exist.
    const facts = readPdf(
      pdf('%PDF-1.5\n<< /Filter /DCTDecode /Length 9999999 >>\nstream\n', JPEG, '\nendstream', TRAILER)
    )
    expect(facts?.images[0]?.bytes).toHaveLength(JPEG.length)
  })
})

describe('notes that would otherwise be wrong', () => {
  it('does not call an empty /URI () an unterminated string', () => {
    const facts = readPdf(pdf('%PDF-1.4\n/URI ()\n/URI (https://evil.test/go)', TRAILER))
    expect(facts?.uris).toEqual(['https://evil.test/go'])
    expect(facts?.notes.join(' ')).not.toContain('never closed')
  })

  it('says so when a /URI value is an indirect reference, instead of reporting a URL-bearing file as bare', () => {
    // `/URI 12 0 R` is legal, and it is what someone who has read this scanner
    // writes. The value is in another object, which a scan does not follow — so
    // the one thing that must not happen is an empty list and silence.
    const facts = readPdf(
      pdf(
        '%PDF-1.7\n1 0 obj\n<< /Type /Action /S /URI /URI 12 0 R >>\nendobj\n' +
          '12 0 obj\n(https://evil.test/qr)\nendobj',
        TRAILER
      )
    )
    expect(facts?.uris).toEqual([])
    expect(facts?.notes.join(' ')).toContain('object reference')
  })

  it('counts a comment between /URI and its string as unread rather than dropping it in silence', () => {
    const facts = readPdf(pdf('%PDF-1.4\n/URI % a comment\n(https://evil.test/go)', TRAILER))
    expect(facts?.notes.join(' ')).toContain('1 /URI name(s) were followed by')
  })

  it('does not count the /S /URI action-type shape as an unresolved value', () => {
    // `/S /URI` is the key naming the action, followed by a name and not a
    // string. Counting it would put a caveat on every well-formed link action.
    const facts = readPdf(pdf('%PDF-1.4\n<< /S /URI /URI (https://evil.test/go) >>', TRAILER))
    expect(facts?.uris).toEqual(['https://evil.test/go'])
    expect(facts?.notes.join(' ')).not.toContain('/URI name(s) were followed by')
  })

  it('says when a stream was cut at an endstream inside its own data and the /Length disagrees', () => {
    // The stream declares 40 bytes; its data carries the nine bytes `endstream`
    // after four. What is handed back is those four, and a hash of them is a
    // real-looking SHA-256 of a file that is not in this document — so the
    // disagreement has to be said out loud, not left in a source comment.
    const facts = readPdf(
      pdf(
        '%PDF-1.5\n<< /Type /XObject /Subtype /Image /Filter /DCTDecode /Length 40 >>\nstream\n',
        Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]),
        'endstream',
        Uint8Array.from([0x01, 0x02, 0x03]),
        'PAYLOADTAIL',
        Uint8Array.from([0xff, 0xd9]),
        '\nendstream\nendobj',
        TRAILER
      )
    )
    // The declared length says 40; the run that `endstream` bounds is 4 bytes
    // that begin as a JPEG and do not end as one. Neither is a file in this
    // document, so nothing is handed back — a fragment carrying a real-looking
    // SHA-256 of something that is not in the file is the one output worse
    // than a missing one.
    expect(facts?.images).toEqual([])
    expect(facts?.notes.join(' ')).toContain('could not be confirmed to begin and end as a complete image')
  })

  it('says the same thing when /Length is written before /Filter, which is how Quartz writes it', () => {
    // Key order in a PDF dictionary carries no meaning, and the detector above
    // used to read only the keys written AFTER the filter name — so this file,
    // byte-for-byte the same document as the one above with two keys swapped,
    // got no note at all. Real producers (Quartz, and every PDF macOS writes
    // with it) write this order.
    const facts = readPdf(
      pdf(
        '%PDF-1.5\n<< /Type /XObject /Subtype /Image /Length 40 /Filter /DCTDecode >>\nstream\n',
        Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]),
        'endstream',
        Uint8Array.from([0x01, 0x02, 0x03]),
        'PAYLOADTAIL',
        Uint8Array.from([0xff, 0xd9]),
        '\nendstream\nendobj',
        TRAILER
      )
    )
    // The declared length says 40; the run that `endstream` bounds is 4 bytes
    // that begin as a JPEG and do not end as one. Neither is a file in this
    // document, so nothing is handed back — a fragment carrying a real-looking
    // SHA-256 of something that is not in the file is the one output worse
    // than a missing one.
    expect(facts?.images).toEqual([])
    expect(facts?.notes.join(' ')).toContain('could not be confirmed to begin and end as a complete image')
  })

  it('does not take a /Length out of the object before this one and call an honest stream mismatched', () => {
    // The cost of looking backwards for the key: a window that runs past the
    // end of the previous object reads ITS /Length and reports a mismatch on a
    // stream that is exactly what it declares — a wrong fact, which is the one
    // thing worse than the missing one it was added to fix.
    const facts = readPdf(
      pdf(
        '%PDF-1.5\n1 0 obj\n<< /Length 40 >>\nstream\nfourty-bytes-of-something-else-entirely\nendstream\nendobj\n',
        '2 0 obj\n<< /Filter /DCTDecode >>\nstream\n',
        JPEG,
        '\nendstream\nendobj',
        TRAILER
      )
    )
    expect(facts?.images).toHaveLength(1)
    expect([...(facts?.images[0]?.bytes ?? [])]).toEqual([...JPEG])
    expect(facts?.notes.join(' ')).not.toContain('declared a /Length that does not match')
  })

  it('counts an image entry whose stream is empty instead of dropping it without a word', () => {
    // `stream` with its `endstream` straight after: nothing to extract, and the
    // entry used to leave no trace anywhere in the result — not in the images,
    // not in the notes — while the two neighbouring failure paths were counted.
    const facts = readPdf(pdf('%PDF-1.5\n<< /Filter /DCTDecode /Length 0 >>\nstream\nendstream\nendobj', TRAILER))
    expect(facts?.images).toEqual([])
    expect(facts?.notes.join(' ')).toContain('1 /DCTDecode or /JPXDecode entr(ies) held nothing but line-ending bytes')
  })

  it('names the byte cap when one oversized image trips it, instead of "Stopped after 0 image(s)"', () => {
    // One image larger than the whole image budget stopped the loop before
    // anything was kept, and the note then read "Stopped after 0 image(s)
    // (caps: 24 images, 12582912 bytes)" — a sentence that reports a count of
    // zero against a cap of twenty-four and explains neither.
    const huge = new Uint8Array(12 * 1024 * 1024 + 1).fill(0x41)
    const facts = readPdf(pdf('%PDF-1.5\n<< /Filter /DCTDecode >>\nstream\n', huge, '\nendstream\nendobj', TRAILER))
    expect(facts?.images).toEqual([])
    const notes = facts?.notes.join(' ') ?? ''
    expect(notes).toContain('Stopped at an image stream of 12582913 bytes')
    expect(notes).not.toContain('Stopped after 0 image(s)')
    expect(notes).not.toContain('Stopped after 24 image(s)')
  })

  it('does not read an object number out of an indirect /Length and call every stream mismatched', () => {
    const facts = readPdf(
      pdf('%PDF-1.5\n<< /Filter /DCTDecode /Length 12 0 R >>\nstream\n', JPEG, '\nendstream', TRAILER)
    )
    expect(facts?.images).toHaveLength(1)
    expect(facts?.notes.join(' ')).not.toContain('declared a /Length that does not match')
  })

  it('carries the endstream ceiling in the result, not only in the source', () => {
    const facts = readPdf(pdf('%PDF-1.5\n<< /Filter /DCTDecode >>\nstream\n', JPEG, '\nendstream', TRAILER))
    expect(facts?.images).toHaveLength(1)
    expect(facts?.notes.join(' ')).toContain("cut at the next 'endstream' keyword")
  })

  it('does not say an image declared no direct /Length when it declared one this scan missed or found wrong', () => {
    // Both files DO declare a direct /Length. The first hides it behind the
    // inner `>>` of /DecodeParms, where the dictionary window is cut; the second
    // declares 12 for a 15-byte stream, so it does not land on `endstream`. Both
    // are cut by search, and the note used to say each "declared no direct
    // /Length" — a false sentence about each file, on the card and in the report.
    for (const dict of [
      '<< /Length 15 /DecodeParms << /ColorTransform 1 >> /Filter /DCTDecode >>',
      '<< /Length 12 /Filter /DCTDecode >>'
    ]) {
      const facts = readPdf(pdf(`%PDF-1.5\n${dict}\nstream\n`, JPEG, '\nendstream\nendobj', TRAILER))
      expect([...(facts?.images[0]?.bytes ?? [])]).toEqual([...JPEG])
      const notes = facts?.notes.join(' ') ?? ''
      expect(notes).not.toContain('declared no direct /Length')
      expect(notes).toContain("cut at the next 'endstream' keyword")
      expect(notes).toContain('had no direct /Length this scan could read')
    }
  })

  it('does not say an image cut at its declared /Length could be a prefix', () => {
    const facts = readPdf(pdf('%PDF-1.5\n<< /Filter /DCTDecode /Length 15 >>\nstream\n', JPEG, '\nendstream', TRAILER))
    expect(facts?.images).toHaveLength(1)
    expect(facts?.notes.join(' ')).not.toMatch(/endstream|prefix/)
  })
})

/**
 * A PDF dictionary has no key order, so every test here is the same document as
 * one the suite already passes with two keys swapped. Each one used to produce a
 * sentence about URLs that went unrecorded, printed at a file where every URL
 * was recorded — the shape of defect this module keeps generating: a claim about
 * the whole file, assembled from a look at part of it.
 */
describe('key order, which a dictionary does not have', () => {
  it('reads a /URI written BEFORE /S /URI and says nothing about unresolved values', () => {
    const facts = readPdf(
      pdf('%PDF-1.7\n1 0 obj\n<< /Type /Action /URI (https://intranet.example/doc0) /S /URI >>\nendobj', TRAILER)
    )
    expect(facts?.uris).toEqual(['https://intranet.example/doc0'])
    expect(facts?.notes.join(' ')).not.toContain('/URI name(s) were followed by')
  })

  it('takes the same shape written without the spaces a writer is free to leave out', () => {
    const facts = readPdf(pdf('%PDF-1.7\n<</URI(https://intranet.example/doc0)/S/URI>>', TRAILER))
    expect(facts?.uris).toEqual(['https://intranet.example/doc0'])
    expect(facts?.notes.join(' ')).not.toContain('/URI name(s) were followed by')
  })

  it('stays silent on an action type with no URL beside it at all', () => {
    // Nothing to report and nothing to caveat. The list being empty is the
    // whole answer; a note here would be a sentence about a missing URL that
    // was never in the file.
    const facts = readPdf(pdf('%PDF-1.7\n<< /Type /Action /S /URI >>', TRAILER))
    expect(facts?.uris).toEqual([])
    expect(facts?.notes.join(' ')).not.toContain('/URI name(s) were followed by')
  })

  it('counts only the entry that really does hide a URL, in a file full of the other order', () => {
    // The count is the load-bearing part. Sixty readable links written the
    // other way round plus ONE genuine `/URI 900 0 R` used to print 61, which
    // makes the one entry that is hiding something indistinguishable from the
    // sixty that are not.
    const links = Array.from(
      { length: 60 },
      (_, i) => `<< /Type /Action /URI (https://intranet.example/doc${i}) /S /URI >>`
    ).join('\n')
    const facts = readPdf(pdf('%PDF-1.7\n', links, '\n<< /S /URI /URI 900 0 R >>', TRAILER))
    expect(facts?.uris).toHaveLength(60)
    const notes = facts?.notes.join(' ') ?? ''
    expect(notes).toContain('1 /URI name(s) were followed by')
    expect(notes).not.toContain('61 /URI')
  })
})

describe('caps, which say where the scan stopped and not what is past it', () => {
  const IMAGE = ['<< /Filter /DCTDecode >>\nstream\n', JPEG, '\nendstream\n'] as const

  it('does not claim unextracted image streams when the 25th filter NAME is a repeat of one already taken', () => {
    // `/Filter [/DCTDecode /DCTDecode]` reaches the loop twice for one stream,
    // so the cap trips on a file whose every image stream was extracted. The
    // note used to read "further image streams in this file were not extracted"
    // — an assertion that there is more to see, at a file where there is not.
    const facts = readPdf(
      pdf(
        '%PDF-1.5\n',
        ...Array.from({ length: 23 }, () => IMAGE).flat(),
        '<< /Filter [/DCTDecode /DCTDecode] >>\nstream\n',
        JPEG,
        '\nendstream\n',
        TRAILER
      )
    )
    expect(facts?.images).toHaveLength(24)
    const notes = facts?.notes.join(' ') ?? ''
    expect(notes).toContain("Stopped after 24 image(s), which is this scan's cap")
    expect(notes).not.toContain('further image streams')
    expect(notes).toContain('unread rather than absent')
  })

  it('puts no cap note on a file holding exactly the cap', () => {
    // An off-by-one in a cap note is a false fact like any other: "stopped,
    // there is more" printed at a file with nothing past the cap.
    const facts = readPdf(pdf('%PDF-1.5\n', ...Array.from({ length: 24 }, () => IMAGE).flat(), TRAILER))
    expect(facts?.images).toHaveLength(24)
    expect(facts?.notes.join(' ')).not.toContain('Stopped after 24 image(s)')
  })

  it('puts no examined-entries note on a file holding exactly that many filter names', () => {
    const facts = readPdf(pdf('%PDF-1.4\n', '/DCTDecode '.repeat(4096), TRAILER))
    expect(facts?.images).toEqual([])
    expect(facts?.notes.join(' ')).not.toContain('Stopped after examining')
  })

  it('puts no URL cap note on a file holding exactly the URL cap', () => {
    const many = Array.from({ length: 200 }, (_, i) => `/URI (https://evil.test/${i})`).join('\n')
    const facts = readPdf(pdf('%PDF-1.4\n', many, TRAILER))
    expect(facts?.uris).toHaveLength(200)
    expect(facts?.notes.join(' ')).not.toContain('Stopped after 200 URLs')
  })
})

describe('strings that run away', () => {
  it('drops an unterminated string however long it is, rather than listing it as cut short', () => {
    // Same file as the short case the suite already pins, with padding. The
    // character cap used to RETURN at 4096, which turned "never closed" into
    // "cut short" — a plausible link that is not in the file, wearing the
    // benign caveat. The cap stops collecting; only a `)` ends the string.
    const facts = readPdf(pdf('%PDF-1.4\n/URI (https://evil.test/never-closed', 'A'.repeat(4200), TRAILER))
    expect(facts?.uris).toEqual([])
    expect(facts?.notes.join(' ')).toContain('never closed')
    expect(facts?.notes.join(' ')).not.toContain('cut short')
  })

  it('cuts a spaced hex string by characters kept, not raw bytes read, and says that it cut it', () => {
    // Whitespace between hex digits is legal, so a raw slice of MAX*2 bytes
    // yielded a third of the URL and left the notes silent about it.
    const url = `https://evil.test/${'a'.repeat(5000)}`
    const hex = [...url].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')
    const facts = readPdf(pdf(`%PDF-1.4\n/URI <${hex}>`, TRAILER))
    expect(facts?.uris).toEqual([url.slice(0, 4096) + GAP])
    expect(facts?.notes.join(' ')).toContain('cut short')
  })

  it('drops an odd trailing hex digit instead of padding it into a character that is not in the file', () => {
    const facts = readPdf(pdf('%PDF-1.4\n/URI <4142434>', TRAILER))
    expect(facts?.uris).toEqual(['ABC' + GAP])
  })

  it('ends a URL in a GAP where it dropped an odd digit, since a reader pads it into one more character', async () => {
    // A reader goes to `…paypal.cop` (§7.3.4.3: the missing digit is 0, so 7 is
    // `p`); listed bare, the prefix names a host this file never leads to.
    const hex = [...'https://secure.paypal.co'].map((c) => c.charCodeAt(0).toString(16)).join('')
    const facts = await deep(buildPdf([{ num: 1, body: `<< /Type /Catalog /Pages 2 0 R /URI <${hex}7> >>` }, NO_PAGES]))
    expect(facts.uris).toEqual([`https://secure.paypal.co${GAP}`])
    expect(parsedOf(facts).links.map((l) => l.uri)).toEqual(['https://secure.paypal.cop'])
  })

  it('does not say a string is "listed cut short" when the URL cap dropped it before it was listed', () => {
    // The note reads "…and is listed cut short", so it is a claim about a row
    // the analyst can go and look at. A string cut at 4,096 characters that then
    // fell out at the 200-URL cap sets the flag and appears nowhere, which sends
    // the reader looking down the list for a truncation that is not in it.
    const many = Array.from({ length: 200 }, (_, i) => `/URI (https://evil.test/${i})`).join('\n')
    const facts = readPdf(pdf('%PDF-1.4\n', many, `\n/URI (https://evil.test/${'a'.repeat(5000)})`, TRAILER))
    expect(facts?.uris).toHaveLength(200)
    expect(facts?.notes.join(' ')).toContain('Stopped after 200 URLs')
    expect(facts?.notes.join(' ')).not.toContain('cut short')
  })

  it('reads a hex URL spaced out past any fixed per-string span, and does not call it unterminated', () => {
    // §7.3.4.3 puts no bound on the whitespace between hex digits, so there is
    // no per-string byte span that fits every legal spelling of a URL. A span of
    // 16,384 dropped this 200-character link — raw span 16,759 — and printed
    // "never closed", which is a false statement about a file whose `>` is right
    // there. Nothing about this file is malformed; it is just written wide.
    const url = `https://evil.test/${'a'.repeat(182)}`
    expect(url).toHaveLength(200)
    const digits = [...url].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    const spaced = [...digits].join(' '.repeat(41))
    expect(spaced.length).toBe(16759)
    const facts = readPdf(pdf(`%PDF-1.4\n/URI <${spaced}>`, TRAILER))
    expect(facts?.uris).toEqual([url])
    expect(facts?.notes.join(' ')).not.toContain('never closed')
  })

  it('reads a fully octal-escaped URL at the character cap, which the old span was one byte short of', () => {
    // Four raw bytes per kept character is what the span was sized for, and it
    // was off by one at exactly that encoding: 4,095 characters came back, 4,096
    // vanished with a "never closed" note on a string that closes.
    const url = `https://evil.test/${'a'.repeat(4078)}`
    expect(url).toHaveLength(4096)
    const octal = [...url].map((c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`).join('')
    const facts = readPdf(pdf(`%PDF-1.4\n/URI (${octal})`, TRAILER))
    expect(facts?.uris[0]).toBe(url)
    expect(facts?.notes.join(' ')).not.toContain('never closed')
    expect(facts?.notes.join(' ')).not.toContain('cut short')
  })
})

describe('an ordinary long document', () => {
  it('reads every link in a 4,097-page file and puts no cap note on it', () => {
    // The shape that made a count of /URI entries examined the wrong bound: one
    // footer link repeated on every page. Each repeat is deduped and costs
    // almost nothing, so a cap of 4,096 attempts fired on a perfectly ordinary
    // document — and hid the one link that was different behind a note telling
    // the analyst that entries "were not looked at at all".
    const footer = '/URI (https://company.example/legal)\n'.repeat(4097)
    const facts = readPdf(pdf('%PDF-1.4\n', footer, '/URI (https://company.example/notice)\n', TRAILER))
    expect(facts?.uris).toEqual(['https://company.example/legal', 'https://company.example/notice'])
    expect(facts?.notes.join(' ')).not.toContain('not looked at')
    expect(facts?.notes.join(' ')).not.toContain('Stopped after')
  })
})

/**
 * Every payload here is a file whose per-match work used to be unbounded: the
 * caps counted results KEPT, and each of these yields nothing on every match,
 * so the loop ran to the last occurrence with an end-of-file scan inside it.
 *
 * readPdf is synchronous, and in Obsidian it runs on the renderer thread — so
 * the failure mode is a frozen window with no spinner and no cancel, ending in
 * `uris: []` as though the file were unremarkable. The assertions are wall
 * clock on purpose. A comment claiming this is fast is what was there before.
 *
 * Every payload carries one REAL item — a closed link, a whole JPEG — in front
 * of the hostile bulk, and every test asserts that item came back. `uris: []`
 * and a fast clock is also what a scanner that gave up at the header returns,
 * so a test asserting only emptiness passes against a module that does nothing.
 */
describe('files built to make the scan run away', () => {
  const MB = 1024 * 1024
  const REAL_LINK = 'https://evil.test/the-one-real-link'
  const REAL_IMAGE = ['<< /Filter /DCTDecode >>\nstream\n', JPEG, '\nendstream\n'] as const

  /** Measured on the unfixed module, same machine, same payloads, for scale. */
  const BEFORE = {
    hex: 6473,
    literal: 14787,
    noStream: 3232,
    noEndstream: 15610,
    distantEndstream: 31_800
  }

  function timed(bytes: Uint8Array): { ms: number; facts: ReturnType<typeof readPdf> } {
    const at = performance.now()
    const facts = readPdf(bytes)
    return { ms: performance.now() - at, facts }
  }

  /**
   * Half what the unfixed module took. A return to that shape still fails on any
   * runner up to twice as fast as the machine it was measured on, and a slow CI
   * runner keeps several times the fixed module's cost in hand: the one-second
   * ceiling this replaced failed the suite on efficiency cores.
   */
  function ceiling(before: number): number {
    return before / 2
  }

  it('bounds an unterminated hex string: no rescan to end-of-file per `<`', () => {
    const { ms, facts } = timed(pdf(`%PDF-1.4\n/URI (${REAL_LINK})\n`, '/URI<'.repeat(400_000), '\nendobj\n%%EOF'))
    expect(facts?.uris).toEqual([REAL_LINK])
    expect(ms).toBeLessThan(ceiling(BEFORE.hex))
  })

  it('bounds an unterminated literal string: the walk for the close has an end', () => {
    const { ms, facts } = timed(pdf(`%PDF-1.4\n/URI (${REAL_LINK})\n`, '/URI('.repeat(400_000), '\nendobj\n%%EOF'))
    expect(facts?.uris).toEqual([REAL_LINK])
    expect(ms).toBeLessThan(ceiling(BEFORE.literal))
  })

  it('bounds filter names with no stream keyword anywhere in the file', () => {
    const { ms, facts } = timed(pdf('%PDF-1.4\n', ...REAL_IMAGE, '/DCTDecode '.repeat(190_000), '\nendobj\n%%EOF'))
    expect([...(facts?.images[0]?.bytes ?? [])]).toEqual([...JPEG])
    expect(ms).toBeLessThan(ceiling(BEFORE.noStream))
  })

  it('bounds streams that never end: one "there is no endstream" answers them all', () => {
    const { ms, facts } = timed(
      pdf('%PDF-1.4\n', ...REAL_IMAGE, '/DCTDecode stream\n'.repeat(116_000), '\nendobj\n%%EOF')
    )
    expect([...(facts?.images[0]?.bytes ?? [])]).toEqual([...JPEG])
    expect(ms).toBeLessThan(ceiling(BEFORE.noEndstream))
  })

  it('bounds streams that all end at one distant endstream: a found answer serves every start before it', () => {
    // The found half of the same hole. Each run is 12MB of `a`, fails the
    // whole-image check and is dropped without touching the byte budget, so
    // the budget never stopped the loop: 4,096 searches of 12MB each, 31.8
    // seconds on the unfixed module. The bulk is built as bytes because
    // turning a 12MB string into them costs more than the scan being timed.
    const { ms, facts } = timed(
      pdf(
        '%PDF-1.7\n',
        ...REAL_IMAGE,
        '/DCTDecode stream\n'.repeat(4096),
        new Uint8Array(12e6).fill(0x61),
        'endstream\nendobj\n%%EOF'
      )
    )
    expect([...(facts?.images[0]?.bytes ?? [])]).toEqual([...JPEG])
    expect(ms).toBeLessThan(ceiling(BEFORE.distantEndstream))
  })

  it('counts an empty stream as work done, though it grows neither the image count nor the byte total', () => {
    // The third way past the old cap, and the cheap one: `end <= start` skips
    // before out.length moves. Each occurrence is individually inexpensive, so
    // this never showed up as a hang — it showed up as a loop with no bound on
    // it at all, which is the thing being pinned. The notes are the proof, as a
    // count of entries examined rather than a time: the cap fired, AND the
    // entries it stopped at are reported rather than dropped.
    const { facts } = timed(
      pdf('%PDF-1.4\n', ...REAL_IMAGE, '/DCTDecode stream\nendstream\n'.repeat(80_000), '\nendobj\n%%EOF')
    )
    expect([...(facts?.images[0]?.bytes ?? [])]).toEqual([...JPEG])
    const notes = facts?.notes.join(' ') ?? ''
    expect(notes).toContain('Stopped after examining 4096')
    expect(notes).toContain('held nothing but line-ending bytes')
  })

  it('stays within reach of a benign file of the same size at the module’s own scan cap', () => {
    // The absolute number belongs to the machine; the ratio belongs to the
    // code. A hostile 16MB file may cost more than a blank one — it must not
    // cost a different SHAPE, which is what 766 seconds against 0.3 was.
    // The benign baseline is now the scan alone: the bytes-to-text conversion
    // both files paid used to be most of it, and once that got about seven
    // times cheaper the hostile file's real per-marker cost showed through at
    // roughly 4x. Ten still catches a change of shape by orders of magnitude,
    // and it is the only bound here: a fixed two seconds failed on a slow runner.
    // Each file's best of three, taken in turn: one run under a parallel suite
    // came in at 10.2 times, a stall on one side and not a change of shape.
    const benignFile = pdf('%PDF-1.4\n', 'x'.repeat(16 * MB), '\nendobj\n%%EOF')
    const hostileFile = pdf(`%PDF-1.4\n/URI (${REAL_LINK})\n`, '/URI<'.repeat(3_300_000), '\nendobj\n%%EOF')
    let benign = Infinity
    let hostile = Infinity
    for (let run = 0; run < 3; run++) {
      benign = Math.min(benign, timed(benignFile).ms)
      const read = timed(hostileFile)
      expect(read.facts?.uris).toEqual([REAL_LINK])
      hostile = Math.min(hostile, read.ms)
    }
    expect(hostile).toBeLessThan(benign * 10)
  })

  it('says the strings it never got to went unread, not that they were never closed', () => {
    // Two wrong sentences this pins. The old one: "Stopped after 200 URLs" over
    // an empty list, naming a cap the loop never reached. The one the budget
    // could introduce: calling a string "never closed" when the scan stopped
    // walking before it would have found the close — a claim about the FILE
    // made out of a fact about the scan.
    const { facts } = timed(pdf('%PDF-1.4\n', '/URI('.repeat(400_000), '\nendobj\n%%EOF'))
    const notes = facts?.notes.join(' ') ?? ''
    expect(notes).toContain('/URI string(s) were not read')
    expect(notes).toContain('16777216 bytes in total')
    expect(notes).not.toContain('Stopped after 200 URLs')
  })

  it('says it stopped examining image entries, separately from the image and byte caps', () => {
    const { facts } = timed(pdf('%PDF-1.4\n', '/DCTDecode '.repeat(190_000), '\nendobj\n%%EOF'))
    const notes = facts?.notes.join(' ') ?? ''
    expect(notes).toContain('Stopped after examining 4096 /DCTDecode or /JPXDecode entries')
    expect(notes).not.toContain('Stopped after 0 image(s)')
  })
})

// ---- the object read (readPdfObjects) ----------------------------------------
//
// Tests marked "needs the page reader" also assert what pdfText.ts supplies —
// page text, and the annotation-to-page map a link's page comes from — and put
// those assertions last, so a fault there is told apart from one in this file.

const MiB = 2 ** 20
const DEEP = "The object read parsed this file's objects"
const SCAN = 'This is a byte scan, not a PDF parse'
const VERDICT = 'Nothing above is a verdict'

/** A readPdf scan, then the object read on top of it, as the phishing analyser runs them. */
async function deep(file: Uint8Array, media = { left: 1e9 }, message: Work = { left: 1e12 }): Promise<PdfFacts> {
  const facts = readPdf(file)
  if (!facts) throw new Error('not read as a PDF')
  await readPdfObjects(file, facts, media, message)
  return facts
}

function parsedOf(facts: PdfFacts): PdfParsed {
  if (!facts.parsed) throw new Error('the object read did not run')
  return facts.parsed
}

/** Plain ASCII as bytes, fast enough for 16MB fixtures (bytes() maps per character). */
function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** Deterministic noise: ciphertext stand-in that is not zlib and holds no PDF keywords. */
function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out[i] = x >>> 24
  }
  return out
}

async function timedDeep(file: Uint8Array): Promise<{ ms: number; facts: PdfFacts }> {
  const at = performance.now()
  const facts = await deep(file)
  return { ms: performance.now() - at, facts }
}

/**
 * Finished inside the object read's own deadline. That is the bound the code
 * enforces, so it holds on a CI runner several times slower than this machine,
 * where a fixed ceiling of two seconds failed the suite under load. A read that
 * runs away stops at FILE_PDF_MS and says so; the wall clock catches one that
 * runs away somewhere the deadline is never read.
 */
function inTime({ ms, facts }: { ms: number; facts: PdfFacts }): void {
  expect(facts.notes.join(' ')).not.toContain('stopped at its time limit')
  expect(ms).toBeLessThan(FILE_PDF_MS)
}

const CATALOG: Obj = { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' }
const NO_PAGES: Obj = { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' }
const HELVETICA = '<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> >>'

const LURE_TEXT = 'Your invoice is ready: https://pay-lure.test/inv'
/** C-1: everything that acts is packed in object stream 10, where the byte scan cannot see it. */
const LURE_MEMBERS = [
  { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>' },
  { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
  {
    num: 3,
    body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R /Annots [6 0 R] >>'
  },
  { num: 5, body: '<< /S /JavaScript /JS (app.launchURL\\("https://js-lure.test/a"\\);) >>' },
  {
    num: 6,
    body: '<< /Type /Annot /Subtype /Link /Rect [0 0 100 100] /A << /S /URI /URI (https://objstm-lure.test/login) >> >>'
  },
  { num: 7, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' }
]

function lure(extra: Obj[] = [], opts: BuildOptions = {}): Uint8Array {
  return buildPdf(
    [
      objStm(10, LURE_MEMBERS),
      { num: 4, body: '<< >>', stream: `BT /F1 12 Tf 72 700 Td (${LURE_TEXT}) Tj ET`, flate: true },
      ...extra
    ],
    { xrefStream: true, ...opts }
  )
}

describe('readPdfObjects: the lure the byte scan cannot see', () => {
  it('reads actions, scripts and links packed in an object stream, and replaces the "not visible" note', async () => {
    const facts = await deep(lure())
    // The gap, proven: the scan sees neither the script nor the link.
    expect(facts.markers.find((m) => m.name === '/JavaScript')).toBeUndefined()
    expect(facts.uris).toEqual([])
    const p = parsedOf(facts)
    expect(p.actions).toEqual([
      {
        type: '/JavaScript',
        trigger: 'when the document opens (/OpenAction)',
        target: '',
        where: 'object 5, packed in object stream 10'
      }
    ])
    expect(p.scripts).toHaveLength(1)
    expect(p.scripts[0].source).toContain('https://js-lure.test/a')
    expect(p.scripts[0].whole).toBe(true)
    expect(p.hiddenMarkers).toContainEqual({ name: '/OpenAction', count: 1 })
    expect(p.hiddenMarkers).toContainEqual({ name: '/JavaScript', count: 1 })
    expect(p.objectStreams).toEqual({ found: 1, read: 1 })
    const notes = facts.notes.join(' ')
    expect(notes).not.toContain('not visible')
    expect(notes).toContain('1 compressed object stream(s) were decompressed')
    expect(notes).toContain(DEEP)
    expect(notes).not.toContain(SCAN)
    expect(facts.notes[facts.notes.length - 1]).toContain(VERDICT)
    expect(p.links.map(({ uri, where, cut }) => ({ uri, where, cut }))).toEqual([
      { uri: 'https://objstm-lure.test/login', where: 'object 6, packed in object stream 10', cut: false }
    ])
    // Needs the page reader: the page comes from its annotation map.
    expect(p.links[0].page).toBe(1)
  })

  it('reads page text (C-10, needs the page reader)', async () => {
    const p = parsedOf(await deep(lure()))
    expect(p.pages[0]?.text).toBe(LURE_TEXT)
  })

  it('takes the trailer startxref points to, not a decoy XRef or a trailer inside stream data', async () => {
    const facts = await deep(
      lure([
        { num: 20, body: '<< /Type /XRef /Encrypt 21 0 R >>', stream: '' },
        { num: 21, body: '<< /Filter /Standard /V 2 /R 3 >>' },
        { num: 22, body: '<< >>', stream: 'trailer<</Root 50 0 R>>' },
        { num: 50, body: '<< /Type /Catalog >>' }
      ])
    )
    const p = parsedOf(facts)
    expect(p.encrypted).toBe(false)
    expect(p.actions.map((a) => a.where)).toEqual(['object 5, packed in object stream 10'])
    expect(facts.notes.join(' ')).toContain('does not point to an /Encrypt dictionary')
    // Needs the page reader.
    expect(p.pages[0]?.text).toBe(LURE_TEXT)
  })

  it('follows a /URI reference, decodes #-escaped names, and never prints the file’s own action type', async () => {
    const p = parsedOf(
      await deep(
        buildPdf([
          { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>' },
          NO_PAGES,
          { num: 5, body: '<< /S /J#61vaScript /JS (app.alert\\(1\\)) >>' },
          { num: 6, body: '<< /Type /Annot /Subtype /Link /A << /S /URI /URI 12 0 R >> >>' },
          { num: 7, body: '<< /JS (x) /S /x#0A#60#60#60#0A![[s]] >>' },
          { num: 12, body: '(https://ref-lure.test/x)' }
        ])
      )
    )
    expect(p.links.map((l) => [l.uri, l.where])).toEqual([['https://ref-lure.test/x', 'object 6']])
    expect(p.escapedMarkers).toEqual([{ name: '/JavaScript', count: 1 }])
    expect(p.actions.find((a) => a.where === 'object 5')).toMatchObject({
      type: '/JavaScript',
      trigger: 'when the document opens (/OpenAction)'
    })
    expect(p.actions.find((a) => a.where === 'object 7')?.type).toBe('/JavaScript')
  })
})

describe('a link or action target cut short ends in a GAP', () => {
  // Its first 4,096 characters end `….secure.paypal.co`: listed bare, that
  // prefix is a host this file never names, and it reached the case.
  const pad = 'a'.repeat(4096 - 'https://'.length - '.secure.paypal.co'.length)
  const long = `https://${pad}.secure.paypal.com.verify-acct.net/login`
  const prefix = long.slice(0, 4096)
  const catalog = (extra = ''): Obj => ({ num: 1, body: `<< /Type /Catalog /Pages 2 0 R ${extra} >>` })

  it('a /URI the byte scan cut', () => {
    expect(prefix.endsWith('.secure.paypal.co')).toBe(true)
    expect(readPdf(pdf(`%PDF-1.4\n/URI (${long})`, TRAILER))?.uris).toEqual([prefix + GAP])
  })

  it('a link the object read cut, and a whole link that a cut one begins with is still listed', async () => {
    const p = parsedOf(
      await deep(
        buildPdf(
          [
            catalog(),
            NO_PAGES,
            objStm(10, [
              { num: 5, body: `<< /URI (${long}) >>` },
              { num: 6, body: `<< /URI (${prefix}) >>` }
            ])
          ],
          { xrefStream: true }
        )
      )
    )
    expect(p.links.map((l) => [l.uri, l.cut])).toEqual([
      [prefix + GAP, true],
      [prefix, false]
    ])
  })

  it('a whole link is not dropped as a repeat of a /URI the byte scan cut', async () => {
    const facts = await deep(
      buildPdf(
        [
          catalog(),
          NO_PAGES,
          { num: 5, body: `<< /URI (${long}) >>` },
          objStm(10, [{ num: 6, body: `<< /URI (${prefix}) >>` }])
        ],
        { xrefStream: true }
      )
    )
    expect(facts.uris).toEqual([prefix + GAP])
    expect(parsedOf(facts).links.map((l) => l.uri)).toEqual([prefix])
  })

  it('an action target', async () => {
    const p = parsedOf(await deep(buildPdf([catalog(`/OpenAction << /S /URI /URI (${long}) >>`), NO_PAGES])))
    expect(p.actions.map((a) => a.target)).toEqual([prefix + GAP])
  })
})

describe('readPdfObjects: actions', () => {
  it('names each action’s target', async () => {
    const p = parsedOf(
      await deep(
        buildPdf([
          { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /URI /URI (https://open.test/) >> >>' },
          NO_PAGES,
          { num: 5, body: '<< /S /Launch /Win << /F (cmd.exe) /P (/c calc) >> >>' },
          { num: 6, body: '<< /S /SubmitForm /F << /FS /URL /F (https://exfil.test/p) >> >>' },
          { num: 7, body: '<< /S /GoToR /F (other.pdf) /D [0 /Fit] >>' }
        ])
      )
    )
    const at = (where: string): unknown => p.actions.find((a) => a.where === where)
    expect(at('object 5')).toMatchObject({ type: '/Launch', target: 'cmd.exe /c calc' })
    expect(at('object 6')).toMatchObject({ type: '/SubmitForm', target: 'https://exfil.test/p' })
    expect(at('object 7')).toMatchObject({ type: '/GoToR', target: 'other.pdf' })
    expect(at('object 1')).toEqual({
      type: '/URI',
      trigger: 'when the document opens (/OpenAction)',
      target: 'https://open.test/',
      where: 'object 1'
    })
    // The byte scan already lists that URL, so it is not listed twice.
    expect(p.links).toEqual([])
  })

  it('ranks by what runs each action, so a triggered one comes before 200 untriggered ones', async () => {
    const untriggered = Array.from({ length: 200 }, (_, k) => ({ num: 100 + k, body: '<< /S /JavaScript /JS (u) >>' }))
    const facts = await deep(
      buildPdf([
        ...untriggered,
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /Names << /JavaScript 8 0 R >> >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /AA << /O 11 0 R >> >>' },
        { num: 8, body: '<< /Names [(doc) 9 0 R] >>' },
        { num: 9, body: '<< /S /JavaScript /JS (docjs) >>' },
        { num: 11, body: '<< /S /JavaScript /JS (pageopen) >>' },
        { num: 12, body: '<< /S /Launch /F (a.exe) /Next 13 0 R >>' },
        { num: 13, body: '<< /S /Launch /F (b.exe) >>' }
      ])
    )
    const p = parsedOf(facts)
    expect(p.actions[0]).toEqual({
      type: '/JavaScript',
      trigger: 'when the document opens (document-level script in /Names /JavaScript)',
      target: '',
      where: 'object 9'
    })
    expect(p.actions[1]).toMatchObject({ trigger: 'when opened (/AA /O)', where: 'object 11' })
    expect(p.actions[2]).toEqual({
      type: '/Launch',
      trigger: 'after an earlier action runs (/Next)',
      target: 'b.exe',
      where: 'object 13'
    })
    expect(p.actions[3]).toMatchObject({ trigger: 'no trigger found by this reader', where: 'object 100' })
    expect(p.actions).toHaveLength(200)
    expect(facts.notes.join(' ')).toContain('Stopped after 200 actions read from the objects')
  })

  it('searches an earlier definition replaced later in the file, and says which one it was', async () => {
    const facts = await deep(
      buildPdf([CATALOG, NO_PAGES, { num: 5, body: '<</S/JavaScript/JS(evil)>>' }, { num: 5, body: '<< >>' }])
    )
    const p = parsedOf(facts)
    const where = 'object 5, an earlier definition replaced later in the file'
    expect(p.actions).toEqual([{ type: '/JavaScript', trigger: 'no trigger found by this reader', target: '', where }])
    expect(p.scripts).toEqual([{ where, source: 'evil', whole: true }])
    expect(facts.notes.join(' ')).toContain('1 object number(s) are defined more than once')
  })
})

describe('readPdfObjects: scripts', () => {
  it('decodes a script stored as a Flate stream and one written as a UTF-16BE string', async () => {
    const p = parsedOf(
      await deep(
        buildPdf([
          CATALOG,
          NO_PAGES,
          { num: 5, body: '<< /S /JavaScript /JS 6 0 R >>' },
          { num: 6, body: '<< >>', stream: 'app.alert("flate-js");', flate: true },
          { num: 7, body: '<< /S /JavaScript /JS <FEFF0068006927130021> >>' }
        ])
      )
    )
    expect(p.scripts).toEqual([
      { where: 'object 5', source: 'app.alert("flate-js");', whole: true },
      { where: 'object 7', source: 'hi✓!', whole: true }
    ])
  })

  it('reads at most ten and counts the rest', async () => {
    const js = Array.from({ length: 12 }, (_, k) => ({ num: 10 + k, body: `<< /S /JavaScript /JS (s${k}) >>` }))
    const facts = await deep(buildPdf([CATALOG, NO_PAGES, ...js]))
    expect(parsedOf(facts).scripts).toHaveLength(10)
    expect(facts.notes.join(' ')).toContain('2 further JavaScript action(s) were not decompressed')
  })

  it('says a script larger than it keeps was not read whole, and marks a GAP where it stops', async () => {
    // What was past the cap is unknown, so the last word kept may be part of one.
    const facts = await deep(
      buildPdf([
        CATALOG,
        NO_PAGES,
        { num: 5, body: '<< /S /JavaScript /JS 6 0 R >>' },
        { num: 6, body: '<< >>', stream: 'a'.repeat(2 * MiB), flate: true },
        // A string past the object layer's 1 MiB cut, the same.
        { num: 7, body: `<< /S /JavaScript /JS (${'b'.repeat(MiB + 1)}) >>` }
      ])
    )
    const scripts = parsedOf(facts).scripts
    expect(scripts.map((s) => [s.whole, s.source.length])).toEqual([
      [false, MiB + 1],
      [false, MiB + 1]
    ])
    expect(scripts[0].source).toBe(`${'a'.repeat(MiB)}${GAP}`)
    expect(scripts[1].source).toBe(`${'b'.repeat(MiB)}${GAP}`)
    expect(facts.notes.join(' ')).toContain('decompress to more than this reader keeps for that use')
  })

  it('charges /JS strings to the script share streams draw on, each distinct text once', async () => {
    // A string is never decoded, so the object layer's share never saw one:
    // ten 1 MiB literals per file were all scanned, and twelve such files ran a
    // message past its deadline. Four strings and a stream here fill the share
    // and one more; the sixth action runs the first's string again and costs nothing.
    const literal = (k: number): string => `${k}${'a'.repeat(MiB - 2)}`
    const facts = await deep(
      buildPdf([
        CATALOG,
        NO_PAGES,
        ...[0, 1, 2, 3, 4, 0].map((k, n) => ({ num: 10 + n, body: `<< /S /JavaScript /JS ${30 + k} 0 R >>` })),
        ...[0, 1, 2, 4].map((k) => ({ num: 30 + k, body: `(${literal(k)})` })),
        { num: 33, body: '<< >>', stream: literal(3), flate: true }
      ])
    )
    const scripts = parsedOf(facts).scripts
    expect(scripts.map((s) => [s.where, s.source.length, s.whole])).toEqual([
      ['object 10', MiB - 1, true],
      ['object 11', MiB - 1, true],
      ['object 12', MiB - 1, true],
      ['object 13', MiB - 1, true],
      ['object 14', 5, false],
      ['object 15', MiB - 1, true]
    ])
    // Cut mid-word, so a GAP: the word beside it is not scanned as a whole one.
    expect(scripts[4].source).toBe(`4aaa${GAP}`)
    expect(facts.notes.join(' ')).toContain(
      '1 JavaScript source(s) were quoted and scanned for indicators only in part, or not at all: this reader ' +
        'takes at most 4194304 characters of JavaScript from one file'
    )
  })

  it('marks no GAP where the script share runs out between two words', async () => {
    // The word beside a GAP is left out of the indicators: one here dropped a whole URL.
    const url = 'https://share-cap-lure.test/a'
    const L = MiB - 100
    const kept = `${'z'.repeat(4 * MiB - 4 * L - url.length - 1)} ${url}`
    const facts = await deep(
      buildPdf([
        CATALOG,
        NO_PAGES,
        ...[0, 1, 2, 3, 4].map((k) => ({ num: 10 + k, body: `<< /S /JavaScript /JS ${30 + k} 0 R >>` })),
        ...[0, 1, 2, 3].map((k) => ({ num: 30 + k, body: `(${k}${'a'.repeat(L - 1)})` })),
        { num: 34, body: `(${kept} more)` }
      ])
    )
    expect(parsedOf(facts).scripts[4]).toEqual({ where: 'object 14', source: kept, whole: false })
  })

  it('takes no checksum the file wrote for proof that a script or an embedded file lost nothing', async () => {
    // A stored block that is not the last, a byte no block starts with, then
    // the checksum of what came out: what the stream held past the break is
    // unknown, so the script ends in a GAP and the file is not hashed.
    const text = 'app.launchURL("https://broken-js.test/a")'
    const len = String.fromCharCode(text.length, 0, ~text.length & 0xff, 0xff)
    const broken = bytes('\x78\x01\x00', len, text, '\xff', zlib(text).subarray(-4))
    const p = parsedOf(
      await deep(
        buildPdf([
          CATALOG,
          NO_PAGES,
          { num: 5, body: '<< /S /JavaScript /JS 6 0 R >>' },
          { num: 6, body: '<< /Filter /FlateDecode >>', stream: broken },
          // No /Length: the end found at endstream, which loses nothing.
          { num: 7, body: '<< /S /JavaScript /JS 9 0 R >>' },
          { num: 9, body: '', raw: '9 0 obj\n<< >>\nstream\napp.alert("searched")\nendstream\nendobj\n' },
          { num: 10, body: '<< /Type /Filespec /F (a.bin) /EF << /F 11 0 R >> >>' },
          { num: 11, body: '<< /Type /EmbeddedFile /Filter /FlateDecode >>', stream: broken }
        ])
      )
    )
    expect(p.scripts).toEqual([
      { where: 'object 5', source: `${text}${GAP}`, whole: false },
      { where: 'object 7', source: 'app.alert("searched")', whole: false }
    ])
    const [file] = p.embeddedFiles
    expect(String.fromCharCode(...file.head)).toBe(text)
    expect(file.bytes).toBeNull()
  })

  it('makes a GAP the file writes U+FFFD in every text it gives, so it cannot hide an indicator', async () => {
    const forged = '<FEFF0061E0000062>' // UTF-16BE "a", U+E000, "b"
    const p = parsedOf(
      await deep(
        buildPdf(
          [
            { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] >> >>' },
            NO_PAGES,
            { num: 5, body: `<< /S /JavaScript /JS ${forged} >>` },
            { num: 6, body: `<< /FT /Tx /T ${forged} /V ${forged} >>` },
            { num: 8, body: `<< /Type /Filespec /UF ${forged} /EF << /F 9 0 R >> >>` },
            { num: 9, body: '<< /Type /EmbeddedFile >>', stream: 'x' },
            { num: 20, body: `<< /Title ${forged} >>` }
          ],
          { trailer: '/Info 20 0 R' }
        )
      )
    )
    const read = 'a\uFFFDb'
    expect(p.scripts.map((s) => s.source)).toEqual([read])
    expect(p.fields.map((f) => [f.name, f.value])).toEqual([[read, read]])
    expect(p.embeddedFiles.map((f) => f.names)).toEqual([[read]])
    expect(p.info).toEqual([{ key: 'Title', value: read }])
    // What phish.ts imports from here, the same contract as pdfObjects.ts.
    expect([GAP, stripGap(`x${GAP}y${GAP}`)]).toEqual(['\uE000', 'x\uFFFDy\uFFFD'])
  })
})

describe('readPdfObjects: embedded files, fields and declared information', () => {
  it('lists every name an embedded file gives itself, and keeps its bytes only when decoded whole', async () => {
    const exe = `MZ${'\x90'.repeat(100)}`
    const p = parsedOf(
      await deep(
        buildPdf([
          CATALOG,
          NO_PAGES,
          { num: 8, body: '<< /Type /Filespec /UF (invoice.pdf) /F (invoice.exe.) /EF << /F 9 0 R >> >>' },
          { num: 9, body: '<< /Type /EmbeddedFile /Params << /Size 1234 >> >>', stream: exe, flate: true }
        ])
      )
    )
    const [file] = p.embeddedFiles
    expect(file).toMatchObject({
      name: 'invoice.pdf',
      names: ['invoice.pdf', 'invoice.exe.'],
      size: 1234,
      where: 'object 8'
    })
    expect([...file.head.subarray(0, 2)]).toEqual([0x4d, 0x5a])
    expect(file.bytes).toHaveLength(exe.length)
  })

  it('does not hand back bytes for an embedded file it could not read whole', async () => {
    const p = parsedOf(
      await deep(
        buildPdf([
          CATALOG,
          NO_PAGES,
          { num: 8, body: '<< /Type /Filespec /F (big.bin) /EF << /F 9 0 R >> >>' },
          { num: 9, body: '<< /Type /EmbeddedFile >>', stream: new Uint8Array(9 * MiB), flate: true }
        ])
      )
    )
    const [file] = p.embeddedFiles
    expect(file.bytes).toBeNull()
    expect(file.head).toHaveLength(512)
    expect(file.size).toBeNull()
  })

  it('reads form fields with inherited types, the XFA flag and the declared producer', async () => {
    const p = parsedOf(
      await deep(
        buildPdf(
          [
            { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [10 0 R] /XFA 13 0 R >> >>' },
            NO_PAGES,
            { num: 10, body: '<< /T (login) /FT /Tx /Kids [11 0 R 12 0 R] >>' },
            { num: 11, body: '<< /T (user) /V (alice) /Parent 10 0 R >>' },
            { num: 12, body: '<< /T (pass) /V (hunter2) /Ff 8192 /Parent 10 0 R >>' },
            { num: 13, body: '<< >>', stream: '<xdp:xdp/>' },
            { num: 20, body: '<< /Producer (macOS Version 27.0 \\(Build 26A428\\) Quartz PDFContext) >>' }
          ],
          { trailer: '/Info 20 0 R' }
        )
      )
    )
    expect(p.fields).toEqual([
      { name: 'login.user', value: 'alice', type: '/Tx', password: false },
      { name: 'login.pass', value: 'hunter2', type: '/Tx', password: true }
    ])
    expect(p.xfa).toBe(true)
    expect(p.info[0]).toEqual({ key: 'Producer', value: 'macOS Version 27.0 (Build 26A428) Quartz PDFContext' })
  })

  it('reads fields from page widgets that /AcroForm does not list, as Apple’s PDFKit writes them', async () => {
    // PDFKit writes /T /FT /V on the widget and no /AcroForm at all, and Preview
    // shows them as fields. With no /AP drawing it, this /V reached the case nowhere.
    const facts = await deep(
      buildPdf([
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] >> >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [5 0 R 7 0 R 9 0 R] >>' },
        {
          num: 5,
          body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (login) /F 4 /Rect [40 600 400 620] /V (Visit http://orphan-value.example.net/x) >>'
        },
        // Listed, with its widget on the page: read once, through /AcroForm.
        { num: 6, body: '<< /FT /Tx /T (user) /V (alice) /Kids [7 0 R] >>' },
        { num: 7, body: '<< /Type /Annot /Subtype /Widget /Parent 6 0 R >>' },
        // Not listed, and its widget names no field itself: the field is its parent.
        { num: 8, body: '<< /FT /Btn /T (agree) /V /Yes /Kids [9 0 R] >>' },
        { num: 9, body: '<< /Type /Annot /Subtype /Widget /Parent 8 0 R >>' }
      ])
    )
    expect(parsedOf(facts).fields).toEqual([
      { name: 'user', value: 'alice', type: '/Tx', password: false },
      { name: 'login', value: 'Visit http://orphan-value.example.net/x', type: '/Tx', password: false },
      { name: 'agree', value: '/Yes', type: '/Btn', password: false }
    ])
    expect(facts.notes.join(' ')).toContain(
      "2 form field(s) were read from widget annotations on the pages that the document's /AcroForm does not list"
    )
  })

  it('says a /V it does not list is unread, not unset: a signature, a stream, a number', async () => {
    const p = parsedOf(
      await deep(
        buildPdf([
          {
            num: 1,
            body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R 7 0 R 8 0 R 11 0 R 12 0 R] >> >>'
          },
          NO_PAGES,
          { num: 6, body: '<< /FT /Sig /T (Signature1) /V 9 0 R >>' },
          { num: 7, body: '<< /FT /Tx /T (Notes) /V 10 0 R >>' },
          { num: 8, body: '<< /FT /Tx /T (Count) /V 42 >>' },
          { num: 9, body: '<< /Type /Sig /Filter /Adobe.PPKLite /Name (Mallory) /Contents <00112233> >>' },
          { num: 10, body: '<< >>', stream: 'rich text value https://stream-field.test/x' },
          // Set to nothing, which is what "no value set" says.
          { num: 11, body: '<< /FT /Tx /T (Blank) /V () >>' },
          { num: 12, body: '<< /FT /Tx /T (Empty) >>' }
        ])
      )
    )
    expect(p.fields).toEqual([
      { name: 'Signature1', value: '', type: '/Sig', password: false, unread: true },
      { name: 'Notes', value: '', type: '/Tx', password: false, unread: true },
      { name: 'Count', value: '', type: '/Tx', password: false, unread: true },
      { name: 'Blank', value: '', type: '/Tx', password: false },
      { name: 'Empty', value: '', type: '/Tx', password: false }
    ])
    expect(p.fields.filter((f) => 'unread' in f)).toHaveLength(3)
  })

  it('says a field value was cut only when /V holds more, which its length cannot say', async () => {
    const fill = 'x'.repeat(980)
    const url = ' https://exact.test/a' // 21 characters: with `fill`, 1,001 — one past the cap
    const facts = await deep(
      buildPdf([
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R 7 0 R 8 0 R 9 0 R] >> >>' },
        NO_PAGES,
        // Exactly the cap, ending in a URL: whole.
        { num: 6, body: `<< /FT /Tx /T (Exact) /V (${fill.slice(1)}${url}) >>` },
        { num: 7, body: `<< /FT /Tx /T (Over) /V (${fill}${url}) >>` },
        // Two choices filling the cap exactly; the number after them adds nothing.
        { num: 8, body: `<< /FT /Ch /T (Fills) /V [(${'y'.repeat(997)}) (z) 5] >>` },
        { num: 9, body: `<< /FT /Ch /T (Runs) /V [(${'y'.repeat(997)}) (z) (more)] >>` }
      ])
    )
    const p = parsedOf(facts)
    expect(p.fields.map((f) => [f.name, f.value.length, f.cut])).toEqual([
      ['Exact', 1000, undefined],
      // Cut inside the URL: a GAP after what was kept.
      ['Over', 1001, true],
      ['Fills', 1000, undefined],
      // Cut where `, more` starts: no word split, so no GAP.
      ['Runs', 1000, true]
    ])
    expect(p.fields[0].value.endsWith('https://exact.test/a')).toBe(true)
    expect(p.fields[1].value.endsWith(`https://exact.test/${GAP}`)).toBe(true)
    expect(facts.notes.join(' ')).toContain('1000 for a form field value')
  })

  it('marks a GAP after a cut value only where the cut splits a word', async () => {
    // The word beside a GAP is left out of the indicators, so a GAP after a cut
    // between two words, or where the `, ` between two elements starts, dropped a whole URL.
    const url = 'https://field-cap-lure.test/pay'
    const fill = 'x'.repeat(1000 - url.length - 1)
    const head = 'y'.repeat(1000 - url.length - 2)
    const p = parsedOf(
      await deep(
        buildPdf([
          { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R 7 0 R 8 0 R] >> >>' },
          NO_PAGES,
          { num: 6, body: `<< /FT /Tx /T (Space) /V (${fill} ${url} and more) >>` },
          { num: 7, body: `<< /FT /Tx /T (Mid) /V (${fill} ${url}more) >>` },
          { num: 8, body: `<< /FT /Ch /T (Elements) /V [(${head}) (${url}) (more)] >>` }
        ])
      )
    )
    expect(p.fields.map((f) => [f.name, f.value, f.cut])).toEqual([
      ['Space', `${fill} ${url}`, true],
      ['Mid', `${fill} ${url}${GAP}`, true],
      ['Elements', `${head}, ${url}`, true]
    ])
  })

  it('says array elements it never examined in a note, not as a cut value or an unset one', async () => {
    // The element cap stops between whole elements, so `cut` there made the
    // phishing analyser drop the last one, a whole URL, as a cut word. And a
    // run of empty strings examined, with the rest not, read as "no value set".
    const facts = await deep(
      buildPdf([
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R 7 0 R 8 0 R] >> >>' },
        NO_PAGES,
        { num: 6, body: `<< /FT /Ch /T (Url) /V [(https://evil-choice.test/pay) ${'0 '.repeat(1000)}] >>` },
        { num: 7, body: `<< /FT /Ch /T (Blanks) /V [${'() '.repeat(1001)}(https://arr-lure.test/x)] >>` },
        // Every element examined: whole, and nothing to say.
        { num: 8, body: `<< /FT /Ch /T (Whole) /V [(https://whole.test/a) ${'0 '.repeat(998)}] >>` }
      ])
    )
    expect(parsedOf(facts).fields).toEqual([
      { name: 'Url', value: 'https://evil-choice.test/pay', type: '/Ch', password: false },
      { name: 'Blanks', value: '', type: '/Ch', password: false, unread: true },
      { name: 'Whole', value: 'https://whole.test/a', type: '/Ch', password: false }
    ])
    const notes = facts.notes.join(' ')
    expect(notes).toContain(
      '2 form field value(s) are arrays this reader stopped examining part way, after 1000 elements or once the ' +
        'value listed ran past 1000 characters; the elements after that point are unread, not absent.'
    )
    expect(notes).not.toContain('shown cut short')
  })

  it('reads a real Quartz file: its link through a /URI reference, and what it declares about itself', async () => {
    const p = parsedOf(await deep(fixture('quartz-lure.pdf')))
    expect(p.info.map((i) => i.key)).toEqual(['Producer', 'Creator', 'CreationDate', 'ModDate'])
    expect(p.info[0].value).toBe('macOS Version 27.0 (Build 26A428) Quartz PDFContext')
    expect(p.links.map((l) => l.uri)).toEqual(['https://docusign-review.example.org/sign?id=8841'])
    expect(p.actions).toEqual([])
    // Needs the page reader.
    expect(p.links[0].page).toBe(1)
  })
})

describe('readPdfObjects: encrypted files', () => {
  function encrypted(box: Obj): Uint8Array {
    return buildPdf(
      [
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        {
          num: 3,
          body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [6 0 R 8 0 R] >>'
        },
        { num: 4, body: '<< /Filter /FlateDecode >>', stream: noise(200, 2) },
        { num: 5, body: '<< /S /JavaScript /JS (\x9b\x13\xe0Q\x07) >>' },
        { num: 6, body: '<< /Type /Annot /Subtype /Link /A << /S /URI /URI (\x8f\x12q\xd3) >> >>' },
        // Through a reference, which the byte scan does not read: only the object read could leak this one.
        { num: 8, body: '<< /Type /Annot /Subtype /Link /A << /S /URI /URI 12 0 R >> >>' },
        { num: 9, body: '<< /S /Launch /F (\x9c\x81\xe7) >>' },
        { num: 12, body: '(\x8f\x12q\xd3\x01)' },
        box,
        { num: 30, body: '<< /Filter /Standard /V 2 /R 3 >>' },
        { num: 31, body: '<< /Producer (\x9a\x07\xc4) >>' }
      ],
      { trailer: '/Encrypt 30 0 R /Info 31 0 R' }
    )
  }

  it('lists what runs, never the ciphertext, and says what it could not read', async () => {
    const facts = await deep(
      encrypted({ num: 10, body: '<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode >>', stream: noise(200, 3) })
    )
    const p = parsedOf(facts)
    expect(p.encrypted).toBe(true)
    expect(p.actions).toEqual([
      { type: '/JavaScript', trigger: 'when the document opens (/OpenAction)', target: '', where: 'object 5' },
      { type: '/Launch', trigger: 'no trigger found by this reader', target: '', where: 'object 9' }
    ])
    expect(p.scripts).toEqual([])
    expect(p.links).toEqual([])
    expect(p.fields).toEqual([])
    expect(p.info).toEqual([])
    expect(p.objectStreams).toEqual({ found: 1, read: 0 })
    const notes = facts.notes.join(' ')
    expect(notes).toContain('1 of 1 compressed object stream(s) could not be read')
    expect(notes).toContain("This file's trailer points to an /Encrypt dictionary (Standard)")
    expect(notes).toContain('were not read because this file is encrypted')
    expect(notes).toContain('1 JavaScript source(s) are strings stored encrypted')
    // Needs the page reader.
    expect(p.pages.length).toBeGreaterThan(0)
    expect(p.pages.every((page) => page.unread > 0)).toBe(true)
    expect(notes).not.toContain('No page read whole drew text')
  })

  it('never lists a field name or value read from ciphertext', async () => {
    const facts = await deep(
      buildPdf(
        [
          { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [7 0 R] >> >>' },
          NO_PAGES,
          { num: 7, body: '<< /T (\x91\xd2) /FT /Tx /V (\x93\xb4) /Ff 8192 >>' },
          { num: 30, body: '<< /Filter /Standard /V 2 /R 3 >>' }
        ],
        { trailer: '/Encrypt 30 0 R' }
      )
    )
    expect(parsedOf(facts).fields).toEqual([{ name: '', value: '', type: '/Tx', password: true }])
    expect(facts.notes.join(' ')).toContain('1 form field value(s) are stored encrypted in this file')
  })

  it('reads an object stream that verifies, and says why it trusted it', async () => {
    const facts = await deep(
      encrypted(
        objStm(10, [
          { num: 40, body: '<< /Type /Annot /Subtype /Link /A << /S /URI /URI (https://verified.test/x) >> >>' }
        ])
      )
    )
    const p = parsedOf(facts)
    expect(p.links.map((l) => [l.uri, l.where])).toEqual([
      ['https://verified.test/x', 'object 40, packed in object stream 10']
    ])
    expect(facts.notes.join(' ')).toContain('decompressed with a matching checksum and were read')
  })

  it('reads the strings of a file that encrypts only its attachments (/StrF /Identity) as cleartext', async () => {
    const facts = await deep(
      buildPdf(
        [
          { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
          { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [6 0 R] >>' },
          // Through a reference, so it is the object read that lists it.
          { num: 6, body: '<< /Type /Annot /Subtype /Link /A << /S /URI /URI 12 0 R >> >>' },
          { num: 12, body: '(https://attachments-only.test/x)' },
          {
            num: 30,
            body: '<< /Filter /Standard /V 4 /R 4 /CF << /StdCF << /CFM /AESV2 >> >> /StmF /Identity /StrF /Identity /EFF /StdCF >>'
          }
        ],
        // Written into the trailer, with no object of its own.
        { trailer: '/Encrypt 30 0 R /Info << /Producer (Acrobat Pro) >>' }
      )
    )
    const p = parsedOf(facts)
    expect([p.encrypted, p.stringsEncrypted]).toEqual([true, false])
    expect(p.links.map((l) => l.uri)).toEqual(['https://attachments-only.test/x'])
    expect(p.info).toEqual([{ key: 'Producer', value: 'Acrobat Pro' }])
    const notes = facts.notes.join(' ')
    expect(notes).toContain('(Standard) that leaves its strings unencrypted')
    expect(notes).not.toContain('read from their encrypted bytes')
  })

  it('reads normally when /Encrypt is only in a comment, and says the trailer does not point to one', async () => {
    const facts = await deep(lure([], { tail: '% /Encrypt\n' }))
    expect(facts.encrypted).toBe(true)
    const p = parsedOf(facts)
    expect(p.encrypted).toBe(false)
    expect(p.actions).toHaveLength(1)
    expect(p.scripts).toHaveLength(1)
    expect(facts.notes.join(' ')).toContain(
      "The name /Encrypt appears in this file's bytes, but the trailer read here does not point to an /Encrypt dictionary"
    )
  })
})

describe('readPdfObjects: a device that cannot inflate', () => {
  async function noInflate(file: Uint8Array): Promise<PdfFacts> {
    const saved = globalThis.DecompressionStream
    Reflect.deleteProperty(globalThis, 'DecompressionStream')
    try {
      return await deep(file)
    } finally {
      Object.defineProperty(globalThis, 'DecompressionStream', { value: saved, configurable: true, writable: true })
    }
  }
  const WIDGET =
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (login) /Rect [0 0 1 1] /V (Visit http://w.example.net/x) >>'
  const ON_PAGE = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [5 0 R] >>'

  it('does not say /AcroForm leaves out a page field when part of it could not be read', async () => {
    const files = [
      // The /AcroForm itself is packed in the object stream.
      buildPdf([
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm 20 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, body: ON_PAGE },
        { num: 5, body: WIDGET },
        objStm(10, [{ num: 20, body: '<< /Fields [5 0 R] >>' }])
      ]),
      // The /AcroForm is read, but the field between it and the widget is packed.
      buildPdf([
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] >> >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, body: ON_PAGE },
        { num: 5, body: `${WIDGET.slice(0, -2)}/Parent 21 0 R >>` },
        { num: 6, body: '<< /T (acct) /Kids [21 0 R] >>' },
        objStm(10, [{ num: 21, body: '<< /T (inner) /Parent 6 0 R /Kids [5 0 R] >>' }])
      ])
    ]
    for (const file of files) {
      const facts = await noInflate(file)
      expect(parsedOf(facts).fields).toContainEqual({
        name: 'login',
        value: 'Visit http://w.example.net/x',
        type: '/Tx',
        password: false
      })
      const notes = facts.notes.join(' ')
      expect(notes).toContain(
        "1 form field(s) were read from widget annotations on the pages; the document's /AcroForm could not be read " +
          'whole here, so whether it lists them is unknown.'
      )
      expect(notes).not.toContain('does not list')
    }
  })

  it('says a /V whose object could not be read is unread, not unset — and /V null is unset', async () => {
    const facts = await noInflate(
      buildPdf([
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R 7 0 R] >> >>' },
        NO_PAGES,
        { num: 6, body: '<< /FT /Tx /T (login) /V 21 0 R >>' },
        { num: 7, body: '<< /FT /Tx /T (cleared) /V null >>' },
        objStm(10, [{ num: 21, body: '(Visit http://v.example.net/x)' }])
      ])
    )
    expect(parsedOf(facts).fields).toEqual([
      { name: 'login', value: '', type: '/Tx', password: false, unread: true },
      { name: 'cleared', value: '', type: '/Tx', password: false }
    ])
  })

  it('still lists top-level actions and says the compressed parts are unread', async () => {
    const saved = globalThis.DecompressionStream
    Reflect.deleteProperty(globalThis, 'DecompressionStream')
    try {
      const facts = await deep(
        onePage('BT /F1 12 Tf 72 700 Td (hello) Tj ET', {
          extra: [
            { num: 5, body: '<< /S /Launch /F (calc.exe) >>' },
            objStm(10, [{ num: 20, body: '<< /S /JavaScript /JS (packed) >>' }])
          ]
        })
      )
      expect(parsedOf(facts).actions).toContainEqual({
        type: '/Launch',
        trigger: 'no trigger found by this reader',
        target: 'calc.exe',
        where: 'object 5'
      })
      const notes = facts.notes.join(' ')
      expect(notes).toContain('This device cannot decompress /FlateDecode data')
      expect(notes).toContain('1 of 1 compressed object stream(s) could not be read')
      // Needs the page reader: PT-UNREAD, and no PT-NOTEXT over a page that was not read.
      expect(notes).toContain('could not all be read')
      expect(notes).not.toContain('No page read whole drew text')
    } finally {
      Object.defineProperty(globalThis, 'DecompressionStream', { value: saved, configurable: true, writable: true })
    }
  })

  it('does not say page text was among the streams it could not read when only a script was', async () => {
    const saved = globalThis.DecompressionStream
    Reflect.deleteProperty(globalThis, 'DecompressionStream')
    try {
      const facts = await deep(
        buildPdf([
          { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>' },
          { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
          {
            num: 3,
            body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font ${HELVETICA} >> /Contents 4 0 R >>`
          },
          { num: 4, body: '<< >>', stream: 'BT /F1 12 Tf 72 700 Td (Readable page text) Tj ET' },
          { num: 5, body: '<< /S /JavaScript /JS 6 0 R >>' },
          { num: 6, body: '<< >>', stream: 'app.alert("x")', flate: true }
        ])
      )
      expect(parsedOf(facts).pages[0]?.text).toBe('Readable page text')
      const notes = facts.notes.join(' ')
      expect(notes).toContain('1 compressed stream(s) this reader needed were not read')
      expect(notes).not.toContain('among them')
    } finally {
      Object.defineProperty(globalThis, 'DecompressionStream', { value: saved, configurable: true, writable: true })
    }
  })
})

describe('readPdfObjects: files built to make the read run away', () => {
  const REAL = '<< /S /JavaScript /JS (real) >>'

  it('bounds a million definitions of one object number, and says where it stopped', async () => {
    // The real object comes after 262,144 valid headers, so the header scan has
    // stopped before it: the object read cannot return it, and says so. The byte
    // scan still counts it — the one real item this file gives back.
    const file = ascii(
      `%PDF-1.7\n${'1 0 obj 1 endobj'.repeat(1_000_000)}\n2 0 obj << /Type /Catalog /OpenAction ${REAL} >> endobj\n%%EOF\n`
    )
    const run = await timedDeep(file)
    expect(run.facts.markers).toContainEqual({ name: '/OpenAction', count: 1 })
    expect(run.facts.notes.join(' ')).toContain('The object read stopped at its limit of 50000 objects')
    inTime(run)
  })

  it('bounds an array nested 16MB deep after the real object', async () => {
    const head = `%PDF-1.7\n1 0 obj << /Type /Catalog /OpenAction 2 0 R >> endobj\n2 0 obj ${REAL} endobj\n3 0 obj `
    const run = await timedDeep(ascii(`${head}${'['.repeat(16 * MiB - head.length - 64)}\nendobj\n%%EOF\n`))
    expect(parsedOf(run.facts).actions.map((a) => a.where)).toEqual(['object 2'])
    inTime(run)
  })

  for (const place of ['first', 'last'] as const) {
    it(`bounds 80 strings that never close, with the real item ${place}`, async () => {
      const junk = Array.from({ length: 80 }, (_, k) => `${10 + k} 0 obj (${'a'.repeat(200_000)}\n`).join('')
      const real = `${place === 'first' ? 1 : 99} 0 obj ${REAL} endobj\n`
      const file = ascii(`%PDF-1.7\n${place === 'first' ? real + junk : junk + real}%%EOF\n`)
      const run = await timedDeep(file)
      expect(parsedOf(run.facts).actions.map((a) => a.where)).toEqual([`object ${place === 'first' ? 1 : 99}`])
      expect(run.facts.notes.join(' ')).toContain('object(s) could not be parsed')
      inTime(run)
    })
  }

  it('bounds 200 object streams that each inflate to 64MB', async () => {
    const bomb = zlib(new Uint8Array(64 * MiB))
    const bombs = Array.from({ length: 200 }, (_, k) => ({
      num: 100 + k,
      body: '<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode >>',
      stream: bomb
    }))
    const file = buildPdf([
      ...bombs,
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>' },
      NO_PAGES,
      { num: 5, body: REAL }
    ])
    const run = await timedDeep(file)
    expect(parsedOf(run.facts).actions.map((a) => a.where)).toEqual(['object 5'])
    expect(run.facts.notes.join(' ')).toContain("Stopped decompressing at this reader's limits for one file")
    inTime(run)
  })

  it('bounds a page tree of 100,000 kids that all point at one page (needs the page reader)', async () => {
    const file = buildPdf([
      CATALOG,
      { num: 2, body: `<< /Type /Pages /Kids [${'3 0 R '.repeat(100_000)}] /Count 100000 >>` },
      { num: 3, body: `<< /Type /Page /Parent 2 0 R /Resources << /Font ${HELVETICA} >> /Contents 4 0 R >>` },
      { num: 4, body: '<< >>', stream: 'BT /F1 12 Tf 72 700 Td (Hello) Tj ET', flate: true }
    ])
    const run = await timedDeep(file)
    inTime(run)
    expect(parsedOf(run.facts).pages[0]?.text).toBe('Hello')
  })

  it('bounds 3,000,000 operands (needs the page reader)', async () => {
    const file = buildPdf([
      CATALOG,
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        num: 3,
        body: `<< /Type /Page /Parent 2 0 R /Resources << /Font ${HELVETICA} >> /Contents [4 0 R 5 0 R 6 0 R] >>`
      },
      { num: 4, body: '<< >>', stream: '1 '.repeat(1_500_000), flate: true },
      { num: 5, body: '<< >>', stream: '1 '.repeat(1_500_000), flate: true },
      { num: 6, body: '<< >>', stream: 'BT /F1 12 Tf 72 700 Td (ok) Tj ET', flate: true }
    ])
    const run = await timedDeep(file)
    inTime(run)
    expect(parsedOf(run.facts).pages[0]?.text).toBe('ok')
  })

  it('bounds an /AA dictionary of 100,000 distinct keys that all run one script', async () => {
    // Each key is its own trigger text, so de-duplicating them by searching the
    // ones already kept was quadratic: 25 seconds for this 1.1MB file, noticed
    // only after the walk, with every action lost to the deadline.
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    const key = (k: number): string => (k < 52 ? letters[k] : key(Math.floor(k / 52) - 1) + letters[k % 52])
    // Prefixed so no key is one the walk reads for itself (/JS, /URI, /A, /EF).
    const aa = Array.from({ length: 100_000 }, (_, k) => `/x${key(k)} 4 0 R`).join(' ')
    const run = await timedDeep(
      buildPdf([
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R /AA 3 0 R >>' },
        NO_PAGES,
        { num: 3, body: `<< ${aa} >>` },
        { num: 4, body: '<< /S /JavaScript /JS (app.alert\\(1\\)) >>' }
      ])
    )
    inTime(run)
    const p = parsedOf(run.facts)
    expect(p.scripts.map((s) => s.source)).toEqual(['app.alert(1)'])
    expect(p.actions).toHaveLength(1)
    // The opening comes first by rank, then the first /AA keys in file order,
    // and the rest are counted rather than joined into a megabyte of text.
    const triggers = p.actions[0].trigger.split('; ')
    expect(triggers.slice(0, 3)).toEqual([
      'when the document opens (/OpenAction)',
      'on this event (/AA /xA)',
      'on this event (/AA /xB)'
    ])
    expect(triggers).toHaveLength(9)
    expect(triggers[8]).toBe(`and ${100_001 - 8} more trigger(s)`)
  })

  it('never throws on a truncated file or on noise after a header, and its notes stay coherent', async () => {
    const whole = lure()
    for (const file of [whole.subarray(0, Math.floor(whole.length * 0.6)), bytes('%PDF-1.7\n', noise(64 * 1024, 7))]) {
      const facts = await deep(file)
      expect(facts.parsed).toBeDefined()
      expect(facts.notes[facts.notes.length - 1]).toContain(VERDICT)
      expect(facts.notes.join(' ')).toContain(DEEP)
      expect(facts.notes.join(' ')).not.toContain(SCAN)
    }
  })
})

describe('readPdfObjects: budgets', () => {
  it('charges every decoded byte to the message, and says when that budget was gone', async () => {
    const box = objStm(10, [
      { num: 1, body: '<< /Type /Catalog /OpenAction 5 0 R >>' },
      { num: 5, body: '<< /S /JavaScript /JS 6 0 R >>' }
    ])
    const js = 'app.alert("measured");'
    const file = buildPdf([box, { num: 6, body: '<< >>', stream: js, flate: true }], { xrefStream: true })
    const media = { left: 1e9 }
    const facts = await deep(file, media)
    expect(parsedOf(facts).scripts.map((s) => s.source)).toEqual([js])
    expect(1e9 - media.left).toBe(String(box.stream).length + js.length)

    const starved = await deep(lure(), { left: 0 })
    expect(starved.notes.join(' ')).toContain(
      "this message's budget for pictures, inner files and decompressed PDF data was used up"
    )
  })

  it('says a stream a budget cut short was read in part, apart from streams it never read', async () => {
    const facts = await deep(onePage('BT /F1 12 Tf 72 700 Td (Hello from the page) Tj ET'), { left: 10 })
    const notes = facts.notes.join(' ')
    expect(notes).toContain('1 stream(s) were cut short when a decompression budget ran out')
    expect(notes).toContain('only their first part was read')
    expect(notes).not.toContain('were not decompressed')
  })

  it('blames the shared budget, not the file, when the message had little left, and spends what it used', async () => {
    const message: Work = { left: 1000 }
    const facts = await deep(
      onePage('BT ET', { extra: [{ num: 5, body: `[${'1 '.repeat(5000)}]` }] }),
      { left: 1e9 },
      message
    )
    const notes = facts.notes.join(' ')
    expect(notes).toContain('The PDFs in this message used up the reading budget they share')
    expect(notes).not.toContain('steps of reading this file')
    expect(message.left).toBe(0)
  })

  it('reads nothing past the message deadline, and says so', async () => {
    const facts = await deep(
      buildPdf([CATALOG, NO_PAGES, { num: 5, body: '<< /S /Launch /F (calc.exe) >>' }]),
      { left: 1e9 },
      { left: 1e9, until: 0 }
    )
    expect(parsedOf(facts).actions).toEqual([])
    expect(facts.notes.join(' ')).toContain('The object read stopped at its time limit')
    expect(facts.notes[facts.notes.length - 1]).toContain(VERDICT)
  })
})

describe('readPdfObjects: the clock inside a walk', () => {
  it('stops a walk at the deadline from inside it, not at the next stage', async () => {
    // A clock that is past the deadline only when the walk itself reads it, so
    // the stage boundaries all pass and only the walk's own look can stop it:
    // without that look this walk runs to the end and finds the action after
    // the array. A message budget under 65,536 units means a look every 65,536
    // would not come until the budget was spent.
    const clock = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => ((new Error().stack ?? '').includes('at spend ') ? Infinity : 0))
    try {
      const message: Work = { left: 60_000 }
      const facts = await deep(
        buildPdf([
          CATALOG,
          NO_PAGES,
          { num: 5, body: `[${'0 '.repeat(3000)}]` },
          { num: 6, body: '<< /S /Launch /F (calc.exe) >>' }
        ]),
        { left: 1e9 },
        message
      )
      expect(parsedOf(facts).actions).toEqual([])
      expect(facts.notes.join(' ')).toContain('The object read stopped at its time limit')
      // Stopped within one interval of 1,024 units, not after the 3,000 the array costs.
      expect(60_000 - message.left).toBeLessThanOrEqual(1024)
    } finally {
      clock.mockRestore()
    }
  })
})

describe('readPdfObjects: notes', () => {
  it('keeps byte notes first, then the deep caveat, then its own notes, with no verdict last', async () => {
    const file = lure([
      { num: 30, body: '<< >>' },
      { num: 30, body: '<< >>' }
    ])
    const alone = readPdf(file)?.notes ?? []
    expect(alone[alone.length - 2]).toContain(SCAN)
    expect(alone[alone.length - 1]).toContain(VERDICT)

    const notes = (await deep(file)).notes
    const at = (text: string): number => notes.findIndex((n) => n.includes(text))
    const objstm = at('compressed object stream(s) were decompressed')
    const images = at('Only /DCTDecode')
    const caveat = at(DEEP)
    const dupes = at('defined more than once')
    expect(objstm).toBeGreaterThanOrEqual(0)
    expect([objstm < images, images < caveat, caveat < dupes, dupes < notes.length - 1]).toEqual([
      true,
      true,
      true,
      true
    ])
    expect(notes[notes.length - 1]).toContain(VERDICT)
  })

  it('puts the page-1 link first and caps the rest (needs the page reader)', async () => {
    const members = [
      CATALOG,
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [300 0 R] >>' },
      // The first repeats the page-1 link from an object no page draws, earlier in
      // the file: the copy kept must be the one on the page.
      ...Array.from({ length: 250 }, (_, k) => ({
        num: 50 + k,
        body: `<< /S /URI /URI (${k ? `https://n${k}.test/` : 'https://page.test/'}) >>`
      })),
      { num: 300, body: '<< /Type /Annot /Subtype /Link /A << /S /URI /URI (https://page.test/) >> >>' }
    ]
    const facts = await deep(buildPdf([objStm(10, members)], { xrefStream: true }))
    const p = parsedOf(facts)
    expect(p.links).toHaveLength(200)
    expect(p.links.filter((l) => l.uri === 'https://page.test/')).toHaveLength(1)
    expect(facts.notes.join(' ')).toContain('Stopped after 200 links read from the objects')
    expect(p.links[0]).toEqual({
      uri: 'https://page.test/',
      where: 'object 300, packed in object stream 10',
      page: 1,
      cut: false
    })
  })
})

describe('a stream whole only by the checksum the file wrote', () => {
  it('says so, so the page note that points at the reasons has one to point at', async () => {
    // A stored block that is not the last, a byte no block can start with,
    // then the checksum of what came out (pdfObjects.test.ts builds the same).
    const content = 'BT /F1 12 Tf 72 700 Td (Sign in at https://login.microsoftonline.co) Tj ET'
    const len = String.fromCharCode(content.length, 0, ~content.length & 0xff, 0xff)
    const broken = bytes('\x78\x01\x00', len, content, '\xff', zlib(content).subarray(-4))
    const file = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        num: 3,
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
      },
      { num: 4, body: '<< /Filter /FlateDecode >>', stream: broken },
      { num: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' }
    ])
    const facts = await deep(file)
    expect(facts.notes.join('\n')).toContain('taken as read to the end')
  })
})
