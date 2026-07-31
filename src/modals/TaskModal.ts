import { App, ButtonComponent, ExtraButtonComponent, Menu, Modal, Notice, setIcon, setTooltip } from 'obsidian'
import type PMPlugin from '../main'
import { type Project, type Task, makeTask } from '../types'
import { flattenTasks } from '../store/TaskTreeOps'
import { TaskFileNameConflictError } from '../store'
import { safeAsync, getDefaultStatusId, getDefaultPriorityId, getPriorityConfig } from '../utils'
import { confirmDialog, openTaskModal } from '../ui/ModalFactory'
import { findTaskById } from '../store/TaskIndex'
import { renderKeyChip } from '../ui/composites/issueMeta'
import { renderTaskFormFields } from './TaskFormFields'
import { renderLifecyclePanel } from '../soc/LifecyclePanel'
import { renderIocSection } from '../soc/IocSection'
import { renderSeverityBadge, renderSlaChip } from '../soc/slaTicker'
import { guardVerdictOnClose } from '../soc/verdictGuard'
import { pivotToProjectQuery, renderActivitySection } from '../views/TaskDetailView'
import { renderTimeTrackingPanel } from './TimeTrackingPanel'
import { renderSubtasksPanel } from './SubtasksPanel'
import { renderDescriptionEditor, type DescriptionEditorHandle } from './DescriptionEditor'
import { renderCommentsSection, type CommentsSectionHandle } from '../soc/CommentsSection'

export class TaskModal extends Modal {
  private task: Task
  private isNew: boolean
  private originalParentId: string | null
  /** Live status at open time — the verdict guard runs only when the save changes it. */
  private originalStatus: string
  private cancelled = false
  private saved = false
  private persistPromise: Promise<void> | null = null
  private descEditor: DescriptionEditorHandle | null = null
  private commentsSection: CommentsSectionHandle | null = null
  private shownExtras = new Set<string>()
  private saveKeyHandler: ((e: KeyboardEvent) => void) | null = null

  constructor(
    app: App,
    private plugin: PMPlugin,
    private project: Project,
    task: Task | null,
    private parentId: string | null,
    private onSave: (task: Task) => void | Promise<void>,
    defaults?: Partial<Task>
  ) {
    super(app)
    if (task) {
      this.task = JSON.parse(JSON.stringify(task)) as Task
      this.isNew = false
      // Compute current parentId from tree if not explicitly provided
      if (parentId == null) {
        const flat = flattenTasks(project.tasks)
        const entry = flat.find((f) => f.task.id === task.id)
        this.parentId = entry?.parentId ?? null
      }
    } else {
      const config = plugin.store.configFor(project)
      this.task = makeTask({
        status: getDefaultStatusId(config.statuses),
        priority: getDefaultPriorityId(config.priorities),
        type: parentId ? 'subtask' : 'task',
        ...defaults
      })
      this.isNew = true
    }
    this.originalParentId = this.parentId
    this.originalStatus = this.task.status
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.addClass('pm-task-modal')
    this.modalEl.addClass('pm-modal', 'pm-modal--task')
    this.render()
  }

  onClose(): void {
    if (
      this.plugin.settings.saveTaskOnClose &&
      !this.isNew &&
      !this.cancelled &&
      !this.saved &&
      this.task.title.trim()
    ) {
      const conflict = this.plugin.store.findTaskFileConflict(this.project, this.task)
      if (conflict) {
        new Notice(`Task not saved: a note named "${conflict.fileName}" already exists.`)
      } else {
        void this.persistTask()
      }
    }
    if (this.saveKeyHandler) {
      this.modalEl.removeEventListener('keydown', this.saveKeyHandler)
      this.saveKeyHandler = null
    }
    this.descEditor?.destroy()
    this.descEditor = null
    this.commentsSection?.destroy()
    this.commentsSection = null
    this.contentEl.empty()
  }

  private persistTask(): Promise<void> {
    if (this.persistPromise) return this.persistPromise
    const p = (async () => {
      try {
        await this.runPersist()
      } catch (err) {
        this.persistPromise = null
        throw err
      }
    })()
    this.persistPromise = p
    return p
  }

  private async runPersist(): Promise<void> {
    if (this.isNew) {
      await this.plugin.store.insertTask(this.project, this.task, this.parentId)
    } else if (this.parentId !== this.originalParentId) {
      await this.plugin.store.updateTask(this.project, this.task.id, this.task)
      await this.plugin.store.moveTask(this.project, this.task.id, this.parentId)
    } else {
      await this.plugin.store.updateTask(this.project, this.task.id, this.task)
    }
    await this.plugin.store.scheduleAfterChange(this.project, this.task.id)
    await this.onSave(this.task)
  }

  private openOverflowMenu(anchorEl: HTMLElement): void {
    const menu = new Menu()
    if (this.task.filePath) {
      const filePath = this.task.filePath
      menu.addItem((item) =>
        item
          .setTitle('Open as note')
          .setIcon('file-text')
          .onClick(() => {
            this.saved = false
            this.cancelled = false
            this.close()
            void this.app.workspace.openLinkText(filePath, '', true)
          })
      )
      menu.addSeparator()
    }
    if (this.task.archived) {
      menu.addItem((item) =>
        item
          .setTitle('Unarchive')
          .setIcon('archive-restore')
          .onClick(
            safeAsync(async () => {
              await this.plugin.store.unarchiveTask(this.project, this.task.id)
              new Notice('Task unarchived')
              await this.onSave(this.task)
              this.cancelled = true
              this.close()
            })
          )
      )
    } else {
      menu.addItem((item) =>
        item
          .setTitle('Archive')
          .setIcon('archive')
          .onClick(
            safeAsync(async () => {
              await this.plugin.store.archiveTask(this.project, this.task.id)
              new Notice('Task archived')
              await this.onSave(this.task)
              this.cancelled = true
              this.close()
            })
          )
      )
    }
    menu.addItem((item) =>
      item
        .setTitle('Delete')
        .setIcon('trash-2')
        .setWarning(true)
        .onClick(
          safeAsync(async () => {
            if (await confirmDialog(this.app, `Delete "${this.task.title}"?`)) {
              await this.plugin.store.deleteTask(this.project, this.task.id)
              await this.onSave(this.task)
              this.cancelled = true
              this.close()
            }
          })
        )
    )
    const rect = anchorEl.getBoundingClientRect()
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 })
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()

    // ── Header: breadcrumb · overflow · close ───────────────────────────────
    const header = contentEl.createDiv('pm-te-header')
    const config = this.plugin.store.configFor(this.project)
    const prio = getPriorityConfig(config.priorities, this.task.priority)
    if (prio?.color) header.setCssProps({ '--pm-accent-strip': prio.color })
    const crumb = header.createDiv('pm-te-crumb')
    if (this.project.icon) {
      const iconEl = crumb.createSpan({ cls: 'pm-te-crumb-icon' })
      // project.icon is either an emoji or a Lucide icon name; render names as icons.
      if (/^[a-z0-9-]+$/.test(this.project.icon)) setIcon(iconEl, this.project.icon)
      else iconEl.setText(this.project.icon)
    }
    crumb.createSpan({ cls: 'pm-te-crumb-name', text: this.project.title })
    const crumbSep = crumb.createSpan({ cls: 'pm-te-crumb-sep' })
    setIcon(crumbSep, 'chevron-right')
    if (this.task.key) {
      renderKeyChip(crumb, this.task.key, { copy: true })
    } else {
      const idEl = crumb.createSpan({ cls: 'pm-te-crumb-id pm-te-copyable', text: this.task.id })
      setTooltip(idEl, 'Copy task ID')
      idEl.addEventListener(
        'click',
        safeAsync(async () => {
          await navigator.clipboard.writeText(this.task.id)
          new Notice('Copied task ID')
        })
      )
    }
    if (this.task.issueType === 'incident') {
      renderSeverityBadge(
        crumb,
        config.severities.find((s) => s.id === this.task.severity)
      )
      // Registered chips unregister themselves: the shared 30s tick drops any
      // chip whose element left the DOM, and both onClose and every render()
      // empty contentEl (KanbanCard lifecycle — rebuild, never detach-and-keep).
      renderSlaChip(crumb, this.task, this.plugin.settings.slaPolicies)
    }

    header.createDiv('pm-te-header-spacer')

    if (!this.isNew) {
      const moreBtn = new ExtraButtonComponent(header).setIcon('more-horizontal').setTooltip('More actions')
      moreBtn.extraSettingsEl.addClass('pm-te-header-btn')
      moreBtn.onClick(() => this.openOverflowMenu(moreBtn.extraSettingsEl))
    }
    const closeBtn = new ExtraButtonComponent(header).setIcon('x').setTooltip('Close')
    closeBtn.extraSettingsEl.addClass('pm-te-header-btn')
    closeBtn.onClick(() => {
      this.cancelled = true
      this.close()
    })

    // ── Body ────────────────────────────────────────────────────────────────
    const body = contentEl.createDiv('pm-te-body')

    // Title hero
    const titleWrap = body.createDiv('pm-te-title-wrap')
    const titleInput = titleWrap.createEl('textarea', { cls: 'pm-te-title' })
    titleInput.rows = 1
    titleInput.value = this.task.title
    titleInput.placeholder = 'Task title'
    titleInput.spellcheck = false
    const autosizeTitle = () => {
      titleInput.setCssProps({ '--te-title-height': 'auto' })
      titleInput.setCssProps({ '--te-title-height': titleInput.scrollHeight + 'px' })
    }
    const titleError = titleWrap.createDiv({ cls: 'pm-modal-title-error', attr: { hidden: '' } })
    const clearTitleError = () => {
      if (titleError.hasAttribute('hidden')) return
      titleError.setAttribute('hidden', '')
      titleError.setText('')
      titleInput.classList.remove('pm-input-error')
    }
    const showTitleError = (message: string) => {
      titleError.setText(message)
      titleError.removeAttribute('hidden')
      titleInput.classList.add('pm-input-error')
      titleInput.focus()
      titleInput.select()
    }
    titleInput.addEventListener('input', () => {
      this.task.title = titleInput.value
      clearTitleError()
      autosizeTitle()
    })
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) e.preventDefault()
    })
    window.setTimeout(autosizeTitle, 0)
    titleInput.focus()
    if (this.isNew) titleInput.select()

    // Properties
    const props = body.createDiv('pm-te-props')
    renderTaskFormFields(props, {
      task: this.task,
      project: this.project,
      plugin: this.plugin,
      parentId: this.parentId,
      setParentId: (id) => {
        this.parentId = id
      },
      rerender: () => this.render(),
      shownExtras: this.shownExtras
    })

    body.createEl('hr', { cls: 'pm-te-divider' })

    // ── Description (preview / edit) ─────────────────────────────────────────
    this.descEditor?.destroy()
    this.descEditor = renderDescriptionEditor(body, {
      app: this.app,
      plugin: this.plugin,
      project: this.project,
      task: this.task,
      onNavigateAway: () => {
        this.saved = false
        this.cancelled = false
        this.close()
      }
    })

    // ── Incident sections (timeline + indicators) ───────────────────────────
    // onChange is a no-op here: the modal persists the whole clone on Save.
    if (this.task.issueType === 'incident') {
      renderLifecyclePanel(body, this.task, { onChange: () => {} })
      renderIocSection(body, this.task, {
        onChange: () => {},
        onPivot: (query) => {
          // Navigate-away semantics (open-as-note precedent): save-on-close still applies.
          this.saved = false
          this.cancelled = false
          this.close()
          void pivotToProjectQuery(this.plugin, this.project.filePath, query)
        }
      })
    }

    // Comments render for every task with a hydrated body (new tasks have none yet).
    if (!this.isNew) {
      this.commentsSection?.destroy()
      this.commentsSection = renderCommentsSection(body, this.plugin, this.project, this.task, {
        onChange: () => this.render()
      })
      renderActivitySection(body, this.task)
    }

    // ── Subtasks ────────────────────────────────────────────────────────────
    renderSubtasksPanel(body, this.task, this.plugin, this.plugin.store.configFor(this.project).statuses, {
      onOpen: (sub) => {
        const live = findTaskById(this.project, sub.id)
        if (!live) {
          new Notice('Save first — this subtask has no page yet.')
          return
        }
        // Navigate-away semantics (open-as-note precedent): save-on-close still applies.
        this.saved = false
        this.cancelled = false
        this.close()
        openTaskModal(this.plugin, this.project, {
          task: live,
          onSave: () => this.plugin.refreshProjectViews()
        })
      }
    })

    // ── Time tracking ─────────────────────────────────────────────────────────
    renderTimeTrackingPanel(body, this.task)

    // ── Footer ──────────────────────────────────────────────────────────────
    const footer = contentEl.createDiv('pm-te-footer')

    if (!this.isNew && this.task.filePath) {
      const filePath = this.task.filePath
      const pathHint = footer.createSpan({ cls: 'pm-te-footer-path pm-te-copyable' })
      const fileIcon = pathHint.createSpan({ cls: 'pm-te-footer-icon' })
      setIcon(fileIcon, 'file-text')
      pathHint.createSpan({ text: filePath })
      setTooltip(pathHint, 'Copy file path')
      pathHint.addEventListener(
        'click',
        safeAsync(async () => {
          await navigator.clipboard.writeText(filePath)
          new Notice('Copied file path')
        })
      )
    }

    footer.createDiv('pm-footer-spacer')

    new ButtonComponent(footer).setButtonText('Cancel').onClick(() => {
      this.cancelled = true
      this.close()
    })

    const saveBtn = new ButtonComponent(footer)
      .setButtonText(this.isNew ? 'Create (Shift+Enter)' : 'Save (Shift+Enter)')
      .setCta()
    let saving = false
    const doSave = async () => {
      if (saving) return
      saving = true
      try {
        if (!this.task.title.trim()) {
          titleInput.focus()
          titleInput.classList.add('pm-input-error')
          return
        }
        clearTitleError()
        if (this.task.status !== this.originalStatus) {
          const patch = await guardVerdictOnClose(this.plugin, this.project, this.task, this.task.status)
          if (patch === null) return // user cancelled the close — keep the modal open, save nothing
          if (patch.verdict) this.task.verdict = patch.verdict
        }
        await this.persistTask()
        this.saved = true
        this.close()
      } catch (err) {
        if (err instanceof TaskFileNameConflictError) {
          showTitleError(`A note named "${err.fileName}" already exists. Choose a different title.`)
          return
        }
        console.error('[PM]', err)
        new Notice('Something went wrong. Check the console for details.')
      } finally {
        saving = false
      }
    }

    saveBtn.onClick(() => {
      void doSave()
    })

    if (this.saveKeyHandler) this.modalEl.removeEventListener('keydown', this.saveKeyHandler)
    this.saveKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        void doSave()
      }
    }
    this.modalEl.addEventListener('keydown', this.saveKeyHandler)
  }
}
