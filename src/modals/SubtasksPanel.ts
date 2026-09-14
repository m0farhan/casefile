import { setIcon } from 'obsidian'
import type PMPlugin from '../main'
import type { StatusConfig, Task } from '../types'
import { makeTask } from '../types'
import { today } from '../dates'
import { renderKeyChip } from '../ui/composites/issueMeta'
import { IconButton } from '../ui/primitives/IconButton'
import { isTerminalStatus, getCompleteStatusId, getDefaultStatusId } from '../utils'

/**
 * Checkbox semantics for a subtask row: terminal/default status, full/zero
 * progress, and the completion date stamped the same way the store stamps a
 * top-level task (ProjectStore.stampCompletion idiom).
 * ponytail: no per-subtask activity entry — activity is store-owned and
 * stamped for the parent patch only; accepted remainder.
 */
export function applySubtaskChecked(sub: Task, checked: boolean, statuses: StatusConfig[]): void {
  sub.status = checked ? getCompleteStatusId(statuses) : getDefaultStatusId(statuses)
  sub.progress = checked ? 100 : 0
  sub.completed = checked ? today().toString() : ''
}

/**
 * Renders the subtasks section: a header with a completed count, the list (each row opens the
 * subtask's own page via onOpen), and an inline add row. The count is derived from how many
 * subtasks sit in a terminal status. onChange fires on every mutation (add, check, remove) so
 * autosave hosts can schedule a save; onRemove additionally reports the removed subtask's id.
 */
export function renderSubtasksPanel(
  container: HTMLElement,
  task: Task,
  plugin: PMPlugin,
  statuses: StatusConfig[],
  opts: { onOpen: (sub: Task) => void; onChange?: () => void; onRemove?: (subtaskId: string) => void }
): void {
  const subSection = container.createDiv('pm-modal-section')

  const subHeader = subSection.createDiv('pm-subtasks-header')
  const heading = subHeader.createEl('h4', { text: 'Subtasks ', cls: 'pm-modal-section-title' })
  const countEl = heading.createSpan({ cls: 'pm-subtasks-count' })

  const subList = subSection.createDiv('pm-modal-subtask-list')

  const renderCount = () => {
    const total = task.subtasks.length
    if (total === 0) {
      countEl.setText('')
      return
    }
    const done = task.subtasks.filter((s) => isTerminalStatus(s.status, statuses)).length
    countEl.setText(`${done}/${total}`)
  }

  const renderSubtasks = () => {
    subList.empty()
    for (const sub of task.subtasks) {
      const row = subList.createDiv('pm-modal-subtask-row')

      // Jira-style child row: nesting connector, checkbox, key, title, status pill.
      setIcon(row.createSpan({ cls: 'pm-subtask-connector' }), 'corner-down-right')

      const cb = row.createEl('input', { type: 'checkbox', cls: 'pm-subtask-checkbox' })
      cb.checked = isTerminalStatus(sub.status, statuses)
      cb.addEventListener('change', () => {
        applySubtaskChecked(sub, cb.checked, statuses)
        renderSubtasks()
        renderCount()
        opts.onChange?.()
      })

      if (sub.key) renderKeyChip(row, sub.key)

      // Title opens the subtask's own page; renaming happens inside it (full editor,
      // slug-rename safety), not via inline contentEditable.
      const titleEl = row.createSpan({
        text: sub.title,
        cls: 'pm-subtask-title pm-subtask-title-link',
        attr: { role: 'link', tabindex: '0', 'aria-label': 'Open subtask' }
      })
      titleEl.addEventListener('click', () => opts.onOpen(sub))
      titleEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          opts.onOpen(sub)
        }
      })

      const statusCfg = statuses.find((s) => s.id === sub.status)
      const pill = row.createSpan({ cls: 'pm-subtask-status' })
      pill
        .createSpan({ cls: 'pm-subtask-status-dot' })
        .setCssStyles({ background: statusCfg?.color ?? 'var(--gs-ink-subtle)' })
      pill.createSpan({ text: statusCfg?.label ?? sub.status })

      new IconButton(row)
        .setIcon('x')
        .setTooltip('Remove subtask')
        .setRevealOnHover(true)
        .onClick(() => {
          task.subtasks = task.subtasks.filter((s) => s.id !== sub.id)
          renderSubtasks()
          renderCount()
          opts.onRemove?.(sub.id)
          opts.onChange?.()
        })
    }
  }

  renderSubtasks()
  renderCount()

  const addRow = subSection.createDiv('pm-subtask-add-row')
  const addInput = addRow.createEl('input', {
    cls: 'pm-subtask-add-input',
    attr: { placeholder: 'Add subtask…' }
  })
  addInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const title = addInput.value.trim()
    if (!title) return
    task.subtasks.push(makeTask({ title, type: 'subtask' }))
    addInput.value = ''
    renderSubtasks()
    renderCount()
    opts.onChange?.()
  })
}
