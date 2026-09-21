import { describe, expect, it } from 'vitest'
import { attachmentFacts, extractLinks, hostFacts, skeleton, unwrapUrl } from './phish'

describe('unwrapUrl', () => {
  it('unwraps Microsoft Safe Links back to the address the sender wrote', () => {
    const wrapped = 'https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fevil.test%2Fgo&data=05%7C01'
    expect(unwrapUrl(wrapped)).toEqual({ target: 'https://evil.test/go', wrappedBy: 'Microsoft Safe Links' })
  })

  it('unwraps Proofpoint v3 and v2', () => {
    expect(unwrapUrl('https://urldefense.com/v3/__https://evil.test/go__;!!abc$').target).toBe('https://evil.test/go')
    expect(unwrapUrl('https://urldefense.proofpoint.com/v2/url?u=https-3A__evil.test_go&d=DwMFaQ').target).toBe(
      'https://evil.test/go'
    )
  })

  it('names the gateway even when the target is opaque, rather than pretending it unwrapped', () => {
    const r = unwrapUrl('https://protect-eu.mimecast.com/s/AbCd123')
    expect(r.wrappedBy).toBe('Mimecast')
    expect(r.target).toBe('https://protect-eu.mimecast.com/s/AbCd123')
  })

  it('leaves an ordinary link alone', () => {
    expect(unwrapUrl('https://example.test/a')).toEqual({ target: 'https://example.test/a', wrappedBy: '' })
  })

  it('does not unwrap forever', () => {
    // Safe Links wrapping Safe Links wrapping Safe Links…
    let url = 'https://evil.test/go'
    for (let i = 0; i < 10; i++) {
      url = `https://x.safelinks.protection.outlook.com/?url=${encodeURIComponent(url)}`
    }
    expect(() => unwrapUrl(url)).not.toThrow()
  })
})

describe('hostFacts', () => {
  it('folds look-alike characters before comparing to a brand', () => {
    expect(skeleton('paypa1')).toBe('paypal')
    expect(hostFacts('login.paypa1.test', ['paypal'])).toContain(
      'reads as "paypal" once look-alike characters are folded'
    )
  })

  it('catches a Cyrillic homoglyph', () => {
    expect(hostFacts('рaypal.test', ['paypal'])).toContain('reads as "paypal" once look-alike characters are folded')
  })

  it('reports a one-character difference', () => {
    expect(hostFacts('paypall.test', ['paypal'])).toContain('one character away from "paypal"')
  })

  it('says nothing about the real domain', () => {
    expect(hostFacts('paypal.test', ['paypal'])).toEqual([])
  })

  it('reports punycode and bare IPs as facts', () => {
    expect(hostFacts('xn--80ak6aa92e.test', [])).toContain(
      'punycode host — the name shown in a client may not be the name here'
    )
    expect(hostFacts('203.0.113.9', [])).toContain('link points at a bare IP address, not a name')
  })

  it('has no opinion without a brand list — the plugin does not ship one', () => {
    expect(hostFacts('paypa1.test', [])).toEqual([])
  })
})

describe('extractLinks', () => {
  const html = '<a href="http://evil.test/go">https://paypal.test/account</a><img src="http://track.example/p.gif">'
  const links = extractLinks('Visit https://paypa1.test/payment', html, ['paypal'])

  it('finds links in the plain text and in the HTML source', () => {
    expect(links.map((l) => l.raw).sort()).toEqual([
      'http://evil.test/go',
      'http://track.example/p.gif',
      'https://paypa1.test/payment'
    ])
  })

  it('states when the visible link text disagrees with the destination', () => {
    const shown = links.find((l) => l.raw === 'http://evil.test/go')
    expect(shown?.flags).toContain('shown as a link to paypal.test, points at evil.test')
  })

  it('carries the look-alike facts through to the finding', () => {
    const lookalike = links.find((l) => l.host === 'paypa1.test')
    expect(lookalike?.flags).toContain('reads as "paypal" once look-alike characters are folded')
  })
})

describe('attachmentFacts', () => {
  const att = (filename: string, inline = false) => ({
    filename,
    contentType: 'application/octet-stream',
    size: 1,
    bytes: new Uint8Array(1),
    inline
  })

  it('names macro-capable, executable and archive types', () => {
    expect(attachmentFacts(att('invoice.docm'))).toContain('file type that can carry macros')
    expect(attachmentFacts(att('setup.hta'))).toContain('executable or script file type')
    expect(attachmentFacts(att('files.7z'))).toContain('archive — its contents are not visible from here')
  })

  it('catches the double extension that reads as a document', () => {
    expect(attachmentFacts(att('invoice.pdf.exe'))).toContain('double extension — reads as pdf but is not')
  })

  it('catches a right-to-left override in the filename', () => {
    expect(attachmentFacts(att('invoice‮gpj.exe'))).toContain('contains a bidirectional override character')
  })

  it('never calls anything malicious', () => {
    const all = [att('invoice.docm'), att('a.exe'), att('b.zip')].flatMap(attachmentFacts)
    expect(all.join(' ')).not.toMatch(/malicious|phish|suspicious|dangerous/i)
  })
})
