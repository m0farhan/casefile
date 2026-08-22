import { Menu, Notice } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, Task, TaskStatus, FilterState, ResolvedProjectConfig } from '../types'
import { flattenTasks, totalLoggedHours } from '../store/TaskTreeOps'
import { findEpicAncestor, findParentId } from '../store/TaskIndex'
import { matchesFilter } from '../store/TaskFilter'
import type { QueryCtx } from '../store/QueryParser'
import { dueUrgency, isTerminalStatus, safeAsync } from '../utils'
import { openTaskModal } from '../ui/ModalFactory'
import { buildTaskContextMenu } from '../ui/TaskContextMenu'
import { KanbanColumn, type DropNeighbor, type KanbanCardData } from '../ui/composites/KanbanColumn'
import { setKanbanSocConfig } from '../ui/composites/KanbanCard'
import { guardVerdictOnClose } from '../soc/verdictGuard'
import { captureRects, markEnter, motionOK, playFlip } from '../ui/motion'
import { computeLanes, isLaneGroup, LANE_GROUPS, type KanbanLaneGroup } from './kanbanLanes'
import type { SubView } from './SubView'

/**
 * Reserved column id for the always-present Archive column. Reuses the
 * status-column collapse persistence (collapsedKanbanColumns is keyed by
 * arbitrary string ids per project, pruned only by project path).
 * ponytail: a user-defined status id could collide with this; double
 * underscores make that vanishingly unlikely — no registry needed.
 */
const ARCHIVE_COLUMN_ID = '__archive__'

export class KanbanView implements SubView {
  private dragTask: Task | null = null
  /** True while handleDrop is persisting, so dragend's snap-back render skips. */
  private dropInFlight = false
  /** Configuration in effect for this project, computed once per board render. */
  private config!: ResolvedProjectConfig

  constructor(
    private container: HTMLElement,
    private project: Project,
    private plugin: PMPlugin,
    private onRefresh: () => Promise<void>,
    private filter: FilterState
  ) {}

  render(): void {
    this.renderBoard()
    if (this.config.kanbanShowDescriptionPreview) {
      void this.hydrateDescriptions()
    }
  }

  private renderBoard(): void {
    this.config = this.plugin.store.configFor(this.project)
    setKanbanSocConfig({ severities: this.config.severities, slaPolicies: this.plugin.settings.slaPolicies })
    // The rebuild resets every scroll position, which reads as a jarring
    // "refresh" on drop. Snapshot card-list and board-row scrolls (positional
    // keying — the rebuilt DOM enumerates in the same order) and restore after.
    const cardScrolls = [...this.container.querySelectorAll<HTMLElement>('.pm-kanban-cards')].map((el) => el.scrollTop)
    const rowScrolls = [...this.container.querySelectorAll<HTMLElement>('.pm-kanban-board')].map((el) => el.scrollLeft)
    // Card ids present before the rebuild: anything absent from this set is
    // genuinely new and gets the enter fade (inert under reduced motion via
    // the CSS-side guards). First render is covered by the column stagger.
    const beforeIds = new Set<string>()
    for (const el of this.container.querySelectorAll<HTMLElement>('.pm-kanban-card[data-task-id]')) {
      if (el.dataset.taskId) beforeIds.add(el.dataset.taskId)
    }
    this.container.empty()
    this.container.addClass('pm-kanban-view')

    const groupBy = this.laneGroup()
    this.container.toggleClass('pm-kanban-view--lanes', groupBy !== 'none')
    this.renderLanesBar(groupBy)

    const lanes = computeLanes(this.visibleTasks(), groupBy, {
      epicOf: (id) => findEpicAncestor(this.project, id),
      severities: this.config.severities
    })

    let lastBoard: HTMLElement | null = null
    for (const lane of lanes) {
      if (groupBy !== 'none') {
        const header = this.container.createDiv('pm-kanban-lane-header')
        header.createSpan({ text: lane.label, cls: 'pm-kanban-lane-label' })
        header.createSpan({ text: String(lane.tasks.length), cls: 'pm-kanban-lane-count' })
      }
      const board = this.container.createDiv('pm-kanban-board')
      lastBoard = board
      for (const status of this.config.statuses) {
        const tasks = lane.tasks.filter((t) => t.status === status.id)
        // The epic chip is noise inside its own epic's lane — the lane header already says it.
        const cards = tasks.map((task) => this.buildCardData(task, groupBy !== 'epic'))
        // Jira-style nesting: a subtask directly under its parent card (or a
        // same-parent sibling run) indents instead of repeating the breadcrumb.
        for (let i = 1; i < tasks.length; i++) {
          const t = tasks[i]
          if (t.type !== 'subtask') continue
          const parent = this.findParentTask(t.id)
          if (!parent) continue
          const prev = tasks[i - 1]
          if (prev.id === parent.id || (prev.type === 'subtask' && this.findParentTask(prev.id)?.id === parent.id)) {
            cards[i].nested = true
          }
        }
        new KanbanColumn(board, {
          status,
          cards,
          collapsed: this.plugin.isKanbanColumnCollapsed(this.project, status.id),
          onToggleCollapse: safeAsync(async () => {
            await this.plugin.toggleKanbanColumnCollapsed(this.project, status.id)
            this.renderBoard()
          }),
          onCardClick: (task) => this.openTask(task),
          onCardProgressChange: safeAsync(async (task: Task, value: number) => {
            await this.plugin.store.updateTask(this.project, task.id, { progress: value })
            await this.onRefresh()
          }),
          onCardContextMenu: (task, e) => this.openContextMenu(task, e),
          onCardDragStart: (task) => {
            this.dragTask = task
          },
          onCardDragEnd: () => {
            this.dragTask = null
            // An aborted drag leaves the live-moved ghost wherever dragover
            // parked it — snap the board back to data. Skipped mid-drop: the
            // drop's own refresh re-renders, and the ghost already sitting at
            // the destination is exactly the gs-landed no-jump contract.
            if (!this.dropInFlight) this.renderBoard()
          },
          onDrop: (taskId, newStatus, before) => this.handleDrop(taskId, newStatus, before)
        })
      }
    }
    // Archive column: always one trailing column, never per-lane — archived
    // tasks have no lane identity worth partitioning, and N drop targets for
    // one action invite mis-drops. With lanes off it joins the single board
    // row; with lanes on it gets its own trailing board row.
    this.renderArchiveColumn(groupBy === 'none' && lastBoard ? lastBoard : this.container.createDiv('pm-kanban-board'))
    // Restore scroll positions captured before the rebuild.
    const cardLists = [...this.container.querySelectorAll<HTMLElement>('.pm-kanban-cards')]
    cardScrolls.forEach((top, i) => {
      if (cardLists[i]) cardLists[i].scrollTop = top
    })
    const rows = [...this.container.querySelectorAll<HTMLElement>('.pm-kanban-board')]
    rowScrolls.forEach((left, i) => {
      if (rows[i]) rows[i].scrollLeft = left
    })
    if (beforeIds.size) markEnter(this.container, '.pm-kanban-card[data-task-id]', beforeIds)
  }

  private renderLanesBar(groupBy: KanbanLaneGroup): void {
    const bar = this.container.createDiv('pm-kanban-lanes-bar')
    // Wrapping label: implicit association, no document-wide id to collide across leaves.
    const label = bar.createEl('label', { text: 'Lanes', cls: 'pm-kanban-lanes-label' })
    const select = label.createEl('select', { cls: 'pm-kanban-lanes-select' })
    for (const g of LANE_GROUPS) {
      select.createEl('option', { text: g.label, value: g.id })
    }
    select.value = groupBy
    select.addEventListener(
      'change',
      safeAsync(async () => {
        await this.setLaneGroup(isLaneGroup(select.value) ? select.value : 'none')
        this.renderBoard()
      })
    )
  }

  /** Persisted per project alongside the filter, in settings.projectFilters. */
  private laneGroup(): KanbanLaneGroup {
    const v = this.plugin.settings.projectFilters[this.project.filePath]?.kanbanLane
    return isLaneGroup(v) ? v : 'none'
  }

  private async setLaneGroup(groupBy: KanbanLaneGroup): Promise<void> {
    const filters = this.plugin.settings.projectFilters
    const entry = (filters[this.project.filePath] ??= { filter: this.filter, activeSavedViewId: null })
    entry.kanbanLane = groupBy
    await this.plugin.saveSettings()
  }

  /** Context for query-bar field terms (prio:>=high, sev:, assignee:me). */
  private queryCtx(): Partial<QueryCtx> {
    return {
      priorities: this.config.priorities,
      severities: this.config.severities,
      currentUser: this.plugin.settings.currentUser
    }
  }

  private candidateTasks(): Task[] {
    return this.config.kanbanShowSubtasks ? flattenTasks(this.project.tasks).map((ft) => ft.task) : this.project.tasks
  }

  private visibleTasks(): Task[] {
    // Archived tasks live in the Archive column only — even with the filter's
    // showArchived on they don't double up in their old status column.
    return this.candidateTasks().filter(
      (t) => !t.archived && matchesFilter(t, this.filter, this.config.statuses, this.queryCtx())
    )
  }

  /** The Archive column's content: same filter with only the archived gate lifted,
   *  so text/status/tag terms still narrow archived cards. */
  private archivedTasks(): Task[] {
    const filter: FilterState = { ...this.filter, showArchived: true }
    return this.candidateTasks().filter(
      (t) => t.archived === true && matchesFilter(t, filter, this.config.statuses, this.queryCtx())
    )
  }

  private renderArchiveColumn(board: HTMLElement): void {
    new KanbanColumn(board, {
      status: { id: ARCHIVE_COLUMN_ID, label: 'Archive', color: 'var(--gs-ink-subtle)', icon: 'archive' },
      cards: this.archivedTasks().map((task) => this.buildCardData(task, true)),
      collapsed: this.plugin.isKanbanColumnCollapsed(this.project, ARCHIVE_COLUMN_ID),
      onToggleCollapse: safeAsync(async () => {
        await this.plugin.toggleKanbanColumnCollapsed(this.project, ARCHIVE_COLUMN_ID)
        this.renderBoard()
      }),
      onCardClick: (task) => this.openTask(task),
      onCardContextMenu: (task, e) => this.openContextMenu(task, e),
      onCardDragStart: (task) => {
        this.dragTask = task
      },
      onCardDragEnd: () => {
        this.dragTask = null
        // Same aborted-drag snap-back as the status columns.
        if (!this.dropInFlight) this.renderBoard()
      },
      onDrop: (taskId, newStatus, before) => this.handleDrop(taskId, newStatus, before)
    })
  }

  /**
   * Task descriptions live in the note body, which loads lazily. Pull the bodies
   * for the cards on the board, then re-render once so previews fill in.
   */
  private async hydrateDescriptions(): Promise<void> {
    const pending = [...this.visibleTasks(), ...this.archivedTasks()].filter((t) => t.filePath && !t.description)
    if (!pending.length) return
    await Promise.all(pending.map((t) => this.plugin.store.loadTaskBody(t)))
    if (pending.some((t) => t.description)) this.renderBoard()
  }

  private buildCardData(task: Task, showEpic: boolean): KanbanCardData {
    let descriptionPreview: string | undefined
    if (this.config.kanbanShowDescriptionPreview && task.description.trim()) {
      const text = task.description
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^[ \t]*[#>\-*+]+[ \t]+/gm, '')
        .replace(/[*~]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      descriptionPreview = text ? text.slice(0, 240) : undefined
    }

    let parentTitle: string | undefined
    let parentKey: string | undefined
    if (this.config.kanbanShowSubtasks && task.type === 'subtask') {
      const parent = this.findParentTask(task.id)
      if (parent) {
        parentTitle = parent.title
        parentKey = parent.key || undefined
      }
    }

    let epic: KanbanCardData['epic']
    if (showEpic) {
      const epicTask = findEpicAncestor(this.project, task.id)
      if (epicTask) {
        epic = {
          label: epicTask.key || epicTask.title,
          color: this.config.issueTypes.find((t) => t.id === epicTask.issueType)?.color
        }
      }
    }

    let subtaskProgress: { done: number; total: number } | undefined
    if (task.subtasks.length) {
      const done = task.subtasks.filter((s) => isTerminalStatus(s.status, this.config.statuses)).length
      subtaskProgress = { done, total: task.subtasks.length }
    }

    return {
      task,
      descriptionPreview,
      parentTitle,
      parentKey,
      issueTypes: this.config.issueTypes,
      epic,
      subtaskProgress,
      loggedHours: totalLoggedHours(task),
      overdue: dueUrgency(task, this.config.statuses) === 'overdue',
      showTagColors: this.plugin.settings.showTagColors
    }
  }

  private findParentTask(taskId: string): Task | null {
    for (const ft of flattenTasks(this.project.tasks)) {
      const parent = ft.task
      if (parent.subtasks.some((s) => s.id === taskId)) return parent
    }
    return null
  }

  private openTask(task: Task): void {
    openTaskModal(this.plugin, this.project, {
      task,
      onSave: async () => {
        await this.onRefresh()
      }
    })
  }

  private openContextMenu(task: Task, e: MouseEvent): void {
    const menu = new Menu()
    buildTaskContextMenu(menu, task, { plugin: this.plugin, project: this.project, onRefresh: this.onRefresh })
    menu.showAtMouseEvent(e)
  }

  private async handleDrop(taskId: string, newStatus: TaskStatus, before: DropNeighbor | null): Promise<void> {
    if (!this.dragTask || this.dragTask.id !== taskId) return
    // Capture now — dragend nulls this.dragTask before the guard's modal settles.
    const task = this.dragTask
    // drop fires before dragend, so the flag is up before the snap-back check.
    this.dropInFlight = true
    try {
      if (newStatus === ARCHIVE_COLUMN_ID) {
        if (!task.archived) {
          // Same semantics as the modal/context-menu Archive action: the store
          // moves the file into the project's Tasks/Archive folder (created on
          // demand). No verdict guard — archiving is not a status change.
          // ponytail: drop order inside the Archive column isn't persisted;
          // archive order is tree order, reordering archived files is noise.
          await this.plugin.store.archiveTask(this.project, taskId)
          new Notice('Task archived')
          await this.refreshWithFlip(taskId)
        } else {
          this.renderBoard() // already archived: snap the live-moved card back
        }
        return
      }
      if (newStatus !== task.status) {
        const extra = await guardVerdictOnClose(this.plugin, this.project, task, newStatus)
        if (extra === null) {
          this.renderBoard() // cancelled: snap the live-moved card back
          return
        }
        // Drop out of Archive: unarchive first (the guard already passed), then
        // apply the target status through the normal path.
        if (task.archived) {
          await this.plugin.store.unarchiveTask(this.project, taskId)
          new Notice('Task unarchived')
        }
        await this.plugin.store.updateTask(this.project, taskId, { status: newStatus, ...extra })
      } else if (task.archived) {
        // Drop out of Archive onto the column matching the stored status: no
        // status write, no verdict guard (status unchanged) — just unarchive.
        await this.plugin.store.unarchiveTask(this.project, taskId)
        new Notice('Task unarchived')
      }
      // reorderTask persists sibling order through the shared parent's list, so a
      // neighbor under a different parent (possible when subtask cards are shown)
      // can't be persisted — skip the reorder silently, keeping the status change.
      // With subtasks hidden both cards are top-level, so the parents match (null).
      if (before && findParentId(this.project, taskId) === findParentId(this.project, before.targetId)) {
        await this.plugin.store.reorderTask(this.project, taskId, before.targetId, before.position)
      }
      await this.refreshWithFlip(taskId)
    } finally {
      this.dropInFlight = false
    }
  }

  /** Refresh after a drop, FLIP-animating card moves when motion is allowed. */
  private async refreshWithFlip(taskId: string): Promise<void> {
    // FLIP only on the drop path — background refreshes render instantly
    // (a change the analyst didn't make animating would be noise, not signal).
    const first = motionOK(this.plugin) ? captureRects(this.container, '.pm-kanban-card[data-task-id]') : null
    await this.onRefresh()
    if (first) {
      playFlip(this.container, '.pm-kanban-card[data-task-id]', first)
      // The dragged card's rect was already at its destination (dragover does a
      // live insertBefore), so it gets the landing border-fade instead of a jump.
      const landed = this.container.querySelector(`.pm-kanban-card[data-task-id="${taskId}"]`)
      landed?.classList.add('gs-landed')
      window.setTimeout(() => landed?.classList.remove('gs-landed'), 400)
    }
  }
}
