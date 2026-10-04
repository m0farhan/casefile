import { describe, expect, it } from 'vitest'
import { GAP, latin1, openPdf, type PdfDict, type PdfDoc, type PdfStream, type Work, WORK_BUDGET } from './pdfObjects'
import { type PdfPage, type PdfTextResult, readPageText } from './pdfText'
import { buildPdf, fixture, type Obj, onePage, zlib } from '../../test/pdf'

const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
const FONTS = `<< /F1 ${HELVETICA} >>`

async function read(file: Uint8Array): Promise<{ doc: PdfDoc; t: PdfTextResult }> {
  const doc = await openPdf(file, latin1(file), { left: 1e9 }, { left: WORK_BUDGET })
  return { doc, t: await readPageText(doc) }
}

/** The first page of a one-page file drawing `content` with these fonts. */
async function firstPage(content: string, fonts?: string, extra?: Obj[]): Promise<{ page: PdfPage; t: PdfTextResult }> {
  const { t } = await read(onePage(content, { fonts, extra }))
  return { page: t.pages[0], t }
}

/** Catalog 1, pages 2, page 3 with these resources, content 4 (deflated); `extra` from 5. */
function withResources(content: string, resources: string, extra: Obj[] = [], pageExtra = ''): Uint8Array {
  return buildPdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, body: `<< /Type /Page /Parent 2 0 R /Resources ${resources} /Contents 4 0 R ${pageExtra} >>` },
    { num: 4, body: '<< >>', stream: content, flate: true },
    ...extra
  ])
}

/** One page per content, Helvetica inherited from the /Pages node: pages 10, 12, …, contents 11, 13, …. */
function manyPages(contents: string[], count = contents.length): Uint8Array {
  const objects: Obj[] = [{ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' }]
  const kids = contents.map((_, i) => `${10 + 2 * i} 0 R`).join(' ')
  objects.push({ num: 2, body: `<< /Type /Pages /Kids [${kids}] /Count ${count} /Resources << /Font ${FONTS} >> >>` })
  contents.forEach((content, i) => {
    objects.push({ num: 10 + 2 * i, body: `<< /Type /Page /Parent 2 0 R /Contents ${11 + 2 * i} 0 R >>` })
    objects.push({ num: 11 + 2 * i, body: '<< >>', stream: content, flate: true })
  })
  return buildPdf(objects)
}

/** One page drawing objects 4, 5, … in turn, with these resources; `extra` after them. */
function pieces(streams: Omit<Obj, 'num'>[], resources = `<< /Font ${FONTS} >>`, extra: Obj[] = []): Uint8Array {
  const refs = streams.map((_, i) => `${4 + i} 0 R`).join(' ')
  return buildPdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, body: `<< /Type /Page /Parent 2 0 R /Resources ${resources} /Contents [${refs}] >>` },
    ...streams.map((o, i) => ({ ...o, num: 4 + i })),
    ...extra
  ])
}

const note = (t: PdfTextResult, start: string): string | undefined => t.notes.find((n) => n.startsWith(start))
const form = (num: number, content: string, resources = `<< /Font ${FONTS} >>`): Obj => ({
  num,
  body: `<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources ${resources} >>`,
  stream: content,
  flate: true
})
const toUnicode = (num: number, body: string): Obj => ({
  num,
  body: '<< >>',
  stream: `/CIDInit /ProcSet findresource begin 12 dict begin begincmap ${body} endcmap CMapName currentdict /CMap defineresource pop end end`,
  flate: true
})
const type0 = (encoding: string, extra = ''): string =>
  `<< /F1 << /Type /Font /Subtype /Type0 /BaseFont /CID /Encoding ${encoding} /DescendantFonts [<< /Type /Font /Subtype /CIDFontType2 /BaseFont /CID /DW 500 ${extra} >>] >> >>`

describe('readPageText: operators and spacing', () => {
  it('reads a Tj', async () => {
    const { page, t } = await firstPage('BT /F1 12 Tf 72 700 Td (Hello) Tj ET')
    expect(page).toMatchObject({
      number: 1,
      where: 'object 3',
      text: 'Hello',
      hidden: '',
      unread: 0,
      textCut: false,
      hiddenCut: false
    })
    expect(t.pageCount).toBe(1)
    expect(note(t, 'Page text is what')).toBeDefined()
    expect(note(t, 'No page read whole')).toBeUndefined()
  })

  it('breaks lines on Td, TL and T*', async () => {
    const { page } = await firstPage('BT /F1 12 Tf 14 TL 72 700 Td (Line one) Tj 0 -14 Td (Line two) Tj T* (x) Tj ET')
    expect(page.text).toBe('Line one\nLine two\nx')
  })

  it('reads a TJ adjustment wide enough as a space and a narrow one as none', async () => {
    const { page } = await firstPage('BT /F1 12 Tf 72 700 Td [(Pay)-300(now)-50(ok)] TJ ET')
    expect(page.text).toBe('Pay nowok')
  })

  it('advances by /Widths, so glyphs set edge to edge stay one word', async () => {
    const widths = Array.from({ length: 95 }, (_, i) =>
      i + 32 === 0x50 ? 667 : i + 32 === 0x61 ? 556 : i + 32 === 0x57 ? 1000 : 500
    )
    const fonts = `<< /F1 << /Type /Font /Subtype /TrueType /BaseFont /Arial /Encoding /WinAnsiEncoding /FirstChar 32 /Widths [${widths.join(' ')}] >> >>`
    const pay = await firstPage(
      'BT /F1 10 Tf 1 0 0 1 100 700 Tm (P) Tj 1 0 0 1 106.67 700 Tm (a) Tj 1 0 0 1 112.23 700 Tm (y) Tj 1 0 0 1 125 700 Tm (now) Tj ET',
      fonts
    )
    expect(pay.page.text).toBe('Pay now')
    // A 1000-unit W ends at 110: read at the default 500 it would end at 105, and the gap would read as a space.
    const wide = await firstPage('BT /F1 10 Tf 1 0 0 1 100 700 Tm (W) Tj 1 0 0 1 110 700 Tm (ok) Tj ET', fonts)
    expect(wide.page.text).toBe('Wok')
  })

  it('carries operands and state from one content piece to the next', async () => {
    const file = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { num: 3, body: `<< /Type /Page /Parent 2 0 R /Resources << /Font ${FONTS} >> /Contents [4 0 R 5 0 R 6 0 R] >>` },
      { num: 4, body: '<< >>', stream: 'BT /F1 12 Tf 72 700 Td (one) Tj', flate: true },
      { num: 5, body: '<< >>', stream: '(two)', flate: true },
      { num: 6, body: '<< >>', stream: 'Tj ET', flate: true }
    ])
    const { t } = await read(file)
    expect(t.pages[0]).toMatchObject({ text: 'onetwo', unread: 0 })
  })

  it('keeps the text state over q and Q', async () => {
    const fonts = `<< /F1 ${HELVETICA} /F2 << /Type /Font /Subtype /Type1 /BaseFont /Symbol >> >>`
    const { page } = await firstPage('BT /F1 12 Tf 72 700 Td q /F2 10 Tf Q (x) Tj ET', fonts)
    expect(page.text).toBe('x')
  })

  it('keeps text visible once q nests past 64, where a Q can no longer restore what was saved', async () => {
    const lure = 'BT /F1 12 Tf 72 700 Td (Sign in at https://evil-lure.test/owa) Tj ET'
    // A reader restores 0 Tr at each Q here; saves past the 64th are not kept, so nothing after them is trusted.
    for (const content of [
      `3 Tr ${'q '.repeat(64)}0 Tr ${'q '.repeat(6)}${'Q '.repeat(6)}${lure}`,
      `3 Tr ${'q '.repeat(64)}0 Tr q 3 Tr Q ${lure}`
    ]) {
      const { page, t } = await firstPage(content)
      expect(page).toMatchObject({ text: 'Sign in at https://evil-lure.test/owa', hidden: '', unread: 1 })
      expect(note(t, 'Page(s) 1 save the graphics state (q) more than 64 levels deep')).toBeDefined()
    }
  })

  it('sends invisible render modes and zero-size text to hidden', async () => {
    const modes = await firstPage('BT /F1 12 Tf 72 700 Td 3 Tr (secret) Tj 0 Tr (shown) Tj ET')
    expect(modes.page).toMatchObject({ text: 'shown', hidden: 'secret' })
    const tiny = await firstPage('BT /F1 0 Tf 72 700 Td (tiny) Tj ET')
    expect(tiny.page).toMatchObject({ text: '', hidden: 'tiny' })
  })

  it('places text through the CTM, as CoreText, AppKit and WebKit write every run at Tm 0 0', async () => {
    // CoreText: each line translated by cm. Read in text space, both start at 0 0 and join.
    const lines = await firstPage(
      'q 1 0 0 1 72 700 cm BT /F1 12 Tf 0 0 Td (To) Tj ET Q q 1 0 0 1 72 680 cm BT /F1 12 Tf 0 0 Td (evil.example.com) Tj ET Q'
    )
    expect(lines.page.text).toBe('To\nevil.example.com')

    // AppKit: a flipped CTM, the same Tm on every line.
    const flipped = await firstPage(
      'q 1 0 0 -1 10 80 cm BT /F1 1 Tf 13 0 0 -13 2 13 Tm (Ref) Tj ET Q q 1 0 0 -1 10 100 cm BT /F1 1 Tf 13 0 0 -13 2 13 Tm (support@acme-billing.example.net) Tj ET Q'
    )
    expect(flipped.page.text).toBe('Ref\nsupport@acme-billing.example.net')

    // WebKit: one run per styled span, each starting where the last one ended
    // (8 units a glyph at 500/1000 × 16), so they read as one word. The second
    // cm only lands at 192 if Q gave back the first one's CTM.
    const run = (x: number, s: string): string => `q 1 0 0 -1 ${x} 700 cm BT 16 0 0 -16 0 0 Tm /F1 1 Tf (${s}) Tj ET Q`
    const spans = await firstPage(
      [run(72, 'https://secure-'), run(192, 'bank'), run(224, '.example.com/login'), run(400, 'today')].join(' ')
    )
    expect(spans.page.text).toBe('https://secure-bank.example.com/login today')

    // A page the CTM turns a quarter, and a line Tm turns: spaced along the line, not by page x and y.
    const turned = await firstPage(
      'q 0 1 -1 0 612 0 cm BT /F1 12 Tf 14 TL 72 700 Td (secure-) Tj (bank.example.com) Tj T* [(Pay) -300 (now) -1000 (ok)] TJ ET Q'
    )
    expect(turned.page.text).toBe('secure-bank.example.com\nPay now ok')
    const slanted = await firstPage('BT /F1 12 Tf 0 1 -1 0 300 100 Tm [(Pay) -300 (now) -1000 (ok)] TJ ET')
    expect(slanted.page.text).toBe('Pay now ok')
  })

  it('notes right-to-left script, which files draw in visual order', async () => {
    // "נחסם" drawn left to right, as producers write it: the last letter first.
    const hebrew = await firstPage('BT /F1 12 Tf 72 700 Td <05DD05E105D705E0> Tj ET', type0('/UniJIS-UCS2-H'))
    expect(hebrew.page.text).toBe('םסחנ')
    expect(note(hebrew.t, 'Page(s) 1 hold right-to-left script')).toContain('read reversed from reading order')
    const latin = await firstPage('BT /F1 12 Tf 72 700 Td (Hello) Tj ET')
    expect(latin.t.notes.some((n) => n.includes('right-to-left'))).toBe(false)
  })
})

describe('readPageText: fonts', () => {
  it('maps Type0 Identity-H codes through /ToUnicode bfchar and both bfrange forms', async () => {
    const cmap = toUnicode(
      7,
      '1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0003> <0020> <0004> <D83DDE00> endbfchar 2 beginbfrange <0010> <0012> <0050> <0020> <0022> [<0061> <0079> <0066006C>] endbfrange'
    )
    const { page } = await firstPage('BT /F1 12 Tf 72 700 Td <0010002000210003000400030022> Tj ET', '<< /F1 5 0 R >>', [
      {
        num: 5,
        body: '<< /Type /Font /Subtype /Type0 /BaseFont /CID /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>'
      },
      { num: 6, body: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /CID /DW 500 >>' },
      cmap
    ])
    expect(page.text).toBe('Pay 😀 fl')
    expect(page.undecoded).toBe(0)
  })

  it('shows Identity-H codes with no /ToUnicode as U+FFFD and says so', async () => {
    const { page, t } = await firstPage('BT /F1 12 Tf 72 700 Td <000100020003> Tj ET', type0('/Identity-H'))
    expect(page).toMatchObject({ text: '���', undecoded: 3 })
    const undecoded = note(t, '3 character(s)')
    expect(undecoded).toContain('shown as �')
    expect(undecoded).toContain('page(s) 1')
  })

  it('applies /Differences, glyph names by code point, and leaves unknown names undecoded', async () => {
    const fonts =
      '<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Differences [65 /a /b /space /fi /uni20AC /g12] >> >> >>'
    const { page } = await firstPage('BT /F1 12 Tf 72 700 Td (ABCDEF) Tj ET', fonts)
    // A code this reader cannot decode is a place text is missing, marked where a word touches it.
    expect(page).toMatchObject({ text: `ab fi€${GAP}�`, undecoded: 1, assumed: 0 })
  })

  it('counts Standard read for a font with no /Encoding as assumed, except for the Latin standard 14', async () => {
    const custom = await firstPage(
      "BT /F1 12 Tf 72 700 Td (it's) Tj ET",
      '<< /F1 << /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Custom >> >>'
    )
    expect(custom.page).toMatchObject({ text: 'it’s', assumed: 4 })
    expect(note(custom.t, '4 character(s) are drawn in fonts that declare neither')).toBeDefined()

    const helvetica = await firstPage(
      "BT /F1 12 Tf 72 700 Td (it's) Tj ET",
      '<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>'
    )
    expect(helvetica.page).toMatchObject({ text: 'it’s', assumed: 0 })
    expect(helvetica.t.notes.some((n) => n.includes('declare neither'))).toBe(false)

    const symbolic = await firstPage(
      "BT /F1 12 Tf 72 700 Td (it's) Tj ET",
      '<< /F1 << /Type /Font /Subtype /TrueType /BaseFont /Custom /FontDescriptor << /Flags 4 >> >> >>'
    )
    expect(symbolic.page).toMatchObject({ text: '����', undecoded: 4, assumed: 0 })
  })

  it('reads MacRomanEncoding', async () => {
    const { page } = await firstPage(
      'BT /F1 12 Tf 72 700 Td <8A> Tj ET',
      '<< /F1 << /Type /Font /Subtype /TrueType /BaseFont /Monaco /Encoding /MacRomanEncoding >> >>'
    )
    expect(page.text).toBe('ä')
  })

  it('prefers /ToUnicode to the encoding', async () => {
    const cmap = toUnicode(5, '1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <41> <0042> endbfchar')
    const fonts =
      '<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 5 0 R >> >>'
    const { page } = await firstPage('BT /F1 12 Tf 72 700 Td (A) Tj ET', fonts, [cmap])
    expect(page.text).toBe('B')
  })

  it('leaves a symbol font with no /ToUnicode undecoded', async () => {
    const { page } = await firstPage(
      'BT /F1 12 Tf 72 700 Td (a) Tj ET',
      '<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Symbol >> >>'
    )
    expect(page).toMatchObject({ text: '�', undecoded: 1 })
  })

  it('takes /Resources inherited from the /Pages node', async () => {
    const { t } = await read(manyPages(['BT /F1 12 Tf 72 700 Td (inherited) Tj ET']))
    expect(t.pages[0].text).toBe('inherited')
  })

  it('reads a UCS-2 CMap with no /ToUnicode as the code units themselves', async () => {
    const { page } = await firstPage('BT /F1 12 Tf 72 700 Td <30423044> Tj ET', type0('/UniJIS-UCS2-H'))
    expect(page).toMatchObject({ text: 'あい', undecoded: 0 })
  })

  it('takes the shortest codespace range a code fits, whatever order they are declared in', async () => {
    const cmap = toUnicode(
      5,
      '2 begincodespacerange <0000> <FFFF> <00> <7F> endcodespacerange 2 beginbfchar <41> <0061> <42> <0062> endbfchar'
    )
    const { page } = await firstPage(
      'BT /F1 12 Tf 72 700 Td (AB) Tj ET',
      type0('/Custom-H').replace('>> >>', '/ToUnicode 5 0 R >> >>'),
      [cmap]
    )
    expect(page.text).toBe('ab')
  })

  it('reads ligatures and Kangxi radicals as the letters and ideographs they draw, and nothing else', async () => {
    // Quartz writes fi as MacRoman 0xDE; read as U+FB01 the scan would find only "scal.example.org".
    const mac = await firstPage(
      'BT /F1 12 Tf 72 700 Td (of\\336ce@\\336scal.example.org) Tj ET',
      '<< /F1 << /Type /Font /Subtype /TrueType /BaseFont /Helvetica /Encoding /MacRomanEncoding >> >>'
    )
    expect(mac.page.text).toBe('office@fiscal.example.org')
    // Through /ToUnicode: fi, the radical 用 (U+2F64), and a fullwidth ａ, which a reader shows as drawn.
    const cmap = toUnicode(5, '3 beginbfchar <01> <FB01> <02> <2F64> <03> <FF41> endbfchar')
    const mapped = await firstPage(
      'BT /F1 12 Tf 72 700 Td <010203> Tj ET',
      '<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 5 0 R >> >>',
      [cmap]
    )
    expect(mapped.page.text).toBe('fi\u7528\uff41')
  })

  it('counts undecoded and assumed characters for the buffer they went into', async () => {
    const identity =
      '<< /Type /Font /Subtype /Type0 /BaseFont /CID /Encoding /Identity-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType2 /BaseFont /CID >>] >>'
    const fonts = `<< /F1 ${HELVETICA} /F2 ${identity} /F3 << /Type /Font /Subtype /Type1 /BaseFont /CustomLure >> >>`
    const { page, t } = await firstPage(
      'BT /F1 12 Tf 72 700 Td (Visit https://plain-lure.test/x now) Tj 3 Tr /F3 12 Tf 0 -20 Td (secret words) Tj /F2 12 Tf <000100020003> Tj ET',
      fonts
    )
    expect(page).toMatchObject({
      text: 'Visit https://plain-lure.test/x now',
      undecoded: 0,
      assumed: 0,
      hiddenUndecoded: 3,
      hiddenAssumed: 12
    })
    // The file-wide notes count both buffers.
    expect(note(t, '3 character(s) on page(s) 1')).toBeDefined()
    expect(note(t, '12 character(s) are drawn in fonts that declare neither')).toBeDefined()
  })
})

describe('readPageText: forms, annotations and pictures', () => {
  it('runs a form XObject with its own resources, its text set off by line breaks', async () => {
    const file = withResources(
      'BT /F1 12 Tf 72 700 Td (before) Tj ET /X Do BT /F1 12 Tf 72 700 Td (after) Tj ET',
      `<< /Font ${FONTS} /XObject << /X 5 0 R >> >>`,
      [form(5, 'BT /F9 12 Tf 72 700 Td (inside) Tj ET', `<< /Font << /F9 ${HELVETICA} >> >>`)]
    )
    const { t } = await read(file)
    // All three start at x 72 on one line; only the breaks keep them from reading as one run.
    expect(t.pages[0]).toMatchObject({ text: 'before\ninside\nafter', unread: 0 })
  })

  it('stops a form drawn from inside itself, a chain past 8 deep, and runs past 2000', async () => {
    const self = withResources('/X Do', '<< /XObject << /X 5 0 R >> >>', [
      form(5, 'BT /F1 12 Tf (self) Tj ET /X Do', `<< /XObject << /X 5 0 R >> /Font ${FONTS} >>`)
    ])
    const selfRead = await read(self)
    // The drawing not run is a place text may be missing, but its text would
    // start on a new line here, so it cut no word before it.
    expect(selfRead.t.pages[0]).toMatchObject({ text: 'self', unread: 1 })
    expect(note(selfRead.t, '1 Form XObject(s) or annotation appearance(s) were not read')).toBeDefined()

    const chain = Array.from({ length: 10 }, (_, i) =>
      form(5 + i, `BT /F1 12 Tf (L${i + 1}) Tj ET /X Do`, `<< /XObject << /X ${6 + i} 0 R >> /Font ${FONTS} >>`)
    )
    const deep = await read(withResources('/X Do', '<< /XObject << /X 5 0 R >> >>', chain))
    expect(deep.t.pages[0].text).toContain('L8')
    expect(deep.t.pages[0].text).not.toContain('L9')
    expect(note(deep.t, '1 Form XObject(s)')).toBeDefined()

    // Counted, not timed: the cap is what bounds the runs, and a clock fails a slow runner.
    const runs = await read(
      withResources('/X Do '.repeat(3000), `<< /XObject << /X 5 0 R >> /Font ${FONTS} >>`, [
        form(5, 'BT /F1 12 Tf (f) Tj ET')
      ])
    )
    expect(runs.t.pages[0].text.split('f').length - 1).toBe(2000)
    expect(note(runs.t, '1000 Form XObject(s)')).toBeDefined()
  })

  it('reads annotation appearances, maps the annotation to its page, and hides Hidden and NoView ones', async () => {
    const appearance = form(6, 'BT /F1 12 Tf (annot) Tj ET')
    const annotated = async (annot: string): Promise<{ doc: PdfDoc; t: PdfTextResult }> =>
      read(
        withResources(
          'BT /F1 12 Tf 72 700 Td (body) Tj ET',
          `<< /Font ${FONTS} >>`,
          [{ num: 5, body: annot }, appearance],
          '/Annots [5 0 R]'
        )
      )
    const shown = await annotated('<< /Type /Annot /Subtype /Widget /Rect [0 0 10 10] /AP << /N 6 0 R >> >>')
    expect(shown.t.pages[0]).toMatchObject({ text: 'body\nannot', hidden: '' })
    expect(shown.t.annotPages.get(shown.doc.objects.get(5)?.value as PdfDict)).toBe(1)

    const byState = await annotated('<< /Type /Annot /Subtype /Widget /AP << /N << /On 6 0 R >> >> /AS /On >>')
    expect(byState.t.pages[0].text).toBe('body\nannot')

    for (const flag of [2, 32]) {
      const hidden = await annotated(`<< /Type /Annot /Subtype /Widget /F ${flag} /AP << /N 6 0 R >> >>`)
      expect(hidden.t.pages[0]).toMatchObject({ text: 'body', hidden: 'annot' })
    }
  })

  it('keeps page words whole beside an appearance, read or not: its text is on lines of its own', async () => {
    const lure = 'BT /F1 12 Tf 72 700 Td (Pay at https://annot-lure.test/pay) Tj ET'
    const widget: Obj = { num: 5, body: '<< /Type /Annot /Subtype /Widget /Rect [0 0 10 10] /AP << /N 6 0 R >> >>' }
    const lzw = {
      body: '<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Filter /LZWDecode >>',
      stream: 'x'.repeat(40)
    }
    const resources = `<< /Font ${FONTS} /XObject << /E 7 0 R >> >>`
    const page = async (content: string, appearance: Obj): Promise<PdfTextResult> =>
      (await read(withResources(content, resources, [widget, appearance, form(7, '')], '/Annots [5 0 R]'))).t
    // Not decoded; and past the 2,000 drawings, after an empty form drawn 2,000 times.
    const undecoded = await page(lure, { num: 6, ...lzw })
    expect(undecoded.pages[0]).toMatchObject({ text: 'Pay at https://annot-lure.test/pay', unread: 1 })
    const capped = await page(`${'/E Do '.repeat(2000)}${lure}`, form(6, 'BT /F1 12 Tf (annot) Tj ET'))
    expect(capped.pages[0]).toMatchObject({ text: 'Pay at https://annot-lure.test/pay', unread: 1 })
    expect(note(capped, '1 Form XObject(s)')).toBeDefined()
    // A page piece not read before it marks the page's word, not the appearance's.
    const { t } = await read(
      buildPdf([
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        {
          num: 3,
          body: `<< /Type /Page /Parent 2 0 R /Resources << /Font ${FONTS} >> /Contents [4 0 R 8 0 R] /Annots [5 0 R] >>`
        },
        { num: 4, body: '<< >>', stream: lure, flate: true },
        widget,
        form(6, 'BT /F1 12 Tf (https://annot.test/x) Tj ET'),
        { num: 8, ...lzw }
      ])
    )
    expect(t.pages[0].text).toBe(`Pay at https://annot-lure.test/pay${GAP}\nhttps://annot.test/x`)
  })

  it('skips an inline image by its EI, records it, and survives one with no end or a negative /L', async () => {
    const image = await firstPage(
      'BT /F1 12 Tf 72 700 Td BI /W 1 /H 1 /BPC 8 /CS /G ID \x00(fake) Tj\xff EI (real) Tj ET'
    )
    expect(image.page.text).toBe('real')
    expect(image.page.pictures[0]).toEqual({
      filter: '(none)',
      width: 1,
      height: 1,
      where: 'inline image',
      offset: null
    })

    const open = await firstPage('BT /F1 12 Tf 72 700 Td (before) Tj BI /W 1 /H 1 ID \x00\x01\x02')
    expect(open.page).toMatchObject({ text: `before${GAP}`, unread: 1 })
    expect(note(open.t, '1 content stream(s) held an inline image')).toBeDefined()

    const negative = await firstPage('BT /F1 12 Tf 72 700 Td BI /W 1 /H 1 /L -100 ID \x00 EI (after) Tj ET')
    expect(negative.page.text).toBe('after')

    // The first ` EI ` in the data ends it before a declared /L that lands on a later one, as pdf.js and PDFKit read it.
    const sized = await firstPage('BT /F1 12 Tf 72 700 Td BI /W 1 /H 1 /L 14 ID x EI (fake) Tj EI (real) Tj ET')
    expect(sized.page.text).toBe('fakereal')
    // So does one past a second image: the /L lands on its EI, over the lure drawn between them.
    const second =
      ' EI Q BT /F1 12 Tf 72 600 Td (Sign in at https://evil-lure.test/owa) Tj ET q BI /W 1 /H 1 /BPC 8 /CS /G ID \x80'
    const later = await firstPage(
      `BT /F1 12 Tf 72 700 Td (Your invoice is attached) Tj ET q BI /W 1 /H 1 /BPC 8 /CS /G /L ${1 + second.length} ID \x80${second} EI Q`
    )
    expect(later.page).toMatchObject({
      text: 'Your invoice is attached\nSign in at https://evil-lure.test/owa',
      unread: 0
    })
  })

  it("takes an inline image's /L only where it lands on EI", async () => {
    // The run after the image starts where the first ends: one address.
    const first = 'Sign in at https://login.microsoftonline.co'
    const tail = `BT /F1 12 Tf 1 0 0 1 ${72 + first.length * 6} 700 Tm (m.evil-split.com/owa) Tj ET `
    const data = ` EI Q ${tail}`
    // The true length, and ones that run over the EI into the run after it.
    for (const l of ['/L 1', `/L ${1 + data.length}`, `/L ${data.length - 2}`]) {
      const { page } = await firstPage(
        `BT /F1 12 Tf 72 700 Td (${first}) Tj ET q BI /W 1 /H 1 /BPC 8 /CS /G ${l} ID \x80${data}`
      )
      expect([l, page]).toMatchObject([l, { text: `${first}m.evil-split.com/owa`, unread: 0 }])
    }
    // One too short, over data shaped as drawing: not drawn by a reader that finds the EI.
    const short = await firstPage(
      'BT /F1 12 Tf 72 700 Td (Pay at https://real.test/pay) Tj ET q BI /W 30 /H 1 /BPC 8 /CS /G /L 0 ID BT /F1 12 Tf 72 600 Td (https://fabricated.test/x) Tj ET EI Q'
    )
    expect(short.page.text).toBe('Pay at https://real.test/pay')
  })

  it('reads an OCR-shaped page: a picture under invisible text', async () => {
    const file = withResources(
      `q 2 0 0 3 0 0 cm /Im0 Do Q BT 3 Tr /F1 12 Tf 72 700 Td (${'x'.repeat(3000)}) Tj ET`,
      `<< /Font ${FONTS} /XObject << /Im0 5 0 R >> >>`,
      [
        {
          num: 5,
          body: '<< /Type /XObject /Subtype /Image /Width 2 /Height 3 /ColorSpace /DeviceGray /BitsPerComponent 8 >>',
          stream: '\x00\x40\x80\xc0\xff\x10',
          flate: true
        }
      ]
    )
    const { doc, t } = await read(file)
    const page = t.pages[0]
    const image = doc.objects.get(5)?.value as PdfStream
    expect(page.hidden).toHaveLength(3000)
    expect(page.text).toBe('')
    expect(page.pictures[0]).toEqual({
      filter: '/FlateDecode',
      width: 2,
      height: 3,
      where: 'object 5',
      offset: image.start
    })
    expect(note(t, 'No page read whole')).toBeUndefined()
  })

  it('reads a page of nothing but undecodable glyphs as U+FFFD, and says no page drew decodable text', async () => {
    const { page, t } = await firstPage('BT /F1 12 Tf 72 700 Td <00010002000300040005> Tj ET', type0('/Identity-H'))
    expect(page.text).toBe('�'.repeat(5))
    expect(page.undecoded).toBe(page.text.length)
    expect(note(t, 'No page read whole drew text this reader could decode.')).toBeDefined()
  })
})

describe('readPageText: page tree', () => {
  it('terminates on a /Kids cycle', async () => {
    const file = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [5 0 R] /Count 1 >>' },
      { num: 5, body: '<< /Type /Pages /Parent 2 0 R /Kids [3 0 R 2 0 R 5 0 R] /Count 1 >>' },
      { num: 3, body: `<< /Type /Page /Parent 5 0 R /Resources << /Font ${FONTS} >> /Contents 4 0 R >>` },
      { num: 4, body: '<< >>', stream: 'BT /F1 12 Tf 72 700 Td (Hello) Tj ET', flate: true }
    ])
    const { t } = await read(file)
    expect(t.pages.map((p) => p.text)).toEqual(['Hello'])
  })

  it('falls back to page objects in file order when the catalog names no page tree', async () => {
    const page = (num: number, content: number): Obj => ({
      num,
      body: `<< /Type /Page /Resources << /Font ${FONTS} >> /Contents ${content} 0 R >>`
    })
    const file = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 99 0 R >>' },
      page(6, 7),
      { num: 7, body: '<< >>', stream: 'BT /F1 12 Tf (first) Tj ET', flate: true },
      page(3, 4),
      { num: 4, body: '<< >>', stream: 'BT /F1 12 Tf (second) Tj ET', flate: true }
    ])
    const { t } = await read(file)
    expect(t.pages.map((p) => [p.number, p.where, p.text])).toEqual([
      [1, 'object 6', 'first'],
      [2, 'object 3', 'second']
    ])
    expect(note(t, 'The page tree could not be followed')).toBeDefined()
    expect(note(t, '1 object(s) marked /Type /Page')).toBeUndefined()
  })

  it('says when there are no pages at all', async () => {
    const { t } = await read(buildPdf([{ num: 1, body: '<< /Type /Catalog >>' }]))
    expect(t.pages).toEqual([])
    expect(t.notes).toEqual(['No page objects were found, so no page text was read.'])
    // Not where they may be packed in an object stream this reader could not read, as on a device with no inflate.
    const packed = await read(
      buildPdf([{ num: 9, body: '<< /Type /ObjStm /N 3 /First 12 /Filter /FlateDecode >>', stream: 'not zlib data' }])
    )
    expect(packed.t.notes).toEqual([
      'No page object was found among the objects read; 1 compressed object stream(s) could not be read, so pages packed there are unread, not absent.'
    ])
  })

  it('reads a /Type /Page object outside the tree as an orphan', async () => {
    const file = onePage('BT /F1 12 Tf 72 700 Td (tree) Tj ET', {
      extra: [
        { num: 5, body: `<< /Type /Page /Parent 2 0 R /Resources << /Font ${FONTS} >> /Contents 6 0 R >>` },
        { num: 6, body: '<< >>', stream: 'BT /F1 12 Tf (orphan) Tj ET', flate: true }
      ]
    })
    const { t } = await read(file)
    expect(t.pages.map((p) => [p.number, p.where, p.text])).toEqual([
      [1, 'object 3', 'tree'],
      [null, 'object 5', 'orphan']
    ])
    expect(note(t, '1 object(s) marked /Type /Page are not in the page tree')).toBeDefined()
  })

  it('bounds 4,096 /Pages nodes sharing one huge /Kids array', async () => {
    // ponytail: 1,900,000 elements, not 2,000,000: one value may span 4 MiB and a
    // file may hold 2,000,000 value units, so a bigger array is not read at all.
    const nodes = Array.from({ length: 4096 }, (_, i) => `${10 + i} 0 R`).join(' ')
    const objects: Obj[] = [
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: `<< /Type /Pages /Kids 9 0 R /Count 1 /Resources << /Font ${FONTS} >> >>` },
      { num: 3, body: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>' },
      { num: 4, body: '<< >>', stream: 'BT /F1 12 Tf 72 700 Td (Hello) Tj ET', flate: true },
      { num: 9, body: `[3 0 R ${nodes} ${'0 '.repeat(1_900_000 - 4097)}]` },
      ...Array.from({ length: 4096 }, (_, i) => ({ num: 10 + i, body: '<< /Type /Pages /Kids 9 0 R /Count 1 >>' }))
    ]
    const { doc, t } = await read(buildPdf(objects))
    // 8,192 elements examined, not one pass of the array per node on the stack.
    expect(WORK_BUDGET - doc.work.left).toBeLessThan(10_000)
    expect(t.pages.map((p) => p.text)).toEqual(['Hello'])
    expect(note(t, 'The page tree was followed only through its first 8192 entries')).toBeDefined()
  })
})

describe('readPageText: caps', () => {
  it('reads the first 500 of 600 pages', async () => {
    const { t } = await read(manyPages(Array.from({ length: 600 }, () => 'BT /F1 12 Tf (p) Tj ET')))
    expect(t.pages).toHaveLength(500)
    expect(t.pages[499]).toMatchObject({ number: 500, text: 'p' })
    expect(note(t, 'Text was read from the first 500 pages only; the document declares 600.')).toBeDefined()
  })

  it('keeps 20,000 characters of a 1,000,000-character string', async () => {
    const { doc, t } = await read(onePage(`BT /F1 12 Tf 72 700 Td (${'x'.repeat(1_000_000)}) Tj ET`))
    const page = t.pages[0]
    // About a step per byte lexed and per code shown: the codes past the cap are walked once each.
    expect(WORK_BUDGET - doc.work.left).toBeLessThan(3_000_000)
    expect(page).toMatchObject({ textCut: true, hiddenCut: false })
    // The cut is marked past the cap: a GAP is not text.
    expect(page.text).toBe(`${'x'.repeat(20_000)}${GAP}`)
    expect(note(t, 'The text or invisible text of page(s) 1 ran past 20000 characters')).toBeDefined()
  })

  it('marks the cut of a string longer than 1 MiB, whose codes draw no text that counts toward the cap', async () => {
    const fonts = '<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 5 0 R >> >>'
    const pad = '\x01'.repeat(2 ** 20 - 32)
    const url = 'https://login.microsoftonline.com.evil-host.test/owa'
    const hex = (s: string): string => Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    for (const shown of [`(${pad}${url}) Tj`, `<${hex(pad + url)}> Tj`, `[(${pad}${url})] TJ`]) {
      const { page, t } = await firstPage(`BT /F1 12 Tf 72 700 Td (Sign in at ) Tj ${shown} ET`, fonts, [
        toUnicode(5, '1 beginbfchar <01> <> endbfchar')
      ])
      // The lexer kept the first MiB: the address stops there, after `.co`.
      expect(page).toMatchObject({ text: `Sign in at https://login.microsoftonline.co${GAP}`, unread: 1 })
      expect(note(t, '1 string(s) the pages draw are longer than 1 MiB')).toBeDefined()
    }
  })

  it('says which buffer stopped, so invisible filler does not cut the visible line', async () => {
    const { page } = await firstPage(
      `BT /F1 12 Tf 72 700 Td (go https://lure.test/x) Tj 3 Tr 0 -20 Td (${'h'.repeat(25_000)}) Tj ET`
    )
    expect(page).toMatchObject({ text: 'go https://lure.test/x', textCut: false, hiddenCut: true })
    expect(page.hidden).toBe(`${'h'.repeat(20_000)}${GAP}`)
  })

  it('says which buffer the fair share trimmed', async () => {
    const page = `BT /F1 12 Tf 72 700 Td (seen) Tj 3 Tr 0 -20 Td (${'h'.repeat(20_000)}) Tj ET`
    const { t } = await read(manyPages([page, page, page, page]))
    expect(note(t, 'Page text was cut to 60000 characters')).toBeDefined()
    for (const p of t.pages) {
      expect(p).toMatchObject({ text: 'seen', textCut: false, hiddenCut: true })
      expect(p.hidden.endsWith(`h${GAP}`)).toBe(true)
    }
  })

  it('flags a cap only where it splits a word, so a whole last link is still read', async () => {
    // The link ends at the 20,000th character and more words follow: the cap falls between them.
    const url = 'https://exact-lure.test/pay'
    const { page, t } = await firstPage(
      `BT /F1 12 Tf 72 700 Td (${'x'.repeat(20_000 - url.length - 1)} ${url}) Tj ( more words after) Tj ET`
    )
    expect(page.text.endsWith(` ${url}`)).toBe(true)
    expect(page).toMatchObject({ textCut: false, hiddenCut: false })
    expect(page.text).not.toContain(GAP)
    // Still said: the page ran past the cap.
    expect(note(t, 'The text or invisible text of page(s) 1 ran past 20000 characters')).toBeDefined()
    // Nor where the cap falls on the break before a glyph not decoded, which would be marked.
    const glyph = await firstPage(
      `BT /F1 12 Tf 72 700 Td (${'x'.repeat(20_000 - url.length - 1)} ${url}) Tj 0 -20 Td (\\000x) Tj ET`
    )
    expect(glyph.page.text).toBe(`${'x'.repeat(20_000 - url.length - 1)} ${url}`)

    // The cap splits the y's; the fair share then trims the page to 19,990, between words. What it
    // ends in is that cut, whatever the cap split.
    const junk = `BT /F1 12 Tf 72 700 Td (${'x'.repeat(20_000)}) Tj ET`
    const shared = await read(
      manyPages([
        `BT /F1 12 Tf 72 700 Td (${'x'.repeat(19_990)} ${'y'.repeat(9_000)}) Tj ET`,
        junk,
        junk,
        'BT /F1 12 Tf 72 700 Td (lure https://pay-lure.test/x) Tj ET'
      ])
    )
    expect(note(shared.t, 'Page text was cut to 60000 characters')).toContain('up to its first 19990 characters')
    expect(shared.t.pages[0]).toMatchObject({ text: 'x'.repeat(19_990), textCut: false })
  })

  it('shares 60,000 characters evenly, so three pages of filler cannot push out the lure', async () => {
    const junk = `BT /F1 12 Tf 72 700 Td (${'x'.repeat(20_000)}) Tj ET`
    const { t } = await read(
      manyPages([junk, junk, junk, 'BT /F1 12 Tf 72 700 Td (lure https://pay-lure.test/x) Tj ET'])
    )
    const [a, b, c, lure] = t.pages
    expect(lure).toMatchObject({ text: 'lure https://pay-lure.test/x', textCut: false, hiddenCut: false })
    expect(a).toMatchObject({ textCut: true, hiddenCut: false })
    // Each cut inside the x's, and marked there.
    for (const p of [a, b, c]) expect(p.text).toBe(`${'x'.repeat(19_990)}${GAP}`)
    const kept = t.pages.reduce((n, p) => n + p.text.replaceAll(GAP, '').length + p.hidden.length, 0)
    expect(kept).toBeLessThanOrEqual(60_000)
    expect(note(t, 'Page text was cut to 60000 characters')).toContain('up to its first 19990 characters')
    expect(note(t, 'The text or invisible text')).toBeUndefined()
  })

  it('marks where a decode lost its end, keeping the text before it', async () => {
    // One address in two runs, padded so the stream decodes to its 4 MiB six
    // bytes into the second, `(m.evi`, which never closes. Read as whole, the
    // first run would name `https://login.microsoftonline.co`, a host the file
    // does not; marked, phish.ts leaves it out of the indicators.
    const head = 'BT /F1 12 Tf 72 700 Td (Sign in at ) Tj '
    const a = '(https://login.microsoftonline.co) Tj '
    const b = '(m.evil-split.test/owa) Tj ET'
    const cut = `${head}${' '.repeat(4 * 2 ** 20 - head.length - a.length - 6)}${a}${b}`
    const whole = await firstPage(head + a + b)
    expect(whole.page.text).toBe('Sign in at https://login.microsoftonline.com.evil-split.test/owa')
    const one = await firstPage(cut)
    // Not flagged cut as well: no cap split it.
    expect(one.page).toMatchObject({ text: `Sign in at https://login.microsoftonline.co${GAP}`, textCut: false })
    expect(note(one.t, 'The drawing instructions of page(s) 1 could not all be read')).toBeDefined()

    // The cut piece first of two: the next piece's text, on a line of its own, starts from a mark too.
    const two = await read(
      pieces([
        { body: '<< >>', stream: cut, flate: true },
        { body: '<< >>', stream: 'BT /F1 12 Tf 72 500 Td (Your invoice is attached) Tj ET', flate: true }
      ])
    )
    expect(two.t.pages[0].text).toBe(
      `Sign in at https://login.microsoftonline.co${GAP}\n${GAP}Your invoice is attached`
    )

    // A form cut the same way: what follows it starts from a mark too, after its line break.
    const xobject = `<< /Font ${FONTS} /XObject << /X 5 0 R >> >>`
    const draw = 'BT /F1 12 Tf 72 700 Td (before) Tj ET /X Do BT /F1 12 Tf 72 600 Td (after) Tj ET'
    const inForm = await read(withResources(draw, xobject, [form(5, cut)]))
    expect(inForm.t.pages[0].text).toBe(`before\nSign in at https://login.microsoftonline.co${GAP}\n${GAP}after`)

    // A whole lure, then padding past the cap: kept, and marked too, since a
    // file can go on with the same word after any amount of padding.
    const pad = ' '.repeat(4 * 2 ** 20)
    const padded = await firstPage(`BT /F1 12 Tf 72 700 Td (Pay at https://pad-lure.test/pay) Tj ET${pad}`)
    expect(padded.page).toMatchObject({ text: `Pay at https://pad-lure.test/pay${GAP}`, unread: 1 })

    // Not marked: a last word a form's line break closed, and one the 20,000 cap was seen to stop after.
    const closed = await read(
      withResources(`/X Do${pad}`, xobject, [form(5, 'BT /F1 12 Tf (https://form.test/x) Tj ET')])
    )
    expect(closed.t.pages[0].text).toBe('https://form.test/x')
    const url = 'https://exact-lure.test/pay'
    const atCap = await firstPage(
      `BT /F1 12 Tf 72 700 Td (${'x'.repeat(20_000 - url.length - 1)} ${url}) Tj ( more) Tj ET${pad}`
    )
    expect(atCap.page.text.endsWith(` ${url}`)).toBe(true)
    expect(atCap.page).toMatchObject({ textCut: false, unread: 1 })
  })

  it('reads a stream whose /Length is missing or wrong up to its endstream, with nothing marked missing', async () => {
    const content = 'BT /F1 12 Tf 72 700 Td (Pay at https://length-lure.test/pay) Tj ET'
    for (const length of ['', '/Length 5', '/Length 9 0 R']) {
      const { t } = await read(
        buildPdf([
          { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
          { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
          { num: 3, body: `<< /Type /Page /Parent 2 0 R /Resources << /Font ${FONTS} >> /Contents 4 0 R >>` },
          { num: 4, body: '', raw: `4 0 obj\n<< ${length} >>\nstream\n${content}\nendstream\nendobj\n` }
        ])
      )
      expect(t.pages[0]).toMatchObject({ text: 'Pay at https://length-lure.test/pay', unread: 0 })
      expect(note(t, 'The drawing instructions')).toBeUndefined()
    }
  })

  it('marks every other place the drawing was not all read, on both sides', async () => {
    const head = 'BT /F1 12 Tf 72 700 Td (Sign in at ) Tj '
    const a = '(https://login.microsoftonline.co) Tj '
    const b = '(m.evil-split.test/owa) Tj ET'
    const split = `Sign in at https://login.microsoftonline.co${GAP}`
    const flate = (stream: string): Omit<Obj, 'num'> => ({ body: '<< >>', stream, flate: true })
    const lzw: Omit<Obj, 'num'> = { body: '<< /Filter /LZWDecode >>', stream: 'x'.repeat(40) }
    const after = flate('BT /F1 12 Tf 150 700 Td (soft.com/owa) Tj ET')
    const blanks = Array.from({ length: 1022 }, () => ({ body: '<< >>', stream: ' ' }))
    const xobject = `<< /Font ${FONTS} /XObject << /X 9 0 R >> >>`
    const cases: [string, Uint8Array, string][] = [
      ['a value nested past 64', pieces([flate(`${head}${a}${'['.repeat(70)}${']'.repeat(70)} ${b}`)]), split],
      ['1,000,000 values between two operators', pieces([flate(`${head}${a}[${'[] '.repeat(300_000)}] ${b}`)]), split],
      ['an unsupported filter', pieces([flate(head + a), lzw]), split],
      [
        'a predictor',
        pieces([flate(head + a), { ...flate(b), body: '<< /DecodeParms << /Predictor 12 >> >>' }]),
        split
      ],
      ['a piece that is not a stream', pieces([flate(head + a), { body: '42' }]), split],
      ['the piece past 1,024', pieces([flate(head), ...blanks, flate(a), flate(b)]), split],
      // The word after a gap, where the file draws `https://login-micro` + `soft.com/owa`.
      ['an unread piece before the text', pieces([lzw, after]), `${GAP}soft.com/owa`],
      [
        'a decode cut inside a run, the next piece drawn straight on',
        pieces([
          flate(`${head}${' '.repeat(4 * 2 ** 20 - head.length - a.length - 6)}${a}${b}`),
          flate('(l-split.com/owa) Tj ET')
        ]),
        `${split}l-split.com/owa`
      ],
      [
        "an unread piece after a form's line break, which closes the word before it, not the one after",
        pieces([flate('/X Do'), lzw, after], xobject, [form(9, 'BT /F1 12 Tf (https://form.test/x) Tj ET')]),
        `https://form.test/x\n${GAP}soft.com/owa`
      ]
    ]
    for (const [name, file, text] of cases) {
      const { t } = await read(file)
      expect([name, t.pages[0].text]).toEqual([name, text])
      expect([name, t.pages[0].unread > 0]).toEqual([name, true])
    }
  })

  it('gives the reason for a content piece found but not a stream', async () => {
    const { t } = await read(
      pieces([
        { body: '<< >>', stream: 'BT /F1 12 Tf 72 700 Td (Pay at https://one-lure.test/pay) Tj ET', flate: true },
        { body: '<< /Length 0 >>' }
      ])
    )
    expect(t.pages[0].unread).toBe(1)
    expect(note(t, 'The drawing instructions of page(s) 1 could not all be read')).toBeDefined()
    expect(note(t, '1 content stream(s), font(s) or form(s) the pages name were not found')).toBeDefined()
  })

  it('takes a string that draws no text as nothing at all, beside a gap too', async () => {
    // Helvetica's codes are 500 units wide here, so each run starts where the
    // one before ends: a reader draws one address.
    const first = 'Sign in at https://login.microsoftonline.co'
    const at = (k: number): string => `1 0 0 1 ${72 + k * 6} 700 Tm`
    const second = `BT /F1 12 Tf ${at(first.length)} (m.evil-split.com/owa) Tj ET`
    const fonts = `<< /F1 ${HELVETICA} /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 5 0 R >> >>`
    const cmap = toUnicode(5, '1 beginbfchar <01> <> endbfchar')
    for (const empty of ['() Tj', '[()] TJ', '/F2 12 Tf <01> Tj']) {
      const { page } = await firstPage(
        `BT /F1 12 Tf 72 700 Td (${first}) Tj ET BT /F1 12 Tf 10 10 Td ${empty} ET ${second}`,
        fonts,
        [cmap]
      )
      expect([empty, page.text]).toEqual([empty, 'Sign in at https://login.microsoftonline.com.evil-split.com/owa'])
    }

    // `m.evil-` in a piece this reader skips, then `host.com/owa`.
    const flate = (stream: string): Omit<Obj, 'num'> => ({ body: '<< >>', stream, flate: true })
    const skipped = {
      ...flate(`BT /F1 12 Tf ${at(first.length)} (m.evil-) Tj ET`),
      body: '<< /DecodeParms << /Predictor 12 >> >>'
    }
    const host = (before: string): Omit<Obj, 'num'> =>
      flate(`BT /F1 12 Tf ${before} ${at(first.length + 7)} (host.com/owa) Tj ET`)
    const cases: [string, Omit<Obj, 'num'>[], string][] = [
      // An empty string after the gap does not use it up: the space the
      // missing run leaves is written, and the word after it marked too.
      [
        'after',
        [flate(`BT /F1 12 Tf 72 700 Td (${first}) Tj ET`), skipped, host('() Tj')],
        `${GAP} ${GAP}host.com/owa`
      ],
      // One before it does not stand in for a break that closes the word.
      ['before', [flate(`BT /F1 12 Tf 72 700 Td (${first}) Tj 0 -300 Td () Tj ET`), skipped], GAP],
      // A space alone does not close a word after a gap either: what was not read may be drawn anywhere.
      [
        'space',
        [flate(`BT /F1 12 Tf 72 700 Td (${first}) Tj ET`), skipped, host('( ) Tj')],
        `${GAP}\n\n${GAP}host.com/owa`
      ]
    ]
    for (const [name, streams, text] of cases) {
      const { t } = await read(pieces(streams))
      expect([name, t.pages[0].text]).toEqual([name, first + text])
    }
  })

  it('marks a glyph this reader cannot decode on both sides, not one the file maps to U+FFFD', async () => {
    const named = `<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+Helvetica /Encoding << /BaseEncoding /WinAnsiEncoding /Differences [109 /g109] >> >> >>`
    // `m` drawn by a glyph name with no meaning. Read as one address, the
    // page would name the host secure.paypal.co, which the file does not.
    const lure = await firstPage(
      'BT /F1 12 Tf 72 700 Td (Verify at https://secure.paypal.com.verify-acct.net/login) Tj ET',
      named
    )
    expect(lure.page).toMatchObject({
      text: `Verify at https://secure.paypal.co${GAP}�${GAP}.verify-acct.net/login`,
      undecoded: 1,
      unread: 0
    })
    // A run takes one mark on each side, and none where a space or the text's start is beside it.
    const run = await firstPage('BT /F1 12 Tf 72 700 Td (mmx ymmy mm) Tj ( mx) Tj ET', named)
    expect(run.page.text).toBe(`��${GAP}x y${GAP}��${GAP}y �� �${GAP}x`)
    // The file's own U+FFFD is its claim, read as it is.
    const mapped = await firstPage(
      'BT /F1 12 Tf 72 700 Td (a\\001b) Tj ET',
      '<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 5 0 R >> >>',
      [toUnicode(5, '1 beginbfchar <01> <FFFD> endbfchar')]
    )
    expect(mapped.page).toMatchObject({ text: 'a�b', undecoded: 0 })
  })

  it('reads a name a read /XObject dict lacks as drawing nothing, and marks no word before a form not run', async () => {
    const lure = 'BT /F1 12 Tf 72 700 Td (Pay at https://one-lure.test/pay) Tj ET'
    const lzw: Obj = {
      num: 5,
      body: '<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Filter /LZWDecode >>',
      stream: 'x'.repeat(40)
    }
    const resources = `<< /Font ${FONTS} /XObject << /L 5 0 R /M 9 0 R >> >>`
    // No reader draws anything for /N: nothing is missing, so nothing is marked, and the lines stay apart.
    const absent = await read(
      withResources(
        'BT /F1 12 Tf 72 700 Td (https://a-lure.test/1) Tj /N Do 0 -20 Td (https://b-lure.test/2) Tj /N Do ET',
        resources,
        [lzw]
      )
    )
    expect(absent.t.pages[0]).toMatchObject({ text: 'https://a-lure.test/1\nhttps://b-lure.test/2', unread: 0 })
    expect(note(absent.t, '2 content stream(s), font(s) or form(s) the pages name were not found')).toBeDefined()
    // Nor for a /Resources dict with no /XObject at all.
    const none = await read(
      withResources(
        'BT /F1 12 Tf 72 700 Td (https://a-lure.test/1) Tj /N Do 0 -20 Td (https://b-lure.test/2) Tj ET',
        `<< /Font ${FONTS} >>`
      )
    )
    expect(none.t.pages[0]).toMatchObject({ text: 'https://a-lure.test/1\nhttps://b-lure.test/2', unread: 0 })

    // A form not decoded, or not found: its text would start on a line of its own, so the lure before it is whole.
    for (const name of ['L', 'M']) {
      const { t } = await read(withResources(`${lure} /${name} Do`, resources, [lzw]))
      expect([name, t.pages[0]]).toMatchObject([name, { text: 'Pay at https://one-lure.test/pay', unread: 1 }])
    }
    // But it may draw nothing, so text drawn straight on from the lure starts from a mark, touching both.
    const first = 'Sign in at https://login.microsoftonline.co'
    const { t } = await read(
      withResources(
        `BT /F1 12 Tf 72 700 Td (${first}) Tj ET /L Do BT /F1 12 Tf 1 0 0 1 ${72 + first.length * 6} 700 Tm (m.evil-split.com/owa) Tj ET`,
        resources,
        [lzw]
      )
    )
    expect(t.pages[0].text).toBe(`${first}${GAP}m.evil-split.com/owa`)
  })

  it('takes a form that writes nothing to a buffer as no break in it', async () => {
    // Helvetica's codes are 500 units wide here, so the second run starts
    // where the first ends: a reader draws one address.
    const first = 'Sign in at https://login.microsoftonline.co'
    const second = `BT /F1 12 Tf 1 0 0 1 ${72 + first.length * 6} 700 Tm (m.evil-split.com/owa) Tj ET`
    const resources = `<< /Font ${FONTS} /XObject << /E 5 0 R /H 6 0 R >> >>`
    const { t } = await read(
      withResources(`BT /F1 12 Tf 72 700 Td (${first}) Tj ET /E Do /H Do ${second}`, resources, [
        form(5, ''),
        form(6, 'BT 3 Tr /F1 12 Tf (secret) Tj ET')
      ])
    )
    // The second form writes to the invisible text only.
    expect(t.pages[0]).toMatchObject({
      text: 'Sign in at https://login.microsoftonline.com.evil-split.com/owa',
      hidden: 'secret',
      unread: 0
    })
  })

  it("marks both sides where a form's text goes straight on from the page's, either way round", async () => {
    // Its line break is this reader's, not the page's: a reader draws one address here.
    const first = 'Sign in at https://login.microsoftonline.co'
    const at = (k: number, y = 700): string => `1 0 0 1 ${72 + k * 6} ${y} Tm`
    const run = (pos: string, s: string): string => `BT /F1 12 Tf ${pos} (${s}) Tj ET`
    const xobject = `<< /Font ${FONTS} /XObject << /X 5 0 R >> >>`
    const page = async (content: string, inForm: string): Promise<string> =>
      (await read(withResources(content, xobject, [form(5, inForm)]))).t.pages[0].text
    const split = `${first}${GAP}\n${GAP}m.evil-split.test/owa`
    expect(await page(`${run(at(0), first)} /X Do`, run(at(first.length), 'm.evil-split.test/owa'))).toBe(split)
    expect(await page(`/X Do ${run(at(first.length), 'm.evil-split.test/owa')}`, run(at(0), first))).toBe(split)
    // A form on the next line, or after a space, cuts no word.
    const whole = 'Sign in at https://login.microsoftonline.com'
    expect(await page(`${run(at(0), whole)} /X Do`, run(at(0, 680), 'https://form-lure.test/x'))).toBe(
      `${whole}\nhttps://form-lure.test/x`
    )
    expect(await page(`${run(at(0), whole)} /X Do`, run(at(whole.length + 1), 'now'))).toBe(`${whole}\nnow`)
  })

  it('shows a GAP a file writes as U+FFFD, so only this reader marks one', async () => {
    const fonts = `<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 5 0 R >> /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Differences [65 /uniE000] >> >> /F3 << /Type /Font /Subtype /Type0 /BaseFont /CID /Encoding /UniJIS-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType2 /BaseFont /CID /DW 500 >>] >> >>`
    const { page } = await firstPage(
      'BT /F1 12 Tf 72 700 Td (a\\001b) Tj /F2 12 Tf (cAd) Tj /F3 12 Tf <0065E0000066> Tj ET',
      fonts,
      [toUnicode(5, '1 beginbfchar <01> <E000> endbfchar')]
    )
    expect(page).toMatchObject({ text: 'a�bc�de�f', undecoded: 0, unread: 0 })
  })

  it('marks the word the work budget runs out in, in a form too', async () => {
    const address = `(https://login.microsoftonline.com.${'a'.repeat(15_000)}.evil.test/) Tj`
    const onPage = onePage(`BT /F1 12 Tf 72 700 Td (Sign in at ) Tj ${address} ET`)
    // A form's line break after its text is not set on the way out, where it would read as closing the word.
    const inForm = withResources('/X Do', '<< /XObject << /X 5 0 R >> >>', [
      form(5, `BT /F1 12 Tf (Sign in at ) Tj ${address} ET`)
    ])
    for (const file of [onPage, inForm]) {
      const spent = WORK_BUDGET - (await read(file)).doc.work.left
      // 3,000 steps short of the whole read: inside the address, whose codes are the last 15,000 or so.
      const doc = await openPdf(file, latin1(file), { left: 1e9 }, { left: spent - 3_000 })
      const t = await readPageText(doc)
      expect(doc.workSpent).toBe('work')
      const text = t.pages[0].text
      expect(text.startsWith('Sign in at https://login.microsoftonline.com.aaa')).toBe(true)
      expect(text.endsWith(`a${GAP}`)).toBe(true)
      expect(t.pages[0].textCut).toBe(false)
    }
  })

  it('bounds hostile CMaps and width tables', async () => {
    const fonts = Array.from(
      { length: 20 },
      (_, i) => `/F${i} << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode ${10 + i} 0 R >>`
    )
    const maps = Array.from({ length: 20 }, (_, i) =>
      toUnicode(10 + i, '1 beginbfrange <0000> <FFFF> <0041> endbfrange')
    )
    const content = `BT 72 700 Td ${fonts.map((_, i) => `/F${i} 12 Tf (A) Tj`).join(' ')} ET`
    // Counted, not timed: a step per entry kept, so the caps show in the work spent.
    const twenty = await read(onePage(content, { fonts: `<< ${fonts.join(' ')} >>`, extra: maps }))
    expect(WORK_BUDGET - twenty.doc.work.left).toBeLessThan(262_144 + 20 * 256 + 20_000)
    expect(note(twenty.t, "A font's /ToUnicode map was larger")).toBeDefined()
    // Four maps of 65,536 fill the file's 262,144; the other sixteen keep only
    // the 256 entries every font is owed, which still map the one code drawn.
    expect(twenty.t.pages[0]).toMatchObject({ text: '\u0082'.repeat(20), undecoded: 0 })

    // A small map of an ordinary font, read after others spent the file's total, still reads.
    const big = Array.from(
      { length: 4 },
      (_, i) => `/C${i} << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode ${40 + i} 0 R >>`
    )
    const bigMaps = Array.from({ length: 4 }, (_, i) =>
      toUnicode(40 + i, '1 beginbfrange <0000> <FFFF> <0000> endbfrange')
    )
    const latin =
      '/L << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 50 0 R >>'
    const late = await read(
      onePage(
        `BT 72 700 Td ${big.map((_, i) => `/C${i} 12 Tf (A) Tj`).join(' ')} ET BT 72 600 Td /L 12 Tf (Pay at https://evil.example/login) Tj ET`,
        {
          fonts: `<< ${big.join(' ')} ${latin} >>`,
          extra: [...bigMaps, toUnicode(50, '1 beginbfrange <20> <7E> <0020> endbfrange')]
        }
      )
    )
    expect(late.t.pages[0].text.split('\n').at(-1)).toBe('Pay at https://evil.example/login')

    const huge = await read(
      onePage('BT /F1 12 Tf 72 700 Td (A) Tj ET', {
        fonts: '<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 5 0 R >> >>',
        extra: [toUnicode(5, '1 beginbfrange <00000000> <FFFFFFFF> <0041> endbfrange')]
      })
    )
    // 65,536 entries, not 2 ** 32.
    expect(WORK_BUDGET - huge.doc.work.left).toBeLessThan(65_536 + 20_000)
    expect(note(huge.t, "A font's /ToUnicode map was larger")).toBeDefined()

    // A code the map may hold past the cap is not read through the encoding, which says `n` where it says `m`.
    const lure = 'Verify at https://secure.paypal.con.verify-acct.net/login'
    const past = await firstPage(
      `BT /F1 12 Tf 72 700 Td (${lure}) Tj ET`,
      '<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 5 0 R >> >>',
      [
        toUnicode(
          5,
          '2 beginbfrange <0100> <FFFF> <0041> <010000> <0100FF> <0041> endbfrange 1 beginbfchar <6E> <006D> endbfchar'
        )
      ]
    )
    expect(past.page).toMatchObject({ text: '�'.repeat(lure.length), undecoded: lure.length })

    // An empty codespace range is dropped, so the codes take the Type0 default of 2 bytes.
    const empty = await firstPage(
      'BT /F1 12 Tf 72 700 Td <00410042> Tj ET',
      type0('/Custom-H').replace('>> >>', '/ToUnicode 5 0 R >> >>'),
      [
        toUnicode(
          5,
          '1 begincodespacerange <> <> endcodespacerange 2 beginbfchar <0041> <0041> <0042> <0042> endbfchar'
        )
      ]
    )
    expect(empty.page.text).toBe('AB')

    const widths = await firstPage(
      'BT /F1 12 Tf 72 700 Td <0001> Tj ET',
      type0('/Identity-H', '/W [100000000000000000000 100000000000000000001 500]')
    )
    expect(widths.page.text).toBe('�')
  })

  it('reads a page whose contents list 100,000 references to one 4 MiB stream within bounds', async () => {
    const big = `BT /F1 12 Tf 72 700 Td (real) Tj ET${' '.repeat(4 * 2 ** 20 - 40)}`
    const refs = Array.from({ length: 100_000 }, () => '4 0 R').join(' ')
    const file = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { num: 3, body: `<< /Type /Page /Parent 2 0 R /Resources << /Font ${FONTS} >> /Contents [${refs}] >>` },
      { num: 4, body: '<< >>', stream: big, flate: true }
    ])
    const { doc, t } = await read(file)
    expect(t.pages[0].text).toContain('real')
    expect(note(t, 'Page(s) 1 list more than 1024 content streams')).toBeDefined()
    // 64 Mi steps of work is about sixteen 4 MiB pieces.
    expect(doc.workSpent).toBe('work')
  })

  it('checks the deadline before every form run, though the form decodes once', async () => {
    // A clock that runs on work, so the test reads no real time: the deadline
    // passes once 1,000,000 steps are spent, five runs of this form in.
    const work: Work = {
      left: WORK_BUDGET,
      get until() {
        return WORK_BUDGET - this.left > 1_000_000 ? 0 : Infinity
      }
    }
    const file = withResources('/X Do '.repeat(1999), '<< /XObject << /X 5 0 R >> >>', [
      form(5, `BT /F1 12 Tf (${'x'.repeat(100_000)}) Tj ET`)
    ])
    const doc = await openPdf(file, latin1(file), { left: 1e9 }, work)
    await readPageText(doc)
    expect(doc.workSpent).toBe('time')
    // Stopped within a run of the deadline, not 1,999 runs and 64 Mi steps later.
    expect(WORK_BUDGET - work.left).toBeLessThan(2_000_000)
  })

  it('charges each code by the codespace ranges it is matched against', async () => {
    // 64 one-byte ranges A never falls in: every A is tried against all 64.
    const ranges = Array.from({ length: 64 }, (_, k) => `<${(0x80 + k).toString(16)}> <${(0x80 + k).toString(16)}>`)
    const cmap: Obj = {
      num: 5,
      body: '<< /Type /CMap >>',
      stream: `begincmap 64 begincodespacerange ${ranges.join(' ')} endcodespacerange endcmap`,
      flate: true
    }
    const { doc, t } = await read(
      onePage(`BT /F1 12 Tf 72 700 Td (${'A'.repeat(10_000)}) Tj ET`, { fonts: type0('5 0 R'), extra: [cmap] })
    )
    expect(t.pages[0].undecoded).toBe(10_000)
    // Charged 1 a code, 64 ranges made each step about 20 times slower than the budget assumes.
    expect(WORK_BUDGET - doc.work.left).toBeGreaterThan(65 * 10_000)
  })
})

describe('readPageText: hostile operands', () => {
  it('reads past 3,000,000 operands', async () => {
    const operands = '1 '.repeat(1_500_000)
    const file = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { num: 3, body: `<< /Type /Page /Parent 2 0 R /Resources << /Font ${FONTS} >> /Contents [4 0 R 5 0 R 6 0 R] >>` },
      { num: 4, body: '<< >>', stream: `BT /F1 12 Tf 72 700 Td ${operands}`, flate: true },
      { num: 5, body: '<< >>', stream: operands, flate: true },
      { num: 6, body: '<< >>', stream: '(ok) Tj ET', flate: true }
    ])
    const started = performance.now()
    const { t } = await read(file)
    // A loose ceiling, not a speed test: what it catches is an operand stack
    // that turned quadratic, which would take minutes. Alone this takes about
    // 0.15 s, and under a loaded full run about 1.6 s.
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(t.pages[0]).toMatchObject({ text: 'ok', unread: 0 })
  })

  it('stops a piece holding a 2,000,000-element TJ array and reads the next piece', async () => {
    const file = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { num: 3, body: `<< /Type /Page /Parent 2 0 R /Resources << /Font ${FONTS} >> /Contents [4 0 R 5 0 R] >>` },
      { num: 4, body: '<< >>', stream: `BT /F1 12 Tf 72 700 Td [${'0 '.repeat(2_000_000)}] TJ`, flate: true },
      { num: 5, body: '<< >>', stream: 'ET BT (ok) Tj ET', flate: true }
    ])
    const { t } = await read(file)
    // What the rest of the first piece drew is missing in front of `ok`.
    expect(t.pages[0]).toMatchObject({ text: `${GAP}ok`, unread: 1 })
    expect(note(t, '1 content stream(s) held a value this reader could not parse')).toBeDefined()
  })

  it('reads page 2 after page 1 never closes a string', async () => {
    const { t } = await read(manyPages(['BT /F1 12 Tf 72 700 Td (never closed', 'BT /F1 12 Tf 72 700 Td (two) Tj ET']))
    expect(t.pages.map((p) => [p.text, p.unread])).toEqual([
      ['', 1],
      ['two', 0]
    ])
    expect(note(t, 'The drawing instructions of page(s) 1 could not all be read')).toBeDefined()
  })
})

describe('readPageText: real writers', () => {
  it('reads the Quartz shape: one positioned line per block, a MacRoman TrueType font, a /Length by reference', async () => {
    const lines = [
      'Your invoice is ready.',
      'Visit https://pay-lure.com/inv to view it.',
      'A very long address https://login.microsoftonline-verify-account-security.com/co',
      'mmon/oauth2/authorize?client_id=abcdef0123456789&redirect=x'
    ]
    const content = lines
      .map(
        (line, i) =>
          `q 1 0 0 1 16.6 0 cm BT 0.0001 Tc 12 0 0 12 0 ${763.284 - 12 * i} Tm /TT1 1 Tf (${line.padEnd(80)}) Tj ET Q`
      )
      .join('\n')
    const used = new Set(
      lines
        .join('')
        .split('')
        .map((c) => c.charCodeAt(0))
    )
    const widths = Array.from({ length: 95 }, (_, i) => (used.has(i + 32) || i === 0 ? 600 : 0))
    const data = latin1(zlib(content))
    const file = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /TT1 5 0 R >> >> /Contents 4 0 R >>' },
      {
        num: 4,
        body: '',
        raw: `4 0 obj\n<< /Length 7 0 R /Filter /FlateDecode >>\nstream\n${data}\nendstream\nendobj\n`
      },
      {
        num: 5,
        body: `<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAB+Monaco /FontDescriptor 6 0 R /Encoding /MacRomanEncoding /FirstChar 32 /LastChar 126 /Widths [${widths.join(' ')}] >>`
      },
      { num: 6, body: '<< /Type /FontDescriptor /FontName /AAAAAB+Monaco /Flags 32 >>' },
      { num: 7, body: String(data.length) }
    ])
    const { t } = await read(file)
    expect(t.pages[0]).toMatchObject({ text: lines.join('\n'), assumed: 0, undecoded: 0, unread: 0 })
  })

  it('reads a real CUPS/Quartz text PDF', async () => {
    const { t } = await read(fixture('cups-text.pdf'))
    expect(t.pages).toHaveLength(1)
    const page = t.pages[0]
    expect(page).toMatchObject({ number: 1, unread: 0, undecoded: 0, assumed: 0 })
    expect(page.text.split('\n').slice(0, 7)).toEqual([
      'Microsoft 365 - Action required',
      '',
      'Your mailbox storage is full. Verify your account within 24 hours at https://log',
      'in-m1crosoft365.example.com/verify',
      'Call the helpdesk on +1 (800) 555-0199 or email support@helpdesk-m365.example.ne',
      't',
      'Reference: INV-2026-0931'
    ])
  })

  it('reads a real Quartz lure: link annotation mapped, a Japanese line with no /ToUnicode reported, not shown as text', async () => {
    const { doc, t } = await read(fixture('quartz-lure.pdf'))
    expect(t.pageCount).toBe(2)
    const [one, two] = t.pages
    const lines = one.text.split('\n')
    expect(lines.slice(0, 4)).toEqual([
      'DocuSign — Please review',
      'You have received a document Invoice_Q3_2026.pdf from Accounts Payable.',
      'REVIEW DOCUMENT',
      'Questions? Call +44 20 7946 0958 or write to billing@acme-invoices.example.com'
    ])
    // The Hiragino line: Identity-H with no /ToUnicode, so nothing in it is guessed at.
    expect(lines[4]).toMatch(/^�+$/)
    expect(one.undecoded).toBe(lines[4].length)
    expect(note(t, `${one.undecoded} character(s) on page(s) 1 are drawn in fonts with no /ToUnicode`)).toBeDefined()
    expect(two).toMatchObject({
      number: 2,
      text: 'Page two: your account will be suspended in 24 hours.',
      undecoded: 0
    })
    expect(t.annotPages.get(doc.objects.get(9)?.value as PdfDict)).toBe(1)
  })
})
