import { describe, expect, it } from 'vitest'
import { EXECUTABLE_NAME, SCRIPT_CARRIER_NAME, SHORTCUT_NAME, entryNote } from './ooxml'
import { GAP } from './pdf'
import {
  apexDomain,
  attachmentFacts,
  charCount,
  contentMismatch,
  decodable,
  decodeEntities,
  entriesRead,
  extractLinks,
  hostFacts,
  htmlToText,
  showGaps,
  showsDerivedDomain,
  skeleton,
  sniffType,
  unwrapUrl,
  visibleText
} from './phish'

describe('unwrapUrl', () => {
  it('unwraps Microsoft Safe Links back to the address the sender wrote', () => {
    const wrapped = 'https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fevil.test%2Fgo&data=05%7C01'
    expect(unwrapUrl(wrapped)).toEqual({ target: 'https://evil.test/go', wrappedBy: 'Microsoft Safe Links' })
  })

  it('unwraps a long Proofpoint v3 link in linear time', () => {
    // The lazy /v3/__(.+?)__;/ restarted at every `/v3/__` and scanned to the
    // end: 300 KB of them took about ten seconds.
    const started = performance.now()
    const r = unwrapUrl(`https://urldefense.com${'/v3/__'.repeat(50_000)}`)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(r.wrappedBy).toBe('Proofpoint URL Defense')
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
    expect(attachmentFacts(att('invoice.pdf.exe'))).toContain(
      'double extension — the name ends .pdf.exe; with the last extension hidden it reads as .pdf'
    )
    expect(attachmentFacts(att('Invoice.pdf.lnk')).join(' ')).toContain('double extension — the name ends .pdf.lnk')
  })

  it('says nothing about a name that gives the same type twice, as scanners write them', () => {
    // "reads as pdf but is not" was said about Invoice.pdf.pdf, whose bytes are a PDF.
    for (const name of ['Invoice.pdf.pdf', 'scan.jpg.jpeg', 'page.htm.html', 'SCAN.PDF.pdf']) {
      expect(attachmentFacts(att(name)).join(' ')).not.toContain('double extension')
    }
  })

  it('catches a right-to-left override in the filename', () => {
    expect(attachmentFacts(att('invoice‮gpj.exe'))).toContain('contains a bidirectional override character')
  })

  it('calls a disk image a disk image, not an executable', () => {
    for (const name of ['Invoice.iso', 'x.vhd', 'backup.img', 'disk.vhdx']) {
      const facts = attachmentFacts(att(name))
      expect(facts).toContain('disk image — the files inside it are not listed here')
      expect(facts).not.toContain('executable or script file type')
    }
  })

  it('says only what the part’s own headers say about being inline', () => {
    expect(attachmentFacts(att('logo.png', true))).toContain('marked inline or given a Content-ID by its own headers')
  })

  it('says the same about a name at the top level as the ZIP reader says about an entry', () => {
    // .vbe and .cpl were flagged only inside a ZIP, .pif and .apk only outside
    // one, and .url, .chm and .xll nowhere.
    const rows: [RegExp, string, string][] = [
      [EXECUTABLE_NAME, 'executable or script file type', 'named like an executable or script'],
      [SCRIPT_CARRIER_NAME, 'file type that can carry script', 'named as a file type that can carry script'],
      [
        SHORTCUT_NAME,
        'shortcut-style file type — it names another location or program to open',
        'named as a shortcut-style file that names another location or program to open'
      ]
    ]
    for (const [list, fact, note] of rows) {
      const extensions = /\(([^)]+)\)/.exec(list.source)?.[1].split('|') ?? []
      expect(extensions.length).toBeGreaterThan(1)
      // Each row names its file, so a failure says which extension drifted.
      const names = extensions.map((ext) => `Invoice.${ext.toUpperCase()}`)
      expect(names.map((name) => [name, attachmentFacts(att(name)).includes(fact), entryNote(name)])).toEqual(
        names.map((name) => [name, true, note])
      )
    }
    // A shortcut, a help file and a console file are not programs.
    for (const name of ['a.url', 'b.chm', 'c.msc', 'd.iqy']) {
      expect(attachmentFacts(att(name))).not.toContain('executable or script file type')
    }
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

  it('keeps a real destination whatever sits in the anchor’s other attributes', () => {
    // A quoted `<` stops the anchor scan, and a quoted `>` before href did
    // too, so the decoy-drop deleted the real href when another anchor showed
    // it as text. Every attribute URL is a destination and is never dropped.
    const ltAfterHref =
      '<a href="https://evil.test/" title="<x">click</a> <a href="https://other.test/">https://evil.test/</a>'
    const gtBeforeHref =
      '<a title="x>y" href="https://evil.test/">click</a> <a href="https://other.test/">https://evil.test/</a>'
    for (const html of [ltAfterHref, gtBeforeHref]) {
      expect(links('', html).map((l) => l.target)).toContain('https://evil.test/')
    }
    expect(links('', '<a title="x>y" href="https://evil.test/">https://bank.test/</a>').map((l) => l.target)).toContain(
      'https://evil.test/'
    )
  })

  it('finds a visible URL after an escaped < in the text', () => {
    // Decoded before the strip, `&lt; b see …` became a tag that swallowed the URL.
    const html = "<p>if a &lt; b see https://x.test/ it's <b>ok</b></p>"
    expect(links('', html).map((l) => l.target)).toEqual(['https://x.test/'])
  })

  it('never reads the text on two sides of a tag as one URL', () => {
    // Stripped with nothing in its place, the cell after the URL ran on into it.
    const html = '<table><tr><td>https://a.test/x</td><td>more</td></tr></table>'
    expect(links('', html).map((l) => l.target)).toEqual(['https://a.test/x'])
  })

  it('does not hang on anchors or tags that never close', () => {
    for (const html of [
      '<a href=x '.repeat(10_000),
      Array.from({ length: 500 }, () => `<a href=https://e.test/${'a'.repeat(1_980)} `).join(''),
      '<'.repeat(1_000_000)
    ]) {
      const started = performance.now()
      links('', html)
      htmlToText(html)
      expect(performance.now() - started).toBeLessThan(2000)
    }
  })

  it('flags a javascript: target whatever the parser strips in front of it or inside it', () => {
    // `%01javascript:` unwraps to a target the browser follows as javascript:,
    // and the pattern the flag was read with could not see past the \u0001.
    const safe = (target: string): string =>
      `<a href="https://eur01.safelinks.protection.outlook.com/?url=${target}&amp;data=05">x</a>`
    for (const target of [
      '%01javascript%3Aalert(1)',
      '%20javascript%3Aalert(1)',
      '%0Ajavascript%3Aalert(1)',
      'java%09script%3Aalert(1)'
    ]) {
      const [link] = links('', safe(target))
      expect(link.flags).toContain('javascript: link, not a web address')
    }
    expect(links('', safe('%1Fdata%3Atext%2Fhtml%2Cx'))[0].flags.join(' ')).toContain('data: URL')
    // DEL is not stripped by the parser: that link does not go to javascript:.
    expect(links('', safe('%7Fjavascript%3Aalert(1)'))[0].flags).not.toContain('javascript: link, not a web address')
  })

  it('lists an href that begins with a control byte, as written', () => {
    const found = links('', '<a href="&#1;javascript:alert(1)">x</a>')
    expect(found).toHaveLength(1)
    expect(found[0].target).toBe('\u0001javascript:alert(1)')
    expect(found[0].flags).toContain('javascript: link, not a web address')
  })

  it('caps the link list and says how many it left out', () => {
    const html = Array.from({ length: 600 }, (_, i) => `<a href="http://e${i}.test/">x</a>`).join('')
    const out = extractLinks('', html, [])
    expect(out.links).toHaveLength(500)
    expect(out.dropped).toBe(100)
  })
})

describe('htmlToText — elements the scanner must not over-drop', () => {
  it('keeps <header> when dropping <head>', () => {
    // The live bug: `<head` matched `<header`, so the element most marketing
    // mail puts its lure in vanished with everything inside it.
    expect(htmlToText('<p>Hello</p><header>URGENT: verify your account</header><p>Regards</p>')).toBe(
      'Hello\nURGENT: verify your account\nRegards'
    )
  })

  it('still drops a real <head> and its contents', () => {
    expect(htmlToText('<head><title>t</title></head><p>Body</p>')).toBe('Body')
  })

  it('does not treat a tag name inside a quoted attribute as a tag', () => {
    // `<img alt="<script>">` used to swallow everything after it.
    expect(htmlToText('<img alt="<script>"><p>Click here to reset</p>')).toBe('Click here to reset')
  })

  it('a tag whose attribute contains > still ends at the real >', () => {
    expect(htmlToText('<img alt="a > b"><p>After</p>')).toBe('After')
  })

  it('an unterminated script still swallows the rest, which is the safe direction', () => {
    expect(htmlToText('<p>Before</p><script>var x = 1')).toBe('Before')
  })
})

describe('what a file actually is', () => {
  const bytes = (...b: number[]) => Uint8Array.from(b)

  it('reads the type from the first bytes', () => {
    expect(sniffType(bytes(0x4d, 0x5a, 0x90, 0x00))).toBe('Windows executable (MZ)')
    // Compound file and nothing more: an encrypted .xlsx and an .msi begin the same way.
    expect(sniffType(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe('OLE compound file')
    expect(sniffType(bytes(0x25, 0x50, 0x44, 0x46))).toBe('PDF')
    expect(sniffType(bytes(0x01, 0x02))).toBe('')
  })

  it('states the disagreement between the name and the bytes', () => {
    expect(contentMismatch('invoice.pdf', 'application/pdf', 'Windows executable (MZ)')).toBe(
      'named .pdf but the bytes begin as Windows executable (MZ)'
    )
    expect(contentMismatch('invoice.pdf', 'application/pdf', 'PDF')).toBe('')
    // .jfif is a JPEG name too, so a program under it is a mismatch.
    expect(contentMismatch('photo.jfif', '', 'Windows executable (MZ)')).toBe(
      'named .jfif but the bytes begin as Windows executable (MZ)'
    )
    expect(contentMismatch('photo.jfif', '', 'JPEG image')).toBe('')
  })

  it('knows a shortcut, a OneNote file and a cabinet by their headers', () => {
    const lnk = bytes(0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46, 0x9b)
    expect(sniffType(lnk)).toBe('Windows shortcut (LNK)')
    expect(contentMismatch('Invoice.pdf', 'application/pdf', sniffType(lnk))).toBe(
      'named .pdf but the bytes begin as Windows shortcut (LNK)'
    )
    const one = bytes(0xe4, 0x52, 0x5c, 0x7b, 0x8c, 0xd8, 0xa7, 0x4d, 0xae, 0xb1, 0x53, 0x78, 0xd0, 0x29, 0x96, 0xd3)
    expect(sniffType(one)).toBe('OneNote document')
    expect(contentMismatch('notes.one', '', 'OneNote document')).toBe('')
    expect(sniffType(bytes(0x4d, 0x53, 0x43, 0x46, 0, 0, 0, 0))).toBe('Microsoft cabinet (CAB)')
    expect(contentMismatch('setup.lnk', '', 'Windows executable (MZ)')).toBe(
      'named .lnk but the bytes begin as Windows executable (MZ)'
    )
  })

  it('names JPEG 2000 without calling it JPEG, which it is not', () => {
    const jp2 = bytes(0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a)
    const j2k = bytes(0xff, 0x4f, 0xff, 0x51)
    expect(sniffType(jp2)).toBe('JP2 image')
    expect(sniffType(j2k)).toBe('J2K image codestream')
    for (const label of [sniffType(jp2), sniffType(j2k)]) expect(label).not.toMatch(/JPEG/)
    expect(contentMismatch('scan.jpg', 'image/jpeg', sniffType(jp2))).toBe(
      'named .jpg but the bytes begin as JP2 image'
    )
  })

  it('says so when a promised format’s first bytes match nothing it knows', () => {
    // An HTA, an ISO or anything newer than the table, renamed Invoice.pdf,
    // used to draw no remark at all.
    expect(contentMismatch('Scan.pdf', 'application/pdf', '')).toBe(
      'named .pdf but its first bytes match no file signature this recognises'
    )
    expect(contentMismatch('scan', 'application/pdf', '')).toBe(
      'declared application/pdf but its first bytes match no file signature this recognises'
    )
    // Nothing was promised, so nothing is said.
    expect(contentMismatch('notes.txt', 'text/plain', '')).toBe('')
  })
})

describe('entriesRead', () => {
  it('counts what was read, in either directory', () => {
    expect(entriesRead(1)).toBe('1 entry read from the ZIP directory')
    expect(entriesRead(2, 'the compound-file directory')).toBe('2 entries read from the compound-file directory')
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

  it('drops a label that ends a sentence, as the visible-text scan read it', () => {
    const html = '<p>Sign in: <a href="http://evil.test/go">https://paypal.test/login.</a></p>'
    expect(extractLinks('', html, []).links.map((l) => l.target)).toEqual(['http://evil.test/go'])
  })
})

describe('a URL in prose ends where the sentence says it does', () => {
  it('leaves off the quotes and punctuation around it, ASCII or typographic', () => {
    // Outlook types curly quotes, and the closing one went into the link.
    const text =
      'Sign in at “https://login.evil-portal.test/verify” today, or «https://a.evil.test/x». Or https://x.test/v.'
    const html = '<p>Or ‘https://b.evil.test/y’.</p>'
    expect(
      extractLinks(text, html, [])
        .links.map((l) => l.raw)
        .sort()
    ).toEqual([
      'https://a.evil.test/x',
      'https://b.evil.test/y',
      'https://login.evil-portal.test/verify',
      'https://x.test/v'
    ])
  })

  it('keeps an attribute value exactly as written, punctuation and all', () => {
    const html =
      '<a href="javascript:void(0)">x</a><a href="https://en.wikipedia.test/wiki/Foo_(bar)">y</a>' +
      '<a href="https://q.test/a.">z</a><img src="https://z.test/c”">'
    expect(
      extractLinks('', html, [])
        .links.map((l) => l.raw)
        .sort()
    ).toEqual([
      'https://en.wikipedia.test/wiki/Foo_(bar)',
      'https://q.test/a.',
      'https://z.test/c”',
      'javascript:void(0)'
    ])
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
  it('names the derived domain beside the host', () => {
    expect(apexDomain('login.paypa1.test')).toBe('paypa1.test')
    expect(apexDomain('a.b.paypa1.co.uk')).toBe('paypa1.co.uk')
    expect(apexDomain('paypa1.test')).toBe('paypa1.test')
    expect(apexDomain('localhost')).toBe('localhost')
  })

  it('reads a generic second label under a country code as part of the suffix', () => {
    // co.id and com.vn are suffixes, not anyone's domain.
    expect(apexDomain('secure.bank-verify.co.id')).toBe('bank-verify.co.id')
    expect(apexDomain('x.victim-shop.com.vn')).toBe('victim-shop.com.vn')
    expect(apexDomain('a.shop.me.uk')).toBe('shop.me.uk')
    // Not a two-letter country code, so not a suffix pair.
    expect(apexDomain('m365-login.pages.dev')).toBe('pages.dev')
    // The brand label is read from the same place.
    expect(hostFacts('www.tokopedia.co.id', ['bca.co.id'])).toEqual([])
  })

  it('carries it on every link row', () => {
    const [link] = extractLinks('', '<a href="https://login.paypa1.co.uk/x">y</a>', []).links
    expect(link.host).toBe('login.paypa1.co.uk')
    expect(link.apexDomain).toBe('paypa1.co.uk')
  })
})

describe('a gap the PDF reader marked, as text leaves the analyser', () => {
  it('is shown as […] and is not counted or read as a character', () => {
    expect(showGaps(`co${GAP}l-split.com ${GAP}x${GAP}`)).toBe('co[…]l-split.com […]x[…]')
    expect(visibleText(`a\u202e${GAP}\tb`)).toBe('a<U+202E>[…]\tb')
    expect(charCount(`abc${GAP}d${GAP}`)).toBe(4)
    // A page of glyphs not decoded is not text a reader shows because a gap marks where it stopped.
    expect([decodable(`\uFFFD\uFFFD${GAP}`), decodable(`${GAP}x`)]).toEqual([false, true])
  })
})

describe('htmlToText — markup read the way a browser reads it', () => {
  it('ends on a close tag that never closes, rather than looping forever', () => {
    const started = performance.now()
    expect(htmlToText('<p>hi</p><script>x</script')).toBe('hi')
    expect(htmlToText('<head><title>x</title></head')).toBe('')
    expect(htmlToText(`<p>a</p>${'<style>x</style'.repeat(20_000)}`)).toBe('a')
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('ends a head with no </head> at <body>, and drops nothing when there is neither', () => {
    const html =
      '<html><head><meta charset="utf-8"><title>Notice</title><body><p>Reply to helpdesk@evil-reply.test</p></body></html>'
    expect(htmlToText(html)).toBe('Reply to helpdesk@evil-reply.test')
    expect(htmlToText('<head><p>Server 203.0.113.50</p>')).toBe('Server 203.0.113.50')
    // Many heads that end at <body>, with one </head> far away, stay linear.
    const started = performance.now()
    htmlToText(`${'<head><body>'.repeat(50_000)}</head>`)
    htmlToText('<head></head>'.repeat(50_000))
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('does not backtrack over a long run of spaces after a <', () => {
    const started = performance.now()
    expect(htmlToText(`<p>a</p><${' '.repeat(100_000)}x`)).toBe('a\n< x')
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('ends a comment where a browser does, <!-->, <!---> and --!> included', () => {
    for (const comment of ['<!-->', '<!--->', '<!---->', '<!-- a --!>']) {
      expect(htmlToText(`<p>Hi</p>${comment}<p>Reply to x@evil.test</p>`)).toBe('Hi\nReply to x@evil.test')
    }
    const started = performance.now()
    htmlToText(`${'<!-- a -->'.repeat(50_000)}<!-- open`)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('reads a < that begins no tag as text, so the script after it is still dropped', () => {
    expect(
      htmlToText(`<p>Spend < $100 and don't miss out</p><script>var c2="198.51.100.7";</script><p>Click</p>`)
    ).toBe("Spend < $100 and don't miss out\nClick")
    expect(htmlToText('<p>a < b and <b>c</b></p>')).toBe('a < b and c')
    expect(
      extractLinks('', "<p>Orders < $5 don't wait: https://evil.test/pay today</p>", []).links.map((l) => l.raw)
    ).toEqual(['https://evil.test/pay'])
  })

  it('decodes a numeric reference without its semicolon, every digit of it', () => {
    expect(decodeEntities('https:&#47&#47e.test/a')).toBe('https://e.test/a')
    expect(decodeEntities('&#00000047;&#x2f')).toBe('//')
    expect(decodeEntities('&#99999999999999999999; &amp &amp;')).toBe('&#99999999999999999999; &amp &')
    expect(extractLinks('', '<a href="https:&#47&#47evil-nosemi.test/login">Sign in</a>', []).links[0].host).toBe(
      'evil-nosemi.test'
    )
  })
})

describe('a link to an IP address, and a brand list with comments', () => {
  it('gives an IP address no derived domain of its last two octets', () => {
    expect(apexDomain('198.51.100.7')).toBe('198.51.100.7')
    const [link] = extractLinks('', '<img src="http://198.51.100.7/beacon.gif">', []).links
    expect(showsDerivedDomain(link)).toBe(false)
  })

  it('never matches a # comment line in the brand list as a brand', () => {
    // One character from the brand it comments out, it was reported as a look-alike of `#paypal`.
    expect(hostFacts('paypal.test', ['#paypal', '# PayPal, ticket SEC-1'])).toEqual([])
    expect(hostFacts('paypai.test', ['# note', 'paypal'])).toEqual(['one character away from "paypal"'])
  })
})
