import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// --interactive-accent is for fills, borders and focus only: as 13px text on the
// label column it reads at 3.89:1 (3.48:1 on a hovered row), under the 4.5:1 AA
// asks for. The hover colour matches the table's `.pm-task-title-text:hover`.
describe('gantt.css', () => {
  it('colours a hovered task title with the text-safe accent', () => {
    const css = readFileSync(new URL('../src/styles/gantt.css', import.meta.url), 'utf8')
    const at = css.indexOf('.pm-gantt-label-title:hover {')
    expect(at).toBeGreaterThanOrEqual(0)
    const rule = css.slice(at, css.indexOf('}', at))
    expect(rule).toContain('color: var(--interactive-accent-hover);')
  })
})

// Linking is by tap, but the dots only showed on hover, which a touch screen never has.
describe('widgets.css', () => {
  it('shows the gantt link dots on a touch screen, after the rule that hides them', () => {
    const css = readFileSync(new URL('../src/styles/widgets.css', import.meta.url), 'utf8')
    const base = css.indexOf('.pm-gantt-link-dot {')
    const touch = css.indexOf('@media (hover: none) {\n  .pm-gantt-link-dot {\n    opacity: 0.5;')
    expect(base).toBeGreaterThanOrEqual(0)
    expect(touch).toBeGreaterThan(base)
  })
})
