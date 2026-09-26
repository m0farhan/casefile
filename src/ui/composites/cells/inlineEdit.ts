import { safeAsync } from '../../../utils'

export interface InlineEditOpts {
  container: HTMLElement
  display: HTMLElement
  inputType: 'text' | 'date'
  value: string
  onSave: (newValue: string) => Promise<void>
}

export function makeInlineEdit(opts: InlineEditOpts): void {
  const { container, display, inputType, value, onSave } = opts
  const input = container.createEl('input', { type: inputType, cls: 'pm-inline-edit', value })
  // What the input holds once the browser has sanitised the seed: a date input
  // turns anything that is not a bare YYYY-MM-DD into ''. Leaving without an
  // edit compares against this, so it never saves '' over a value the input
  // could not show.
  const initial = input.value.trim()
  display.replaceWith(input)
  input.focus()
  if (inputType === 'text') input.select()

  let saved = false
  const save = safeAsync(async () => {
    if (saved) return
    saved = true
    const newVal = input.value.trim()
    if (newVal !== initial) {
      await onSave(newVal)
    } else {
      input.replaceWith(display)
    }
  })

  // Escape: close the editor and keep the pre-edit value. `saved` blocks the
  // commit in case removing the focused input still fires a blur; stopPropagation
  // keeps the table-level Escape handler from also clearing the row selection.
  const cancel = (ev: KeyboardEvent) => {
    ev.stopPropagation()
    saved = true
    input.replaceWith(display)
  }

  // Commit on Enter or blur only. Date inputs used to commit on 'change' too,
  // which fires per completed segment — committing mid-edit before the user
  // finished the month/year, and making Escape meaningless.
  input.addEventListener('blur', save)
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') save()
    if (ev.key === 'Escape') cancel(ev)
  })
}
