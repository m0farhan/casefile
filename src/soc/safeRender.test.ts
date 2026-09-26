import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { App } from 'obsidian'
import { opensInApp } from './attachments'
import { neutralizeExternalLinks, scrubRemoteEmbeds } from './safeRender'

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

describe('opensInApp', () => {
  it('opens only what Obsidian shows itself', () => {
    for (const ext of ['png', 'PDF', 'md', 'canvas', 'base', 'mp4', 'opus']) expect(opensInApp(ext)).toBe(true)
    // Each of these would go to the system's default app: a browser, or a runner.
    for (const ext of ['html', 'htm', 'lnk', 'hta', 'docm', 'js', 'url', '']) expect(opensInApp(ext)).toBe(false)
  })
})

describe('neutralizeExternalLinks', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
  vi.stubGlobal('navigator', { clipboard: { writeText } })

  const FILES: Record<string, { path: string; extension: string }> = {
    'Invoice.html': { path: 'Cases/attachments/Invoice.html', extension: 'html' },
    'Payload.lnk': { path: 'Cases/attachments/Payload.lnk', extension: 'lnk' },
    'shot.png': { path: 'Cases/attachments/shot.png', extension: 'png' },
    Runbook: { path: 'Runbook.md', extension: 'md' }
  }
  const app = {
    metadataCache: { getFirstLinkpathDest: (path: string) => FILES[path] ?? null }
  } as unknown as App

  /** A rendered element stub: `closest` answers for the selectors the guard asks about. */
  function node(kind: 'embed' | 'internal' | 'external', attrs: Record<string, string>) {
    const el = {
      classList: { contains: (c: string) => kind === 'internal' && c === 'internal-link' },
      getAttribute: (name: string) => attrs[name] ?? null,
      closest: (sel: string) => {
        if (sel === 'a') return kind === 'embed' ? null : el
        return kind === 'external' ? null : el
      }
    }
    return el
  }

  function click(target: unknown, withApp = true) {
    const handlers: ((e: MouseEvent) => void)[] = []
    const host = { addEventListener: (_type: string, h: (e: MouseEvent) => void) => handlers.push(h) }
    if (withApp) neutralizeExternalLinks(host as unknown as HTMLElement, app, 'Cases/Case.md')
    else neutralizeExternalLinks(host as unknown as HTMLElement)
    const e = { target, preventDefault: vi.fn<() => void>(), stopPropagation: vi.fn<() => void>() }
    handlers[0](e as unknown as MouseEvent)
    return e
  }

  beforeEach(() => writeText.mockClear())

  it('copies the path of a dropped file Obsidian would hand to the system', () => {
    const e = click(node('embed', { src: 'Invoice.html' }))
    expect(e.preventDefault).toHaveBeenCalled()
    expect(e.stopPropagation).toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith('Cases/attachments/Invoice.html')
  })

  it('guards an internal link the same way, subpath and all', () => {
    const e = click(node('internal', { 'data-href': 'Payload.lnk#section' }))
    expect(e.preventDefault).toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith('Cases/attachments/Payload.lnk')
  })

  it('lets files Obsidian shows, and unresolved links, through untouched', () => {
    for (const target of [
      node('embed', { src: 'shot.png' }),
      node('internal', { 'data-href': 'Runbook' }),
      node('internal', { 'data-href': 'Not a note yet' })
    ]) {
      expect(click(target).preventDefault).not.toHaveBeenCalled()
    }
    expect(writeText).not.toHaveBeenCalled()
  })

  it('keeps the old one-argument behaviour for hosts that pass no app', () => {
    expect(click(node('embed', { src: 'Invoice.html' }), false).preventDefault).not.toHaveBeenCalled()
  })

  it('still copies external links defanged instead of opening them', () => {
    const e = click(node('external', { href: 'https://evil.example/x' }))
    expect(e.preventDefault).toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith('hxxps://evil[.]example/x')
  })
})
