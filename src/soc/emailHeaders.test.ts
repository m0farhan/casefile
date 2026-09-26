import { describe, expect, it } from 'vitest'
import {
  addressOf,
  analyseHeaders,
  decodeEncodedWords,
  formatDelay,
  formatHeaderReport,
  parseHeaderBlock,
  quotedPrintableBytes,
  quoteUntrusted
} from './emailHeaders'
import { analysePhishing } from './phish'

// A realistic spoof: envelope sender and reply-to are elsewhere, SPF fails,
// and the display name carries a second address.
const SPOOF = `Delivered-To: analyst@corp.test
Received: from mx.corp.test (mx.corp.test [10.4.1.9])
        by inbox.corp.test with ESMTPS id 7a2
        for <analyst@corp.test>; Mon, 21 Sep 2026 09:14:30 +0000 (UTC)
Received: from cheap-vps.example (cheap-vps.example [203.0.113.55])
        by mx.corp.test with ESMTP id 4b1; Mon, 21 Sep 2026 09:12:00 +0000
Authentication-Results: mx.corp.test;
        spf=fail smtp.mailfrom=bounce@cheap-vps.example;
        dkim=none; dmarc=fail header.from=paypal.test
Return-Path: <bounce@cheap-vps.example>
From: "PayPal Security <service@paypal.test>" <billing@paypa1.test>
Reply-To: recovery@mail-verify.test
To: analyst@corp.test
Subject: =?utf-8?B?VXJnZW50OiB2ZXJpZnkgeW91ciBhY2NvdW50?=
Message-ID: <abc123@cheap-vps.example>
Date: Mon, 21 Sep 2026 09:11:58 +0000

This is the body. From: not-the-real-sender@evil.test
`

describe('parseHeaderBlock', () => {
  it('joins continuation lines into one field', () => {
    const fields = parseHeaderBlock(SPOOF)
    const auth = fields.find((f) => f.name === 'Authentication-Results')
    expect(auth?.value).toContain('spf=fail')
    expect(auth?.value).toContain('dmarc=fail')
  })

  it('stops at the blank line, so a From: in the body cannot impersonate the sender', () => {
    const names = parseHeaderBlock(SPOOF).map((f) => f.name.toLowerCase())
    expect(names.filter((n) => n === 'from')).toHaveLength(1)
    expect(parseHeaderBlock(SPOOF).find((f) => f.name.toLowerCase() === 'from')?.value).toContain('paypa1.test')
  })
})

describe('decodeEncodedWords', () => {
  it('decodes a base64 encoded word', () => {
    expect(decodeEncodedWords('=?utf-8?B?VXJnZW50?=')).toBe('Urgent')
  })

  it('decodes a quoted-printable encoded word, underscore as space', () => {
    expect(decodeEncodedWords('=?utf-8?Q?Hello_World=21?=')).toBe('Hello World!')
  })

  it('leaves an unknown charset exactly as written rather than guessing', () => {
    const odd = '=?x-made-up?B?VXJnZW50?='
    expect(decodeEncodedWords(odd)).toBe(odd)
  })
})

describe('addressOf', () => {
  it('takes the angle-bracketed address, not the display name', () => {
    expect(addressOf('"PayPal Security <service@paypal.test>" <billing@paypa1.test>')).toBe('billing@paypa1.test')
  })

  it('accepts a bare address', () => {
    expect(addressOf('recovery@mail-verify.test')).toBe('recovery@mail-verify.test')
  })
})

describe('analyseHeaders', () => {
  const a = analyseHeaders(SPOOF)

  it('reports authentication results as stated, never as a verdict', () => {
    expect(a.auth).toContainEqual({
      mechanism: 'spf',
      result: 'fail',
      detail: 'smtp.mailfrom=bounce@cheap-vps.example',
      // The asserting host is the whole trust question: a sender can write
      // this header themselves and it parses identically to the receiver's.
      assertedBy: 'mx.corp.test'
    })
    expect(a.auth.map((r) => `${r.mechanism}=${r.result}`)).toEqual(['spf=fail', 'dkim=none', 'dmarc=fail'])
    // No word like "phishing", "malicious" or "suspicious" anywhere in the output.
    expect(JSON.stringify(a)).not.toMatch(/phish|malicious|suspicious|spoofed/i)
  })

  it('reverses the Received chain so hop 1 is the origin', () => {
    expect(a.hops).toHaveLength(2)
    expect(a.hops[0].from).toContain('cheap-vps.example')
    expect(a.hops[0].by).toBe('mx.corp.test')
    expect(a.hops[1].by).toBe('inbox.corp.test')
  })

  it('measures the delay between hops', () => {
    expect(a.hops[0].delaySec).toBeNull() // nothing before the origin
    expect(a.hops[1].delaySec).toBe(150)
  })

  it('states the identity mismatches as comparisons', () => {
    expect(a.observations.map((o) => o.text)).toContain(
      'From is at paypa1.test; Return-Path is at cheap-vps.example. They differ.'
    )
    expect(a.observations.map((o) => o.text)).toContain(
      'From is at paypa1.test; Reply-To is at mail-verify.test. They differ.'
    )
    expect(a.observations.map((o) => o.text)).toContain(
      'The display name contains an address at paypal.test, which is not the sending domain.'
    )
  })

  it('decodes the subject', () => {
    expect(a.identities.find((i) => i.label === 'Subject')?.value).toBe('Urgent: verify your account')
  })

  it('the report built on it defangs the header indicators and marks the analyst’s own estate', async () => {
    // The header reader no longer scans for indicators — the phishing report
    // does, from the parsed message — so this is asserted where the list lives.
    const { indicators } = await analysePhishing(SPOOF, ['corp.test'], [])
    expect(indicators).toContain('ip: 203[.]0[.]113[.]55')
    expect(indicators.join('\n')).not.toMatch(/(^|\s)203\.0\.113\.55/)
    // The analyst's own mail relay is marked, so it never reads as an indicator.
    expect(indicators).toContain('ip: 10[.]4[.]1[.]9 (own asset)')
    expect(indicators).toContain('email: analyst[at]corp[.]test (own asset)')
  })

  it('says what a paste does not contain instead of passing it', () => {
    const bare = analyseHeaders('From: a@b.test\nSubject: hi')
    expect(bare.notes).toContain('No Received headers — the delivery path is not recorded.')
    expect(bare.notes).toContain('No Authentication-Results or Received-SPF — SPF, DKIM and DMARC are not recorded.')
    expect(bare.notes).toContain('No Return-Path — the envelope sender is not recorded.')
    expect(bare.identities.find((i) => i.label === 'Reply-To')?.value).toBe('not recorded')
  })

  it('is empty-handed, not wrong, on rubbish', () => {
    const none = analyseHeaders('just some prose that is not a header block')
    expect(none.notes).toContain('No headers found in this paste.')
    expect(none.hops).toEqual([])
    expect(none.auth).toEqual([])
  })
})

describe('formatHeaderReport', () => {
  it('prints every section, with honest absences', () => {
    const md = formatHeaderReport(analyseHeaders('From: a@b.test'))
    expect(md).toContain('### Authentication\n\nNot recorded.')
    expect(md).toContain('### Path\n\nNot recorded.')
    // Indicators are emitted once, by the phishing report, from the PARSED
    // message — this section no longer prints a second raw-paste scan.
    expect(md).not.toContain('### Indicators')
  })
})

describe('trust attribution on authentication results', () => {
  it('names the host that asserted each result', () => {
    const a = analyseHeaders(
      'Authentication-Results: mx.corp.test; spf=pass smtp.mailfrom=corp.test\nFrom: a@corp.test'
    )
    expect(a.auth[0].assertedBy).toBe('mx.corp.test')
  })

  it('marks an ARC result as a relayed claim, not the receiver’s own check', () => {
    const a = analyseHeaders(
      'ARC-Authentication-Results: i=1; relay.test; dkim=pass header.d=corp.test\nFrom: a@corp.test'
    )
    // Exactly: the host follows the ARC instance, and "i=1" was once printed
    // as the host while a toContain check passed.
    expect(a.auth[0].assertedBy).toBe('relay.test (ARC — relayed claim)')
  })

  it('says a Received-SPF result has no asserting host rather than implying one', () => {
    const a = analyseHeaders(
      'Received-SPF: pass (corp.test: domain of a@corp.test designates 1.2.3.4)\nFrom: a@corp.test'
    )
    expect(a.auth[0].assertedBy).toBe('Received-SPF, no asserting host stated')
  })

  it('states the domain a pass was for, and whether it is the From domain', () => {
    const third = analyseHeaders(
      'Authentication-Results: mx.corp.test; spf=pass smtp.mailfrom=bounce@mailer.sendgrid.net; dkim=pass header.d=sendgrid.net\n' +
        'From: security@paypal.test'
    )
    // Reported exactly as the header states it — mailer.sendgrid.net, not a
    // registrable-domain guess. The analyst reads what was actually signed.
    expect(third.observations.map((o) => o.text)).toContain(
      'SPF passed for mailer.sendgrid.net; From is at paypal.test. They differ.'
    )
    expect(third.observations.map((o) => o.text)).toContain(
      'DKIM passed for sendgrid.net; From is at paypal.test. They differ.'
    )

    const aligned = analyseHeaders(
      'Authentication-Results: mx.corp.test; dkim=pass header.d=paypal.test\nFrom: security@paypal.test'
    )
    expect(aligned.observations.map((o) => o.text)).toContain('DKIM passed for paypal.test, which is the From domain.')
  })
})

describe('headers that appear more than once', () => {
  it('says so rather than silently using the first', () => {
    const a = analyseHeaders('From: real@corp.test\nFrom: spoof@evil.test\nSubject: hi')
    expect(a.observations.map((o) => o.text)).toContain(
      'There are 2 from headers. Identities show the first; authentication results show all of them. ' +
        'Mail clients do not agree on which one wins.'
    )
  })
})

describe('addressOf against RFC 5322 comments', () => {
  it('ignores an address parked in a comment', () => {
    // The comment is legal, every client shows the real mailbox, and reading
    // the comment reported alignment on a mail that had none.
    expect(addressOf('(<bounce@mailer-svc.test>) security@microsoft.com')).toBe('security@microsoft.com')
    expect(addressOf('Real Name (note <a@decoy.test>) <real@corp.test>')).toBe('real@corp.test')
  })

  it('handles nested comments', () => {
    expect(addressOf('((<a@decoy.test>) more) <real@corp.test>')).toBe('real@corp.test')
  })
})

describe('encoded words cannot break out of their line', () => {
  it('flattens decoded newlines so a subject cannot forge report sections', () => {
    // =?utf-8?B?...?= of "Hi\n\n### Indicators\n\n- evil.test"
    const forged = '=?utf-8?B?' + btoa('Hi\n\n### Indicators\n\n- evil.test') + '?='
    const out = decodeEncodedWords(forged)
    expect(out).not.toContain('\n')
    expect(out).toBe('Hi ### Indicators - evil.test')
  })
})

describe('the report cannot be used as an injection vector', () => {
  // The report is written into a note that Obsidian RENDERS. Every value in it
  // was written by the sender.
  const hostile = ['Subject: ![[private-note]] <img src="http://beacon.test/x.gif"> [[rewire]]', 'From: a@b.test'].join(
    '\n'
  )

  it('quarantines an embed, a beacon and a wiki-link inside inline code', () => {
    const md = formatHeaderReport(analyseHeaders(hostile))
    const subject = md.split('\n').find((l) => l.startsWith('- Subject:')) ?? ''
    expect(subject).toBe('- Subject: `![[private-note]] <img src="http://beacon.test/x.gif"> [[rewire]]`')
    // Nothing renders: the whole value sits between a matched pair of backticks.
    expect(subject.match(/`/g)?.length).toBe(2)
  })

  it('cannot be escaped by a value that contains backticks', () => {
    const md = formatHeaderReport(analyseHeaders('Subject: ``` ![[boom]] ```\nFrom: a@b.test'))
    const subject = md.split('\n').find((l) => l.startsWith('- Subject:')) ?? ''
    expect(subject).toContain('````')
    expect(subject.startsWith('- Subject: ````')).toBe(true)
  })

  it('names a negative hop gap instead of printing "(+-90s)"', () => {
    expect(formatDelay(-90)).toBe(' (90s EARLIER than the hop before it — clock skew or a forged hop)')
    expect(formatDelay(90)).toBe(' (+90s)')
    expect(formatDelay(null)).toBe('')
  })
})

describe('PhishTool parity on the header model', () => {
  const MAIL = [
    'Received: from a.test (a.test [1.2.3.4]) by mx.corp.test with ESMTP id 4b1abc',
    '\tfor <alias@corp.test>; Mon, 21 Sep 2026 09:12:00 +0000',
    'From: Real Person <real@corp.test>',
    'Sender: bounces@mailer.test',
    'To: analyst@corp.test',
    'Cc: team@corp.test',
    'In-Reply-To: <parent-123@corp.test>',
    'References: <a@corp.test> <parent-123@corp.test>',
    'Subject: Re: invoice'
  ].join('\n')

  it('surfaces Sender, Cc and the thread headers', () => {
    const labels = analyseHeaders(MAIL).identities
    const value = (l: string) => labels.find((i) => i.label === l)?.value
    expect(value('Sender')).toBe('bounces@mailer.test')
    expect(value('Cc')).toBe('team@corp.test')
    expect(value('In-Reply-To')).toBe('<parent-123@corp.test>')
    expect(value('References')).toContain('parent-123@corp.test')
  })

  it('states the thread claim without judging it', () => {
    const texts = analyseHeaders(MAIL).observations.map((o) => o.text)
    const claim = texts.find((t) => t.includes('claims to reply'))
    expect(claim).toContain('<parent-123@corp.test>')
    // Says a genuine reply is indistinguishable here, and hands the question
    // to the analyst rather than answering it.
    expect(claim).toContain('tells a genuine reply apart')
    expect(claim).toContain('check whether that conversation is yours')
    expect(texts.join(' ')).not.toMatch(/hijack|malicious|suspicious/i)
  })

  it('carries the hop id and the envelope recipient', () => {
    const [hop] = analyseHeaders(MAIL).hops
    expect(hop.id).toBe('4b1abc')
    expect(hop.forWhom).toBe('alias@corp.test')
    expect(formatHeaderReport(analyseHeaders(MAIL))).toContain('id `4b1abc`')
  })

  it('says nothing for headers the mail does not carry', () => {
    const labels = analyseHeaders('From: a@b.test').identities
    expect(labels.find((i) => i.label === 'Cc')?.value).toBe('not recorded')
    expect(labels.find((i) => i.label === 'In-Reply-To')?.value).toBe('not recorded')
  })
})

describe('hostile header sizes stay linear', () => {
  // Header values have no length cap. Each of these took seconds through a
  // regex that retried from every position of a long run.
  it.each([
    ['a run of escaped quotes', 'From: ' + '\\"'.repeat(50_000)],
    ['a run of escaped parens', 'From: ' + '\\('.repeat(50_000)],
    ['a run of open brackets', 'From: ' + '<'.repeat(100_000)],
    ['a domain of dots', 'From: <x@' + '.'.repeat(100_000) + 'a>'],
    ['a long bare display name', 'From: ' + 'a'.repeat(100_000) + ' <x@y.test>'],
    ['a long quoted display name', 'From: "' + 'a'.repeat(100_000) + '" <x@y.test>'],
    ['a Received tail of open parens', 'Received: from a.test by b.test; ' + '('.repeat(100_000)],
    ['a result comment of escaped parens', 'Authentication-Results: mx.corp.test; spf=pass (' + '\\('.repeat(80_000)]
  ])('%s', (_, raw) => {
    const started = performance.now()
    analyseHeaders(raw)
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('still finds an address padded behind 2000 spaces in the display name', () => {
    const a = analyseHeaders('From: "' + ' '.repeat(2000) + 'service@paypal.test" <evil@evil.test>')
    expect(a.observations.map((o) => o.text)).toContain(
      'The display name contains an address at paypal.test, which is not the sending domain.'
    )
  })

  it('reads the same address the regexes it replaced read', () => {
    // The old strips, kept as the reference: the scanners are meant to be
    // exact, not merely fast.
    const byRegex = (value: string): string => {
      let unquoted = value.replace(/"(?:[^"\\]|\\.)*"/g, '')
      for (let i = 0; i < 6; i++) {
        const next = unquoted.replace(/\((?:[^()\\]|\\.)*\)/g, ' ')
        if (next === unquoted) break
        unquoted = next
      }
      const angled = [...unquoted.matchAll(/<([^>]*)>/g)]
      return (angled.length ? angled[angled.length - 1][1] : unquoted).trim().replace(/^mailto:/i, '')
    }
    let seed = 7
    const next = (): number => (seed = (seed * 48_271) % 2_147_483_647)
    const alphabet = 'a.@<>()"\\ '
    const differ: string[] = []
    for (let n = 0; n < 20_000; n++) {
      const s = Array.from({ length: next() % 24 }, () => alphabet[next() % alphabet.length]).join('')
      if (addressOf(s) !== byRegex(s)) differ.push(s)
    }
    expect(differ).toEqual([])
  })
})

describe('a Received hop, read as the MTA wrote it', () => {
  const hop = (received: string) => analyseHeaders(`Received: ${received}\nFrom: a@b.test`).hops[0]

  it('keeps the address Postfix saw beside a HELO literal, and the protocol outside the TLS comment', () => {
    const h = hop(
      'from [192.168.1.20] (unknown [203.0.113.9]) (using TLSv1.3 with cipher TLS_AES_256_GCM_SHA384 ' +
        '(256/256 bits) key-exchange X25519 server-signature RSA-PSS (2048 bits) server-digest SHA256) ' +
        '(No client certificate requested) by mx.example.com (Postfix) with ESMTPS id 4ABC123 ' +
        'for <user@example.com>; Mon, 1 Jan 2024 00:00:00 +0000'
    )
    expect(h.from).toBe('[192.168.1.20] (unknown [203.0.113.9])')
    expect(h.via).toBe('ESMTPS')
    expect(h.by).toBe('mx.example.com')
    expect(h.id).toBe('4ABC123')
    expect(h.forWhom).toBe('user@example.com')
    expect(h.at).toBe('2024-01-01T00:00:00.000Z')
  })

  it('keeps the public address Gmail recorded for a submission from a LAN', () => {
    const h = hop(
      'from [192.168.1.100] (host86-1-2-3.range86-1.btcentralplus.com. [86.1.2.3]) by smtp.gmail.com ' +
        'with ESMTPSA id abc123 for <x@gmail.test> (version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384 bits=256/256); ' +
        'Mon, 01 Jan 2024 00:00:00 -0800 (PST)'
    )
    expect(h.from).toContain('86.1.2.3')
    expect(h.via).toBe('ESMTPSA')
    expect(h.at).toBe('2024-01-01T08:00:00.000Z')
  })

  it('keeps Exim’s order, the address it saw first and the HELO in the comment, unlabelled', () => {
    const h = hop(
      'from [203.0.113.8] (helo=[192.168.1.20]) by mx.example.com with esmtpsa (TLS1.3) tls ' +
        'TLS_AES_256_GCM_SHA384 (Exim 4.96) (envelope-from <a@b.test>) id 1abc-000 for c@d.test; ' +
        'Mon, 01 Jan 2024 00:00:00 +0000'
    )
    expect(h.from).toBe('[203.0.113.8] (helo=[192.168.1.20])')
    expect(h.via).toBe('esmtpsa')
    expect(h.id).toBe('1abc-000')
  })

  it('reads an ordinary Postfix TLS hop as ESMTPS, not "cipher"', () => {
    const h = hop(
      'from mail.sender.test (mail.sender.test [198.51.100.5]) (using TLSv1.3 with cipher ' +
        'TLS_AES_256_GCM_SHA384 (256/256 bits)) by mx.corp.test (Postfix) with ESMTPS id 9F2; ' +
        'Mon, 1 Jan 2024 00:00:00 +0000'
    )
    expect(h.from).toBe('mail.sender.test (mail.sender.test [198.51.100.5])')
    expect(h.via).toBe('ESMTPS')
  })

  it('keeps the address in a Sendmail comment that nests "(may be forged)"', () => {
    const h = hop(
      'from smtp.sender.test (smtp.sender.test [192.0.2.1] (may be forged)) by mx.corp.test ' +
        '(8.15.2/8.15.2) with ESMTP id 3ABC; Mon, 1 Jan 2024 00:00:00 +0000'
    )
    expect(h.from).toBe('smtp.sender.test (smtp.sender.test [192.0.2.1] (may be forged))')
    expect(h.via).toBe('ESMTP')
  })

  it('does not read a local pickup’s "(Postfix, from userid 1000)" as a hop from "userid"', () => {
    const h = hop('by web1.corp.test (Postfix, from userid 1000) id 4XYZ; Mon, 1 Jan 2024 00:00:00 +0000')
    expect(h.from).toBe('not recorded')
    expect(h.by).toBe('web1.corp.test')
    expect(h.id).toBe('4XYZ')
  })
})

describe('who asserted an authentication result', () => {
  const said = (header: string) =>
    analyseHeaders(`${header}\nFrom: a@contoso.test`).auth.map((r) => `${r.mechanism}=${r.result} by ${r.assertedBy}`)

  it('says Microsoft 365’s results name no host, rather than naming "spf=pass" as one', () => {
    const header =
      'Authentication-Results: spf=pass (sender IP is 40.107.1.1) smtp.mailfrom=contoso.test; ' +
      'dkim=pass (signature was verified) header.d=contoso.test;dmarc=pass action=none ' +
      'header.from=contoso.test;compauth=pass reason=100'
    expect(said(header)).toEqual([
      'spf=pass by no asserting host stated',
      'dkim=pass by no asserting host stated',
      'dmarc=pass by no asserting host stated',
      'compauth=pass by no asserting host stated'
    ])
    // The comment stays in the detail: it is where Microsoft states the sending IP.
    expect(analyseHeaders(`${header}\nFrom: a@contoso.test`).auth[0].detail).toBe(
      '(sender IP is 40.107.1.1) smtp.mailfrom=contoso.test'
    )
  })

  it('reads the host after an ARC instance', () => {
    expect(
      said(
        'ARC-Authentication-Results: i=1; mx.microsoft.com 1; spf=pass smtp.mailfrom=contoso.test; ' +
          'dmarc=pass header.from=contoso.test'
      )
    ).toEqual([
      'spf=pass by mx.microsoft.com (ARC — relayed claim)',
      'dmarc=pass by mx.microsoft.com (ARC — relayed claim)'
    ])
  })

  it('does not split a result at a semicolon in a comment or a quoted address', () => {
    // Receivers copy the envelope sender into both, so the sender writes them.
    expect(
      said(
        'Authentication-Results: mx.corp.test; spf=fail (domain of x@evil.test; dkim=pass) smtp.mailfrom=x@evil.test'
      )
    ).toEqual(['spf=fail by mx.corp.test'])
    expect(
      said(
        'Authentication-Results: mx.corp.test; spf=fail (domain of "x;dkim=pass"@evil.test does not designate ' +
          '192.0.2.1 as permitted sender) smtp.mailfrom="x;dkim=pass"@evil.test'
      )
    ).toEqual(['spf=fail by mx.corp.test'])
  })
})

describe('encoded words never move the From address', () => {
  const texts = (raw: string) => analyseHeaders(raw).observations.map((o) => o.text)

  it('does not read an encoded word inside the address as its domain', () => {
    const raw =
      'Return-Path: <bounce@paypal.test>\nFrom: <security@=?utf-8?q?paypal.test?=>\n' +
      'Authentication-Results: mx.corp.test; dkim=pass header.d=paypal.test'
    expect(texts(raw).join('\n')).not.toMatch(/both at|which is the From domain/)
    expect(texts(raw)).toContain(
      'Decoding the encoded words in From changes the address it names: read as written it names no ' +
        'complete address; decoded it is security@paypal.test.'
    )
    expect(analyseHeaders(raw).fromAddress).toBe('security@')
  })

  it('reads the address a receiver’s DMARC check reads when decoding forges a second one', () => {
    const raw =
      'Return-Path: <service@paypal.com>\n' +
      'From: =?utf-8?q?PayPal_=22?= <attacker@paypa1.com> (=?utf-8?q?=22?=<service@paypal.com>)'
    expect(texts(raw)).toContain('From is at paypa1.com; Return-Path is at paypal.com. They differ.')
    expect(texts(raw)).toContain(
      'Decoding the encoded words in From changes the address it names: read as written it is ' +
        'attacker@paypa1.com; decoded it is service@paypal.com.'
    )
    expect(analyseHeaders(raw).fromAddress).toBe('attacker@paypa1.com')
  })

  it('does not take an encoded angle address after the real one', () => {
    const raw = 'Return-Path: <bounce@paypal.test>\nFrom: <x@evil.test> =?utf-8?q?=3Csecurity@paypal.test=3E?='
    expect(texts(raw)).toContain('From is at evil.test; Return-Path is at paypal.test. They differ.')
  })

  it('still finds an address hidden in an encoded display name, and says nothing about decoding', () => {
    const found = texts('From: =?utf-8?q?service=40paypal.com?= <attacker@evil.test>')
    expect(found).toContain('The display name contains an address at paypal.com, which is not the sending domain.')
    expect(found.join('\n')).not.toContain('Decoding')
  })
})

describe('adjacent encoded words', () => {
  it('drop the space a fold put between them', () => {
    expect(decodeEncodedWords('=?UTF-8?B?UGF5?= =?UTF-8?B?UGFs?=')).toBe('PayPal')
    expect(decodeEncodedWords('"=?UTF-8?B?aW52b2ljZS5w?=\t=?UTF-8?B?ZGYuZXhl?="')).toBe('"invoice.pdf.exe"')
    const folded = analyseHeaders('Subject: =?UTF-8?B?UGF5?=\r\n =?UTF-8?B?UGFs?= account\nFrom: a@b.test')
    expect(folded.identities.find((i) => i.label === 'Subject')?.value).toBe('PayPal account')
  })

  it('decode a character split across two words whole', () => {
    // U+0430 is D0 B0 in UTF-8, and the split falls between the two bytes.
    const split = '=?utf-8?B?' + btoa('p\xd0') + '?= =?utf-8?B?' + btoa('\xb0ypal') + '?='
    expect(decodeEncodedWords(split)).toBe('p\u0430ypal')
  })

  it('join words in different charsets', () => {
    expect(decodeEncodedWords('=?utf-8?Q?a?= =?iso-8859-1?Q?=E9?=')).toBe('aé')
  })

  it('keep whitespace a reader sees, and text that only looks like a word', () => {
    expect(decodeEncodedWords('=?UTF-8?B?UGF5?=\u00A0=?UTF-8?B?UGFs?=')).toBe('Pay\u00A0Pal')
    expect(decodeEncodedWords('ok?= =?UTF-8?B?UGF5?=')).toBe('ok?= Pay')
    expect(decodeEncodedWords('=?UTF-8?B?UGF5?= x =?UTF-8?B?UGFs?=')).toBe('Pay x Pal')
  })

  it('join two 3 MB words without running out of stack', () => {
    const word = '=?utf-8?B?' + btoa('a'.repeat(3_000_000)) + '?='
    expect(decodeEncodedWords(`${word} ${word}`)).toBe('a'.repeat(6_000_000))
  })

  it('leave a word that does not decode, and the space beside it, as written', () => {
    expect(decodeEncodedWords('=?x-made-up?B?VXJnZW50?= =?UTF-8?B?UGF5?=')).toBe('=?x-made-up?B?VXJnZW50?= Pay')
    expect(decodeEncodedWords('=?UTF-8?B?UGF5?= =?UTF-8?B?!!?=')).toBe('Pay =?UTF-8?B?!!?=')
  })
})

describe('quoted-printable over text already read as UTF-8', () => {
  it('keeps a raw non-ASCII character as its UTF-8 bytes, not its low byte', () => {
    expect([...quotedPrintableBytes('p\u0430y=3D')]).toEqual([112, 208, 176, 121, 61])
    expect(decodeEncodedWords('=?utf-8?Q?p\u0430ypal?=')).toBe('p\u0430ypal')
  })

  it('still reads each escape, and leaves a broken one as written', () => {
    expect(new TextDecoder().decode(quotedPrintableBytes('a=3Db=C3=A9=zz='))).toBe('a=bé=zz=')
  })
})

describe('a Return-Path that names no address', () => {
  it('says a null sender is null, not absent', () => {
    const bounce = analyseHeaders('Return-Path: <>\nFrom: Mailer <postmaster@bank.test>\nSubject: Undeliverable')
    expect(bounce.notes).not.toContain('No Return-Path — the envelope sender is not recorded.')
    expect(bounce.notes).toContain(
      'Return-Path is <>, a null envelope sender (the form RFC 5321 gives bounces and delivery notices), ' +
        'so there is no envelope domain to compare with From.'
    )
  })

  it('says a Return-Path of only a comment names no address', () => {
    expect(analyseHeaders('Return-Path: (none given)\nFrom: a@b.test').notes).toContain(
      'Return-Path names no address, so there is no envelope domain to compare with From.'
    )
  })
})

describe('format characters in the report', () => {
  it('show as code points inside the quoting, with line breaks still flattened to spaces', () => {
    expect(quoteUntrusted('scan\u202Efdp.exe')).toBe('`scan<U+202E>fdp.exe`')
    expect(quoteUntrusted('micro\u00ADsoft.test')).toBe('`micro<U+00AD>soft.test`')
    expect(quoteUntrusted('a\r\nb')).toBe('`a b`')
    // Already escaped is left alone, so no value is escaped twice.
    expect(quoteUntrusted('<U+202E>')).toBe('`<U+202E>`')
  })

  it('cannot let a direction override in the From domain reverse the report’s own sentences', () => {
    const md = formatHeaderReport(
      analyseHeaders(
        'From: PayPal <x@\u202Emoc.lapyap>\nReturn-Path: <bounce@evil.test>\n' +
          'Received: from a.test by b\u202Eevil.test; Mon, 1 Jan 2024 00:00:00 +0000'
      )
    )
    expect(md.split('\n').filter((line) => /\p{Cf}/u.test(line))).toEqual([])
    expect(md).toContain('From is at <U+202E>moc.lapyap; Return-Path is at evil.test. They differ.')
  })
})
