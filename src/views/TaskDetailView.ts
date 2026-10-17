import { ItemView, Notice, Platform, WorkspaceLeaf, TFile, setIcon, type View, type WorkspaceSidedock } from 'obsidian'
import { activityValue, sightingsIndex } from '../soc/ioc'
import type PMPlugin from '../main'
import type { Project, Task } from '../types'
import { renderDescriptionEditor, type DescriptionEditorHandle } from '../modals/DescriptionEditor'
import { renderCommentsSection, type CommentsSectionHandle } from '../soc/CommentsSection'
import { fillProgressOnDone, renderTaskFormFields } from '../modals/TaskFormFields'
import { renderLifecyclePanel, isoToLocalInput } from '../soc/LifecyclePanel'
import { renderIocSection } from '../soc/IocSection'
import { renderDetailsSection } from '../soc/DetailsSection'
import { renderSeverityBadge, renderSlaChip } from '../soc/slaTicker'
import { guardVerdictOnClose } from '../soc/verdictGuard'
import { renderSubtasksPanel } from '../modals/SubtasksPanel'
import { renderLinksPanel } from '../modals/LinksPanel'
import { renderAttachmentsSection } from '../modals/AttachmentsSection'
import { findTaskById } from '../store/TaskIndex'
import { isNameableTitle } from '../store/ProjectStore'
import { flattenTasks } from '../store/TaskTreeOps'
import { openIndicatorSearch, openTaskModal } from '../ui/ModalFactory'
import { renderTimeTrackingPanel } from '../modals/TimeTrackingPanel'
import { renderKeyChip, renderIssueTypeIcon } from '../ui/composites/issueMeta'
import { renderStatusBadge } from '../ui/StatusBadge'
import { CollapseToggle } from '../ui/primitives/CollapseToggle'
import { isTerminalStatus } from '../utils'
import { today } from '../dates'
import { TASK_FRONTMATTER_KEY } from '../store/YamlParser'
import { PM_PROJECT_VIEW_TYPE } from './ProjectView'
import { PM_DASHBOARD_VIEW_TYPE } from './DashboardView'

export const CASEFILE_TASK_DETAIL_VIEW_TYPE = 'casefile-task-detail'

/** What the main pane has in front: its view, the file it shows, and the tab group it sits in. */
interface Front {
  view: View
  file: string | undefined
  group: WorkspaceLeaf['parent'] | null
}

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
  /** What a Done pick's progress fill replaced, until the save goes out (fillProgressOnDone). */
  private filledFrom: number | undefined
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
  /** A save is writing; an outside change read now would include it half-done. */
  private persisting = false
  private syncTimer: number | null = null
  /** An outside change arrived while something in the panel had focus: read it once focus leaves. */
  private syncOnBlur = false
  /** Re-fits the title to its text; set by render, rerun when the panel changes size. */
  private fitTitle: (() => void) | null = null
  /** Counts case notes brought to the front; only the latest one is followed. */
  private followSeq = 0
  /** What the main pane last had in front, and its tab group: a click back into it is not a change. */
  private front: Front | null = null
  /** The panel sat in a sidebar at the last look: moved into one, it takes what is in front as it finds it. */
  private wasDocked = false
  /** The panel shut its sidebar for a board, so the case note back in front opens it again. */
  private shutForBoard = false

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
    // A case, not the sidebar: 'panel-right' looked like Obsidian's own sidebar toggle beside it.
    return 'ticket'
  }

  onOpen(): Promise<void> {
    // The case's note changed from outside the panel: typed into in the main
    // pane, a card dragged on the board, a Sync. 'changed' comes once
    // Obsidian has read the new text, so the store reads the new case.
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        if (file.path !== this.task?.filePath) return
        // This panel's own save leaves the store a marker that only an open
        // board took up; left, it hid the analyst's next edit to the note for
        // five seconds. The read below finds nothing new in an own save.
        this.plugin.store.consumeSelfWrite(file.path)
        this.queueSync()
      })
    )
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!this.task || !this.snapshot || oldPath !== this.task.filePath) return
        this.task.filePath = file.path
        this.snapshot.filePath = file.path
      })
    )
    // The panel shows whichever case note is in front: opened, or its tab chosen.
    this.registerEvent(this.app.workspace.on('file-open', (file) => void this.followFile(file)))
    // The panel goes with the case note, not the board: a board in front shuts its sidebar.
    // Opened from the board (Open in sidebar), that board is already in front, so it stays.
    // A tab closed, or a board loaded into the tab in front, changes no active leaf: the layout.
    const inFront = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)
    this.front = inFront === this.leaf ? null : this.frontOf(inFront)
    this.wasDocked = this.dock() !== null
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => this.fitToFront(leaf)))
    this.registerEvent(this.app.workspace.on('layout-change', () => this.fitToFront(null)))
    // The sidebar opened again, by hand or onto another tab: a later shut is the analyst's.
    this.registerEvent(
      this.app.workspace.on('resize', () => {
        if (this.dock()?.collapsed === false) this.shutForBoard = false
      })
    )
    this.registerDomEvent(this.contentEl, 'focusout', (e) => {
      if (this.syncOnBlur && !(e.relatedTarget instanceof Node && this.contentEl.contains(e.relatedTarget))) {
        this.queueSync()
      }
    })
    return Promise.resolve()
  }

  /**
   * A case note came to the front: the panel shows that case, after saving
   * what it holds of the last one. Any other note leaves the panel as it is.
   * The note is found on its board by the id in its frontmatter and its own
   * path, so a copy of a note carrying the same id is not taken for it.
   */
  private async followFile(file: TFile | null): Promise<void> {
    if (!file || file.path === this.task?.filePath) return
    const id = this.caseIdOf(file)
    if (!id) return
    const seq = ++this.followSeq
    const projects = await this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder)
    // A later note came to the front while the boards loaded: that one is followed.
    if (seq !== this.followSeq) return
    const project = projects.find((p) => p.taskIndex.get(id)?.task.filePath === file.path)
    if (!project) return
    await this.leaf.setViewState({
      type: CASEFILE_TASK_DETAIL_VIEW_TYPE,
      state: { projectPath: project.filePath, taskId: id },
      active: false
    })
  }

  /** The case id a note carries in its frontmatter, or null for any other note. */
  private caseIdOf(file: TFile | null | undefined): string | null {
    const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : null
    const id: unknown = fm?.[TASK_FRONTMATTER_KEY] === true ? fm.id : null
    return typeof id === 'string' && id ? id : null
  }

  /** The sidebar the panel sits in, or null when it sits in the main pane. */
  private dock(): WorkspaceSidedock | null {
    const { workspace } = this.app
    const root = this.leaf.getRoot()
    return root === workspace.leftSplit || root === workspace.rightSplit ? (root as WorkspaceSidedock) : null
  }

  private frontOf(leaf: WorkspaceLeaf | null): Front | null {
    return leaf
      ? { view: leaf.view, file: (leaf.view as { file?: TFile | null }).file?.path, group: leaf.parent }
      : null
  }

  /**
   * What is in front now where the last front was: that tab while it still
   * shows it (stacked tabs all show, so the group's first is not it), else the
   * tab its group moved to after it closed or a view replaced it.
   */
  private shownWhereFrontWas(): WorkspaceLeaf | null {
    const front = this.front
    if (!front) return null
    const { view } = front
    if (view.leaf.view === view && view.containerEl.isShown()) {
      // Dragged into another group, it is looked for there from now on.
      if (view.leaf.getRoot() === this.app.workspace.rootSplit) front.group = view.leaf.parent
      return view.leaf
    }
    // ponytail: the group's current tab is internal (children, currentTab); the newest shown tab stands in without it.
    const tabs = front.group as unknown as { children?: WorkspaceLeaf[]; currentTab?: number } | null
    const current = tabs?.children?.[tabs.currentTab ?? -1]
    if (current?.view.containerEl.isShown()) return current
    return front.group ? this.app.workspace.getMostRecentLeaf(front.group) : null
  }

  /**
   * Something new came to the front of the main pane. A board or the boards
   * list shuts the sidebar the panel is showing in, unless a case note is
   * still on screen in another pane or the sidebar; the case note back in front opens it
   * again. A sidebar opened or shut by hand since, or showing another tab, is
   * left as it is, and so is a panel that boards open cases in.
   * ponytail: the shut is remembered in memory only; after a restart the case note does not reopen it.
   */
  private fitToFront(leaf: WorkspaceLeaf | null): void {
    const { workspace } = this.app
    // On a phone the sidebar is a drawer over the note, never left open beside it.
    if (Platform.isPhone) return
    const side = this.dock()
    const justDocked = side !== null && !this.wasDocked
    this.wasDocked = side !== null
    // A sidebar leaf, another window, or a layout change: the main pane's tab in front.
    if (leaf?.getRoot() !== workspace.rootSplit) {
      leaf = this.shownWhereFrontWas() ?? workspace.getMostRecentLeaf(workspace.rootSplit)
    }
    // The panel itself in the main pane is never what it makes way for.
    const front = leaf === this.leaf ? null : this.frontOf(leaf)
    if (!leaf || !front || (front.view === this.front?.view && front.file === this.front.file)) return
    // Kept while the panel sits in the main pane too, and taken as found when it is docked.
    this.front = front
    if (!side || justDocked) return
    const type = leaf.view.getViewType()
    if (type === PM_PROJECT_VIEW_TYPE || type === PM_DASHBOARD_VIEW_TYPE) {
      if (this.plugin.settings.openTaskIn === 'panel' || side.collapsed || !this.containerEl.isShown()) return
      // A note in the board's own tab group is behind it, or stacked under it: not beside it.
      const caseBeside = workspace
        .getLeavesOfType('markdown')
        .some(
          (l) =>
            l.parent !== leaf.parent &&
            l.view.containerEl.isShown() &&
            this.caseIdOf((l.view as { file?: TFile | null }).file) !== null
        )
      if (caseBeside) return
      side.collapse()
      this.shutForBoard = true
    } else if (this.shutForBoard && this.caseIdOf((leaf.view as { file?: TFile | null }).file)) {
      this.shutForBoard = false
      side.expand()
    }
  }

  onResize(): void {
    // A panel drawn while its sidebar was shut measured its title at no
    // height at all, and kept it at none once shown.
    this.fitTitle?.()
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
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer)
    this.syncTimer = null
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
    this.filledFrom = undefined
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
      // Filled only once the pick stands, so a cancelled prompt has nothing to put back.
      const { statuses } = this.plugin.store.configFor(this.project)
      const savedStatus = this.snapshot?.status ?? prev
      this.filledFrom = fillProgressOnDone(task, savedStatus, statuses, this.filledFrom)
      // The completion date as the store will stamp it (stampCompletion), set
      // here so the panel shows it now and the save has nothing to redraw: a
      // redraw while the analyst types closes the editor under the caret.
      if (this.snapshot) {
        const closed = isTerminalStatus(task.status, statuses)
        task.completed =
          closed === isTerminalStatus(savedStatus, statuses)
            ? this.snapshot.completed
            : closed
              ? this.snapshot.completed || today().toString()
              : ''
      }
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
    // Done's fill is already on the slider (onStatusChanged), so a status
    // change sends the slider as it stands: dragged back after the pick, it stays.
    if (patch.status !== undefined) patch.progress = task.progress
    // A copy: a removal made while this save writes is not part of it.
    const removed = [...this.removedSubtaskIds]
    if (!Object.keys(patch).length && !removed.length) return
    // subtaskBase makes the subtask merge three-way, so this panel's stale
    // copy of a subtask never undoes a change made to it on the board.
    const opts = { removedSubtaskIds: removed, subtaskBase: this.snapshot.subtasks }
    // The next snapshot is what this save sends, copied now. Taken after the
    // write, it held any edit made meanwhile (a second comment deleted), which
    // then never differed from it, so was never written.
    const sent = JSON.parse(JSON.stringify(saved())) as Task
    // The fill goes out with this save; reopening from here keeps it, as the store does.
    this.filledFrom = undefined
    this.persisting = true
    try {
      // The store gets its own copy. Handed the panel's arrays, the live task
      // shared them, and the next edit here changed the live task before the
      // store could compare old with new: a second subtask tick never reached
      // disk, an indicator removal was never logged. structuredClone, not
      // JSON: a field cleared to undefined must stay in the patch.
      await this.plugin.store.updateTask(this.project, this.task.id, structuredClone(patch), opts)
      this.removedSubtaskIds = this.removedSubtaskIds.filter((id) => !removed.includes(id))
      // Store-side stamps (activity entries, lifecycle timestamps, completion)
      // land on the LIVE task, not this editor clone. Sync them back, onto the
      // clone and the snapshot alike, or the next debounced patch would diff
      // against stale values.
      const live = this.project.taskIndex.get(this.task.id)?.task
      if (live) {
        const shown = { progress: this.task.progress, completed: this.task.completed }
        for (const t of [this.task, sent]) {
          t.activity = JSON.parse(JSON.stringify(live.activity)) as Task['activity']
          t.respondedAt = live.respondedAt
          t.resolvedAt = live.resolvedAt
          t.completed = live.completed
          // A title save renames the note; the clone and the snapshot follow it.
          t.filePath = live.filePath
          // The store sets 100 on reaching Done. A slider move made here while
          // this save wrote is newer, so the clone keeps it (sent is first
          // compared, then synced, in that order).
          if (t === sent || t.progress === sent.progress) t.progress = live.progress
        }
        // A subtask added here gets its key and note from the store, on the
        // store's copy. Copied onto the panel's own subtask objects in place,
        // since the subtask rows hold those objects.
        const byId = new Map(flattenTasks(live.subtasks).map((f) => [f.task.id, f.task]))
        for (const { task: sub } of [...flattenTasks(this.task.subtasks), ...flattenTasks(sent.subtasks)]) {
          const stored = byId.get(sub.id)
          if (stored) {
            sub.key = stored.key
            sub.filePath = stored.filePath
          }
        }
        // The store stamped what the panel shows and the pick did not already
        // (a date that rolled over at midnight): draw it. Only then, since a
        // redraw drops the focus of whatever is being typed.
        const stamped = this.task.progress !== shown.progress || this.task.completed !== shown.completed
        if (stamped && this.contentEl.isConnected) this.render()
      }
      // Snapshot follows the save: the next diff is relative to what was sent.
      this.snapshot = sent
      // The store marks this write as a self-write, so open boards deliberately
      // skip their file-watcher reload — but that skip assumes the SAVING view
      // refreshes itself. The panel is a different view: poke the boards.
      this.plugin.refreshProjectViews()
    } catch (err) {
      console.error('[PM] Panel autosave failed', err)
      new Notice('Autosave failed. Check console for details.')
    } finally {
      this.persisting = false
    }
  }

  private queueSync(): void {
    this.syncOnBlur = false
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer)
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null
      void this.syncExternal()
    }, 300)
  }

  /** Focus is in the panel: a redraw now would close whatever is being typed. */
  private focusedInside(): boolean {
    const focused = this.contentEl.ownerDocument?.activeElement
    return !!focused && this.contentEl.contains(focused)
  }

  /**
   * Takes in a change made to the case outside this panel. Each field the
   * panel has not changed since its last save takes the value on disk. A list
   * both changed (comments, indicators, details, tags) is merged: what the
   * other side added is added, what it removed is removed, the panel's own
   * changes stay, and the merge is saved. Any other field both changed keeps
   * the panel's value, which its next save writes. Never while the panel's
   * own save is pending or writing, and never under the caret: the redraw
   * would close whatever is being typed, so it waits for focus to leave.
   */
  private async syncExternal(): Promise<void> {
    if (!this.task || !this.snapshot) return
    if (this.saveTimer !== null || this.persisting) {
      this.queueSync()
      return
    }
    if (this.focusedInside()) {
      this.syncOnBlur = true
      return
    }
    const file = this.app.vault.getAbstractFileByPath(this.projectPath)
    if (!(file instanceof TFile)) return
    const project = await this.plugin.store.loadProject(file)
    const live = project?.taskIndex.get(this.taskId)?.task
    if (!project || !live) return
    await this.plugin.store.loadTaskBody(live)
    // Read again after the awaits: an edit, a save or a click into the panel may have come meanwhile.
    const task = this.task
    const snapshot = this.snapshot
    if (!task || !snapshot || this.saveTimer !== null || this.persisting) return
    if (this.focusedInside()) {
      this.syncOnBlur = true
      return
    }
    this.project = project
    const fresh = structuredClone(live)
    // Against the clone as it stands: a title being typed or a close waiting
    // on the verdict prompt is the panel's change too.
    const local = diffTaskPatch(snapshot, task)
    const outside = diffTaskPatch(snapshot, fresh)
    // Every save stamps it; on its own it is no change to show.
    snapshot.updatedAt = fresh.updatedAt
    task.updatedAt = fresh.updatedAt
    const changed = (Object.keys(outside) as (keyof Task)[]).filter((k) => k !== 'updatedAt')
    const panelTask = task as unknown as Record<string, unknown>
    const panelSnapshot = snapshot as unknown as Record<string, unknown>
    const fromDisk = fresh as unknown as Record<string, unknown>
    const isList = (v: unknown): v is unknown[] | undefined => v === undefined || Array.isArray(v)
    let merged = false
    let adopted = false
    for (const key of changed) {
      const mine = panelTask[key]
      const base = panelSnapshot[key]
      const theirs = fromDisk[key]
      if (!(key in local)) {
        panelTask[key] = structuredClone(theirs)
        adopted = true
      } else if (key !== 'subtasks' && isList(mine) && isList(base) && isList(theirs)) {
        // Subtasks are left out: persist merges those three ways itself
        // (subtaskBase). An absent list (the last detail removed) is an empty one.
        const id = (x: unknown) => JSON.stringify(x)
        const before = new Set((base ?? []).map(id))
        const now = theirs ?? []
        const onDisk = new Set(now.map(id))
        const result = (mine ?? []).filter((x) => !before.has(id(x)) || onDisk.has(id(x)))
        const kept = new Set(result.map(id))
        for (const x of now) if (!before.has(id(x)) && !kept.has(id(x))) result.push(structuredClone(x))
        panelTask[key] = result
        merged = true
      } else {
        continue
      }
      panelSnapshot[key] = structuredClone(theirs)
    }
    if (!adopted && !merged) return
    if (!('title' in local) && 'title' in outside) this.persistedTitle = fresh.title
    if (!('status' in local) && 'status' in outside) this.lastStatus = fresh.status
    if (merged) this.scheduleSave()
    if (this.contentEl.isConnected) this.render()
  }

  /** Blur-path save: persists the title (renames the file) after a conflict pre-check. */
  private async persistTitle(titleInput: HTMLTextAreaElement): Promise<void> {
    if (!this.project || !this.task) return
    const next = this.task.title.trim()
    // A title of only dots names no file: the store would refuse it, and every
    // save after it, so it is put back like an empty one.
    const nameless = next !== '' && !isNameableTitle(next)
    if (nameless) new Notice('Title not saved: it needs a character a file name can hold.')
    if (!next || nameless || next === this.persistedTitle) {
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
      // Not laid out (the sidebar is shut): a measure of 0 would hide the
      // title, so it keeps its natural height until onResize measures again.
      if (titleInput.scrollHeight) titleInput.setCssProps({ '--te-title-height': titleInput.scrollHeight + 'px' })
    }
    this.fitTitle = autosizeTitle
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
    // Details and indicators come first here, unlike the dialog: the panel is
    // where they are added while the case is read and worked in the main pane.
    const incident = config.boardType !== 'plain' && task.issueType === 'incident'
    if (incident) {
      renderDetailsSection(body, task, { onChange: () => this.scheduleSave() })
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

    body.createEl('hr', { cls: 'pm-te-divider' })
    // The panel shows only saved cases, so files always have a folder to go in.
    const attach = {
      reserve: (name: string) => this.plugin.store.reserveAttachmentName(name),
      write: (name: string, data: ArrayBuffer) => this.plugin.store.writeTaskAttachment(project, task, name, data)
    }
    this.descEditor = renderDescriptionEditor(body, {
      app: this.app,
      plugin: this.plugin,
      project,
      task,
      attach,
      // The CodeMirror editor dispatches transactions instead of firing the
      // 'input' events the body-level delegation below relies on.
      onChange: () => this.scheduleSave()
    })
    // Subtasks straight under the description, as in the modal.
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
    // Evidence (files referenced in description/comments); attaching one links it
    // from the description, so it saves like a description edit.
    renderAttachmentsSection(body, {
      app: this.app,
      project,
      task,
      attach: {
        ...attach,
        onLinked: () => {
          this.scheduleSave()
          this.render()
        },
        // Still showing this case in an open panel: redraw, so Evidence resolves the copies.
        onCopied: () => {
          if (this.task?.id === task.id && this.contentEl.isConnected) this.render()
        }
      }
    })
    if (incident && this.plugin.settings.showIncidentTimeline) {
      renderLifecyclePanel(body, task, {
        onChange: () => this.scheduleSave(),
        slaPolicies: this.plugin.settings.slaPolicies
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
