import { Menu } from 'obsidian'
import type { Task, TaskStatus, StatusConfig } from '../types'
import { getStatusConfig, formatBadgeText, isIconName } from '../utils'
import { Chip } from './primitives/Chip'

/** Returns the config's icon when it's a named (Lucide) icon; emoji/text icons render inline via formatBadgeText. */
function namedIcon(config: { icon: string } | undefined): string | null {
  return config?.icon && isIconName(config.icon) ? config.icon : null
}

export function renderStatusBadge(
  container: HTMLElement,
  task: Task,
  statuses: StatusConfig[],
  onChange: (status: TaskStatus) => void
): HTMLElement {
  const config = getStatusConfig(statuses, task.status)
  const badge = new Chip(container)
    .setLabel(formatBadgeText(config?.icon, config?.label ?? task.status))
    .setColor(config?.color ?? 'var(--text-muted)')
    .setVariant('solid')
    .setDot(!config?.icon)
    .onClick((e) => {
      const menu = new Menu()
      for (const s of statuses) {
        menu.addItem((item) => {
          item
            .setTitle(formatBadgeText(s.icon, s.label))
            .setChecked(s.id === task.status)
            .onClick(() => onChange(s.id))
          const icon = namedIcon(s)
          if (icon) item.setIcon(icon)
        })
      }
      menu.showAtMouseEvent(e)
    })
  const icon = namedIcon(config)
  if (icon) badge.setLeadingIcon(icon)
  return badge.el
}

export function renderStatusDot(
  container: HTMLElement,
  status: TaskStatus,
  statuses: StatusConfig[],
  cls = 'pm-subtask-dot'
): HTMLElement {
  const config = getStatusConfig(statuses, status)
  const dot = container.createSpan({ cls })
  dot.style.background = config?.color ?? 'var(--text-muted)'
  return dot
}
