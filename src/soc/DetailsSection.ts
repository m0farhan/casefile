import { Notice } from 'obsidian'
import type { CaseDetail, Task } from '../types'
import { IconButton } from '../ui/primitives/IconButton'
import { NAME_LIKE, detectDetailField, readValue } from './detailKind'
import { refangIoc } from './ioc'
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
  'Domain',
  'Registry key',
  'Message-ID',
  'Subject',
  'Sender',
  'Recipient',
  'Hostname'
]

export { cleanDetailValue, detectDetailField } from './detailKind'

/** Reply and forward marks: an email subject's, never a field name. */
const REPLY_MARK = /^(?:re|fwd?|aw|sv|tr|wg|antw|vs|rv|ynt)$/i

/** `**x**`, `__x__` and `` `x` `` around a whole cell are markup, not the value. */
function unwrap(s: string): string {
  return s
    .trim()
    .replace(/^`([^`]+)`$|^\*\*((?:(?!\*\*).)+)\*\*$/, (_, code?: string, bold?: string) => code ?? bold ?? '')
    .trim()
}

/**
 * Rows from pasted text, one per line: a markdown table row (`| User | anita |`),
 * a tab-separated pair, or `Field: value` (colon then a space, so `C:\` and
 * `https://` stay whole). A table's divider row and a `Field | Value` header
 * are skipped. A name splits a line when it is a known one (DETAIL_FIELDS or
 * `names`) or, unless `knownOnly`, reads as a name; a subject's RE: does not.
 * A bare value on its own line is named `bareField` when given, else by its
 * kind (detectDetailField). `unread` counts the lines left over.
 */
export function parseDetailLines(
  text: string,
  opts: { bareField?: string; names?: Iterable<string>; knownOnly?: boolean } = {}
): { rows: CaseDetail[]; unread: number } {
  const bareField = opts.bareField ?? ''
  const names = new Set([...DETAIL_FIELDS, ...(opts.names ?? [])].map((n) => n.toLowerCase()))
  const known = (name: string) => names.has(name.toLowerCase())
  // Under a name typed for bare values, or for one line into the field box, only a known name splits a line.
  const strict = !!opts.knownOnly || !!bareField
  const splits = (name: string) => known(name) || (!strict && NAME_LIKE.test(name) && !REPLY_MARK.test(name))
  const rows: CaseDetail[] = []
  let unread = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    let field = ''
    let value = ''
    const tab = line.indexOf('\t')
    const colon = line.indexOf(': ')
    const left = colon > 0 ? unwrap(line.slice(0, colon).replace(/^[-*+]\s+/, '')) : ''
    const after = colon > 0 ? line.slice(colon + 2) : ''
    // A table cell's escaped pipe (\|) is its own, as Obsidian writes one.
    const cells = line
      .replace(/\\\|/g, '\ue000')
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => unwrap(c.replace(/\ue000/g, '|')))
    // A table row starts with a pipe; anywhere else a pipe is the value's own
    // (`cmd | find`, whoami /all | more), so tab and ": " pairs are tried first.
    const table = line.startsWith('|') ? !strict || known(cells[0] ?? '') : false
    const bareCells = tab < 0 && colon <= 0 && line.includes('|') && !detectDetailField(line) && splits(cells[0] ?? '')
    if (line.startsWith('|') && cells.every((c) => /^:?-{3,}:?$/.test(c))) continue
    if (table || bareCells) {
      field = cells[0] ?? ''
      value = cells.slice(1).filter(Boolean).join(' | ')
    } else if (tab >= 0 && (!strict || known(unwrap(line.slice(0, tab))))) {
      field = unwrap(line.slice(0, tab))
      value = unwrap(line.slice(tab + 1))
    } else if (
      colon > 0 &&
      splits(left) &&
      // A colon in a command line (cmd /c echo done: ok) is the command's own; a
      // name before a value (Reg key: HKLM\...) still names it.
      (known(left) || !detectDetailField(line) || (detectDetailField(after) !== null && !detectDetailField(left)))
    ) {
      field = left
      value = unwrap(after)
    } else {
      // A bare value on its own line takes the name typed for it, or its kind's, or is left unread.
      const read = readValue(line)
      value = read.value
      field = bareField || (read.field ?? '')
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
  // The field name the add line wrote itself from the value: the next value
  // may change it. A name the analyst typed is theirs and stays.
  let namedFor = ''
  newField.addEventListener('input', () => (namedFor = ''))
  // An IME or a dictation starting in a self-filled name replaces it too.
  const dropSelfName = () => {
    if (namedFor && newField.value === namedFor) newField.value = namedFor = ''
  }
  newField.addEventListener('compositionstart', dropSelfName)
  // Typing into a name the add line wrote replaces it, rather than joining onto it.
  newField.addEventListener('beforeinput', (e) => {
    if (!namedFor || newField.value !== namedFor || e.inputType !== 'insertText' || !e.data) return
    e.preventDefault()
    newField.value = e.data
    namedFor = ''
  })
  const fieldFree = () => !newField.value.trim() || newField.value === namedFor
  // A self-filled name follows the value's kind; it is blanked only for a fresh paste
  // that has none, not when the analyst adds words to a value already named.
  const nameFrom = (value: string, fresh = false) => {
    if (!fieldFree()) return
    const kind = detectDetailField(value)
    if (kind || fresh) newField.value = namedFor = kind ?? ''
  }
  newValue.addEventListener('change', () => nameFrom(newValue.value))
  // A paste lands in the value box as pasted; the field is named from what is there after.
  newValue.addEventListener('input', (e) => {
    const how = e.inputType
    if (how !== 'insertFromPaste' && how !== 'insertFromDrop') return
    const read = readValue(newValue.value)
    // Only an indicator sheds the markup it came in (a list marker, backticks, quotes), in sight before Add.
    if (read.field && read.value !== newValue.value.trim()) newValue.value = read.value
    nameFrom(newValue.value, true)
  })
  const commitAdd = () => {
    nameFrom(newValue.value)
    const field = newField.value.trim()
    const value = newValue.value.trim()
    if (!field || !value) {
      ;(field ? newValue : newField).focus()
      return
    }
    details().push({ field, value })
    newField.value = newValue.value = namedFor = ''
    changed()
    newField.focus()
  }
  addBtn.addEventListener('click', commitAdd)
  /**
   * One line pasted into the empty field box. A value that cannot be a name
   * (an IP, an address, a URL, a hash, a path, a command; any kind but a bare
   * domain like event.id) goes to the value box, named; a "Known field: value"
   * line fills both; a subject or log line goes to the value box unnamed.
   * Anything else is the name being pasted. The value box keeps its own paste.
   */
  const pasteOne = (input: HTMLInputElement, text: string, e: ClipboardEvent) => {
    if (input !== newField) return
    // A paste over a self-filled name replaces it.
    dropSelfName()
    if (newField.value.trim() || newValue.value.trim()) return
    const read = readValue(text)
    const used = details().map((d) => d.field)
    // A pair only when the line is not itself a value (a bare value would come back named by its kind).
    const pair = read.field ? undefined : parseDetailLines(text, { names: used, knownOnly: true }).rows[0]
    const valueKind = read.field && (read.field !== 'Domain' || refangIoc(read.value) !== read.value)
    if (pair) {
      newField.value = pair.field
      newValue.value = pair.value
      namedFor = ''
    } else if (valueKind) {
      newValue.value = read.value
      newField.value = namedFor = read.field ?? ''
    } else if (/:\s|\t/.test(text.trim())) {
      newValue.value = text.trim()
      newField.value = namedFor = ''
    } else return
    e.preventDefault()
    newValue.focus()
  }

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
      if (!/\r?\n/.test(text.trim())) {
        pasteOne(input, text.trim(), e)
        return
      }
      e.preventDefault()
      // A name typed for them names the bare values pasted under it.
      const typed = fieldFree() ? '' : newField.value.trim()
      const { rows, unread } = parseDetailLines(text, { bareField: typed, names: details().map((d) => d.field) })
      const have = new Set((task.details ?? []).map((d) => `${d.field}\u0000${d.value}`))
      const fresh = rows.filter((r) => !have.has(`${r.field}\u0000${r.value}`))
      const parts: string[] = []
      if (fresh.length) parts.push(`Added ${fresh.length} detail${fresh.length === 1 ? '' : 's'}`)
      if (rows.length > fresh.length) parts.push(`${rows.length - fresh.length} already recorded`)
      if (unread) parts.push(`${unread} line${unread === 1 ? '' : 's'} not read as "Field: value"`)
      if (parts.length) new Notice(parts.join(' · '))
      if (!fresh.length) return
      details().push(...fresh)
      // The typed name is used up; a value waiting in the box stays for its own Add.
      if (typed) newField.value = namedFor = ''
      changed()
    })
  }

  renderRows()
}
