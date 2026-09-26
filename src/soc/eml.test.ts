import { describe, expect, it } from 'vitest'
import { latin1Bytes, parseEml, withoutLeadingBlankLines } from './eml'

const b64 = (s: string): string => btoa(s)

const MAIL = `From: "Billing" <billing@paypa1.test>
To: analyst@corp.test
Subject: =?utf-8?B?SW52b2ljZQ==?=
Content-Type: multipart/mixed; boundary="OUTER"

This is the MIME preamble and should be dropped.
--OUTER
Content-Type: multipart/alternative; boundary="INNER"

--INNER
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

Please review the invoice at https://paypa1.test/pay=
ment
--INNER
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: base64

${b64('<html><body><img src="http://track.example/p.gif"><a href="http://evil.test/go">https://paypal.test/account</a></body></html>')}
--INNER--
--OUTER
Content-Type: application/vnd.ms-word.document.macroEnabled.12; name="invoice.docm"
Content-Disposition: attachment; filename="invoice.docm"
Content-Transfer-Encoding: base64

${b64('macro payload here')}
--OUTER--
Epilogue text after the close.
`

describe('parseEml', () => {
  const eml = parseEml(MAIL)

  it('walks nested multiparts and drops preamble and epilogue', () => {
    expect(eml.text).toContain('https://paypa1.test/payment') // soft line break joined
    expect(eml.text).not.toContain('preamble')
    expect(eml.text).not.toContain('Epilogue')
  })

  it('keeps the HTML as source and never as markup', () => {
    expect(eml.html).toContain('<img src="http://track.example/p.gif">')
    expect(eml.html).toContain('href="http://evil.test/go"')
  })

  it('decodes attachments to their true size, not the encoded length', () => {
    expect(eml.attachments).toHaveLength(1)
    const [a] = eml.attachments
    expect(a.filename).toBe('invoice.docm')
    expect(a.size).toBe('macro payload here'.length)
    expect(a.inline).toBe(false)
  })

  it('decodes an RFC 2047 filename', () => {
    const mail = `Content-Type: application/pdf; name="=?utf-8?B?ZmFrdHVyYS5wZGY=?="\nContent-Disposition: attachment\n\nx`
    expect(parseEml(mail).attachments[0].filename).toBe('faktura.pdf')
  })

  it('does not let an inner boundary that starts with the outer one hide a part', () => {
    // `--OUT` is a prefix of `--OUTER`. A substring split would end the outer
    // part at the inner delimiter and the attachment would vanish from the
    // analysis — the one thing an analyst must be able to trust it for.
    const mail = [
      'Content-Type: multipart/mixed; boundary="OUT"',
      '',
      '--OUT',
      'Content-Type: multipart/alternative; boundary="OUTER"',
      '',
      '--OUTER',
      'Content-Type: text/plain',
      '',
      'body text',
      '--OUTER--',
      '--OUT',
      'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename="hidden.pdf"',
      '',
      'PDFBYTES',
      '--OUT--',
      ''
    ].join('\n')
    const out = parseEml(mail)
    expect(out.text).toContain('body text')
    expect(out.attachments.map((a) => a.filename)).toEqual(['hidden.pdf'])
  })

  it('says when a multipart declared no boundary instead of losing it quietly', () => {
    const eml2 = parseEml('Content-Type: multipart/mixed\n\nbody')
    expect(eml2.notes).toContain('A multipart/mixed part declared no boundary, so its contents were not read.')
  })

  it('tells a headers-only paste apart from something that is not an email', () => {
    expect(parseEml('From: a@b.test\nSubject: hi').notes).toContain('No message body in this paste — headers only.')
    expect(parseEml('just prose').notes).toContain('No headers and no body — is this an email?')
  })

  it('stops at a bounded depth instead of walking a pathological file forever', () => {
    // Genuinely nested, innermost first: 15 multiparts each with its own boundary.
    let mail = 'Content-Type: text/plain\n\ndeep'
    for (let i = 14; i >= 0; i--) {
      mail = `Content-Type: multipart/mixed; boundary="b${i}x"\n\n--b${i}x\n${mail}\n--b${i}x--\n`
    }
    const out = parseEml(mail)
    expect(out.notes).toContain('Stopped at 12 levels of nesting — deeper parts were not read.')
    expect(out.text).not.toContain('deep')
  })
})

describe('parser evasions that used to hide content from the analyst', () => {
  const b64of = (s: string): string => btoa(s)

  it('an inline disposition with a filename is still the body, not an attachment', () => {
    // One parameter on the text/html part used to move the whole body out of
    // the body: the client still rendered it (the header says inline) while
    // the analysis showed no HTML, no links, and one bland attachment row.
    const mail =
      'Content-Type: text/html; charset=utf-8\nContent-Disposition: inline; filename="message.html"\n\n' +
      '<html><body><a href="http://evil.test/login">Sign in</a></body></html>'
    const eml = parseEml(mail)
    expect(eml.attachments).toEqual([])
    expect(eml.html).toContain('http://evil.test/login')
  })

  it('RFC 2231 filename* wins, because it is the name the client saves', () => {
    const mail =
      'Content-Type: application/octet-stream\n' +
      'Content-Disposition: attachment; filename="invoice.pdf"; filename*=UTF-8\'\'invoice.pdf.exe\n\nx'
    expect(parseEml(mail).attachments[0].filename).toBe('invoice.pdf.exe')
  })

  it('reassembles a filename split across RFC 2231 continuations', () => {
    const mail =
      'Content-Type: application/octet-stream\n' +
      'Content-Disposition: attachment; filename*0="inv"; filename*1="oice.exe"\n\nx'
    expect(parseEml(mail).attachments[0].filename).toBe('invoice.exe')
  })

  it('reads the boundary a client reads, not one hidden inside another parameter', () => {
    const mail =
      'Content-Type: multipart/mixed; boundary=real; x="; boundary="fake"\n\n' +
      '--fake\nContent-Type: text/plain\n\ndecoy\n--fake--\n' +
      '--real\nContent-Type: application/octet-stream\nContent-Disposition: attachment; filename="p.exe"\n\nMZ\n--real--\n'
    expect(parseEml(mail).attachments.map((a) => a.filename)).toEqual(['p.exe'])
  })

  const named = (disposition: string): string =>
    parseEml(`Content-Type: application/octet-stream\nContent-Disposition: attachment; ${disposition}\n\nx`)
      .attachments[0].filename

  it('reads a filename a client reads, not one hidden inside another parameter', () => {
    expect(named('filename=payload.exe; x="; filename="invoice.pdf"')).toBe('payload.exe')
    expect(named('filename="payload.exe"; x="; filename*=UTF-8\'\'invoice.pdf"')).toBe('payload.exe')
  })

  it('unescapes a quoted-pair instead of stopping at it', () => {
    expect(named('filename="Invoice\\".pdf.exe"')).toBe('Invoice".pdf.exe')
  })

  it('takes the first of two plain parameters of one name, quoted or not', () => {
    expect(named('filename=payload.exe; filename="invoice.pdf"')).toBe('payload.exe')
  })

  it('reads a header of 100,000 parameters, or one 20 MB quoted value, without stalling or throwing', () => {
    const many = Array.from({ length: 100_000 }, (_, i) => `x${i}="v;${i}"`).join('; ')
    const started = performance.now()
    expect(named(`${many}; filename="late.exe"`)).toBe('late.exe')
    expect(performance.now() - started).toBeLessThan(1000)
    // Ten million quoted-pairs: a regex walking the quoted-string overflows V8's stack here.
    expect(named(`filename="${'\\a'.repeat(10_000_000)}"`)).toHaveLength(10_000_000)
  })

  it('opens a forwarded message and finds the payload inside it', () => {
    // Forward-as-attachment is how most reported phish reaches a SOC.
    const inner =
      'From: attacker@evil.test\nSubject: Invoice\nContent-Type: multipart/mixed; boundary="IN"\n\n' +
      '--IN\nContent-Type: application/octet-stream\n' +
      'Content-Disposition: attachment; filename="payload.exe"\nContent-Transfer-Encoding: base64\n\n' +
      `${b64of('MZ payload')}\n--IN--\n`
    const outer =
      'Content-Type: multipart/mixed; boundary="OUT"\n\n--OUT\nContent-Type: text/plain\n\nSee attached.\n' +
      `--OUT\nContent-Type: message/rfc822\nContent-Disposition: attachment; filename="fwd.eml"\n\n${inner}--OUT--\n`
    const names = parseEml(outer).attachments.map((a) => a.filename)
    expect(names).toContain('fwd.eml')
    expect(names).toContain('payload.exe')
  })

  it('tolerates the stray bytes RFC 2045 says to ignore, as every client does', () => {
    const mail =
      'Content-Type: application/octet-stream\nContent-Disposition: attachment; filename="a.bin"\n' +
      `Content-Transfer-Encoding: base64\n\n${b64of('payload bytes').slice(0, 4)}!${b64of('payload bytes').slice(4)}`
    const [a] = parseEml(mail).attachments
    expect(a.undecodable).toBe(false)
    expect(a.size).toBe('payload bytes'.length)
  })

  it('records a genuinely undecodable part as not recorded rather than as empty', () => {
    const mail =
      'Content-Type: application/octet-stream\nContent-Disposition: attachment; filename="a.bin"\n' +
      'Content-Transfer-Encoding: base64\n\n=====\n'
    const eml = parseEml(mail)
    expect(eml.attachments[0].undecodable).toBe(true)
    expect(eml.notes.join(' ')).toContain('could not be decoded')
  })

  it('does not run two text parts together into a token that is in neither', () => {
    const mail =
      'Content-Type: multipart/mixed; boundary="B"\n\n--B\nContent-Type: text/plain\n\nhttp://a.test' +
      '\n--B\nContent-Type: text/plain\n\n/evil\n--B--\n'
    expect(parseEml(mail).text).not.toContain('http://a.test/evil')
  })
})

describe('a paste that opens on a blank line', () => {
  it('still reads the headers and the attachment of the message after it', () => {
    for (const prefix of ['\n', '\r\n', '\n\n', '\r']) {
      const eml = parseEml(prefix + MAIL)
      expect(eml.headers.find((h) => h.name === 'From')?.value).toContain('billing@paypa1.test')
      expect(eml.attachments.map((a) => a.filename)).toEqual(['invoice.docm'])
      expect(eml.text).not.toContain('Content-Type')
    }
  })

  it('keeps a pasted body that is not headers as the body, link and all', () => {
    const eml = parseEml('\nClick http://evil.test/a now\n\nThanks')
    expect(eml.text).toContain('http://evil.test/a')
  })

  it('does not overflow on millions of blank lines', () => {
    const raw = '\n'.repeat(5_000_000) + 'From: a@b.test\n\nbody'
    expect(() => parseEml(raw)).not.toThrow()
    expect(withoutLeadingBlankLines(raw)).toBe('From: a@b.test\n\nbody')
  })
})

describe('hostile sizes stay linear', () => {
  // Each of these took seconds at 80 KB when a trim was a regex, and grew four
  // times over with every doubling. The bound is generous for a loaded machine;
  // the fixed code takes a few milliseconds.
  const lines76 = (s: string): string => s.match(/[^]{1,76}/g)?.join('\n') ?? ''

  it('a base64 part that is a long run of = then one letter', () => {
    const mail =
      'Content-Type: application/octet-stream\nContent-Disposition: attachment; filename="a.bin"\n' +
      `Content-Transfer-Encoding: base64\n\n${lines76('='.repeat(80_000) + 'A')}\n`
    const started = performance.now()
    parseEml(mail)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('a multipart body line that is a long run of spaces then one letter', () => {
    const mail =
      'Content-Type: multipart/mixed; boundary="B"\n\n--B\nContent-Type: text/plain\n\n' +
      `${' '.repeat(80_000)}x\n--B--\n`
    const started = performance.now()
    expect(parseEml(mail).text).toContain('x')
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('latin1Bytes', () => {
  it('gives one byte per code unit, for every byte value atob can return', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(latin1Bytes(String.fromCharCode(...all))).toEqual(all)
    expect(latin1Bytes('')).toEqual(new Uint8Array(0))
  })
})
