import { describe, expect, it } from 'vitest'
import {
  apexDomain,
  attachmentFacts,
  contentMismatch,
  extractLinks,
  hostFacts,
  htmlToText,
  skeleton,
  sniffType,
  unwrapUrl
} from './phish'

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

  it('stops after a bounded number of unwraps instead of following the whole chain', () => {
    // The old version of this test only asserted "does not throw", which a
    // five-deep chain satisfies whether or not any bound exists. Ten wrappers
    // with a distinct innermost target proves the loop STOPS: after five
    // rounds the target is still a Safe Links URL, not evil.test.
    let url = 'https://evil.test/go'
    for (let i = 0; i < 10; i++) {
      url = `https://x.safelinks.protection.outlook.com/?url=${encodeURIComponent(url)}`
    }
    const { target, wrappedBy } = unwrapUrl(url)
    expect(wrappedBy).toBe('Microsoft Safe Links')
    expect(target).not.toBe('https://evil.test/go')
    expect(target).toContain('safelinks.protection.outlook.com')
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
    undecodable: false,
    exact: true
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

describe('gateway unwrapping cannot be steered by the attacker', () => {
  it('will not treat google.<attacker domain> as the Google redirector', () => {
    // `google\.[a-z.]+$` let the suffix swallow a whole attacker domain, so a
    // link the browser sends to evil.com was reported as going to paypal.test.
    const crafted = 'https://google.evil.com/url?q=https://paypal.test/'
    expect(unwrapUrl(crafted)).toEqual({ target: crafted, wrappedBy: '' })
    expect(unwrapUrl('https://accounts.google.evil.test/url?q=https://paypal.test/').wrappedBy).toBe('')
  })

  it('still unwraps the real Google redirector on its real suffixes', () => {
    for (const host of ['www.google.com', 'google.de', 'www.google.co.uk']) {
      expect(unwrapUrl(`https://${host}/url?q=https://evil.test/go`).target).toBe('https://evil.test/go')
    }
  })

  it('does not percent-decode a target the gateway already decoded', () => {
    // searchParams.get() decodes once. Decoding again turned this into a
    // different URL from the one the gateway actually redirects to, so the row
    // named a host the victim never reaches.
    const wrapped =
      'https://eur01.safelinks.protection.outlook.com/?url=' +
      encodeURIComponent('https://evil.test/a?next=https%3A%2F%2Fpaypal.test')
    expect(unwrapUrl(wrapped).target).toBe('https://evil.test/a?next=https%3A%2F%2Fpaypal.test')
  })
})

describe('an anchor label is dropped only when nothing else found it', () => {
  it('keeps a URL that is a decoy label in the HTML and a real link in the text', () => {
    // The mail says "type this address" in the plain part and uses the same
    // string as the visible text of a link pointing elsewhere. It is genuinely
    // clickable in a plain-text client, so it is a destination.
    const text = 'Or go to https://paypal.test/signin yourself.'
    const html = '<a href="http://evil.test/go">https://paypal.test/signin</a>'
    const targets = extractLinks(text, html, []).links.map((l) => l.target)
    expect(targets).toContain('https://paypal.test/signin')
    expect(targets).toContain('http://evil.test/go')
  })

  it('still drops a label that appears nowhere else', () => {
    const html = '<a href="http://evil.test/go">https://paypal.test/signin</a>'
    const targets = extractLinks('', html, []).links.map((l) => l.target)
    expect(targets).toEqual(['http://evil.test/go'])
  })
})

describe('htmlToText — the words the victim read', () => {
  it('drops stylesheet and script CONTENT, not just their tags', () => {
    // Phishing HTML is mostly style block. Stripping tags alone leaves the CSS
    // as the first thing in the pane, which defeats the whole point.
    const html =
      '<html><head><style>.a{color:#fff;background:url(http://x.test/b.gif)}</style></head>' +
      '<body><script>var c2="http://evil.test"</script><p>Your account is limited.</p></body></html>'
    expect(htmlToText(html)).toBe('Your account is limited.')
  })

  it('removes an Outlook conditional comment, which contains a >', () => {
    // `<[^>]*>` closes this early and the rest leaks in as if it were read.
    const html = '<!--[if mso]><table><tr><td><![endif]--><p>Verify now</p>'
    expect(htmlToText(html)).toBe('Verify now')
  })

  it('keeps text the victim saw that only looks like markup', () => {
    // Strip-then-decode. Decoding first would turn this into a tag and delete it.
    expect(htmlToText('<p>Click &lt;here&gt; to continue</p>')).toBe('Click <here> to continue')
  })

  it('breaks block elements onto their own lines and collapses the rest', () => {
    const html = '<div>Dear    user</div><p>Your account\n  is limited.</p><br><span>Act now</span>'
    expect(htmlToText(html)).toBe('Dear user\nYour account is limited.\nAct now')
  })

  it('decodes the entities a lure hides its words in', () => {
    expect(htmlToText('<p>P&#97;yP&#x61;l&nbsp;Security</p>')).toBe('PayPal Security')
  })

  it('treats an unterminated script as swallowing the rest, which is the safe direction', () => {
    expect(htmlToText('<p>Hello</p><script>var x = 1; // never closed')).toBe('Hello')
  })

  it('does not hang on a large body full of unterminated opens', () => {
    const html = '<script>x'.repeat(50_000) + '<p>text</p>'
    const started = performance.now()
    htmlToText(html)
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('says nothing about whether any of it was styled invisible', () => {
    // Preheader text is legitimate and on nearly every marketing-shaped mail.
    // A hidden-text flag would fire constantly and would be a verdict.
    const html = '<div style="display:none">preheader</div><p>Real text</p>'
    expect(htmlToText(html)).toBe('preheader\nReal text')
  })
})

describe('PhishTool parity on the parsed model', () => {
  it('names the registrable domain beside the host', () => {
    expect(apexDomain('login.paypa1.test')).toBe('paypa1.test')
    expect(apexDomain('a.b.paypa1.co.uk')).toBe('paypa1.co.uk')
    expect(apexDomain('paypa1.test')).toBe('paypa1.test')
    expect(apexDomain('localhost')).toBe('localhost')
  })

  it('carries it on every link row', () => {
    const [link] = extractLinks('', '<a href="https://login.paypa1.co.uk/x">y</a>', []).links
    expect(link.host).toBe('login.paypa1.co.uk')
    expect(link.apexDomain).toBe('paypa1.co.uk')
  })
})
