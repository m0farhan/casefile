import type { App } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, Task, TaskLinkType } from '../types'
import { flattenTasks } from '../store/TaskTreeOps'
import { findTaskById } from '../store/TaskIndex'
import { renderKeyChip } from '../ui/composites/issueMeta'
import { IconButton } from '../ui/primitives/IconButton'
import { renderSelectControl } from '../ui/composites/properties'
import { renderAddButton } from '../ui/composites/addButton'

export interface LinksPanelContext {
  app: App
  plugin: PMPlugin
  project: Project
  task: Task
  /** Fires after every mutation of task.links (add, remove) so autosave hosts can schedule a save. */
  onChange: () => void
  /** Opens the clicked case the way the host opens subtasks. */
  onOpen: (task: Task) => void
}

const LINK_LABELS: Record<TaskLinkType, { forward: string; inverse: string }> = {
  blocks: { forward: 'Blocks', inverse: 'Blocked by' },
  'relates-to': { forward: 'Relates to', inverse: 'Related to' },
  duplicates: { forward: 'Duplicates', inverse: 'Duplicated by' }
}

/** ponytail: display cap only — the helper still returns every overlap so the "and M more" line is honest. */
const MAX_DERIVED_ROWS = 5

/**
 * Every other task sharing at least one IOC value with this one
 * (case-insensitive on the value), most shared first. Pure — derived live
 * from real indicators, never stored.
 */
export function sharedIndicatorLinks(task: Task, allTasks: Task[]): { task: Task; shared: number }[] {
  const mine = new Set(task.iocs.map((i) => i.value.toLowerCase()))
  if (mine.size === 0) return []
  const out: { task: Task; shared: number }[] = []
  for (const other of allTasks) {
    if (other.id === task.id) continue
    let shared = 0
    for (const v of new Set(other.iocs.map((i) => i.value.toLowerCase()))) {
      if (mine.has(v)) shared++
    }
    if (shared > 0) out.push({ task: other, shared })
  }
  return out.sort((a, b) => b.shared - a.shared)
}

/**
 * "Linked cases" section: the typed links this case declares (editable), the
 * links other cases declare at it (read-only inverse rows), and derived
 * indicator-overlap rows, plus an add row (type + case picker).
 */
export function renderLinksPanel(container: HTMLElement, ctx: LinksPanelContext): void {
  const { project, task } = ctx
  const section = container.createDiv('pm-modal-section pm-links-section')
  section.createEl('h4', { text: 'Linked cases', cls: 'pm-modal-section-title' })
  const list = section.createDiv('pm-links-list')
  const addRow = section.createDiv('pm-links-add-row')

  const renderTarget = (row: HTMLElement, target: Task) => {
    if (target.key) renderKeyChip(row, target.key, { plain: true })
    const titleEl = row.createSpan({
      text: target.title,
      cls: 'pm-link-title',
      attr: { role: 'link', tabindex: '0', 'aria-label': 'Open linked case' }
    })
    titleEl.addEventListener('click', () => ctx.onOpen(target))
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        ctx.onOpen(target)
      }
    })
  }

  const renderRows = () => {
    list.empty()
    let any = false

    // Explicit rows: the links this case declares. Removable here — this case owns them.
    for (const link of task.links ?? []) {
      any = true
      const row = list.createDiv('pm-link-row')
      row.createSpan({ cls: 'pm-link-chip', text: LINK_LABELS[link.type].forward })
      const target = findTaskById(project, link.taskId)
      if (target) renderTarget(row, target)
      else row.createSpan({ cls: 'pm-link-missing', text: 'Missing case' })
      new IconButton(row)
        .setIcon('x')
        .setTooltip('Remove link')
        .setRevealOnHover(true)
        .onClick(() => {
          task.links = (task.links ?? []).filter((l) => l !== link)
          renderRows()
          renderAdd()
          ctx.onChange()
        })
    }

    // Inverse rows: links other cases declare at this one. Read-only —
    // ownership lives on the declaring case, so removal lives there too.
    for (const { task: other } of flattenTasks(project.tasks)) {
      if (other.id === task.id) continue
      for (const link of other.links ?? []) {
        if (link.taskId !== task.id) continue
        any = true
        const row = list.createDiv('pm-link-row')
        row.createSpan({ cls: 'pm-link-chip', text: LINK_LABELS[link.type].inverse })
        renderTarget(row, other)
        row.createSpan({ cls: 'pm-link-hint', text: 'from the other case' })
      }
    }

    // Derived rows: real IOC-value overlap, computed live, never stored.
    const allTasks = flattenTasks(project.tasks).map((f) => f.task)
    const overlaps = sharedIndicatorLinks(task, allTasks)
    for (const { task: other, shared } of overlaps.slice(0, MAX_DERIVED_ROWS)) {
      any = true
      const row = list.createDiv('pm-link-row')
      row.createSpan({
        cls: 'pm-link-chip',
        text: `Shares ${shared} indicator${shared === 1 ? '' : 's'}`
      })
      renderTarget(row, other)
      row.createSpan({ cls: 'pm-link-chip pm-link-chip--derived', text: 'derived' })
    }
    if (overlaps.length > MAX_DERIVED_ROWS) {
      list.createDiv({ cls: 'pm-links-more', text: `and ${overlaps.length - MAX_DERIVED_ROWS} more` })
    }

    if (!any) list.createDiv({ cls: 'pm-links-empty', text: 'None recorded' })
  }

  let pendingType: TaskLinkType = 'blocks'
  let pendingTargetId: string | null = null

  const renderAdd = () => {
    addRow.empty()
    const linkedIds = new Set((task.links ?? []).map((l) => l.taskId))
    const candidates = flattenTasks(project.tasks)
      .map((f) => f.task)
      .filter((t) => t.id !== task.id && !linkedIds.has(t.id))
    if (pendingTargetId && !candidates.some((t) => t.id === pendingTargetId)) pendingTargetId = null
    renderSelectControl({
      container: addRow,
      value: pendingType,
      options: (Object.keys(LINK_LABELS) as TaskLinkType[]).map((t) => ({
        id: t,
        label: LINK_LABELS[t].forward
      })),
      onChange: (id) => {
        pendingType = id as TaskLinkType
        renderAdd()
      }
    })
    renderSelectControl({
      container: addRow,
      value: pendingTargetId,
      options: candidates.map((t) => ({ id: t.id, label: t.key ? `${t.key} ${t.title}` : t.title })),
      placeholder: 'Select case',
      search: true,
      searchPlaceholder: 'Search cases…',
      width: 230,
      onChange: (id) => {
        pendingTargetId = id || null
        renderAdd()
      }
    })
    renderAddButton(addRow, 'Add link', () => {
      if (!pendingTargetId) return
      task.links = [...(task.links ?? []), { type: pendingType, taskId: pendingTargetId }]
      pendingTargetId = null
      renderRows()
      renderAdd()
      ctx.onChange()
    })
  }

  renderRows()
  renderAdd()
}
