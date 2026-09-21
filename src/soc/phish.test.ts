import { describe, expect, it } from 'vitest'
import { attachmentFacts, contentMismatch, extractLinks, hostFacts, skeleton, sniffType, unwrapUrl } from './phish'

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
  const { links } = extractLinks('Visit https://paypa1.test/payment', html, ['paypal'])

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
    inline,
    undecodable: false
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

describe('link evasions that used to mislead or hide', () => {
  const links = (text: string, html: string, brands: string[] = []) => extractLinks(text, html, brands).links

  it('a gateway name in the QUERY does not make the link a gateway link', () => {
    // Substring matching handed the attacker the label: this reported
    // "unwrapped from Microsoft Safe Links → paypal.test" for a link that
    // goes to evil.test.
    const crafted = 'https://evil.test/?x=safelinks.protection.outlook.com&url=https%3A%2F%2Fpaypal.test'
    expect(unwrapUrl(crafted)).toEqual({ target: crafted, wrappedBy: '' })
  })

  it('finds an unquoted href', () => {
    expect(links('', '<a href=http://evil.test/go>Sign in</a>').map((l) => l.target)).toEqual(['http://evil.test/go'])
  })

  it('decodes character references before reading the URL', () => {
    const html = '<a href="http&#58;&#x2F;&#x2F;evil.test&#x2F;go">x</a>'
    expect(links('', html).map((l) => l.target)).toEqual(['http://evil.test/go'])
  })

  it('keeps a non-http link instead of reporting "none found"', () => {
    const found = links('', '<a href="data:text/html;base64,PGh0bWw+">Open</a>')
    expect(found).toHaveLength(1)
    expect(found[0].flags.join(' ')).toContain('data: URL')
  })

  it('finds a URL in a form action, a CSS url() and a srcset', () => {
    const html =
      '<form action="http://collect.test/p"></form>' +
      '<div style="background:url(http://beacon.test/b.gif)"></div>' +
      '<img srcset="http://cdn.test/a.png 1x, http://cdn.test/b.png 2x">'
    const targets = links('', html)
      .map((l) => l.target)
      .sort()
    expect(targets).toContain('http://collect.test/p')
    expect(targets).toContain('http://beacon.test/b.gif')
    expect(targets).toContain('http://cdn.test/a.png')
  })

  it('names userinfo for what it is', () => {
    const found = links('', '<a href="https://paypal.test@evil.test/go">x</a>')
    expect(found[0].flags.join(' ')).toContain('username, not the site')
  })

  it('folds a literal Unicode host, which URL parsing would have punycoded away', () => {
    const found = links('', '<a href="https://рaypal.test/login">x</a>', ['paypal'])
    expect(found[0].flags).toContain('reads as "paypal" once look-alike characters are folded')
  })

  it('compares against the right label under a two-part suffix', () => {
    expect(hostFacts('login.paypa1.co.uk', ['paypal'])).toContain(
      'reads as "paypal" once look-alike characters are folded'
    )
  })

  it('says nothing about a brand listed only as a name on its own domain', () => {
    // With bare names there is nothing to tell the real site from a look-alike
    // TLD, so the tool stays quiet rather than crying wolf on genuine mail.
    expect(hostFacts('paypal.test', ['paypal'])).toEqual([])
  })

  it('flags the brand on another domain once a known-good domain is listed', () => {
    expect(hostFacts('paypal.co', ['paypal.test'])).toContain(
      'the name "paypal" on paypal.co, which is not paypal.test or a subdomain of it'
    )
    expect(hostFacts('mail.paypal.test', ['paypal.test'])).toEqual([])
  })

  it('does not hang on thousands of unclosed anchors', () => {
    const html = '<a href="http://evil.test/go">text'.repeat(20_000)
    const started = performance.now()
    const found = links('', html)
    expect(performance.now() - started).toBeLessThan(2000)
    expect(found.map((l) => l.target)).toEqual(['http://evil.test/go'])
  })

  it('caps the link list and says how many it left out', () => {
    const html = Array.from({ length: 600 }, (_, i) => `<a href="http://e${i}.test/">x</a>`).join('')
    const out = extractLinks('', html, [])
    expect(out.links).toHaveLength(500)
    expect(out.dropped).toBe(100)
  })
})

describe('what a file actually is', () => {
  const bytes = (...b: number[]) => Uint8Array.from(b)

  it('reads the type from the first bytes', () => {
    expect(sniffType(bytes(0x4d, 0x5a, 0x90, 0x00))).toBe('Windows executable (MZ)')
    expect(sniffType(bytes(0x25, 0x50, 0x44, 0x46))).toBe('PDF')
    expect(sniffType(bytes(0x01, 0x02))).toBe('')
  })

  it('states the disagreement between the name and the bytes', () => {
    expect(contentMismatch('invoice.pdf', 'application/pdf', 'Windows executable (MZ)')).toBe(
      'named .pdf but the bytes begin as Windows executable (MZ)'
    )
    expect(contentMismatch('invoice.pdf', 'application/pdf', 'PDF')).toBe('')
  })
})
