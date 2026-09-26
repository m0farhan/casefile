import { describe, expect, it } from 'vitest'
import { analysePhishing, formatPhishReport } from './phish'

// A whole message, shaped like the real thing: nested multiparts, a
// quoted-printable text body with a soft line break, a base64 HTML body, a
// Safe Links-wrapped anchor whose visible text is a different domain, a
// tracking pixel, and a macro-capable attachment.
const html =
  '<html><body><img src="http://track.paypa1.test/open.gif" width="1">' +
  '<p>Your account is limited.</p>' +
  '<a href="https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Flogin.paypa1.test%2Fverify&amp;data=05">' +
  'https://www.paypal.test/signin</a></body></html>'

const MAIL = `Received: from mx.corp.test (mx.corp.test [10.4.1.9])
\tby inbox.corp.test with ESMTPS id 9f1
\tfor <analyst@corp.test>; Mon, 21 Sep 2026 09:20:10 +0000 (UTC)
Received: from vps-77.hostingcheap.example (vps-77.hostingcheap.example [203.0.113.77])
\tby mx.corp.test with ESMTP id 3c9; Mon, 21 Sep 2026 09:18:40 +0000
Authentication-Results: mx.corp.test; spf=softfail smtp.mailfrom=noreply@hostingcheap.example; dkim=none; dmarc=fail header.from=paypal.test
Return-Path: <noreply@hostingcheap.example>
From: "PayPal Service <service@paypal.test>" <security@paypa1.test>
Reply-To: recover@secure-verify.test
To: analyst@corp.test
Subject: =?utf-8?B?QWN0aW9uIHJlcXVpcmVkOiB5b3VyIGFjY291bnQgaXMgbGltaXRlZA==?=
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="MIXED1"

--MIXED1
Content-Type: multipart/alternative; boundary="ALT1"

--ALT1
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

Your account is limited. Verify at https://login.paypa1.test/verify=
 now.
--ALT1
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: base64

${btoa(html)}
--ALT1--
--MIXED1
Content-Type: application/vnd.ms-word.document.macroEnabled.12; name="Invoice_2026.docm"
Content-Disposition: attachment; filename="Invoice_2026.docm"
Content-Transfer-Encoding: base64

${btoa('fake macro document bytes')}
--MIXED1--
`

describe('inline parts and attachments that share a filename', () => {
  const COLLIDING = [
    'From: a@evil.test',
    'Subject: Invoice',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: image/png',
    'Content-Disposition: inline; filename="image001.png"',
    'Content-Transfer-Encoding: base64',
    '',
    'iVBORw0KGgo=',
    '--B',
    'Content-Type: application/octet-stream',
    'Content-Disposition: attachment; filename="image001.png"',
    'Content-Transfer-Encoding: base64',
    '',
    'TVqQAAMAAAAEAAAA',
    '--B--',
    ''
  ].join('\n')

  it('keeps them apart, because a shared name used to merge them', async () => {
    const report = await analysePhishing(COLLIDING, [], [])
    expect(report.inlineImages).toHaveLength(1)
    expect(report.attachments).toHaveLength(1)
    // The one that matters: the real attachment is still on the attachment
    // side, where its declared-vs-actual mismatch gets reported.
    expect(report.attachments[0]?.sniffed).toContain('Windows executable')
  })
})

describe('analysePhishing over a whole message', () => {
  it('reads every layer of it', async () => {
    const report = await analysePhishing(MAIL, ['corp.test'], ['paypal', 'microsoft'])

    // Headers
    expect(report.headers.identities.find((i) => i.label === 'Subject')?.value).toBe(
      'Action required: your account is limited'
    )
    expect(report.headers.auth.map((a) => `${a.mechanism}=${a.result}`)).toEqual([
      'spf=softfail',
      'dkim=none',
      'dmarc=fail'
    ])
    expect(report.headers.hops[0].from).toContain('203.0.113.77')
    expect(report.headers.hops[1].delaySec).toBe(90)
    expect(report.headers.observations.map((o) => o.text)).toContain(
      'The display name contains an address at paypal.test, which is not the sending domain.'
    )

    // Body: soft line break joined, HTML kept as source
    expect(report.text).toContain('https://login.paypa1.test/verify now.')
    expect(report.htmlSource).toContain('<img src="http://track.paypa1.test/open.gif"')

    // Links: Safe Links unwrapped, look-alike folded, visible text compared
    const wrapped = report.links.find((l) => l.wrappedBy === 'Microsoft Safe Links')
    expect(wrapped?.target).toBe('https://login.paypa1.test/verify')
    expect(wrapped?.flags).toContain('reads as "paypal" once look-alike characters are folded')
    expect(wrapped?.flags).toContain('shown as a link to www.paypal.test, points at login.paypa1.test')

    // Attachment: hashed here, type named, nothing called malicious
    expect(report.attachments).toHaveLength(1)
    const [attachment] = report.attachments
    expect(attachment.filename).toBe('Invoice_2026.docm')
    expect(attachment.size).toBe('fake macro document bytes'.length)
    expect(attachment.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(attachment.sha1).toMatch(/^[0-9a-f]{40}$/)
    expect(attachment.facts).toContain('file type that can carry macros')
  })

  it('reaches no verdict anywhere in the report it emits', async () => {
    const markdown = formatPhishReport(await analysePhishing(MAIL, ['corp.test'], ['paypal']))
    expect(markdown).not.toMatch(/malicious|phishing|suspicious|spoofed|dangerous|threat/i)
    // Hashes are labelled with where they came from, always.
    expect(markdown).toContain('(computed here)')
    // Links in the LINKS section are defanged, so a copied report cannot be
    // clicked through. The body is a separate matter: it is evidence and is
    // carried verbatim, inside a fence, where nothing autolinks.
    expect(markdown).toContain('hxxps://login[.]paypa1[.]test/verify')
    const linkLine = markdown.split('\n').find((l) => l.startsWith('- hxxps://login')) ?? ''
    expect(linkLine).not.toContain('https://login.paypa1.test/verify')
  })
})

describe('the whole-message report after hardening', () => {
  it('builds indicators from the parsed message, not the raw paste', async () => {
    const report = await analysePhishing(MAIL, ['corp.test'], ['paypal'])
    const joined = report.indicators.join('\n')
    // The phishing URL is split by a quoted-printable soft line break in the
    // raw text, so scanning `raw` missed it entirely.
    expect(joined).toContain('login[.]paypa1[.]test')
    // And nothing from the base64 of the HTML part leaks in as an "indicator".
    expect(report.indicators.some((i) => i.includes('PGh0bWw'))).toBe(false)
  })

  it('carries the sender domain’s own look-alike facts', async () => {
    const report = await analysePhishing(MAIL, [], ['paypal'])
    expect(report.senderFacts).toContain('reads as "paypal" once look-alike characters are folded')
  })

  it('quarantines hostile values so the case note cannot be used as a beacon', async () => {
    const hostile = MAIL.replace(
      'Subject: =?utf-8?B?QWN0aW9uIHJlcXVpcmVkOiB5b3VyIGFjY291bnQgaXMgbGltaXRlZA==?=',
      'Subject: ![[private]] <img src="http://beacon.test/x.gif">'
    )
    const markdown = formatPhishReport(await analysePhishing(hostile, [], []))
    // Every line carrying the hostile string must have it inside inline code.
    const carrying = markdown.split('\n').filter((line) => line.includes('beacon.test'))
    expect(carrying.length).toBeGreaterThan(0)
    expect(carrying.every((line) => /`[^`]*beacon\.test[^`]*`/.test(line))).toBe(true)
    expect(markdown).not.toMatch(/^- Subject: !\[\[/m)
  })

  it('still reaches no verdict', async () => {
    const markdown = formatPhishReport(await analysePhishing(MAIL, ['corp.test'], ['paypal']))
    expect(markdown).not.toMatch(/malicious|phishing|suspicious|spoofed|dangerous|threat/i)
  })
})

describe('a hash is either this machine’s answer or nothing', () => {
  const b64 = (s: string): string => btoa(s)

  it('pins the digest to a value, not a shape', async () => {
    const mail =
      'Content-Type: application/octet-stream\n' +
      'Content-Disposition: attachment; filename="a.bin"\n' +
      `Content-Transfer-Encoding: base64\n\n${b64('MZ payload')}\n`
    const [a] = (await analysePhishing(mail, [], [])).attachments
    // The literal digest, computed outside this codebase with `shasum -a 256`.
    // Pinned to a VALUE, not a shape: a test that only checks 64 hex characters
    // passes just as happily on the hash of an empty file.
    expect(a.sha256).toBe('48bf631186b8c57da7e7a47b870604e8d58fa140633ee0c899cf25a549ebd7a6')
    expect(a.size).toBe('MZ payload'.length)
  })

  it('records nothing at all for a part it could not decode', async () => {
    // The exact shape that used to print the empty file's SHA-256 under
    // "computed here, from the bytes in the file".
    const mail =
      'Content-Type: application/octet-stream\n' +
      'Content-Disposition: attachment; filename="a.bin"\n' +
      'Content-Transfer-Encoding: base64\n\n=====\n'
    const report = await analysePhishing(mail, [], [])
    const [a] = report.attachments
    expect(a.sha256).toBe('')
    expect(a.sha1).toBe('')
    expect(a.facts).toContain('this part could not be decoded, so its size, hashes and type are not recorded')
    const md = formatPhishReport(report)
    expect(md).toContain('SHA-256 not recorded')
    expect(md).toContain('size not recorded')
    expect(md).not.toContain('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('the report carries the message body it says it carries', () => {
  it('emits the body, fenced, so a case records the mail and not just the analysis', async () => {
    const markdown = formatPhishReport(await analysePhishing(MAIL, [], []))
    expect(markdown).toContain('### Message body')
    expect(markdown).toContain('Your account is limited.')
    expect(markdown).toContain('<img src="http://track.paypa1.test/open.gif"')
  })

  it('fences content that contains a fence, so it cannot close its own block', async () => {
    const mail = 'Content-Type: text/plain\n\n```\n![[private]] <img src="http://beacon.test/x">\n`````\n'
    const markdown = formatPhishReport(await analysePhishing(mail, [], []))
    expect(markdown).toContain('``````')
    // The embed is inside the fence, not loose in the note.
    const lines = markdown.split('\n')
    const fenceStarts = lines.reduce((n, l) => n + (/^`{3,}$/.test(l) ? 1 : 0), 0)
    expect(fenceStarts % 2).toBe(0)
  })

  it('says so when there is no body rather than implying one', async () => {
    const markdown = formatPhishReport(await analysePhishing('From: a@b.test\nSubject: hi', [], []))
    expect(markdown).toContain('### Message body\n\nNot recorded.')
  })
})

describe('the extracted text travels with the analysis', () => {
  it('is on the report, so the screen, the clipboard and the case agree', async () => {
    const report = await analysePhishing(MAIL, [], [])
    expect(report.htmlText).toContain('Your account is limited.')
    // The markup itself is not in the extracted text.
    expect(report.htmlText).not.toContain('<img')
    expect(report.htmlText).not.toContain('track.paypa1.test/o.gif')

    const md = formatPhishReport(report)
    expect(md).toContain('Text extracted from the HTML, not rendered:')
    expect(md).toContain('Your account is limited.')
    // The source is still carried beside it, not replaced by it.
    expect(md).toContain('HTML source, not rendered:')
  })

  it('is empty, not invented, when the mail has no HTML part', async () => {
    const report = await analysePhishing('Content-Type: text/plain\n\nJust words.', [], [])
    expect(report.htmlText).toBe('')
    expect(formatPhishReport(report)).not.toContain('Text extracted from the HTML')
  })
})

describe('a PDF attachment is read for its structure', () => {
  const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]
  const head = '%PDF-1.7\n1 0 obj\n<< /Type /XObject /Subtype /Image /Filter /DCTDecode /Length 13 >>\nstream\n'
  const tail =
    '\nendstream\nendobj\n2 0 obj\n<< /A << /S /URI /URI (https://qr-lure.test/login) >> >>\nendobj\n' +
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n'
  const bytes = [...head]
    .map((c) => c.charCodeAt(0))
    .concat(
      JPEG,
      [...tail].map((c) => c.charCodeAt(0))
    )
  const b64 = btoa(String.fromCharCode(...bytes))
  const mail =
    'From: a@sender.test\nTo: b@corp.test\nSubject: scan\nMIME-Version: 1.0\n' +
    'Content-Type: multipart/mixed; boundary="B"\n\n--B\nContent-Type: text/plain\n\nsee attached\n' +
    '--B\nContent-Type: application/pdf\nContent-Disposition: attachment; filename="scan.pdf"\n' +
    `Content-Transfer-Encoding: base64\n\n${b64}\n--B--\n`

  it('carries the picture, the link and its indicator into the report', async () => {
    const report = await analysePhishing(mail, [], [])
    const [pdf] = report.attachments
    expect(pdf.pdf?.images.map((i) => i.sniffed)).toEqual(['JPEG image'])
    expect(pdf.pdf?.uris).toEqual(['https://qr-lure.test/login'])
    // Found by the reader, not by a text scan: the plain-bytes pass sees the
    // same URL here, and the line must not be listed twice.
    expect(pdf.inside.filter((l) => l.includes('qr-lure')).length).toBe(1)
    // The lure is the indicator the analyst will block, so it reaches the
    // copied list and the case — not only the attachment's card.
    expect(report.indicators).toContain('url: hxxps://qr-lure[.]test/login')
    const text = formatPhishReport(report)
    expect(text).toContain('PDF link (/URI): `hxxps://qr-lure[.]test/login`')
    expect(text).toMatch(
      /embedded picture `byte \d+ \(\/DCTDecode\)`: JPEG image, 13 bytes, SHA-256 [0-9a-f]{64} \(computed here\)/
    )
  })
})
