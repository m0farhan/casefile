import { describe, expect, it } from 'vitest'
import {
  asDict,
  asName,
  asString,
  Broken,
  checkTime,
  type Decoded,
  GAP,
  latin1,
  Lexer,
  openPdf,
  type PdfDict,
  type PdfDoc,
  type PdfStream,
  type PdfValue,
  stripGap,
  textString,
  type Work,
  WORK_BUDGET,
  WorkSpent
} from './pdfObjects'
import {
  buildPdf,
  bytes,
  fixture,
  heapHeld,
  inflating,
  keptByChromium,
  type Obj,
  objStm,
  onePage,
  zlib
} from '../../test/pdf'

const MiB = 2 ** 20
/**
 * Wall-clock ceilings catch only a superlinear regression, never a 2x one, so
 * they are set far above any runner's time and the counts asserted beside
 * them pin the behaviour. A fixed 1-2 s ceiling failed on slower CPUs.
 */
const SLOW_MS = 10_000

function lex(src: string, budgets: { work?: Work; values?: Work; escaped?: Map<string, number> } = {}): Lexer {
  return new Lexer(src, 0, src.length, {
    work: budgets.work ?? { left: 1e9 },
    values: budgets.values ?? { left: 1e9 },
    escaped: budgets.escaped
  })
}

function open(file: Uint8Array, media = { left: 1e9 }, work: Work = { left: WORK_BUDGET }): Promise<PdfDoc> {
  return openPdf(file, latin1(file), media, work)
}

/** What `run` throws, for asserting on the error's fields. */
function thrown(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

const ref = (num: number): PdfValue => ({ t: 'ref', num, gen: 0 })
const str = (doc: PdfDoc, num: number): unknown => {
  const v = doc.resolve(ref(num))
  return v && typeof v === 'object' && !Array.isArray(v) && v.t === 'str' ? v.v : v
}
const streamOf = (doc: PdfDoc, num: number): PdfStream => doc.objects.get(num)?.value as PdfStream

/** A file holding stream object 4 exactly as written, for decode tests. */
function streamFile(dict: string, data: string | Uint8Array): Uint8Array {
  return bytes('%PDF-1.7\n4 0 obj\n', dict, '\nstream\n', data, '\nendstream\nendobj\n')
}

async function decodeOne(
  dict: string,
  data: string | Uint8Array,
  cap = 4 * MiB,
  media = { left: 1e9 }
): Promise<{ doc: PdfDoc; text: string | undefined; whole: boolean | undefined; endLost: boolean | undefined }> {
  const doc = await open(streamFile(dict, data), media)
  const d = await doc.decode(streamOf(doc, 4), cap, 'text')
  return { doc, text: d?.text, whole: d?.whole, endLost: d?.endLost }
}

const flateDict = (data: Uint8Array, extra = ''): string => `<< /Length ${data.length} /Filter /FlateDecode ${extra}>>`
const PLAIN = Array.from(
  { length: 3000 },
  (_, i) => `BT /F1 12 Tf 72 ${700 - i} Td (line ${i} https://x.test/${i}) Tj ET\n`
).join('')

describe('Lexer', () => {
  it('reads numbers, escaped names, strings, hex, dicts with references, and skips comments', () => {
    const numbers = lex('-.5 4. +3')
    expect([numbers.read(), numbers.read(), numbers.read(), numbers.read()]).toEqual([-0.5, 4, 3, undefined])

    const escaped = new Map<string, number>()
    const names = lex('/J#61vaScript /Foo#20Bar /Bad#zz', { escaped })
    expect(names.read()).toEqual({ t: 'name', v: 'JavaScript' })
    expect(names.read()).toEqual({ t: 'name', v: 'Foo Bar' })
    expect(names.read()).toEqual({ t: 'name', v: 'Bad#zz' })
    // Only the marker names are recorded: the map cannot grow with the file.
    expect([...escaped]).toEqual([['JavaScript', 1]])

    expect(lex('(a (nested) \\) \\150 \\777 x\r\ny\\\nz)').read()).toEqual({
      t: 'str',
      v: 'a (nested) ) h \xFF x\nyz',
      cut: false
    })
    expect(lex('<4142 4>').read()).toEqual({ t: 'str', v: 'AB@', cut: false })

    const dict = lex('<< /A [1 2] /R 12 0 R /S (x) >>').read() as PdfDict
    expect(dict.v.get('A')).toEqual([1, 2])
    expect(dict.v.get('R')).toEqual({ t: 'ref', num: 12, gen: 0 })
    // A colour operator is not a reference: `R` must end its token.
    const colour = lex('1 0 0 RG')
    expect([colour.read(), colour.read(), colour.read(), colour.read()]).toEqual([1, 0, 0, { t: 'op', v: 'RG' }])

    const commented = lex('% a comment /NotThis\n/Name')
    expect(commented.read()).toEqual({ t: 'name', v: 'Name' })
    expect(commented.read()).toBeUndefined()
  })

  it('throws Broken(depth) on deep nesting without overflowing the stack', () => {
    const error = thrown(() => lex('['.repeat(100_000)).read())
    expect(error).toBeInstanceOf(Broken)
    expect(error).toMatchObject({ why: 'depth' })
  })

  it('throws Broken(end) on a string that never closes, and WorkSpent when the budget runs out', () => {
    expect(() => lex('(never closed').read()).toThrow(Broken)
    expect(() => lex(`(${'a'.repeat(1000)})`, { work: { left: 100 } }).read()).toThrow(WorkSpent)
    // Charged on a failed walk too, which is what bounds a flood of unclosed strings.
    const work = { left: 1e6 }
    expect(() => lex(`(${'a'.repeat(1000)}`, { work }).read()).toThrow(Broken)
    expect(work.left).toBeLessThan(1e6 - 1000)
    const late = thrown(() => checkTime({ left: 1, until: 0 }))
    expect(late).toBeInstanceOf(WorkSpent)
    expect(late).toMatchObject({ why: 'time' })
  })

  it('builds long strings and names flat, holding about what they keep', async () => {
    // Built a character at a time, each held about 32 bytes of heap per
    // character until something read it: a 1 MiB string 32 MiB, against one
    // unit of the value budget.
    const sources = {
      hex: `<${'41'.repeat(MiB)}>`,
      escapes: `(${'\\\\'.repeat(MiB)})`,
      octal: `(${'\\101'.repeat(MiB)})`,
      names: `[${` /${'n'.repeat(127)}`.repeat(8_192)}]`
    }
    const over: [string, number][] = []
    for (const [kind, src] of Object.entries(sources)) {
      // Read once first: that flattens the source, and its copy is not the lexer's.
      src.charCodeAt(0)
      const { held, value } = await heapHeld(() => lex(src).read())
      expect(value).toBeDefined()
      if (held >= 3 * MiB) over.push([kind, held])
    }
    expect(over).toEqual([])
    const source = '\x80'.repeat(MiB)
    source.charCodeAt(0)
    const mapped = await heapHeld(() => textString(source))
    expect(mapped.value).toHaveLength(MiB)
    expect(mapped.held).toBeLessThan(4 * MiB)
  })
})

describe('openPdf: the index pass', () => {
  it('stops on the value budget, keeps what it read, and runs no second pass', async () => {
    const started = performance.now()
    const doc = await open(
      bytes(
        '%PDF-1.7\n5 0 obj\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\nendobj\n1 0 obj\n[',
        '<<>>'.repeat(400_000),
        ']\nendobj\n'
      )
    )
    expect(doc.valueSpent).toBe(true)
    expect(asDict(doc.resolve(ref(5)))?.has('OpenAction')).toBe(true)
    expect(doc.objects.has(1)).toBe(false)
    expect(doc.stats.unreadable).toBe(0)
    expect(performance.now() - started).toBeLessThan(SLOW_MS)
  })

  it('indexes loose but legal headers and rejects what a reader would not take', async () => {
    const doc = await open(
      bytes(
        '%PDF-1.7\n12 0obj\n(a)\nendobj\n0000000000013 0 obj (b) endobj\n',
        `14${' '.repeat(40)}0${' '.repeat(40)}obj (c) endobj5 0 obj (d) endobj\n`,
        `${'1'.repeat(33)} 0 obj (too long) endobj\n`
      )
    )
    expect([str(doc, 12), str(doc, 13), str(doc, 14), str(doc, 5)]).toEqual(['a', 'b', 'c', 'd'])
    expect(doc.objects.size).toBe(4)

    const commented = await open(bytes('%PDF-1.7\n12 0 %c\nobj (x) endobj\n'))
    expect(commented.objects.has(12)).toBe(false)
    expect(commented.stats.looseHeaders).toBe(1)

    const flood = await open(bytes('%PDF-1.7\n', 'obj '.repeat(196_608), '7 0 obj (real) endobj\n'))
    expect(str(flood, 7)).toBe('real')
  })

  it('takes a direct /Length, resolves an indirect one, and searches when neither lands on endstream', async () => {
    const direct = await open(buildPdf([{ num: 4, body: '<< >>', stream: 'hello' }]))
    expect(streamOf(direct, 4)).toMatchObject({ confirmed: true })
    expect(streamOf(direct, 4).end - streamOf(direct, 4).start).toBe(5)

    const indirect = await open(
      bytes('%PDF-1.7\n4 0 obj << /Length 9 0 R >> stream\nhello\nendstream endobj 9 0 obj 5 endobj\n')
    )
    expect(streamOf(indirect, 4)).toMatchObject({ confirmed: true })
    expect(streamOf(indirect, 4).end - streamOf(indirect, 4).start).toBe(5)

    const negative = await open(bytes('%PDF-1.7\nendstream\n1 0 obj<</Length -39>>stream\nabc\nendstream\nendobj\n'))
    expect(negative.stats.duplicates).toBe(0)
    expect(streamOf(negative, 1)).toMatchObject({ confirmed: false })
    expect(streamOf(negative, 1).end - streamOf(negative, 1).start).toBe(3)

    const huge = await open(bytes('%PDF-1.7\n1 0 obj << /Length 1000000000 >> stream\nabc\nendstream endobj\n'))
    expect(streamOf(huge, 1)).toMatchObject({ confirmed: false })
    expect(streamOf(huge, 1).end - streamOf(huge, 1).start).toBe(3)
  })

  it('resolves a number to its last definition and keeps the earlier one, labelled', async () => {
    const doc = await open(
      buildPdf([
        { num: 3, body: '<< /S /JavaScript /JS (evil) >>' },
        { num: 3, body: '<< >>' }
      ])
    )
    expect(asDict(doc.resolve(ref(3)))?.size).toBe(0)
    expect(doc.stats.duplicates).toBe(1)
    const earlier = doc.superseded.find((s) => s.num === 3)
    expect(earlier && asName(asDict(earlier.obj.value)?.get('S'))).toBe('JavaScript')
    expect(doc.where(3, earlier?.obj)).toBe('object 3, an earlier definition replaced later in the file')
    expect(doc.where(3)).toBe('object 3')
  })
})

describe('openPdf: shadows', () => {
  const inStream = { num: 4, body: '<< >>', stream: 'q\n9 0 obj (shadow) endobj\nQ' }

  it('uses a header inside stream data when nothing else defines the number', async () => {
    const doc = await open(buildPdf([{ num: 1, body: '<< /Type /Catalog >>' }, inStream]))
    expect(str(doc, 9)).toBe('shadow')
    expect(doc.where(9)).toBe('object 9, found inside object 4')
    expect(doc.stats.shadowsUsed).toBe(1)
    expect(doc.stats.shadows).toBe(1)
  })

  it('prefers a top-level definition to a shadow wherever it sits, and keeps the shadow', async () => {
    const doc = await open(buildPdf([{ num: 9, body: '(top)' }, { num: 1, body: '<< /Type /Catalog >>' }, inStream]))
    expect(str(doc, 9)).toBe('top')
    expect(doc.superseded.find((s) => s.num === 9)?.obj.inside).toBe(4)
    expect(doc.stats.shadowsUsed).toBe(0)
  })

  it('re-reads a string that ran into the next header, and marks the headers it swallowed', async () => {
    const doc = await open(
      buildPdf(
        [
          {
            num: 1,
            body: '',
            raw: '1 0 obj (\n2 0 obj << /Type /Catalog >> endobj\n3 0 obj (inner) endobj\n) endobj\n'
          }
        ],
        { root: 2 }
      )
    )
    expect(str(doc, 1)).toContain('2 0 obj << /Type /Catalog >> endobj')
    expect(str(doc, 3)).toBe('inner')
    expect(doc.where(2)).toBe('object 2, found inside object 1')
    expect(doc.where(3)).toBe('object 3, found inside object 1')
    expect(doc.rootFrom).toBe('trailer')
    expect(asName(doc.root?.v.get('Type'))).toBe('Catalog')
  })

  it('does not let an `obj` inside a script string replace a real object', async () => {
    const doc = await open(
      bytes('%PDF-1.7\n1 0 obj (real) endobj\n5 0 obj <</S/JavaScript/JS(x("1 0 obj"))>> endobj\n')
    )
    expect(str(doc, 1)).toBe('real')
    expect(asDict(doc.resolve(ref(5)))?.get('JS')).toEqual({ t: 'str', v: 'x("1 0 obj")', cut: false })
  })

  it('finds a header between a false and a true endstream once the indirect /Length is resolved', async () => {
    const data = 'AAA\nendstream\n7 0 obj (hidden) endobj\nBBB'
    const doc = await open(
      bytes(`%PDF-1.7\n4 0 obj << /Length 9 0 R >> stream\n${data}\nendstream\nendobj\n9 0 obj ${data.length} endobj\n`)
    )
    expect(streamOf(doc, 4).end - streamOf(doc, 4).start).toBe(data.length)
    expect(str(doc, 7)).toBe('hidden')
    expect(doc.where(7)).toBe('object 7, found inside object 4')
  })
})

describe('openPdf: object streams', () => {
  it('reads packed members and labels where they came from', async () => {
    const doc = await open(
      buildPdf(
        [
          objStm(10, [
            { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
            { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
            { num: 5, body: '(member)' }
          ])
        ],
        { xrefStream: true }
      )
    )
    expect(doc.objectStreams).toEqual({ found: 1, read: 1 })
    expect(str(doc, 5)).toBe('member')
    expect(doc.where(5)).toBe('object 5, packed in object stream 10')
    expect(doc.trailerFrom).toBe('startxref')
    expect(doc.rootFrom).toBe('trailer')
    expect(doc.objStmTexts[0]).toContain('(member)')
  })

  it('ranks a member by its container: a later top-level object beats it, a later object stream beats that', async () => {
    const member = objStm(10, [{ num: 5, body: '(member)' }])
    const later = await open(buildPdf([member, { num: 5, body: '(top)' }]))
    expect(str(later, 5)).toBe('top')
    expect(later.superseded.find((s) => s.num === 5)?.obj.container).toBe(10)
    const earlier = await open(buildPdf([{ num: 5, body: '(top)' }, member]))
    expect(str(earlier, 5)).toBe('member')
  })

  it('bounds hostile headers: every member is read at most once', async () => {
    const stm = (first: string, header: string, data: string): Obj => ({
      num: 10,
      body: `<< /Type /ObjStm /N 3 /First ${first} >>`,
      stream: header + data,
      flate: true
    })
    const read = async (o: Obj): Promise<PdfDoc> => open(buildPdf([o]))

    const negative = await read(stm('-5', '5 0 ', '(five)'))
    expect(negative.objects.has(5)).toBe(false)
    expect(negative.stats.unreadable).toBe(1)
    const far = await read(stm('1000000000', '5 0 ', '(five)'))
    expect(far.objects.has(5)).toBe(false)
    expect(far.stats.unreadable).toBe(1)

    // Offsets below are relative to /First, which is where the member data begins.
    const minus = await read(stm('12', '5 -3 6 0   ', '(five)'))
    expect(minus.objects.has(5) || minus.objects.has(6)).toBe(false)
    const fraction = await read(stm('12', '5 1.5 6 0  ', '(five)'))
    expect(fraction.objects.has(5)).toBe(false)

    const unsorted = await read(stm('8', '6 7 5 0 ', '(five) (six)'))
    expect([str(unsorted, 5), str(unsorted, 6)]).toEqual(['five', 'six'])

    const repeated = await read(stm('12', '5 0 6 0 7 7 ', '(five) (seven)'))
    expect([str(repeated, 5), repeated.objects.has(6), str(repeated, 7)]).toEqual(['five', false, 'seven'])

    const zeros = await read(stm('12', '5 0 6 0 7 0 ', '(five)'))
    expect([...zeros.objects.keys()].filter((n) => n !== 10)).toEqual([5])
  })
})

describe('openPdf: the trailer', () => {
  const catalog = (extra = ''): Obj[] => [
    { num: 1, body: `<< /Type /Catalog /Pages 2 0 R ${extra}>>` },
    { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' }
  ]

  it('follows startxref to a classic trailer, to an xref stream, and past junk in front of the header', async () => {
    const classic = await open(onePage('BT ET'))
    expect([classic.trailerFrom, classic.rootFrom]).toEqual(['startxref', 'trailer'])
    const stream = await open(onePage('BT ET', { xrefStream: true }))
    expect([stream.trailerFrom, stream.rootFrom]).toEqual(['startxref', 'trailer'])
    expect(asName(stream.trailer?.v.get('Type'))).toBe('XRef')
    const prefixed = await open(buildPdf(catalog(), { prefix: 'J'.repeat(100) }))
    expect([prefixed.trailerFrom, prefixed.rootFrom]).toEqual(['startxref', 'trailer'])
  })

  it('is not fooled by an unreferenced /XRef object, a commented trailer, or one in stream data', async () => {
    const encrypt = { num: 8, body: '<< /Filter /Standard /V 2 /R 3 >>' }
    const decoy = {
      num: 99,
      body: '',
      raw: '99 0 obj <</Type/XRef/Encrypt 8 0 R/Length 0>>stream\n\nendstream endobj\n'
    }
    expect((await open(buildPdf([...catalog(), encrypt, decoy]))).encrypted).toBe(false)

    const inData = '60 0 obj << /Length 24 >> stream\ntrailer<</Root 50 0 R>>\nendstream endobj\n'
    const fake = `50 0 obj << /Type /Catalog /Pages 99 0 R >> endobj\n${inData}% trailer << /Root 50 0 R /Encrypt 8 0 R >>\n`
    const following = await open(buildPdf([...catalog(), encrypt], { tail: fake }))
    expect(following.trailerFrom).toBe('startxref')
    expect(following.root).toBe(following.objects.get(1)?.value)

    const guessed = await open(buildPdf([...catalog(), encrypt], { tail: fake, noStartxref: true }))
    expect(guessed.trailerFrom).toBe('guessed')
    expect(guessed.root).toBe(guessed.objects.get(1)?.value)
    expect(guessed.encrypted).toBe(false)
  })

  it('falls back to the last catalog when no trailer is found', async () => {
    const doc = await open(bytes('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n'))
    expect(doc.trailer).toBeNull()
    expect(doc.rootFrom).toBe('catalog')
    expect(doc.root).toBe(doc.objects.get(1)?.value)
  })
})

describe('openPdf: encryption', () => {
  const base = (encrypt: string, more: Obj[] = []): Uint8Array =>
    buildPdf(
      [
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
        { num: 9, body: encrypt },
        ...more
      ],
      { trailer: '/Encrypt 9 0 R' }
    )
  // Deterministic noise whose first byte can never start a zlib header.
  const noise = Uint8Array.from({ length: 200 }, (_, i) => (i === 0 ? 0xff : (i * 2654435761) >>> 24))

  it('is encrypted only when the trailer points at a dict with a /Filter name', async () => {
    const doc = await open(base('<< /Filter /Standard /V 2 /R 3 >>'))
    expect([doc.encrypted, doc.encryptFilter]).toEqual([true, 'Standard'])
    expect((await open(base('42'))).encrypted).toBe(false)
    expect((await open(base('<< /V 2 >>'))).encrypted).toBe(false)
  })

  it('reads an encrypted file only where a stream verifies against its own checksum', async () => {
    const cipher = await open(
      base('<< /Filter /Standard >>', [
        { num: 10, body: '<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode >>', stream: noise }
      ])
    )
    expect(cipher.objectStreams).toEqual({ found: 1, read: 0 })
    expect(cipher.tally.encrypted).toBe(1)

    const clear = await open(base('<< /Filter /Standard >>', [objStm(10, [{ num: 5, body: '(packed)' }])]))
    expect(clear.objectStreams).toEqual({ found: 1, read: 1 })
    expect(clear.tally.verified).toBe(1)
    const packed = clear.objects.get(5)
    expect(packed && clear.plain(packed)).toBe(true)
    const top = clear.objects.get(1)
    expect(top && clear.plain(top)).toBe(false)
    expect(clear.stringsEncrypted).toBe(true)

    // A zlib header over ciphertext, a stream that ends cleanly but whose
    // checksum does not match, and an unfiltered stream: none is accepted from
    // an encrypted file, though the second reads as whole from a plain one.
    const z = zlib(PLAIN)
    const badSum = Uint8Array.from(z)
    badSum[badSum.length - 1] ^= 0xff
    const flate = '<< /Filter /FlateDecode >>'
    const doc = await open(
      base('<< /Filter /Standard >>', [
        { num: 11, body: flate, stream: z },
        { num: 12, body: flate, stream: badSum },
        { num: 13, body: flate, stream: bytes(z.subarray(0, 2), noise, noise) },
        { num: 14, body: '<< >>', stream: PLAIN }
      ])
    )
    const read = async (n: number): Promise<string | undefined> =>
      (await doc.decode(streamOf(doc, n), 4 * MiB, 'text'))?.text
    expect(await read(11)).toBe(PLAIN)
    expect([await read(12), await read(13), await read(14)]).toEqual([undefined, undefined, undefined])
    expect([doc.tally.verified, doc.tally.encrypted]).toEqual([1, 3])
  })

  it('reads strings as written where crypt filters leave /StrF at /Identity, as attachment-only encryption does', async () => {
    const cf = '/CF << /StdCF << /CFM /AESV2 /AuthEvent /EFOpen >> >> /StmF /Identity /EFF /StdCF'
    const cases: [string, boolean][] = [
      [`<< /Filter /Standard /V 4 /R 4 ${cf} /StrF /Identity >>`, true],
      // Absent, /StrF is /Identity (ISO 32000-1 Table 20).
      [`<< /Filter /Standard /V 4 /R 4 ${cf} >>`, true],
      [`<< /Filter /Standard /V 5 /R 6 ${cf} /StrF /StdCF >>`, false],
      // Before crypt filters /StrF means nothing: every string is encrypted.
      ['<< /Filter /Standard /V 2 /R 3 /StrF /Identity >>', false]
    ]
    for (const [encrypt, cleartext] of cases) {
      const doc = await open(base(encrypt))
      const top = doc.objects.get(1)
      expect({ encrypt, read: [doc.encrypted, doc.stringsEncrypted, top && doc.plain(top)] }).toEqual({
        encrypt,
        read: [true, !cleartext, cleartext]
      })
    }
  })
})

describe('PdfDoc.decode', () => {
  it('inflates a whole stream, and one with a corrupted checksum, as whole', async () => {
    const z = zlib(PLAIN)
    const ok = await decodeOne(flateDict(z), z)
    expect(ok.text).toBe(PLAIN)
    expect([ok.whole, ok.endLost]).toEqual([true, false])

    const bad = Uint8Array.from(z)
    bad[bad.length - 1] ^= 0xff
    const corrupted = await decodeOne(flateDict(bad), bad)
    expect([corrupted.text, corrupted.whole, corrupted.doc.tally.partial]).toEqual([PLAIN, true, 0])
  })

  it('says partial when a stream breaks off, and whole when only its checksum is missing or bytes trail it', async () => {
    const z = zlib(PLAIN)
    const cut = z.subarray(0, Math.floor(z.length * 0.6))
    const short = await decodeOne(flateDict(cut), cut)
    expect([short.whole, short.endLost, short.doc.tally.partial]).toEqual([false, true, 1])
    expect(PLAIN.startsWith(short.text ?? 'x')).toBe(true)

    const stripped = z.subarray(0, z.length - 4)
    const noSum = await decodeOne(flateDict(stripped), stripped)
    expect([noSum.text, noSum.whole]).toEqual([PLAIN, true])

    const trailing = bytes(z, '\r\n')
    const long = await decodeOne(flateDict(trailing), trailing)
    expect([long.text, long.whole, long.endLost, long.doc.tally.partial]).toEqual([PLAIN, true, false, 0])
  })

  it('reads to a clean end a stream whose /Length counts the EOL, raw deflate or with a wrong checksum', async () => {
    const lure = 'BT /F1 12 Tf 72 700 Td (Pay at https://raw-lure.test/pay) Tj ET'
    const raw = zlib(lure).subarray(2, -4)
    const badSum = zlib(lure)
    badSum[badSum.length - 1] ^= 0xff
    for (const chromium of [false, true]) {
      for (const eol of ['\n', '\r\n', '\r']) {
        const r = (await inflating(() => decodeOne(flateDict(bytes(raw, eol)), bytes(raw, eol)), chromium)).value
        expect([r.text, r.whole, r.endLost, r.doc.tally.rawDeflate, r.doc.tally.notZlib]).toEqual([
          lure,
          true,
          false,
          1,
          0
        ])
        const z = (await inflating(() => decodeOne(flateDict(bytes(badSum, eol)), bytes(badSum, eol)), chromium)).value
        expect([z.text, z.whole, z.endLost, z.doc.tally.partial]).toEqual([lure, true, false, 0])
      }
      // Junk that is not an EOL: Chromium fails the write carrying its first
      // byte, and the stream cut there ends cleanly. Node fails only the close,
      // which says nothing of where the stream ended, and raw deflate has no
      // checksum to look for, so it is not taken, as before.
      const junk = (await inflating(() => decodeOne(flateDict(bytes(raw, ' x')), bytes(raw, ' x')), chromium)).value
      expect([junk.text, junk.whole, junk.endLost]).toEqual(
        chromium ? [lure, true, false] : [undefined, undefined, undefined]
      )
      expect(junk.doc.tally).toMatchObject({ rawDeflate: chromium ? 1 : 0, partial: 0, notZlib: chromium ? 0 : 1 })
    }
  })

  it("reads whole, on the decoder's word, a zlib stream whose /Length counts junk after the checksum", async () => {
    // Chromium fails the write carrying the first junk byte, and try A cut
    // there ends cleanly. Node fails only the close, and try A cut where the
    // checksum of what came out sits ends cleanly: the checksum chose where to
    // cut, the decoder said the stream ends there. Junk past the one-byte tail
    // starts in a 1 KiB write, which Chromium replays before it can say which
    // byte it failed on: one pass more.
    const lure = 'BT /F1 12 Tf 72 700 Td (Pay at https://zjunk-lure.test/pay) Tj ET'
    for (const chromium of [false, true]) {
      for (const junk of ['\n\n', '\r\n\r\n', ' \n', 'xy', ' '.repeat(16)]) {
        const data = bytes(zlib(lure), junk)
        const { value: r, passes } = await inflating(() => decodeOne(flateDict(data), data), chromium)
        expect([r.text, r.whole, r.endLost, passes]).toEqual([lure, true, false, chromium && junk.length > 8 ? 3 : 2])
        expect(r.doc.tally).toMatchObject({ partial: 0, checksumOnly: 0 })
      }
      // With a wrong checksum there is nothing to look for where Node fails
      // only the close, so the stream stays read in part there.
      const bad = bytes(zlib(lure), 'xy')
      bad[bad.length - 3] ^= 0xff
      const { value: w } = await inflating(() => decodeOne(flateDict(bad), bad), chromium)
      expect([w.text, w.whole, w.endLost, w.doc.tally.partial]).toEqual(
        chromium ? [lure, true, false, 0] : [lure, false, true, 1]
      )
    }
  })

  it('takes no checksum the file wrote for proof that a stream which broke off lost nothing', async () => {
    // A stored block that is not the last, a byte no block can start with,
    // then the checksum of what came out: what the stream held past the break
    // is unknown, whatever that checksum says.
    const text = 'Sign in at https://login.microsoftonline.co'
    const len = String.fromCharCode(text.length, 0, ~text.length & 0xff, 0xff)
    const broken = bytes('\x78\x01\x00', len, text, '\xff', zlib(text).subarray(-4))
    for (const chromium of [false, true]) {
      const r = (await inflating(() => decodeOne(flateDict(broken), broken), chromium)).value
      expect([r.text, r.whole, r.endLost]).toEqual([text, true, true])
      // Counted apart, so a note can say why its end was not vouched for.
      expect(r.doc.tally).toMatchObject({ checksumOnly: 1, partial: 0 })
    }
    // In an encrypted file too, where that checksum is what lets it be read at all.
    const sealed = await open(
      buildPdf(
        [
          { num: 1, body: '<< /Filter /FlateDecode >>', stream: broken },
          { num: 2, body: '<< /Filter /Standard >>' }
        ],
        { trailer: '/Encrypt 2 0 R' }
      )
    )
    const d = await sealed.decode(streamOf(sealed, 1), 4 * MiB, 'text')
    expect([d?.text, d?.whole, d?.endLost]).toEqual([text, true, true])
    expect(sealed.tally).toMatchObject({ verified: 1, checksumOnly: 1 })
  })

  it('takes raw deflate with no header, and refuses bytes that are neither', async () => {
    const raw = zlib(PLAIN).subarray(2, -4)
    const taken = await decodeOne(flateDict(raw), raw)
    expect([taken.text, taken.whole, taken.endLost, taken.doc.tally.rawDeflate]).toEqual([PLAIN, true, false, 1])

    const junk = new Uint8Array(100).fill(0xff)
    const refused = await decodeOne(flateDict(junk), junk)
    expect(refused.text).toBeUndefined()
    expect(refused.doc.tally.notZlib).toBe(1)

    // Only a try that ends cleanly makes it raw deflate: not one that breaks
    // off, nor bytes that are not deflate data at all, which Chromium hands
    // out a few at a time before it sees so (each of these five does).
    const cut = raw.subarray(0, raw.length >> 1)
    for (const chromium of [false, true]) {
      const broke = (await inflating(() => decodeOne(flateDict(cut), cut), chromium)).value
      expect(broke.text).toBeUndefined()
      expect(broke.doc.tally).toMatchObject({ notZlib: 1, rawDeflate: 0, partial: 0 })
    }
    for (const seed of [4, 6, 13, 18, 20]) {
      let x = (seed * 2_654_435_761) >>> 0
      const noise = Uint8Array.from({ length: 200 }, () => (x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0) >>> 24)
      const r = (await inflating(() => decodeOne(flateDict(noise), noise), true)).value
      expect(r.text).toBeUndefined()
      expect(r.doc.tally).toMatchObject({ notZlib: 1, rawDeflate: 0, partial: 0 })
    }
  })

  it('decodes ASCIIHex, ASCII85, a chain, and the abbreviations', async () => {
    const hex = '48 65\n6c 6C 6F 2>'
    expect(await decodeOne(`<< /Length ${hex.length} /Filter /ASCIIHexDecode >>`, hex)).toMatchObject({
      text: 'Hello ',
      whole: true,
      endLost: false
    })
    // No `>`: read in part, so the end counts as lost.
    expect(await decodeOne('<< /Length 4 /Filter /AHx >>', '4865')).toMatchObject({ text: 'He', endLost: true })
    const a85 = 'z87cURDZ~>'
    expect(await decodeOne(`<< /Length ${a85.length} /Filter /A85 >>`, a85)).toMatchObject({
      text: '\0\0\0\0Hello',
      whole: true
    })
    const z85 = ascii85(zlib(PLAIN))
    expect(await decodeOne(`<< /Length ${z85.length} /Filter [/ASCII85Decode /FlateDecode] >>`, z85)).toMatchObject({
      text: PLAIN,
      whole: true
    })
    const z = zlib('BT ET')
    expect(await decodeOne(`<< /Length ${z.length} /Filter /Fl >>`, z)).toMatchObject({ text: 'BT ET', whole: true })
  })

  it('counts what it does not decode, by filter, with a bounded set of keys', async () => {
    const lzw = await decodeOne('<< /Length 3 /Filter /LZWDecode >>', 'abc')
    expect(lzw.text).toBeUndefined()
    expect(lzw.doc.tally.unsupported.get('LZWDecode')).toBe(1)

    const chain = await decodeOne(`<< /Length 3 /Filter [${' /ASCIIHexDecode'.repeat(9)}] >>`, 'abc')
    expect([...chain.doc.tally.unsupported]).toEqual([['(a chain of more than 8 filters)', 1]])

    const predictor = await decodeOne('<< /Length 3 /Filter /FlateDecode /DecodeParms << /Predictor 12 >> >>', 'abc')
    expect(predictor.doc.tally.predictor).toBe(1)

    const objects: Obj[] = Array.from({ length: 20 }, (_, i) => ({
      num: i + 1,
      body: '',
      raw: `${i + 1} 0 obj << /Length 1 /Filter /Bogus${i} >> stream\nx\nendstream endobj\n`
    }))
    const doc = await open(buildPdf(objects))
    for (let i = 1; i <= 20; i++) expect(await doc.decode(streamOf(doc, i), MiB, 'text')).toBeNull()
    expect(doc.tally.unsupported.size).toBe(17)
    expect(doc.tally.unsupported.get('other')).toBe(4)
  })

  it('marks an unfiltered stream whose end was searched for as not whole', async () => {
    // Not whole, but its end is not lost: the data ends at `endstream` for every reader.
    const searched = await decodeOne('<< >>', 'BT (x) Tj ET')
    expect([searched.text, searched.whole, searched.endLost]).toEqual(['BT (x) Tj ET', false, false])
    const confirmed = await decodeOne('<< /Length 12 >>', 'BT (x) Tj ET')
    expect([confirmed.whole, confirmed.endLost]).toEqual([true, false])
    const capped = await decodeOne('<< /Length 12 >>', 'BT (x) Tj ET', 5)
    expect([capped.text, capped.whole, capped.endLost]).toEqual(['BT (x', false, true])
  })

  it('stops a decompression bomb at the cap, after one try, charging exactly what it kept', async () => {
    const bomb = zlib(new Uint8Array(64 * MiB))
    const media = { left: 100 * MiB }
    const { value: out, passes } = await inflating(() => decodeOne(flateDict(bomb), bomb, 4 * MiB, media))
    expect(passes).toBe(1)
    expect(out.text?.length).toBe(4_194_304)
    expect([out.whole, out.endLost]).toEqual([false, true])
    expect(out.doc.tally.capped).toBe(1)
    expect(media.left).toBe(100 * MiB - 4_194_304)
  })
})

describe('PdfDoc.decode budgets', () => {
  it('says a stream a budget cut short was read in part, not that it was not decompressed', async () => {
    const z = zlib(PLAIN)
    const media = await decodeOne(flateDict(z), z, 4 * MiB, { left: 1000 })
    expect(media.text).toBe(PLAIN.slice(0, 1000))
    expect([media.whole, media.endLost]).toEqual([false, true])
    expect(media.doc.tally).toMatchObject({ shortened: 1, messageBudget: 0, budget: 0, capped: 0 })

    // The script share is 4 MiB: the second 3 MiB script gets the last 1 MiB of it.
    const objects: Obj[] = [1, 2].map((num) => ({ num, body: '<< >>', stream: 'a'.repeat(3 * MiB), flate: true }))
    const doc = await open(buildPdf(objects))
    await doc.decode(streamOf(doc, 1), 4 * MiB, 'script')
    expect((await doc.decode(streamOf(doc, 2), 4 * MiB, 'script'))?.text.length).toBe(MiB)
    expect(doc.tally).toMatchObject({ shortened: 1, messageBudget: 0, budget: 0, capped: 0 })
  })

  /** Zeros after some noise, so the write that holds the stream's end expands far past what it was given; Chromium lost that write's output with the junk error. */
  const sloppy = new Uint8Array(65_536)
  for (let i = 0, x = 1; i < 2_500; i++) sloppy[i] = (x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0) >>> 24
  /** Streams 1 and 2 hold `data`; 2,045 one-pass streams follow, numbered from 3. */
  const pair = (data: Uint8Array, encrypted = false): Promise<PdfDoc> =>
    open(
      buildPdf(
        [
          ...[1, 2].map((num) => ({ num, body: '<< /Filter /FlateDecode >>', stream: data })),
          ...Array.from({ length: 2_045 }, (_, i) => ({ num: i + 3, body: '<< >>', stream: 'x', flate: true })),
          { num: 2_048, body: '<< /Filter /Standard >>' }
        ],
        { trailer: encrypted ? '/Encrypt 2048 0 R' : '' }
      )
    )
  /** After stream 1's three passes, decodes 2,044 one-pass streams, which leaves one of the 2,048 opens, then stream 2 with it. */
  const lastOpen = (doc: PdfDoc): Promise<{ value: Decoded | null; passes: number }> =>
    inflating(async () => {
      for (let i = 3; i < 2_047; i++) expect((await doc.decode(streamOf(doc, i), MiB, 'text'))?.text).toBe('x')
      return doc.decode(streamOf(doc, 2), 4 * MiB, 'embedded')
    }, true)

  it('reads a stream whole on Chromium when its /Length counts bytes after the checksum, and charges the second pass', async () => {
    // Counting the EOL: in try A the junk starts in the one-byte tail and
    // fails a write that made no output, so it is not run again, and try A
    // without the EOL ends cleanly.
    const eol = await pair(bytes(zlib(sloppy), '\r\n'))
    const once = await inflating(() => eol.decode(streamOf(eol, 1), 4 * MiB, 'embedded'), true)
    expect(once.passes).toBe(2)
    expect([once.value?.whole, once.value?.endLost]).toEqual([true, false])
    expect(once.value?.text).toBe(latin1(sloppy))

    // Sixteen bytes long: the junk starts in the 1 KiB write holding the
    // stream's end, so try A is run again a byte at a time, which finds the
    // byte that write failed on; try A cut there ends cleanly: three passes.
    const doc = await pair(bytes(zlib(sloppy), ' '.repeat(16)))
    const first = await inflating(() => doc.decode(streamOf(doc, 1), 4 * MiB, 'embedded'), true)
    expect(first.passes).toBe(3)
    expect([first.value?.whole, first.value?.endLost]).toEqual([true, false])
    expect(first.value?.text).toBe(latin1(sloppy))
    expect(doc.tally).toMatchObject({ partial: 0, checksumOnly: 0 })

    // Those three count against the 2,048 opens, so the same stream on the
    // last one gets no second passes, nor a cut, and is partial.
    const rest = await lastOpen(doc)
    expect(rest.passes).toBe(2_044 + 2)
    expect(rest.value?.whole).toBe(false)
    expect(await doc.decode(streamOf(doc, 2_047), MiB, 'text')).toBeNull()
  })

  it('takes no checksum the file wrote for proof that a lossy first pass lost nothing', async () => {
    // After the real checksum, the checksum of what a lossy first pass keeps,
    // then enough that the junk starts in a 1 KiB write. Judged by checksum,
    // the replay was skipped and the cut text read as whole.
    const z = zlib(sloppy)
    const kept = keptByChromium(z.subarray(2, -4))
    expect(kept.length).toBeLessThan(sloppy.length)
    const forged = bytes(z, zlib(kept).subarray(-4), ' '.repeat(8))
    const doc = await pair(forged)
    const first = await inflating(() => doc.decode(streamOf(doc, 1), 4 * MiB, 'embedded'), true)
    expect(first.value?.text).toBe(latin1(sloppy))
    expect(first.value?.whole).toBe(true)

    // On the last open there is no second pass, and the forged checksum must
    // not stand in for one.
    const rest = await lastOpen(doc)
    expect(rest.value?.text).toBe(latin1(kept))
    expect(rest.value?.whole).toBe(false)

    // Nor in an encrypted file, where a checksum that verifies is what lets a
    // stream be read at all.
    const sealed = await pair(forged, true)
    const opened = await inflating(() => sealed.decode(streamOf(sealed, 1), 4 * MiB, 'embedded'), true)
    expect(opened.value?.text).toBe(latin1(sloppy))
    expect((await lastOpen(sealed)).value).toBeNull()
    expect([sealed.tally.verified, sealed.tally.encrypted]).toEqual([2_045, 1])
  })

  it('runs no second pass for a /Length that counts the EOL when the first lost nothing', async () => {
    // Incompressible, so one stored block of 2,048 bytes: the deflate body ends
    // on a write boundary, and in try A the junk after it fails a write that
    // made no output, so it is not replayed. Without the EOL it ends cleanly:
    // the two passes the stream cost before any replay existed.
    const noise = new Uint8Array(2_043)
    for (let i = 0, x = 1; i < noise.length; i++) noise[i] = (x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0) >>> 24
    const z = zlib(noise)
    expect(z.length).toBe(2 + 2_048 + 4)
    const doc = await open(buildPdf([{ num: 1, body: '<< /Filter /FlateDecode >>', stream: bytes(z, '\n') }]))
    const { value, passes } = await inflating(() => doc.decode(streamOf(doc, 1), 4 * MiB, 'embedded'), true)
    expect(passes).toBe(2)
    expect([value?.whole, value?.endLost]).toEqual([true, false])
    expect(value?.text).toBe(latin1(noise))
  })

  it('stops opening decompressors after 2,048 per file', async () => {
    const objects: Obj[] = Array.from({ length: 2_100 }, (_, i) => ({
      num: i + 1,
      body: '<< >>',
      stream: 'x',
      flate: true
    }))
    const doc = await open(buildPdf(objects))
    const out = []
    for (let i = 1; i <= 2_100; i++) out.push(await doc.decode(streamOf(doc, i), MiB, 'text'))
    expect(out.slice(0, 2_048).every((d) => d?.text === 'x')).toBe(true)
    expect(out.slice(2_048).every((d) => d === null)).toBe(true)
    expect(doc.tally.budget).toBe(52)
  })

  it('refuses when the message budget is spent, and keeps each use to its own share', async () => {
    const z = zlib('BT ET')
    const spent = await decodeOne(flateDict(z), z, MiB, { left: 0 })
    expect(spent.text).toBeUndefined()
    expect(spent.doc.tally.messageBudget).toBe(1)

    const big = 'a'.repeat(MiB)
    const objects: Obj[] = Array.from({ length: 6 }, (_, i) => ({
      num: i + 1,
      body: '<< >>',
      stream: big,
      flate: true
    }))
    const doc = await open(buildPdf(objects))
    const scripts = []
    for (let i = 1; i <= 5; i++) scripts.push(await doc.decode(streamOf(doc, i), MiB, 'script'))
    expect(scripts.map((d) => d?.text.length ?? null)).toEqual([MiB, MiB, MiB, MiB, null])
    expect(doc.tally.budget).toBe(1)
    expect((await doc.decode(streamOf(doc, 6), MiB, 'text'))?.text.length).toBe(MiB)
  })

  it('reuses a decode for a smaller cap and decodes again for a larger one', async () => {
    const z = zlib('b'.repeat(4 * MiB))
    const media = { left: 100 * MiB }
    const doc = await open(streamFile(flateDict(z), z), media)
    const s = streamOf(doc, 4)
    const small = await doc.decode(s, MiB, 'script')
    expect(small?.text.length).toBe(MiB)
    const large = await doc.decode(s, 4 * MiB, 'text')
    expect(large?.text.length).toBe(4 * MiB)
    expect(media.left).toBe(100 * MiB - 5 * MiB)
    expect(await doc.decode(s, 2 * MiB, 'text')).toBe(large)
  })

  it('degrades out loud when the device cannot inflate', async () => {
    const saved = globalThis.DecompressionStream
    Reflect.deleteProperty(globalThis, 'DecompressionStream')
    try {
      const z = zlib('BT ET')
      const flate = await decodeOne(flateDict(z), z)
      expect(flate.text).toBeUndefined()
      expect(flate.doc.tally.noInflate).toBe(1)
      const hex = await decodeOne('<< /Length 5 /Filter /AHx >>', '4142>')
      expect(hex.text).toBe('AB')
    } finally {
      Object.defineProperty(globalThis, 'DecompressionStream', { value: saved, configurable: true, writable: true })
    }
  })
})

describe('openPdf: resolve and floods', () => {
  it('returns undefined for a reference cycle or a missing object, and follows a short chain', async () => {
    const doc = await open(
      bytes('%PDF-1.7\n1 0 obj 2 0 R endobj 2 0 obj 1 0 R endobj 3 0 obj 4 0 R endobj 4 0 obj (end) endobj\n')
    )
    expect(doc.resolve(ref(1))).toBeUndefined()
    expect(doc.resolve(ref(77))).toBeUndefined()
    expect(str(doc, 3)).toBe('end')
  })

  it('bounds a million definitions of one number', async () => {
    const file = bytes('%PDF-1.7\n', '1 0 obj 1 endobj'.repeat(1_000_000))
    const started = performance.now()
    const doc = await open(file)
    expect(performance.now() - started).toBeLessThan(SLOW_MS)
    expect(doc.objects.size).toBe(1)
    expect(doc.stats.supersededCapped).toBe(true)
    expect(doc.stats.headersCapped).toBe(true)
    expect(doc.superseded).toHaveLength(10_000)
  })

  it('stops re-reading unclosed strings on its own budget and still indexes the real object last', async () => {
    const parts = ['%PDF-1.7\n']
    for (let n = 1; n <= 80; n++) parts.push(`${n} 0 obj (${'a'.repeat(200_000)}\n`)
    parts.push('81 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n')
    const file = bytes(...parts)
    const started = performance.now()
    const doc = await open(file)
    expect(performance.now() - started).toBeLessThan(SLOW_MS)
    expect(asDict(doc.resolve(ref(81)))?.has('OpenAction')).toBe(true)
    expect(doc.stats.unreadable).toBe(80)
    // Closed at the very end, object 80's string would swallow object 81 if it
    // were ever re-read. It is not: the retry budget was spent on the first few.
    const closed = await open(bytes(file, ')\nendobj\n'))
    expect(closed.where(81)).toBe('object 81')
    expect(closed.stats.unreadable).toBe(80)
  })
})

describe('textString', () => {
  it('reads UTF-16BE and UTF-8 with their marks, and PDFDocEncoding otherwise', () => {
    expect(textString('\xFE\xFF\x00H\x00i\xD8\x3D\xDE\x00\x00')).toBe('Hi\u{1F600}')
    expect(textString('\xEF\xBB\xBF\xC3\xA9\xE2\x82\xAC')).toBe('é€')
    expect(textString('\x80 \xA0 \x18 plain')).toBe('• € ˘ plain')
    expect(textString('\x9F')).toBe('�')
  })

  it('makes a GAP the file spells U+FFFD, so only this reader writes one', () => {
    expect(GAP).toBe('\uE000')
    expect(textString('\xFE\xFF\x00a\xE0\x00\x00b')).toBe('a\uFFFDb')
    expect(textString('\xEF\xBB\xBFa\xEE\x80\x80b')).toBe('a\uFFFDb')
    expect(stripGap(`x${GAP}y${GAP}`)).toBe('x\uFFFDy\uFFFD')
  })
})

describe('real files', () => {
  it('reads a macOS Quartz PDF: trailer, catalog, both pages, the link and the fonts', async () => {
    const doc = await open(fixture('quartz-lure.pdf'))
    expect([doc.trailerFrom, doc.rootFrom, doc.encrypted]).toEqual(['startxref', 'trailer', false])
    expect(doc.stats.unreadable).toBe(0)
    expect(doc.stats.duplicates).toBe(0)
    const pages = asDict(doc.resolve(doc.root?.v.get('Pages')))
    expect(pages?.get('Count')).toBe(2)
    const uris = [...doc.objects.values()]
      .map((o) => asDict(o.value))
      .filter((d) => d && asName(d.get('S')) === 'URI')
      .map((d) => doc.resolve(d?.get('URI')))
    expect(uris).toHaveLength(1)
    expect((uris[0] as { v: string }).v).toMatch(/^https?:\/\//)
    const info = asDict(doc.resolve(doc.trailer?.v.get('Info')))
    expect(textString(asString(info?.get('Producer')) ?? '')).toContain('Quartz PDFContext')
    const streams = [...doc.objects.values()]
      .map((o) => o.value)
      .filter((v): v is PdfStream => typeof v === 'object' && v !== null && !Array.isArray(v) && v.t === 'stream')
    expect(streams.length).toBeGreaterThan(5)
    const decoded = await Promise.all(streams.map((s) => doc.decode(s, 4 * MiB, 'text')))
    expect(decoded.every((d) => d?.whole)).toBe(true)
  })

  it('reads a CUPS text PDF the same way', async () => {
    const doc = await open(fixture('cups-text.pdf'))
    expect([doc.trailerFrom, doc.rootFrom, doc.stats.unreadable]).toEqual(['startxref', 'trailer', 0])
    const pages = [...doc.objects.values()].map((o) => asDict(o.value)).filter((d) => asName(d?.get('Type')) === 'Page')
    expect(pages).toHaveLength(1)
    const content = await doc.decode(doc.resolve(pages[0]?.get('Contents')) as PdfStream, 4 * MiB, 'text')
    expect(content?.whole).toBe(true)
    expect(content?.text).toMatch(/\)\s*Tj/)
  })
})

/** ASCII85 for the chain test: groups of four bytes, a short last group, and the end marker. */
function ascii85(data: Uint8Array): string {
  let out = ''
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.subarray(i, i + 4)
    let v = 0
    for (let k = 0; k < 4; k++) v = v * 256 + (chunk[k] ?? 0)
    const digits: string[] = []
    for (let k = 0; k < 5; k++) {
      digits.unshift(String.fromCharCode(0x21 + (v % 85)))
      v = Math.floor(v / 85)
    }
    out += digits.slice(0, chunk.length + 1).join('')
  }
  return `${out}~>`
}
