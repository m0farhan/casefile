import { describe, expect, it } from 'vitest'
import { checklistProgress, toggleRenderedCheckbox } from './checkboxToggle'

// Mixed content: the renderer shows checkboxes for indices 0 "first"
// (bullet), 1 "second" (ordered, capital X) and 2 "third" (custom state),
// and NONE for the fenced line. The old regex (/[-*+] \[( |x)\]/ only, no
// fence awareness) counted the fenced line and skipped [X] and [-], so any
// index past 0 landed on the wrong line.
const MIXED = ['intro text', '- [ ] first', '```', '- [ ] not a checkbox', '```', '1. [X] second', '- [-] third'].join(
  '\n'
)

describe('toggleRenderedCheckbox', () => {
  it('unchecks a capital-X checkbox', () => {
    expect(toggleRenderedCheckbox('- [X] done', 0)).toBe('- [ ] done')
  })

  it('treats a custom state as unchecked and checks it', () => {
    expect(toggleRenderedCheckbox('- [-] cancelled', 0)).toBe('- [x] cancelled')
  })

  it('does not count checkbox-looking lines inside a fence', () => {
    const src = ['```', '- [ ] in fence', '```', '- [ ] real'].join('\n')
    expect(toggleRenderedCheckbox(src, 0)).toBe(['```', '- [ ] in fence', '```', '- [x] real'].join('\n'))
  })

  it('maps rendered indices across mixed content, fence untouched', () => {
    expect(toggleRenderedCheckbox(MIXED, 1)).toBe(MIXED.replace('1. [X] second', '1. [ ] second'))
    expect(toggleRenderedCheckbox(MIXED, 2)).toBe(MIXED.replace('- [-] third', '- [x] third'))
  })

  it('round-trips: toggling the same index twice restores the source', () => {
    const src = ['- [ ] a', '- [x] b', '\t- [ ] indented'].join('\n')
    for (const i of [0, 1, 2]) {
      expect(toggleRenderedCheckbox(toggleRenderedCheckbox(src, i), i)).toBe(src)
    }
  })

  it('returns the source unchanged for an out-of-range index', () => {
    expect(toggleRenderedCheckbox(MIXED, 3)).toBe(MIXED)
    expect(toggleRenderedCheckbox('no checkboxes here', 0)).toBe('no checkboxes here')
  })
})

describe('checklistProgress', () => {
  it('counts the same rendered set the toggle walks, fences excluded', () => {
    expect(checklistProgress(MIXED)).toEqual({ done: 1, total: 3 })
    const fenced = ['```', '- [ ] in fence', '```', '- [x] real'].join('\n')
    expect(checklistProgress(fenced)).toEqual({ done: 1, total: 1 })
  })

  it('treats x and X as done and any other state as open', () => {
    expect(checklistProgress(['- [X] a', '- [-] b', '- [ ] c'].join('\n'))).toEqual({ done: 1, total: 3 })
  })

  it('is null when the text has no checkboxes', () => {
    expect(checklistProgress('no checkboxes here')).toBeNull()
    expect(checklistProgress('')).toBeNull()
  })
})
