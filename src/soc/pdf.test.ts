import { describe, expect, it } from 'vitest'
import { readPdf } from './pdf'

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
    expect(facts?.uris[0]).toHaveLength(4096)
    expect(facts?.uris[0]?.startsWith('https://evil.test/aaa')).toBe(true)
    expect(facts?.notes.join(' ')).toContain('cut short')
  })

  it('drops an odd trailing hex digit instead of padding it into a character that is not in the file', () => {
    const facts = readPdf(pdf('%PDF-1.4\n/URI <4142434>', TRAILER))
    expect(facts?.uris).toEqual(['ABC'])
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
    noEndstream: 15610
  }

  function timed(bytes: Uint8Array): { ms: number; facts: ReturnType<typeof readPdf> } {
    const at = performance.now()
    const facts = readPdf(bytes)
    return { ms: performance.now() - at, facts }
  }

  /** Whichever bound is tighter — so neither assertion is decoration. */
  function ceiling(before: number): number {
    return Math.min(1000, before / 4)
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
    expect(ms).toBeLessThan(2000)
  })

  it('counts an empty stream as work done, though it grows neither the image count nor the byte total', () => {
    // The third way past the old cap, and the cheap one: `end <= start` skips
    // before out.length moves. Each occurrence is individually inexpensive, so
    // this never showed up as a hang — it showed up as a loop with no bound on
    // it at all, which is the thing being pinned. The notes are the proof: the
    // cap fired, AND the entries it stopped at are reported rather than dropped.
    const { ms, facts } = timed(
      pdf('%PDF-1.4\n', ...REAL_IMAGE, '/DCTDecode stream\nendstream\n'.repeat(80_000), '\nendobj\n%%EOF')
    )
    expect([...(facts?.images[0]?.bytes ?? [])]).toEqual([...JPEG])
    const notes = facts?.notes.join(' ') ?? ''
    expect(notes).toContain('Stopped after examining 4096')
    expect(notes).toContain('held nothing but line-ending bytes')
    expect(ms).toBeLessThan(1000)
  })

  it('stays within reach of a benign file of the same size at the module’s own scan cap', () => {
    // The absolute number belongs to the machine; the ratio belongs to the
    // code. A hostile 16MB file may cost more than a blank one — it must not
    // cost a different SHAPE, which is what 766 seconds against 0.3 was.
    // The benign baseline is now the scan alone: the bytes-to-text conversion
    // both files paid used to be most of it, and once that got about seven
    // times cheaper the hostile file's real per-marker cost showed through at
    // roughly 4x. Ten still catches a change of shape by orders of magnitude.
    const benign = timed(pdf('%PDF-1.4\n', 'x'.repeat(16 * MB), '\nendobj\n%%EOF'))
    const hostile = timed(pdf(`%PDF-1.4\n/URI (${REAL_LINK})\n`, '/URI<'.repeat(3_300_000), '\nendobj\n%%EOF'))
    expect(hostile.facts?.uris).toEqual([REAL_LINK])
    expect(hostile.ms).toBeLessThan(2000)
    expect(hostile.ms).toBeLessThan(benign.ms * 10)
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
