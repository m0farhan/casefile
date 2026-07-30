import type { Ioc, IocType, Task } from '../types'
import { IOC_TYPE_LABELS, defangIoc } from './ioc'
import { IconButton } from '../ui/primitives/IconButton'
import { safeAsync } from '../utils'

const IOC_TYPES = Object.keys(IOC_TYPE_LABELS) as IocType[]

function renderTypeSelect(parent: HTMLElement, value: IocType): HTMLSelectElement {
  const sel = parent.createEl('select', { cls: 'pm-prop-select pm-ioc-type' })
  for (const t of IOC_TYPES) sel.createEl('option', { value: t, text: IOC_TYPE_LABELS[t] })
  sel.value = value
  return sel
}

/**
 * Indicators section: one row per IOC (type select, defanged value, optional
 * note, copy-real-value + remove) and an add-row form. Display always defangs
 * via defangIoc; only the copy button touches the real value. Mutates
 * task.iocs in place and reports every commit through opts.onChange.
 */
export function renderIocSection(container: HTMLElement, task: Task, opts: { onChange: () => void }): void {
  const section = container.createDiv('pm-modal-section pm-ioc-section')
  const title = section.createEl('h4', { cls: 'pm-modal-section-title' })
  const rowsEl = section.createDiv('pm-ioc-rows')

  const renderRows = () => {
    title.setText(`Indicators (${task.iocs.length})`)
    rowsEl.empty()
    for (const [i, ioc] of task.iocs.entries()) {
      const row = rowsEl.createDiv('pm-ioc-row')
      const sel = renderTypeSelect(row, ioc.type)
      sel.addEventListener('change', () => {
        ioc.type = sel.value as IocType
        renderRows() // re-defang + recolor for the new type
        opts.onChange()
      })
      const valueEl = row.createDiv('pm-ioc-value')
      const dot = valueEl.createSpan({ cls: 'pm-ioc-dot' })
      dot.setCssProps({ '--pm-ioc-color': `var(--gs-ioc-${ioc.type})` })
      valueEl.createSpan({ text: defangIoc(ioc.value, ioc.type) })
      const noteInput = row.createEl('input', {
        type: 'text',
        cls: 'pm-prop-text pm-ioc-note',
        attr: { placeholder: 'Note…' }
      })
      noteInput.value = ioc.note ?? ''
      noteInput.addEventListener('change', () => {
        const v = noteInput.value.trim()
        // Omit the key entirely when blank — the YAML emitter writes literal `undefined` otherwise.
        if (v) ioc.note = v
        else delete ioc.note
        opts.onChange()
      })
      const copyBtn = new IconButton(row).setIcon('copy').setTooltip('Copy real value')
      copyBtn.onClick(
        safeAsync(async () => {
          await navigator.clipboard.writeText(ioc.value)
          copyBtn.setIcon('check')
          window.setTimeout(() => copyBtn.setIcon('copy'), 700)
        })
      )
      new IconButton(row)
        .setIcon('x')
        .setTooltip('Remove indicator')
        .onClick(() => {
          task.iocs.splice(i, 1)
          renderRows()
          opts.onChange()
        })
    }
  }

  const addRow = section.createDiv('pm-ioc-row pm-ioc-add')
  const addSel = renderTypeSelect(addRow, 'ip')
  const valueInput = addRow.createEl('input', {
    type: 'text',
    cls: 'pm-prop-text pm-ioc-value-input',
    attr: { placeholder: 'Value', spellcheck: 'false' }
  })
  const noteInput = addRow.createEl('input', {
    type: 'text',
    cls: 'pm-prop-text pm-ioc-note',
    attr: { placeholder: 'Note (optional)' }
  })
  const addBtn = addRow.createEl('button', { cls: 'pm-soc-btn', text: 'Add' })
  const commitAdd = () => {
    const value = valueInput.value.trim()
    if (!value) return
    const ioc: Ioc = { type: addSel.value as IocType, value }
    const note = noteInput.value.trim()
    if (note) ioc.note = note
    task.iocs.push(ioc)
    valueInput.value = ''
    noteInput.value = ''
    renderRows()
    opts.onChange()
    valueInput.focus()
  }
  addBtn.addEventListener('click', commitAdd)
  valueInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitAdd()
  })

  renderRows()
}
