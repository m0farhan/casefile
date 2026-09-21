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
    expect(report.headers.observations).toContain(
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
    // Links in the report are defanged, so a copied report cannot be clicked.
    expect(markdown).toContain('hxxps://login[.]paypa1[.]test/verify')
    expect(markdown).not.toContain('https://login.paypa1.test/verify')
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
