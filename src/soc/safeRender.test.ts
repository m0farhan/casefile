import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { App } from 'obsidian'
import { opensInApp } from './attachments'
import { fenceVerbatim, neutralizeExternalLinks, scrubRemoteEmbeds } from './safeRender'

describe('fenceVerbatim', () => {
  it('keeps every byte inside one fence nothing inside can close', () => {
    const md = 'a ``` b\n````\n`c`'
    expect(fenceVerbatim(md)).toBe(`\`\`\`\`\`\n${md}\n\`\`\`\`\``)
    expect(fenceVerbatim('plain')).toBe('```\nplain\n```')
  })
})

describe('scrubRemoteEmbeds', () => {
  // Shown as source means exactly fenceVerbatim's output: the input, every
  // byte, inside one fence that nothing inside it can close.
  it.each([
    ['a remote markdown image', 'before ![pixel](https://evil.example/t.png "x") after'],
    ['embed tags', 'a <img src="https://evil.example/p.gif"> b <iframe src="https://x"></iframe> c']
  ])('shows text holding %s as source, every byte kept', (_name, md) => {
    expect(scrubRemoteEmbeds(md)).toBe(fenceVerbatim(md))
  })

  // Named payloads rather than a loop, so a regression says which shape came
  // back. The first group walked past the nine-tag list the scrub once was;
  // the second walked past the shape list that replaced it.
  it.each([
    ['style background-image', '<div style="background-image:url(https://evil.example/b?id=1)">x</div>'],
    ['image element', '<image src="https://evil.example/b">'],
    ['input type=image', '<input type=image src="https://evil.example/b">'],
    ['background attribute', '<table background="https://evil.example/b">x</table>'],
    ['inline svg image', '<svg><image href="https://evil.example/b"/></svg>'],
    ['protocol-relative src', '<div data-x><img src="//evil.example/b"></div>'],
    ['poster attribute', '<video poster="https://evil.example/b"></video>'],
    ['reference-style image', '![logo][r]\n\n[r]: https://evil.example/b.png'],
    ['nested brackets in alt text', '![a [b] c](https://evil.example/n.png)'],
    ['escaped bracket in alt text', '![a\\]b](https://evil.example/e.png)'],
    ['escaped colon in the scheme', '![x](https\\://evil.example/bs.png)'],
    ['entity for a scheme letter', '![x](&#104;ttps://evil.example/h.png)'],
    ['entity for the scheme colon', '![x](https&#58;//evil.example/c.png)'],
    ['definition with its URL on the next line', '![logo][r]\n\n[r]:\nhttps://evil.example/r.png'],
    ['definition inside a quote', '![logo][r]\n\n> [r]: https://evil.example/q.png'],
    ['quoted > before the style', '<div title=">" style="background-image:url(https://evil.example/d.png)">x</div>'],
    ['quoted > before the background', '<table title=">" background="https://evil.example/t.png">x</table>'],
    ['entity inside url(', '<div style="background:u&#114;l(https://evil.example/u.png)">x</div>'],
    ['entity in the url( scheme', '<div style="background:url(&#104;ttps://evil.example/v.png)">x</div>'],
    ['image-set', `<div style="background-image:image-set('https://evil.example/s.png' 1x)">x</div>`],
    ['style @import', '<style>@import "https://evil.example/i.css";</style>'],
    ['forged internal-link overlay', '<a class="internal-link" style="position:fixed;inset:0" href="Case">x</a>']
  ])('shows %s as source', (_name, payload) => {
    expect(scrubRemoteEmbeds(payload)).toBe(fenceVerbatim(payload))
  })

  // Each of these hides live markup behind something a simple scan reads as
  // code — a backtick pair on one line, or a fence — while the renderer reads
  // the backtick or the fence line as part of something else.
  it.each([
    ['a backtick inside a link destination', '[x](a`b) <img src="https://evil.example/l.png"> `'],
    ['a backtick inside a link title', '[x](/u "a `b") <img src="https://evil.example/t.png"> `'],
    ['a span opened on the line before', '`x\ny ` <img src="https://evil.example/m.png"> `'],
    ['emphasis that runs over the opener', '*a `b* <img src="https://evil.example/e.png"> `'],
    ['an opener glued to a bare URL', 'https://ok.example/`a <img src="https://evil.example/u.png"> `'],
    ['an escaped opener', '\\`a <img src="https://evil.example/x.png"> `'],
    ['a table cell boundary inside the pair', 'a | b\n--|--\n`x | <img src="https://evil.example/c.png"> | y`'],
    ['inline math over the opener', '$a `b$ <img src="https://evil.example/m.png"> `'],
    ['paragraphs split by lone carriage returns', '`a\r\r<img src="https://evil.example/r.png">\r\rb`'],
    ['a tilde fence holding a fence line', '~~~\n```\n~~~\n<img src="https://evil.example/f.png">\n```'],
    ['an indented fence', '  ```\nx\n```\n<img src="https://evil.example/i.png">\n```'],
    ['a math block holding a fence line', '$$\n```\n$$\n<img src="https://evil.example/b.png">\n```'],
    ['a comment block holding a fence line', '%%\n```\n%%\n<img src="https://evil.example/k.png">\n```'],
    ['a comment opened mid-line before a fence', 'a %%\n\n```\n%%<img src="https://evil.example/j.png">\n```'],
    ['math opened mid-line before a fence', 'a $$\n\n```\n$$ <img src="https://evil.example/w.png">\n```'],
    ['a comment opened a paragraph earlier', 'a %%\n\nb `x %% <img src="https://evil.example/p.png"> `'],
    ['one-tilde strikethrough over the opener', '~a `b~ <img src="https://evil.example/s.png"> `'],
    ['front matter holding a fence line', '---\n\n```\n---\n<img src="https://evil.example/y.png">\n```'],
    ['a fence another plugin renders', '```mermaid\n<img src="https://evil.example/g.png">\n```'],
    ['a fence line that closes untidily', '```\na ``` b\n```\n<img src="https://evil.example/z.png">\n```'],
    ['a fence never closed', '```\n<img src="https://evil.example/o.png">']
  ])('shows markup behind %s as source', (_name, payload) => {
    expect(scrubRemoteEmbeds(payload)).toBe(fenceVerbatim(payload))
  })

  it.each([
    ['vault embeds and links', '![[screenshot.png]] [report](https://vendor.example/x)'],
    ['a wiki embed', '![[s.png]]'],
    ['an address quoted as code', 'Sender `Name <a@b.com>` spoofed the CEO'],
    ['an image quoted as code', 'Seen: (`![](https://evil.example/p.png)`)'],
    ['a comparison', 'score a < 5 and b > 2'],
    ['a pixel quoted in a code block', 'Pixel in the body:\n\n```\n<img src="https://tracker.example/p.gif">\n```'],
    [
      'the phishing report shape',
      '- From: `Mallory <m@evil.example>`\n- Subject: ``Pay `now` <b>due</b>``\n\nHTML source, not rendered:\n\n````\n<html><img src="https://evil.example/p"></html>\n```\n````'
    ],
    ['a paste already quarantined', fenceVerbatim('Rule : x\n<img src="https://evil.example/p">\n```js\ncode\n```')]
  ])('leaves %s as it is', (_name, md) => {
    expect(scrubRemoteEmbeds(md)).toBe(md)
  })

  it('fences once: its own output passes through', () => {
    const once = scrubRemoteEmbeds('<img src="https://evil.example/p"> ```` x')
    expect(scrubRemoteEmbeds(once)).toBe(once)
  })

  // The shape list this replaced was quadratic, and cubic on '![](http:',
  // on text it runs over at every render. 200 ms is far above the linear
  // cost and far below the seconds each of these took.
  it.each([
    ['<img ', '<img '.repeat(50_000)],
    ['![a](https://x', '![a](https://x'.repeat(20_000)],
    ['[x newline', '[x\n'.repeat(60_000)],
    ['spans on one line', '`a` '.repeat(60_000) + '<b>'],
    ['mixed runs', '` `` '.repeat(50_000)],
    ['a fenced payload', `\`\`\`\n${'<img '.repeat(50_000)}\n\`\`\``]
  ])('stays fast on %s', (_name, md) => {
    const start = performance.now()
    scrubRemoteEmbeds(md)
    expect(performance.now() - start).toBeLessThan(200)
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
