import { describe, expect, it } from 'vitest'
import { parseEml } from './eml'

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
