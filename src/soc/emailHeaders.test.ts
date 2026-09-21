import { describe, expect, it } from 'vitest'
import {
  addressOf,
  analyseHeaders,
  decodeEncodedWords,
  formatDelay,
  formatHeaderReport,
  parseHeaderBlock
} from './emailHeaders'

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
  const a = analyseHeaders(SPOOF, ['corp.test'])

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

  it('defangs the indicators it pulls out and marks the analyst’s own estate', () => {
    expect(a.indicators).toContain('ip: 203[.]0[.]113[.]55')
    expect(a.indicators.join('\n')).not.toMatch(/(^|\s)203\.0\.113\.55/)
    // The analyst's own mail relay is marked, so it never reads as an indicator.
    expect(a.indicators).toContain('ip: 10[.]4[.]1[.]9 (own asset)')
    expect(a.indicators).toContain('email: analyst[at]corp[.]test (own asset)')
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
    expect(a.auth[0].assertedBy).toContain('ARC — relayed claim')
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
