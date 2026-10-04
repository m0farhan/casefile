import { Notice, setIcon } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, StatusConfig, Task } from '../types'
import { makeTask } from '../types'
import { today } from '../dates'
import { renderKeyChip } from '../ui/composites/issueMeta'
import { IconButton } from '../ui/primitives/IconButton'
import { guardVerdictOnClose } from '../soc/verdictGuard'
import { isTerminalStatus, getCompleteStatusId, getDefaultStatusId, safeAsync } from '../utils'
import { isNameableTitle } from '../store/ProjectStore'

/**
 * Checkbox semantics for a subtask row: terminal/default status, full/zero
 * progress, and the completion date stamped the same way the store stamps a
 * top-level task (ProjectStore.stampCompletion idiom). The store stamps the
 * activity rows and lifecycle times when the parent is saved.
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
  opts: {
    /** The board the task is on, for the verdict prompt. */
    project: Project
    onOpen: (sub: Task) => void
    onChange?: () => void
    onRemove?: (subtaskId: string) => void
  }
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
      cb.addEventListener(
        'change',
        safeAsync(async () => {
          const checked = cb.checked
          // Ticking closes the subtask, and closing an incident asks for its
          // verdict on this path too. Cancel leaves it open and unticked.
          if (checked) {
            const extra = await guardVerdictOnClose(plugin, opts.project, sub, getCompleteStatusId(statuses))
            if (extra === null) {
              cb.checked = false
              return
            }
            if (extra.verdict) sub.verdict = extra.verdict
          }
          applySubtaskChecked(sub, checked, statuses)
          renderSubtasks()
          renderCount()
          opts.onChange?.()
        })
      )

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
    const me = plugin.settings.currentUser
    const sub = makeTask({ title, type: 'subtask', assignees: me ? [me] : [] })
    // Refused where it is typed: the store refuses a subtask whose note name
    // is taken, or that makes none, and so every later save carrying it. Only
    // a saved parent has a folder to clash in.
    const clash = opts.project.taskIndex.has(task.id)
      ? plugin.store.findTaskFileConflict(opts.project, sub, task.id)
      : null
    if (clash || !isNameableTitle(title)) {
      new Notice(
        clash
          ? `Subtask not added: a note named "${clash.fileName}" already exists.`
          : 'Subtask not added: the title needs a character a file name can hold.'
      )
      return
    }
    task.subtasks.push(sub)
    addInput.value = ''
    renderSubtasks()
    renderCount()
    opts.onChange?.()
  })
}
