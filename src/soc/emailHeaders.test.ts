import { describe, expect, it } from 'vitest'
import { addressOf, analyseHeaders, decodeEncodedWords, formatHeaderReport, parseHeaderBlock } from './emailHeaders'

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
      detail: 'smtp.mailfrom=bounce@cheap-vps.example'
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
    expect(a.observations).toContain('From is at paypa1.test; Return-Path is at cheap-vps.example. They differ.')
    expect(a.observations).toContain('From is at paypa1.test; Reply-To is at mail-verify.test. They differ.')
    expect(a.observations).toContain(
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
    expect(md).toContain('### Indicators\n\n- email: a[at]b[.]test')
  })
})
