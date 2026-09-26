import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { buildLivePreviewDecorations } from './DescriptionEditor'

// The decorations decide where a list item's text starts in the editor. The
// stylesheet gives the marker box the same width as the preview's bullet
// indent, so these ranges are what keeps the two modes lined up (checked in
// Chromium against Obsidian's app.css; views have no DOM in vitest).

interface Seen {
  from: number
  to: number
  cls?: string
  widget?: string
  style?: string
}

function decorations(doc: string, cursor: number): Seen[] {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) })
  const seen: Seen[] = []
  buildLivePreviewDecorations(state, [{ from: 0, to: doc.length }]).between(0, doc.length, (from, to, d) => {
    const spec = d.spec as { class?: string; widget?: object; attributes?: { style?: string } }
    seen.push({
      from,
      to,
      cls: spec.class,
      widget: spec.widget?.constructor.name,
      style: spec.attributes?.style
    })
  })
  return seen
}

describe('buildLivePreviewDecorations: list lines', () => {
  it('replaces the bullet and its space with one box, so the text starts where the preview puts it', () => {
    // Cursor on the last line, so the bullet line is not revealed.
    expect(decorations('- a\nx', 5)).toContainEqual({ from: 0, to: 2, widget: 'BulletWidget' })
  })

  it('keeps the revealed raw marker in the same box on the cursor line', () => {
    const seen = decorations('- a', 3)
    expect(seen).toContainEqual({ from: 0, to: 2, cls: 'cm-cf-listmark' })
    expect(seen.some((s) => s.widget)).toBe(false)
  })

  it('marks every list line with its nesting depth and boxes the indent', () => {
    const seen = decorations('- a\n  - b\nx', 11)
    expect(seen).toContainEqual({ from: 0, to: 0, cls: 'cm-cf-li', style: '--pm-depth: 0' })
    expect(seen).toContainEqual({ from: 4, to: 4, cls: 'cm-cf-li', style: '--pm-depth: 1' })
    expect(seen).toContainEqual({ from: 4, to: 6, cls: 'cm-cf-indent' })
  })

  it('covers "- [ ] " with the checkbox, custom states included', () => {
    expect(decorations('- [ ] a\nx', 9)).toContainEqual({ from: 0, to: 6, widget: 'CheckWidget' })
    expect(decorations('- [-] a\nx', 9)).toContainEqual({ from: 0, to: 6, widget: 'CheckWidget' })
  })

  it('boxes an ordered number with its space', () => {
    expect(decorations('1. a\nx', 6)).toContainEqual({ from: 0, to: 3, cls: 'cm-cf-listmark' })
  })

  it('leaves headings, quotes and prose without list decorations', () => {
    const seen = decorations('# H\n> q\ntext', 0)
    expect(seen.some((s) => s.cls === 'cm-cf-li' || s.cls === 'cm-cf-listmark')).toBe(false)
  })
})
