import { ItemView, Notice, WorkspaceLeaf, TFile, setIcon } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, Task } from '../types'
import { renderDescriptionEditor, type DescriptionEditorHandle } from '../modals/DescriptionEditor'
import { renderCommentsSection, type CommentsSectionHandle } from '../soc/CommentsSection'
import { renderTaskFormFields } from '../modals/TaskFormFields'
import { renderLifecyclePanel } from '../soc/LifecyclePanel'
import { renderIocSection } from '../soc/IocSection'
import { guardVerdictOnClose } from '../soc/verdictGuard'
import { renderSubtasksPanel } from '../modals/SubtasksPanel'
import { renderTimeTrackingPanel } from '../modals/TimeTrackingPanel'
import { renderKeyChip, renderIssueTypeIcon } from '../ui/composites/issueMeta'

export const GSPM_TASK_DETAIL_VIEW_TYPE = 'gspm-task-detail'

interface TaskDetailState {
  projectPath: string
  taskId: string
  [key: string]: unknown
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
  /** Status before the in-flight edit — lets the rerender hook detect a change and run the verdict guard. */
  private lastStatus = ''
  private descEditor: DescriptionEditorHandle | null = null
  private commentsSection: CommentsSectionHandle | null = null
  private saveTimer: number | null = null
  private dirty = false
  private shownExtras = new Set<string>()

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: PMPlugin
  ) {
    super(leaf)
    this.navigation = false
  }

  getViewType(): string {
    return GSPM_TASK_DETAIL_VIEW_TYPE
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
    this.persistedTitle = this.task.title
    this.lastStatus = this.task.status
    this.dirty = false
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
    this.dirty = true
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      void this.persist()
    }, 800)
  }

  private async flushPendingSave(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.dirty) await this.persist()
  }

  /** Debounce-path save: everything except the in-flight title edit. */
  private async persist(): Promise<void> {
    if (!this.project || !this.task) return
    this.dirty = false
    try {
      await this.plugin.store.updateTask(this.project, this.task.id, { ...this.task, title: this.persistedTitle })
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
    renderIssueTypeIcon(
      header,
      config.issueTypes.find((t) => t.id === task.issueType)
    )
    if (task.key) renderKeyChip(header, task.key, { copy: true })
    header.createDiv('pm-td-header-spacer')
    if (task.filePath) {
      const filePath = task.filePath
      const noteBtn = header.createSpan({ cls: 'pm-td-note-btn' })
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
      setParentId: () => {},
      rerender: () => {
        if (task.status !== this.lastStatus) {
          void this.onStatusChanged(task)
          return
        }
        this.scheduleSave()
        this.render()
      },
      shownExtras: this.shownExtras
    })

    body.createEl('hr', { cls: 'pm-te-divider' })
    this.descEditor = renderDescriptionEditor(body, {
      app: this.app,
      plugin: this.plugin,
      project,
      task
    })
    if (task.issueType === 'incident') {
      renderLifecyclePanel(body, task, { onChange: () => this.scheduleSave() })
      renderIocSection(body, task, { onChange: () => this.scheduleSave() })
    }
    this.commentsSection?.destroy()
    this.commentsSection = renderCommentsSection(body, this.plugin, project, task, {
      onChange: () => {
        this.scheduleSave()
        this.render()
      }
    })
    renderSubtasksPanel(body, task, this.plugin, config.statuses)
    renderTimeTrackingPanel(body, task)

    // Any input inside the body (description textarea, subtask titles, time
    // logs) marks the clone dirty; the field controls above already do it via
    // rerender(). Event delegation keeps this one listener instead of N hooks.
    body.addEventListener('input', () => this.scheduleSave())
  }
}
