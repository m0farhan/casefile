import { describe, expect, it } from 'vitest'
import { extractAttachmentRefs, refExtension } from './attachments'

describe('extractAttachmentRefs', () => {
  it('collects embed wikilinks', () => {
    expect(extractAttachmentRefs(['See ![[screenshot.png]] above'])).toEqual(['screenshot.png'])
  })

  it('collects plain wikilinks that name a file', () => {
    expect(extractAttachmentRefs(['Report in [[evidence/dump.pdf]]'])).toEqual(['evidence/dump.pdf'])
  })

  it('excludes bare note wikilinks (no extension)', () => {
    expect(extractAttachmentRefs(['Linked to [[Incident runbook]] and [[Report v2.1]]'])).toEqual([])
  })

  it('collects local markdown images and decodes %20', () => {
    expect(extractAttachmentRefs(['![alt](attachments/mem%20dump.png)'])).toEqual(['attachments/mem dump.png'])
  })

  it('excludes external http/https URLs', () => {
    expect(extractAttachmentRefs(['![ext](https://evil.example.com/x.png) and ![e2](http://a.io/b.jpg)'])).toEqual([])
  })

  it('strips |alias and #subpath in either order', () => {
    expect(
      extractAttachmentRefs(['![[pcap.pdf|the capture]] [[log.txt#section]] [[a.png#x|y]] [[b.png|y#x]]'])
    ).toEqual(['pcap.pdf', 'log.txt', 'a.png', 'b.png'])
  })

  it('dedups preserving first-seen order across texts', () => {
    expect(extractAttachmentRefs(['![[a.png]] then [[b.pdf]]', 'again ![[a.png]] and ![[c.jpg]]'])).toEqual([
      'a.png',
      'b.pdf',
      'c.jpg'
    ])
  })

  it('handles empty input', () => {
    expect(extractAttachmentRefs([])).toEqual([])
    expect(extractAttachmentRefs(['', 'no links here'])).toEqual([])
  })

  it('unwraps <angle-bracket> markdown paths and drops "title" parts', () => {
    expect(extractAttachmentRefs(['![a](<mem dump.png>) ![b](shot.png "a title")'])).toEqual([
      'mem dump.png',
      'shot.png'
    ])
  })
})

describe('refExtension', () => {
  it('extracts lowercase extensions and rejects digit-only tails', () => {
    expect(refExtension('a/B.PNG')).toBe('png')
    expect(refExtension('archive.7z')).toBe('7z')
    expect(refExtension('Report v2.1')).toBe('')
    expect(refExtension('plain note')).toBe('')
  })
})
