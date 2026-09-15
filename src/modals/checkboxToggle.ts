import { fenceMap } from './livePreviewMarks'

/**
 * Pure source-side counterpart of the checkboxes Obsidian's MarkdownRenderer
 * emits in the read-mode preview. The renderer produces an <input> for any
 * list item whose marker is followed by "[<single char>]" and a space (or end
 * of line) — including capital X and custom states like "[-]" — and produces
 * NONE for lines inside fenced code blocks. The toggle mapping must walk the
 * same set, or the Nth rendered checkbox flips the wrong source line.
 *
 * Toggle semantics match Obsidian reading mode: x/X (case-insensitive) is
 * checked and toggles to " "; any other state char is unchecked and toggles
 * to "x".
 */

// ponytail: checkboxes nested inside blockquotes ("> - [ ]") are not handled —
// strip quote markers here AND in fenceMap if task descriptions ever grow them.
const CHECKBOX_LINE = /^(\s*(?:[-*+]|\d{1,9}[.)]) \[)(.)\](?= |$)/

/**
 * Progress over the same rendered-checkbox set toggleRenderedCheckbox walks
 * (fence-skipped; x/X = done, any other state char = open). Null when the
 * text has no checkboxes, so callers can skip the chip entirely.
 */
export function checklistProgress(source: string): { done: number; total: number } | null {
  const fenced = fenceMap(source)
  const lines = source.split('\n')
  let done = 0
  let total = 0
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue
    const m = lines[i].match(CHECKBOX_LINE)
    if (!m) continue
    total++
    if (m[2].toLowerCase() === 'x') done++
  }
  return total ? { done, total } : null
}

/**
 * Returns `source` with the checkbox at rendered index `renderedIndex`
 * toggled; unchanged if the index is beyond the rendered set.
 */
export function toggleRenderedCheckbox(source: string, renderedIndex: number): string {
  const fenced = fenceMap(source)
  const lines = source.split('\n')
  let seen = 0
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue
    const m = lines[i].match(CHECKBOX_LINE)
    if (!m) continue
    if (seen++ !== renderedIndex) continue
    const next = m[2].toLowerCase() === 'x' ? ' ' : 'x'
    lines[i] = m[1] + next + lines[i].slice(m[1].length + 1)
    return lines.join('\n')
  }
  return source
}
