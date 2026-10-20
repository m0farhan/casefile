import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('note-timeline.css in Live Preview', () => {
  const css = readFileSync(new URL('../src/styles/note-timeline.css', import.meta.url), 'utf8')
  const rule = (selector: string): string => {
    const at = css.indexOf(`${selector} {`)
    expect(at, selector).toBeGreaterThanOrEqual(0)
    return css.slice(at, css.indexOf('}', at))
  }

  it('draws the header inline, so the buffers CodeMirror puts around a widget share its row', () => {
    // A block header (display: flex) stood between CodeMirror's two inline
    // buffer images, which then took a blank row each, above and below it.
    expect(rule('.markdown-source-view.mod-cm6 .cm-line.cf-ntl-marker-line .cf-ntl-header')).toContain(
      'display: inline-flex;'
    )
    expect(rule('.markdown-source-view.mod-cm6 .cm-line.cf-ntl-marker-line')).toContain('white-space: nowrap;')
  })

  it('takes the link look off links that leave the vault only: a note link opens, so it looks like one', () => {
    // The formatter breaks a long selector over lines: compare without whitespace.
    const flat = css.replace(/\s+/g, '')
    const at = flat.indexOf('.markdown-source-view.mod-cm6.cf-ntl-line:is(.cm-url,')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(flat.slice(at, flat.indexOf('{', at))).toContain(':not(.cm-hmd-internal-link,.cm-hmd-internal-link*)')
  })

  it("keeps a folded card's fold arrow, so a click can open it again", () => {
    expect(css).not.toContain('.cf-ntl-line .cm-fold-indicator .collapse-indicator')
    expect(css).toContain('.cf-ntl-line .cm-fold-indicator:not(.is-collapsed) .collapse-indicator')
  })
})

describe('note-timeline.css for every style', () => {
  const css = readFileSync(new URL('../src/styles/note-timeline.css', import.meta.url), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  )
  /** Every innermost rule, inside @media blocks too, as its selector (whitespace collapsed) and body. */
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].replace(/\s+/g, ' ').trim(),
    body: m[2]
  }))
  const body = (selector: string): string => {
    const found = rules.filter((r) => r.selector.split(',').some((s) => s.trim() === selector))
    expect(found.length, selector).toBeGreaterThan(0)
    return found.map((r) => r.body).join('\n')
  }

  it('builds every colour from theme variables, so light and dark both read', () => {
    // '#0000' is the transparent shadow the box-shadow lists end on.
    expect(css.match(/#[0-9a-f]{3,8}\b/gi)?.filter((c) => c !== '#0000') ?? []).toEqual([])
    expect(css).not.toMatch(/rgba?\(\s*\d/)
    expect(css).not.toMatch(/--gs-/)
  })

  it('gives a Live Preview line no vertical margin, so CodeMirror measures it true', () => {
    const lines = rules.filter((r) => r.selector.includes('.cm-line'))
    expect(lines.length).toBeGreaterThan(10)
    for (const r of lines) expect(r.body, r.selector).not.toMatch(/(?:^|[\s;])margin(?:-top|-bottom|-block[\w-]*)?\s*:/)
  })

  it('colours User pink and Host blue, apart from every other kind', () => {
    expect(body('.cf-ntl-k-user')).toContain('--cf-ntl-kc: var(--color-pink);')
    expect(body('.cf-ntl-k-host')).toContain('--cf-ntl-kc: var(--color-blue);')
    const kinds = rules.filter((r) => /^\.cf-ntl-k-\w+$/.test(r.selector)).map((r) => /--cf-ntl-kc:([^;]+);/.exec(r.body)?.[1])
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it("starts a fact's extra line on its value's column in Live Preview", () => {
    // The hidden key copy measures in the key's own em only if the line keeps the body size.
    const line = rules.filter((r) => r.selector.includes('.cm-line.cf-ntl-fact-more'))
    for (const r of line) expect(r.body, r.selector).not.toMatch(/font-size:/)
    expect(body('.markdown-source-view.mod-cm6 .cf-ntl-fact-pad')).toContain('visibility: hidden;')
    expect(body('.markdown-source-view.mod-cm6 .cf-ntl-fact-more-text')).toContain('font-family: var(--font-monospace);')
  })

  it('spreads the facts across the width in Reading view, so a host name does not break mid-word', () => {
    // auto-fill keeps empty tracks: three facts took three narrow columns of seven.
    expect(body('ul.cf-ntl-facts-list li.cf-ntl-facts > ul')).toContain('repeat(auto-fit, minmax(12em, 1fr))')
  })

  it("hides Obsidian's indent guides beside a chain in Reading view, outranking its own rule", () => {
    // Obsidian draws them with .markdown-rendered.show-indentation-guide li > ul::before.
    expect(body('.markdown-rendered ul.cf-ntl-chain li > ul::before')).toContain('display: none;')
  })

  it("bars a chain's root orange and its spawned children red", () => {
    expect(body('.cf-ntl-root')).toContain('--cf-ntl-kc: var(--color-orange);')
    expect(body('.cf-ntl-child')).toContain('--cf-ntl-kc: var(--color-red);')
  })

  it('ends the label row in Live Preview with a line break, the row itself inline on the bullet\'s row', () => {
    // Obsidian measures a list line's hanging indent from the first character
    // after its bullet: a row as wide as the line wrapped below the bullet,
    // and the indent came out 0.
    const head = body('.markdown-source-view.mod-cm6 .cf-ntl-head')
    expect(head).not.toMatch(/display:|width:/)
    const end = body('.markdown-source-view.mod-cm6 .cf-ntl-head::after')
    expect(end).toContain(String.raw`content: '\A';`)
    expect(end).toContain('white-space: pre;')
    // The role of a link with no label sits before the value on that row.
    expect(body('.cf-ntl-role.cf-ntl-role-alone')).not.toMatch(/display:|width:/)
  })

  it('draws no inline-block as wide as the line, which would wrap below a bullet', () => {
    const wide = rules.filter((r) => r.body.includes('display: inline-block') && /(?:^|[\s;])width: 100%/.test(r.body))
    expect(wide.map((r) => r.selector)).toEqual([])
  })

  it('outsets the padding of a time that opens a step, so its text starts on the column the value wraps to', () => {
    expect(body('.markdown-source-view.mod-cm6 .cf-ntl-head > .cf-ntl-time:first-child')).toContain(
      'margin-inline-start: -6px;'
    )
    expect(body('.cf-ntl-time')).toContain('padding: 1px 6px;')
  })

  it("keeps every inline box in a line off the line's hanging indent", () => {
    // CodeMirror draws its placeholder as an inline-block, which would take
    // Obsidian's negative text-indent and start left of the text.
    for (const selector of ['.cf-ntl-ghost', '.cf-ntl-value-icon']) {
      expect(body(selector), selector).toContain('text-indent: 0;')
    }
  })

  it('hides the bullet of every drawn item, its width kept', () => {
    const hidden = rules.filter((r) => r.body.includes('visibility: hidden')).map((r) => r.selector)
    expect(hidden.join()).toContain('.cf-ntl-ev .cm-formatting-list')
    expect(hidden.join()).toContain('.cf-ntl-fact .cm-formatting-list')
  })

  it("keeps the events rail and card off a chain's lines, which paint their own cards", () => {
    expect(
      rules.some((r) => r.selector === '.markdown-source-view.mod-cm6 .cm-line.cf-ntl-line:not(.cf-ntl-marker-line, .cf-ntl-chain)')
    ).toBe(true)
    expect(body('.markdown-source-view.mod-cm6 .cm-line.cf-ntl-chain')).toContain('background-origin: content-box;')
  })
})
