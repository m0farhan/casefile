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
