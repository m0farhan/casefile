import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('comment body styles', () => {
  const css = readFileSync(new URL('../src/styles/widgets.css', import.meta.url), 'utf8')
  const rule = (selector: string): string => {
    const at = css.indexOf(`${selector} {`)
    expect(at, selector).toBeGreaterThanOrEqual(0)
    return css.slice(at, css.indexOf('}', at))
  }

  it('shows the blank line between two paragraphs as a gap, as the note does, and none after the last', () => {
    // At 0.2em the paragraphs of a comment sat flush, as if the blank line typed between them was lost.
    expect(rule('.pm-comment-body p')).toContain('margin: 0 0 var(--p-spacing);')
    expect(rule('.pm-comment-body p:last-child')).toContain('margin-bottom: 0;')
  })

  it('keeps the line breaks of a comment shown in the case timeline', () => {
    const timeline = readFileSync(new URL('../src/styles/timeline.css', import.meta.url), 'utf8')
    const at = timeline.indexOf('.pm-tl-detail {')
    expect(timeline.slice(at, timeline.indexOf('}', at))).toContain('white-space: pre-line;')
  })
})
