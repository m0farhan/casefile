import { ItemView, Notice, WorkspaceLeaf, TFile, setIcon } from 'obsidian'
import { activityValue, sightingsIndex } from '../soc/ioc'
import type PMPlugin from '../main'
import type { Project, Task } from '../types'
import { renderDescriptionEditor, type DescriptionEditorHandle } from '../modals/DescriptionEditor'
import { renderCommentsSection, type CommentsSectionHandle } from '../soc/CommentsSection'
import { renderTaskFormFields } from '../modals/TaskFormFields'
import { renderLifecyclePanel, isoToLocalInput } from '../soc/LifecyclePanel'
import { renderIocSection } from '../soc/IocSection'
import { renderSeverityBadge, renderSlaChip } from '../soc/slaTicker'
import { guardVerdictOnClose } from '../soc/verdictGuard'
import { renderSubtasksPanel } from '../modals/SubtasksPanel'
import { renderLinksPanel } from '../modals/LinksPanel'
import { renderAttachmentsSection } from '../modals/AttachmentsSection'
import { findTaskById } from '../store/TaskIndex'
import { flattenTasks } from '../store/TaskTreeOps'
import { openIndicatorSearch, openTaskModal } from '../ui/ModalFactory'
import { renderTimeTrackingPanel } from '../modals/TimeTrackingPanel'
import { renderKeyChip, renderIssueTypeIcon } from '../ui/composites/issueMeta'
import { renderStatusBadge } from '../ui/StatusBadge'
import { CollapseToggle } from '../ui/primitives/CollapseToggle'

export const CASEFILE_TASK_DETAIL_VIEW_TYPE = 'casefile-task-detail'

/**
 * Read-only audit timeline rendered from task.activity (store-stamped field
 * changes plus the Notifier's persisted SLA-breach entries). Collapsed by
 * default; shared by the detail panel and the task modal.
 */
export function renderActivitySection(
  container: HTMLElement,
  task: Task,
  // Owner-held collapse flag (shownExtras precedent): rerenders rebuild this
  // section, so the expanded state must live on the caller to survive them.
  state: { collapsed: boolean } = { collapsed: true }
): void {
  const section = container.createDiv('pm-modal-section pm-activity-section')
  // The whole header is the one button: one tab stop, named by its heading.
  const header = section.createDiv({
    cls: 'pm-modal-section-header pm-activity-header',
    attr: { role: 'button', tabindex: '0', 'aria-expanded': String(!state.collapsed) }
  })
  // The toggle's own click bubbles to the header handler below — its onToggle
  // stays a no-op so a triangle click doesn't toggle twice. It is only the
  // picture of the state, so it leaves the tab order and the accessibility tree.
  const toggle = new CollapseToggle(header, { collapsed: state.collapsed, onToggle: () => {} })
  toggle.el.removeAttribute('tabindex')
  toggle.el.removeAttribute('role')
  toggle.el.removeAttribute('aria-expanded')
  toggle.el.setAttr('aria-hidden', 'true')
  toggle.el.setAttr('aria-label', state.collapsed ? 'Expand activity' : 'Collapse activity')
  header.createEl('h4', { text: `Activity (${task.activity.length})`, cls: 'pm-modal-section-title' })
  const list = section.createDiv('pm-activity-list')
  list.hidden = state.collapsed
  const flip = () => {
    state.collapsed = !state.collapsed
    header.setAttr('aria-expanded', String(!state.collapsed))
    toggle.el.toggleClass('is-collapsed', state.collapsed)
    toggle.el.setAttr('aria-label', state.collapsed ? 'Expand activity' : 'Collapse activity')
    list.hidden = state.collapsed
  }
  header.addEventListener('click', flip)
  header.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    // A modified Enter belongs to whatever owns that shortcut (the modal's Shift+Enter save).
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
    e.preventDefault()
    // Stops the board's own Enter, which would open the selected row as well.
    e.stopPropagation()
    flip()
  })

  if (!task.activity.length) {
    list.createDiv({ cls: 'pm-activity-empty', text: 'No activity recorded' })
    return
  }
  for (const e of task.activity) {
    const row = list.createDiv('pm-activity-row')
    // Viewer-local minute stamp (the Comments format); raw value when unparseable.
    row.createSpan({ cls: 'pm-activity-at', text: isoToLocalInput(e.at).replace('T', ' ') || e.at })
    const change = row.createSpan({ cls: 'pm-activity-change' })
    change.createSpan({ cls: 'pm-activity-field', text: `${e.field}:` })
    // Indicator values show defanged, as everywhere else; the log keeps them as recorded.
    change.appendText(` ${activityValue(e.field, e.from) || '—'} → ${activityValue(e.field, e.to) || '—'}`)
  }
}

interface TaskDetailState {
  projectPath: string
  taskId: string
  [key: string]: unknown
}

/**
 * Top-level fields whose working value differs from the snapshot (JSON
 * compare — key order is stable because working descends from the same
 * clone). Fields the panel never touched stay out of the patch, so a stale
 * clone can no longer revert edits made elsewhere (board drag-to-Done, etc.).
 */
export function diffTaskPatch(snapshot: Task, working: Task): Partial<Task> {
  const patch: Record<string, unknown> = {}
  const keys = new Set([...Object.keys(snapshot), ...Object.keys(working)])
  for (const key of keys) {
    const before = (snapshot as unknown as Record<string, unknown>)[key]
    const after = (working as unknown as Record<string, unknown>)[key]
    if (JSON.stringify(before) !== JSON.stringify(after)) patch[key] = after
  }
  return patch
}

/**
 * Right-leaf task detail panel — the triage alternative to TaskModal (list
 * left, detail right). Edits a deep clone like the modal, but persists with a
 * debounced autosave instead of an explicit Save. Title is the exception: a
 * title save renames the task file, so it persists on blur only, after the
 * same conflict pre-check the modal runs.
 */
export class TaskDetailView extends ItemView {
  private projectPath = ''
  private taskId = ''
  private project: Project | null = null
  private task: Task | null = null
  /** Last title actually persisted; debounced saves always send this, never the in-flight edit. */
  private persistedTitle = ''
  /** Last status that passed the verdict guard; persist() always sends this, never a pick still waiting on the prompt. */
  private lastStatus = ''
  private descEditor: DescriptionEditorHandle | null = null
  private commentsSection: CommentsSectionHandle | null = null
  private saveTimer: number | null = null
  private shownExtras = new Set<string>()
  /** Half-typed comment, hoisted across rerenders (the composer's DOM dies on every render). */
  private commentDraft = ''
  private commentHadFocus = false
  /** Activity collapse flag, owner-held so rerenders don't snap it shut (shownExtras precedent). */
  private activityState = { collapsed: true }
  /** Pristine deep clone of the last persisted state; persist() sends only fields that differ from it. */
  private snapshot: Task | null = null
  /** Subtask ids removed in the panel since the last successful save — only these get their files trashed. */
  private removedSubtaskIds: string[] = []

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: PMPlugin
  ) {
    super(leaf)
    this.navigation = false
  }

  getViewType(): string {
    return CASEFILE_TASK_DETAIL_VIEW_TYPE
  }
  getDisplayText(): string {
    return this.task ? this.task.key || this.task.title : 'Task'
  }
  getIcon(): string {
    return 'panel-right'
  }

  async setState(state: TaskDetailState, result: unknown): Promise<void> {
    if (state.projectPath && state.taskId) {
      // Switching tasks flushes any pending edit of the previous one first.
      await this.flushPendingSave()
      this.projectPath = state.projectPath
      this.taskId = state.taskId
      await this.loadTask()
      this.render()
    }
    await super.setState(state, result as import('obsidian').ViewStateResult)
  }

  getState(): TaskDetailState {
    return { projectPath: this.projectPath, taskId: this.taskId }
  }

  async onClose(): Promise<void> {
    await this.flushPendingSave()
    this.descEditor?.destroy()
    this.descEditor = null
    this.commentsSection?.destroy()
    this.commentsSection = null
    this.contentEl.empty()
  }

  private async loadTask(): Promise<void> {
    this.project = null
    this.task = null
    const file = this.app.vault.getAbstractFileByPath(this.projectPath)
    if (!(file instanceof TFile)) return
    const project = await this.plugin.store.loadProject(file)
    if (!project) return
    const live = project.taskIndex.get(this.taskId)?.task
    if (!live) return
    await this.plugin.store.loadTaskBody(live)
    this.project = project
    this.task = JSON.parse(JSON.stringify(live)) as Task
    this.snapshot = JSON.parse(JSON.stringify(live)) as Task
    this.removedSubtaskIds = []
    this.persistedTitle = this.task.title
    this.lastStatus = this.task.status
    // Per-task UI state: a draft or expanded timeline for task A must not leak into task B.
    this.commentDraft = ''
    this.commentHadFocus = false
    this.activityState = { collapsed: true }
  }

  /**
   * Status changes can't ride the debounced autosave directly: closing an
   * unverdicted incident must first pass the verdict guard, and a debounce
   * can't await a modal. The guard resolves immediately for every
   * non-guarded case, so all status changes route through here.
   */
  private async onStatusChanged(task: Task): Promise<void> {
    if (!this.project) return
    const prev = this.lastStatus
    const patch = await guardVerdictOnClose(this.plugin, this.project, task, task.status)
    if (patch === null) {
      task.status = prev // user cancelled the close — revert the clone
    } else {
      this.lastStatus = task.status
      if (patch.verdict) task.verdict = patch.verdict
      this.scheduleSave()
    }
    this.render()
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      void this.persist()
    }, 800)
  }

  /** Saves whatever the clone holds that disk does not, scheduled or not:
   * some edits reach the clone with no save scheduled (a field committed on
   * 'change' after the debounce already ran), and persist() is a no-op when
   * nothing differs. */
  private async flushPendingSave(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.persist()
  }

  /** Debounce-path save: everything except the in-flight title edit. */
  private async persist(): Promise<void> {
    if (!this.project || !this.task || !this.snapshot) return
    // Diff against the pristine snapshot and send only what this panel
    // changed — the whole stale clone as a patch reverted concurrent edits
    // made elsewhere (drag a card to Done, type here → status undone on disk).
    // Title and status are the persisted ones: a title in flight saves on
    // blur, and a close still waiting on the verdict prompt is not a close.
    const task = this.task
    const saved = () => ({ ...task, title: this.persistedTitle, status: this.lastStatus })
    const patch = diffTaskPatch(this.snapshot, saved())
    const removed = this.removedSubtaskIds
    if (!Object.keys(patch).length && !removed.length) return
    // subtaskBase makes the subtask merge three-way, so this panel's stale
    // copy of a subtask never undoes a change made to it on the board.
    const opts = { removedSubtaskIds: removed, subtaskBase: this.snapshot.subtasks }
    try {
      // The store gets its own copy. Handed the panel's arrays, the live task
      // shared them, and the next edit here changed the live task before the
      // store could compare old with new: a second subtask tick never reached
      // disk, an indicator removal was never logged. structuredClone, not
      // JSON: a field cleared to undefined must stay in the patch.
      await this.plugin.store.updateTask(this.project, this.task.id, structuredClone(patch), opts)
      this.removedSubtaskIds = []
      // Store-side stamps (activity entries, lifecycle timestamps, completion)
      // land on the LIVE task, not this editor clone. Sync them back, or the
      // next debounced patch would diff against stale values.
      const live = this.project.taskIndex.get(this.task.id)?.task
      if (live) {
        this.task.activity = JSON.parse(JSON.stringify(live.activity)) as Task['activity']
        this.task.respondedAt = live.respondedAt
        this.task.resolvedAt = live.resolvedAt
        this.task.completed = live.completed
        // A subtask added here gets its key and note from the store, on the
        // store's copy. Copied onto the panel's own subtask objects in place,
        // since the subtask rows hold those objects.
        const byId = new Map(flattenTasks(live.subtasks).map((f) => [f.task.id, f.task]))
        for (const { task: sub } of flattenTasks(this.task.subtasks)) {
          const stored = byId.get(sub.id)
          if (stored) {
            sub.key = stored.key
            sub.filePath = stored.filePath
          }
        }
      }
      // Snapshot follows the save: the next diff is relative to what's on disk.
      this.snapshot = JSON.parse(JSON.stringify(saved())) as Task
      // The store marks this write as a self-write, so open boards deliberately
      // skip their file-watcher reload — but that skip assumes the SAVING view
      // refreshes itself. The panel is a different view: poke the boards.
      this.plugin.refreshProjectViews()
    } catch (err) {
      console.error('[PM] Panel autosave failed', err)
      new Notice('Autosave failed. Check console for details.')
    }
  }

  /** Blur-path save: persists the title (renames the file) after a conflict pre-check. */
  private async persistTitle(titleInput: HTMLTextAreaElement): Promise<void> {
    if (!this.project || !this.task) return
    const next = this.task.title.trim()
    if (!next || next === this.persistedTitle) {
      this.task.title = this.persistedTitle
      titleInput.value = this.persistedTitle
      return
    }
    const conflict = this.plugin.store.findTaskFileConflict(this.project, this.task)
    if (conflict) {
      new Notice(`Title not saved: a note named "${conflict.fileName}" already exists.`)
      this.task.title = this.persistedTitle
      titleInput.value = this.persistedTitle
      return
    }
    this.persistedTitle = next
    await this.persist()
  }

  private render(): void {
    const { contentEl } = this
    // Snapshot before empty() so a property-change rerender doesn't jump the
    // panel or drop a half-typed comment (KanbanView.renderBoard precedent).
    const scrollTop = contentEl.scrollTop
    if (this.commentsSection) {
      this.commentDraft = this.commentsSection.getDraft()
      this.commentHadFocus = this.commentsSection.hasFocus()
    }
    this.descEditor?.destroy()
    this.descEditor = null
    contentEl.empty()
    contentEl.addClass('pm-root', 'pm-task-detail')

    if (!this.project || !this.task) {
      contentEl.createDiv({ cls: 'pm-empty-state', text: 'No task selected.' })
      return
    }
    const project = this.project
    const task = this.task
    const config = this.plugin.store.configFor(project)

    // ── Header: type icon · key · open-as-note ──────────────────────────────
    const header = contentEl.createDiv('pm-td-header')
    const socBoard = config.boardType !== 'plain'
    // Derived from the title on a case board only, as on the board card.
    renderIssueTypeIcon(
      header,
      config.issueTypes.find((t) => t.id === task.issueType),
      {
        alert: { tags: task.tags, title: socBoard ? task.title : '', categories: this.plugin.settings.alertCategories }
      }
    )
    if (task.key) renderKeyChip(header, task.key, { copy: true })
    // Severity shows on any task type of any board; the SLA chip stays
    // incident-only on a case board (slaState also gates on issueType, so that
    // is belt and braces).
    renderSeverityBadge(
      header,
      config.severities.find((s) => s.id === task.severity),
      'solid',
      task.severity
    )
    if (socBoard && task.issueType === 'incident') {
      // Registered chips unregister themselves: the shared 30s tick drops any
      // chip whose element left the DOM, and both onClose and every render()
      // empty contentEl (KanbanCard lifecycle — rebuild, never detach-and-keep).
      renderSlaChip(header, task, this.plugin.settings.slaPolicies)
    }
    // Status lozenge: same clone-mutation + verdict-guard path as the grid's
    // status select (onStatusChanged guards terminal moves and schedules the save).
    renderStatusBadge(header, task, config.statuses, (id) => {
      if (id === task.status) return // re-picking the current status must not re-run the guard
      task.status = id
      void this.onStatusChanged(task)
    }).addClass('pm-status-badge--lg')
    header.createDiv('pm-td-header-spacer')
    if (task.filePath) {
      const filePath = task.filePath
      // A real button, so it takes focus and Enter/Space; clickable-icon keeps it an icon.
      const noteBtn = header.createEl('button', { cls: 'pm-td-note-btn clickable-icon' })
      setIcon(noteBtn, 'file-text')
      noteBtn.setAttribute('aria-label', 'Open as note')
      noteBtn.addEventListener('click', () => {
        void this.app.workspace.openLinkText(filePath, '', true)
      })
    }

    // ── Title (persists on blur — a title save renames the file) ────────────
    const titleInput = contentEl.createEl('textarea', { cls: 'pm-te-title pm-td-title' })
    titleInput.rows = 1
    titleInput.value = task.title
    titleInput.spellcheck = false
    const autosizeTitle = () => {
      titleInput.setCssProps({ '--te-title-height': 'auto' })
      titleInput.setCssProps({ '--te-title-height': titleInput.scrollHeight + 'px' })
    }
    titleInput.addEventListener('input', () => {
      task.title = titleInput.value
      autosizeTitle()
    })
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        titleInput.blur()
      }
    })
    titleInput.addEventListener('blur', () => {
      void this.persistTitle(titleInput)
    })
    window.setTimeout(autosizeTitle, 0)

    // ── Body: shared form/description/subtask/time panels ───────────────────
    const body = contentEl.createDiv('pm-td-body')
    renderTaskFormFields(body, {
      task,
      project,
      plugin: this.plugin,
      parentId: project.taskIndex.get(task.id)?.parentId ?? null,
      // Reparenting is a modal affordance; the panel keeps hierarchy read-only.
      // Without a working picker, "Subtask of…" would wedge tasks as
      // parentless subtasks — so the merged Type dropdown drops that option.
      setParentId: () => {},
      parentPickerEnabled: false,
      rerender: () => {
        if (task.status !== this.lastStatus) {
          void this.onStatusChanged(task)
          return
        }
        this.scheduleSave()
        this.render()
      },
      // The multi-selects pick outside this panel's DOM, so the body listeners below never hear them.
      onChange: () => this.scheduleSave(),
      shownExtras: this.shownExtras
    })

    body.createEl('hr', { cls: 'pm-te-divider' })
    this.descEditor = renderDescriptionEditor(body, {
      app: this.app,
      plugin: this.plugin,
      project,
      task,
      // The CodeMirror editor dispatches transactions instead of firing the
      // 'input' events the body-level delegation below relies on.
      onChange: () => this.scheduleSave()
    })
    // Evidence (files referenced in description/comments) — read-only, no save wiring.
    renderAttachmentsSection(body, { app: this.app, project, task })
    if (config.boardType !== 'plain' && task.issueType === 'incident') {
      if (this.plugin.settings.showIncidentTimeline) {
        renderLifecyclePanel(body, task, {
          onChange: () => this.scheduleSave(),
          slaPolicies: this.plugin.settings.slaPolicies
        })
      }
      renderIocSection(body, task, {
        onChange: () => this.scheduleSave(),
        onPivot: (value) => void openIndicatorSearch(this.plugin, value),
        reputationKeys: {
          ...this.plugin.reputationKeys()
        },
        ownedAssets: () => this.plugin.settings.ownedAssets,
        findSightings: () => sightingsIndex(project.tasks, task.id, this.plugin.settings.ownedAssets)
      })
    }
    this.commentsSection?.destroy()
    this.commentsSection = renderCommentsSection(body, this.plugin, project, task, {
      onChange: () => {
        this.scheduleSave()
        this.render()
      },
      initialDraft: this.commentDraft
    })
    renderActivitySection(body, task, this.activityState)
    renderSubtasksPanel(body, task, this.plugin, config.statuses, {
      project,
      onOpen: (sub) => {
        const live = findTaskById(project, sub.id)
        if (!live) {
          new Notice('This subtask has not been saved yet — one moment.')
          return
        }
        // Honors openTaskIn: in panel mode this panel becomes the subtask's page.
        openTaskModal(this.plugin, project, {
          task: live,
          onSave: () => this.plugin.refreshProjectViews()
        })
      },
      // Click-only edits never pass through the body 'input' delegation below.
      onChange: () => this.scheduleSave(),
      onRemove: (id) => this.removedSubtaskIds.push(id)
    })
    // Linked cases: click-only mutations never fire the body 'input' delegation,
    // so onChange schedules the save explicitly — the panel mutates the clone's
    // links array, and diffTaskPatch picks the changed field up off it.
    renderLinksPanel(body, {
      app: this.app,
      plugin: this.plugin,
      project,
      task,
      onChange: () => this.scheduleSave(),
      onOpen: (target) => {
        const live = findTaskById(project, target.id)
        if (!live) return
        // Honors openTaskIn: in panel mode this panel becomes the linked case's page.
        openTaskModal(this.plugin, project, {
          task: live,
          onSave: () => this.plugin.refreshProjectViews()
        })
      }
    })
    renderTimeTrackingPanel(body, task, { onChange: () => this.scheduleSave() })

    // Any input inside the body (subtask titles, time logs) marks the clone
    // dirty; the field controls above already do it via rerender(), and the
    // description editor via its onChange. Event delegation keeps this one
    // listener instead of N hooks. 'change' too: time logs, the estimate and
    // the custom fields write the clone only on change, which can come after
    // the debounce for their typing has already saved.
    body.addEventListener('input', () => this.scheduleSave())
    body.addEventListener('change', () => this.scheduleSave())

    // Restore the pre-rebuild snapshot (scroll always; focus only where it was).
    contentEl.scrollTop = scrollTop
    if (this.commentHadFocus) this.commentsSection?.focusDraft()
  }
}
