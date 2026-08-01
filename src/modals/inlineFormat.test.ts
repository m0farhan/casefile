import { describe, expect, it } from 'vitest'
import { toggleInlineMarker } from './inlineFormat'

describe('toggleInlineMarker', () => {
  it('wraps a selection in bold and keeps it selected', () => {
    const r = toggleInlineMarker('make this bold', 5, 9, '**')
    expect(r.value).toBe('make **this** bold')
    expect(r.value.slice(r.selStart, r.selEnd)).toBe('this')
  })

  it('unwraps when the selection sits inside existing markers', () => {
    const r = toggleInlineMarker('make **this** bold', 7, 11, '**')
    expect(r.value).toBe('make this bold')
    expect(r.value.slice(r.selStart, r.selEnd)).toBe('this')
  })

  it('unwraps when the markers are part of the selection', () => {
    const r = toggleInlineMarker('make **this** bold', 5, 13, '**')
    expect(r.value).toBe('make this bold')
    expect(r.value.slice(r.selStart, r.selEnd)).toBe('this')
  })

  it('handles italic and inline code the same way', () => {
    expect(toggleInlineMarker('a word here', 2, 6, '*').value).toBe('a *word* here')
    expect(toggleInlineMarker('run ls now', 4, 6, '`').value).toBe('run `ls` now')
    expect(toggleInlineMarker('run `ls` now', 5, 7, '`').value).toBe('run ls now')
  })

  it('stacks italic on bold to make bold-italic', () => {
    const r = toggleInlineMarker('see **it** go', 6, 8, '*')
    expect(r.value).toBe('see ***it*** go')
  })

  it('empty selection inserts markers with the caret between them', () => {
    const r = toggleInlineMarker('note ', 5, 5, '**')
    expect(r.value).toBe('note ****')
    expect(r.selStart).toBe(7)
    expect(r.selEnd).toBe(7)
  })
})
