import { Menu, setIcon } from 'obsidian'
import type PMPlugin from '../main'
import type { FilterState, Project, Task } from '../types'
import { BUCKETS } from '../types'
import { matchesFilter } from '../store/TaskFilter'
import { flattenTasks } from '../store/TaskTreeOps'
import { buildTaskContextMenu } from '../ui/TaskContextMenu'
import { openTaskModal } from '../ui/ModalFactory'
import { renderIssueTypeIcon, renderKeyChip } from '../ui/composites/issueMeta'
import { relativeDue } from '../dates'
import type { SubView } from './SubView'

/**
 * Backlog: a compact flat list grouped by bucket (This week / Next / Later /
 * Someday / No bucket) for planning triage. Row click routes through
 * openTaskModal, so the panel-vs-modal setting applies — backlog left,
 * detail right is the intended triage layout.
 */
export class BacklogView implements SubView {
  constructor(
    private container: HTMLElement,
    private project: Project,
    private plugin: PMPlugin,
    private onRefresh: () => Promise<void>,
    private filter: FilterState
  ) {}

  render(): void {
    this.container.empty()
    const root = this.container.createDiv('pm-backlog')
    const cfg = this.plugin.store.configFor(this.project)
    const queryCtx = {
      priorities: cfg.priorities,
      severities: cfg.severities,
      currentUser: this.plugin.settings.currentUser
    }

    const visible = flattenTasks(this.project.tasks)
      .map((f) => f.task)
      .filter((t) => matchesFilter(t, this.filter, cfg.statuses, queryCtx))

    const byBucket = new Map<string, Task[]>()
    for (const t of visible) {
      const list = byBucket.get(t.bucket) ?? []
      list.push(t)
      byBucket.set(t.bucket, list)
    }

    let renderedAny = false
    for (const bucket of BUCKETS) {
      const tasks = byBucket.get(bucket.id)
      if (!tasks?.length) continue
      renderedAny = true

      const section = root.createDiv('pm-backlog-section')
      const header = section.createDiv('pm-backlog-header')
      header.createSpan({ cls: 'pm-backlog-header-label', text: bucket.label })
      header.createSpan({ cls: 'pm-backlog-header-count', text: String(tasks.length) })

      for (const task of tasks) {
        const row = section.createDiv('pm-backlog-row')
        row.dataset.taskId = task.id

        renderIssueTypeIcon(
          row,
          cfg.issueTypes.find((t) => t.id === task.issueType)
        )
        if (task.key) renderKeyChip(row, task.key)
        row.createSpan({ cls: 'pm-backlog-title', text: task.title })

        const status = cfg.statuses.find((s) => s.id === task.status)
        const statusChip = row.createSpan({ cls: 'pm-backlog-status', text: status?.label ?? task.status })
        if (status?.color) statusChip.setCssProps({ '--pm-chip-color': status.color })

        if (task.due) {
          const due = row.createSpan({ cls: 'pm-backlog-due' })
          setIcon(due.createSpan({ cls: 'pm-backlog-due-icon' }), 'calendar-clock')
          due.createSpan({ text: relativeDue(task.due)?.text ?? task.due })
        }

        row.addEventListener('click', () => {
          openTaskModal(this.plugin, this.project, {
            task,
            onSave: async () => {
              await this.onRefresh()
            }
          })
        })
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          const menu = new Menu()
          buildTaskContextMenu(menu, task, {
            plugin: this.plugin,
            project: this.project,
            onRefresh: this.onRefresh
          })
          menu.showAtMouseEvent(e)
        })
      }
    }

    if (!renderedAny) {
      root.createDiv({ cls: 'pm-empty-state', text: 'No tasks match the current filter.' })
    }
  }
}
