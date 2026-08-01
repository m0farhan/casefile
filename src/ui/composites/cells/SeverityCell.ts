import { Menu } from 'obsidian'
import type { SeverityConfig, Task } from '../../../types'
import { formatBadgeText } from '../../../utils'
import { Chip } from '../../primitives/Chip'

export interface SeverityCellProps {
  task: Task
  severities: SeverityConfig[]
  /** '' clears the severity (the None entry). */
  onChange: (severity: string) => void
}

/**
 * Severity column cell: tinted badge + picker menu. Severity is optional on
 * every task type, so an unset value renders a muted dash that still opens the
 * picker (unlike priority, there is no always-set default to badge).
 */
export class SeverityCell {
  el: HTMLTableCellElement

  constructor(parentRow: HTMLElement, props: SeverityCellProps) {
    this.el = parentRow.createEl('td', { cls: 'pm-table-cell' })
    const config = props.severities.find((s) => s.id === props.task.severity)
    const badge = config
      ? new Chip(this.el)
          .setLabel(formatBadgeText(config.icon, config.label))
          .setColor(config.color)
          .setVariant('solid')
      : new Chip(this.el).setLabel('—').setVariant('plain').setTooltip('Set severity')
    badge.onClick((e) => {
      const menu = new Menu()
      menu.addItem((item) =>
        item
          .setTitle('None')
          .setChecked(!props.task.severity)
          .onClick(() => props.onChange(''))
      )
      for (const s of props.severities) {
        menu.addItem((item) =>
          item
            .setTitle(formatBadgeText(s.icon, s.label))
            .setChecked(s.id === props.task.severity)
            .onClick(() => props.onChange(s.id))
        )
      }
      menu.showAtMouseEvent(e)
    })
  }
}
