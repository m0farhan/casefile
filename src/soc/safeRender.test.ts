import { describe, it, expect } from 'vitest'
import { scrubRemoteEmbeds } from './safeRender'

describe('scrubRemoteEmbeds', () => {
  it('replaces remote markdown images with a defanged placeholder', () => {
    const out = scrubRemoteEmbeds('before ![pixel](https://evil.example/t.png "x") after')
    expect(out).toBe('before [remote image not loaded: hxxps://evil[.]example/t[.]png] after')
    expect(out).not.toContain('https://')
  })

  it('strips raw embed tags but keeps the surrounding text', () => {
    const md = 'a <img src="https://evil.example/p.gif"> b <iframe src="https://x"></iframe> c <video src=x></video>'
    expect(scrubRemoteEmbeds(md)).toBe('a  b  c ')
  })

  // Every one of these walked past the nine-tag list the scrub used to be.
  // They are here as named payloads rather than a loop so a regression says
  // which shape came back.
  it.each([
    ['style background-image', '<div style="background-image:url(https://evil.example/b?id=1)">x</div>'],
    ['image element', '<image src="https://evil.example/b">'],
    ['input type=image', '<input type=image src="https://evil.example/b">'],
    ['background attribute', '<table background="https://evil.example/b">x</table>'],
    ['inline svg image', '<svg><image href="https://evil.example/b"/></svg>'],
    ['protocol-relative src', '<div data-x><img src="//evil.example/b"></div>'],
    ['poster attribute', '<video poster="https://evil.example/b"></video>'],
    ['reference-style image', '![logo][r]\n\n[r]: https://evil.example/b.png']
  ])('removes the remote reference in %s', (_name, payload) => {
    expect(scrubRemoteEmbeds(payload)).not.toContain('evil.example')
  })

  it('leaves vault embeds and links alone', () => {
    const md = '![[screenshot.png]] [report](https://vendor.example/x)'
    expect(scrubRemoteEmbeds(md)).toBe(md)
  })
})
