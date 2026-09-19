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

  it('leaves vault embeds and links alone', () => {
    const md = '![[screenshot.png]] [report](https://vendor.example/x)'
    expect(scrubRemoteEmbeds(md)).toBe(md)
  })
})
