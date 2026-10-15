import { Notice } from 'obsidian'
import type { CaseDetail, Task } from '../types'
import { IconButton } from '../ui/primitives/IconButton'
import { safeAsync } from '../utils'

/** Offered as the field is typed (a native datalist); any other name is kept as typed. */
export const DETAIL_FIELDS = [
  'User',
  'Workstation',
  'Host',
  'IP',
  'Email',
  'Department',
  'Process',
  'Parent process',
  'Command line',
  'File path',
  'Hash',
  'URL',
  'Domain'
]

/** `**x**`, `__x__` and `` `x` `` around a whole cell are markup, not the value. */
function unwrap(s: string): string {
  return s
    .trim()
    .replace(/^(\*\*|__|`)(.+)\1$/, '$2')
    .trim()
}

/**
 * Rows from pasted text, one per line: a markdown table row (`| User | anita |`),
 * a tab-separated pair, or `Field: value` (colon then a space, so `C:\` and
 * `https://` stay whole). A table's divider row and a `Field | Value` header
 * are skipped. `unread` counts the non-blank lines that were none of these.
 */
export function parseDetailLines(text: string): { rows: CaseDetail[]; unread: number } {
  const rows: CaseDetail[] = []
  let unread = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    let field = ''
    let value = ''
    // A table row starts with a pipe; anywhere else a pipe is the value's own
    // (`cmd | find` in a command line), so tab and ": " pairs are tried first.
    const tab = line.indexOf('\t')
    const colon = line.indexOf(': ')
    if (line.startsWith('|') || (tab < 0 && colon <= 0 && line.includes('|'))) {
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(unwrap)
      if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue
      field = cells[0] ?? ''
      value = cells.slice(1).filter(Boolean).join(' | ')
    } else if (tab >= 0) {
      field = unwrap(line.slice(0, tab))
      value = unwrap(line.slice(tab + 1))
    } else if (colon > 0) {
      field = unwrap(line.slice(0, colon).replace(/^[-*+]\s+/, ''))
      value = unwrap(line.slice(colon + 2))
    }
    if (field && value.toLowerCase() === 'value') continue
    if (field && value) rows.push({ field, value })
    else unread++
  }
  return { rows, unread }
}

let datalistSeq = 0

/**
 * The case's Details: who and what the incident touches, as field/value rows.
 * Edits the task clone in place and calls onChange, like the indicator table.
 */
export function renderDetailsSection(container: HTMLElement, task: Task, opts: { onChange: () => void }): void {
  const section = container.createDiv('pm-modal-section pm-details-section')
  const header = section.createDiv('pm-modal-section-header')
  const title = header.createEl('h4', { cls: 'pm-modal-section-title' })
  // One list per section: the modal and the side panel can both be open.
  const listId = `pm-detail-fields-${++datalistSeq}`
  const datalist = section.createEl('datalist', { attr: { id: listId } })
  for (const f of DETAIL_FIELDS) datalist.createEl('option', { value: f })
  const rowsEl = section.createDiv('pm-details-rows')

  const details = (): CaseDetail[] => (task.details ??= [])
  const fieldInput = (parent: HTMLElement, placeholder: string): HTMLInputElement =>
    parent.createEl('input', {
      type: 'text',
      cls: 'pm-prop-text pm-details-field',
      attr: { placeholder, list: listId, 'aria-label': 'Detail field', spellcheck: 'false' }
    })
  const valueInput = (parent: HTMLElement, placeholder: string): HTMLInputElement =>
    parent.createEl('input', {
      type: 'text',
      cls: 'pm-prop-text pm-details-value',
      attr: { placeholder, 'aria-label': 'Detail value', spellcheck: 'false' }
    })

  const changed = () => {
    // An emptied list leaves the key out of the file (links idiom).
    if (task.details && !task.details.length) delete task.details
    renderRows()
    opts.onChange()
  }

  // By identity: a row already gone (indexOf -1) must not take the last one with it.
  const remove = (d: CaseDetail) => {
    const at = task.details?.indexOf(d) ?? -1
    if (at < 0) return
    task.details?.splice(at, 1)
    changed()
  }

  const renderRows = () => {
    const list = task.details ?? []
    title.setText(`Details (${list.length})`)
    rowsEl.empty()
    for (const d of list) {
      const row = rowsEl.createDiv('pm-details-row')
      const field = fieldInput(row, 'Field')
      field.value = d.field
      field.addEventListener('change', () => {
        const v = field.value.trim()
        // A row needs a name: an emptied one keeps the last.
        if (!v) field.value = d.field
        else if (v !== d.field) {
          d.field = v
          opts.onChange()
        }
      })
      const value = valueInput(row, 'Value')
      value.value = d.value
      value.addEventListener('change', () => {
        const v = value.value.trim()
        if (v === d.value) return
        if (v) {
          d.value = v
          opts.onChange()
          return
        }
        // Emptying a value removes its row; the activity log keeps what it was.
        remove(d)
      })
      const copyBtn = new IconButton(row).setIcon('copy').setTooltip('Copy value')
      copyBtn.onClick(
        safeAsync(async () => {
          await navigator.clipboard.writeText(d.value)
          copyBtn.setIcon('check')
          window.setTimeout(() => copyBtn.setIcon('copy'), 700)
        })
      )
      new IconButton(row)
        .setIcon('x')
        .setTooltip('Remove detail')
        .onClick(() => remove(d))
    }
  }

  const addRow = section.createDiv('pm-details-row pm-details-add')
  const newField = fieldInput(addRow, 'Field, e.g. User')
  const newValue = valueInput(addRow, 'Value')
  const addBtn = addRow.createEl('button', { cls: 'pm-soc-btn', text: 'Add' })
  const commitAdd = () => {
    const field = newField.value.trim()
    const value = newValue.value.trim()
    if (!field || !value) {
      ;(field ? newValue : newField).focus()
      return
    }
    details().push({ field, value })
    newField.value = ''
    newValue.value = ''
    changed()
    newField.focus()
  }
  addBtn.addEventListener('click', commitAdd)
  for (const input of [newField, newValue]) {
    input.addEventListener('keydown', (e) => {
      // A modified Enter is the dialog's (Shift+Enter saves).
      if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      // Stops the modal's own Enter handling (Shift+Enter saves; this is not that).
      e.stopPropagation()
      if (input === newField && !newValue.value.trim()) newValue.focus()
      else commitAdd()
    })
    // Several lines pasted at once (a copied table, "User: x" lines) become
    // rows in one go; a single line pastes into the box as usual.
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') ?? ''
      if (!/\r?\n/.test(text.trim())) return
      e.preventDefault()
      const { rows, unread } = parseDetailLines(text)
      const have = new Set((task.details ?? []).map((d) => `${d.field}\u0000${d.value}`))
      const fresh = rows.filter((r) => !have.has(`${r.field}\u0000${r.value}`))
      const parts: string[] = []
      if (fresh.length) parts.push(`Added ${fresh.length} detail${fresh.length === 1 ? '' : 's'}`)
      if (rows.length > fresh.length) parts.push(`${rows.length - fresh.length} already recorded`)
      if (unread) parts.push(`${unread} line${unread === 1 ? '' : 's'} not read as "Field: value"`)
      if (parts.length) new Notice(parts.join(' · '))
      if (!fresh.length) return
      details().push(...fresh)
      changed()
    })
  }

  renderRows()
}
