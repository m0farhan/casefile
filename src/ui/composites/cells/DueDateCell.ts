import type { Task } from '../../../types'
import { parsePlainDate } from '../../../dates'
import { formatDateLong } from '../../../utils'
import type { DueUrgency } from '../dueChip'
import { renderDueChip } from '../dueChip'
import { Chip } from '../../primitives/Chip'
import { makeInlineEdit } from './inlineEdit'

export interface DueDateCellProps {
  task: Task
  urgency: DueUrgency
  onSave: (newDate: string) => Promise<void>
}

export class DueDateCell {
  el: HTMLTableCellElement

  constructor(parentRow: HTMLElement, props: DueDateCellProps) {
    const { task } = props
    this.el = parentRow.createEl('td', { cls: 'pm-table-cell' })

    const startEdit = (display: HTMLElement): void => {
      makeInlineEdit({
        container: this.el,
        display,
        inputType: 'date',
        // The picker opens on the day the chip shows, even when the stored due
        // carries a time; a deliberate pick then writes a bare date.
        value: parsePlainDate(task.due)?.toString() ?? '',
        onSave: props.onSave
      })
    }

    if (!task.due) {
      const chip = new Chip(this.el)
        .setLabel('—')
        .setColor('var(--text-faint)')
        .onClick((e) => {
          e.stopPropagation()
          startEdit(chip.el)
        })
      return
    }

    const chip = renderDueChip(this.el, formatDateLong(task.due), props.urgency)
    chip.onClick((e) => {
      e.stopPropagation()
      startEdit(chip.el)
    })
  }
}
