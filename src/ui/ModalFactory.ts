import { type App, ButtonComponent, Modal, SuggestModal } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, Task } from '../types'
import { CASEFILE_TASK_DETAIL_VIEW_TYPE } from '../views/TaskDetailView'
import { TaskModal } from '../modals/TaskModal'
import { ProjectModal } from '../modals/ProjectModal'
import { ProjectPickerModal, TaskPickerModal } from '../modals/PickerModals'
import { ImportModal } from '../modals/ImportModal'
import { flattenTasks } from '../store/TaskTreeOps'
import { findTaskById } from '../store/TaskIndex'
import { pushRecent } from './recents'

/**
 * Opens an Obsidian-native confirmation dialog.
 * Returns a promise that resolves to true if confirmed, false if cancelled.
 */
export function confirmDialog(app: App, message: string, confirmLabel = 'Delete'): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new ConfirmModal(app, message, confirmLabel, resolve)
    modal.open()
  })
}

/**
 * Asks the user whether to duplicate a task with or without its subtasks.
 * Resolves to the chosen mode, or null if cancelled.
 */
export function confirmDuplicateSubtasks(app: App, taskTitle: string): Promise<'with-subtasks' | 'task-only' | null> {
  return new Promise((resolve) => {
    const modal = new DuplicateSubtasksModal(app, taskTitle, resolve)
    modal.open()
  })
}

/**
 * Opens an Obsidian-native text input prompt.
 * Returns the trimmed string, or null if cancelled/empty.
 */
export function promptText(app: App, label: string, placeholder = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new TextPromptModal(app, label, placeholder, resolve)
    modal.open()
  })
}

class TextPromptModal extends Modal {
  private resolved = false

  constructor(
    app: App,
    private label: string,
    private placeholder: string,
    private resolve: (value: string | null) => void
  ) {
    super(app)
  }

  private finish(value: string | null): void {
    if (this.resolved) return
    this.resolved = true
    this.resolve(value)
  }

  onOpen(): void {
    const { contentEl } = this
    this.modalEl.addClass('pm-prompt-modal')

    contentEl.createEl('p', {
      text: this.label,
      cls: 'pm-prompt-text'
    })

    const input = contentEl.createEl('input', {
      type: 'text',
      placeholder: this.placeholder,
      cls: 'pm-prompt-input'
    })

    const btnRow = contentEl.createDiv('pm-modal-btn-row')

    new ButtonComponent(btnRow).setButtonText('Cancel').onClick(() => {
      this.finish(null)
      this.close()
    })

    const submit = () => {
      const val = input.value.trim()
      this.finish(val || null)
      this.close()
    }

    new ButtonComponent(btnRow).setButtonText('OK').setCta().onClick(submit)

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        submit()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        this.finish(null)
        this.close()
      }
    })

    window.setTimeout(() => input.focus(), 10)
  }

  onClose(): void {
    this.finish(null)
    this.contentEl.empty()
  }
}

class ConfirmModal extends Modal {
  private resolved = false

  constructor(
    app: App,
    private message: string,
    private confirmLabel: string,
    private resolve: (value: boolean) => void
  ) {
    super(app)
  }

  private finish(value: boolean): void {
    if (this.resolved) return
    this.resolved = true
    this.resolve(value)
  }

  onOpen(): void {
    const { contentEl } = this
    this.modalEl.addClass('pm-confirm-modal')

    contentEl.createEl('p', {
      text: this.message,
      cls: 'pm-confirm-text'
    })

    const btnRow = contentEl.createDiv('pm-modal-btn-row')

    new ButtonComponent(btnRow).setButtonText('Cancel').onClick(() => {
      this.finish(false)
      this.close()
    })

    new ButtonComponent(btnRow)
      .setButtonText(this.confirmLabel)
      .setWarning()
      .onClick(() => {
        this.finish(true)
        this.close()
      })
  }

  onClose(): void {
    this.finish(false)
    this.contentEl.empty()
  }
}

class DuplicateSubtasksModal extends Modal {
  private resolved = false

  constructor(
    app: App,
    private taskTitle: string,
    private resolve: (value: 'with-subtasks' | 'task-only' | null) => void
  ) {
    super(app)
  }

  private finish(value: 'with-subtasks' | 'task-only' | null): void {
    if (this.resolved) return
    this.resolved = true
    this.resolve(value)
  }

  onOpen(): void {
    const { contentEl } = this
    this.modalEl.addClass('pm-confirm-modal')

    contentEl.createEl('p', {
      text: `Duplicate "${this.taskTitle}" with its subtasks?`,
      cls: 'pm-confirm-text'
    })

    const btnRow = contentEl.createDiv('pm-modal-btn-row')

    new ButtonComponent(btnRow).setButtonText('Cancel').onClick(() => {
      this.finish(null)
      this.close()
    })

    new ButtonComponent(btnRow).setButtonText('Task only').onClick(() => {
      this.finish('task-only')
      this.close()
    })

    new ButtonComponent(btnRow)
      .setButtonText('With subtasks')
      .setCta()
      .onClick(() => {
        this.finish('with-subtasks')
        this.close()
      })
  }

  onClose(): void {
    this.finish(null)
    this.contentEl.empty()
  }
}

/**
 * Centralized modal helpers. Instead of `new TaskModal(app, plugin, project, task, parentId, cb).open()`
 * everywhere (6 params, 14+ call sites), use `openTaskModal(plugin, project, { task, parentId, onSave })`.
 */

export interface OpenTaskModalOpts {
  task?: Task | null
  parentId?: string | null
  defaults?: Partial<Task>
  onSave: (task: Task) => void | Promise<void>
}

/** Reveal (or create) the right-leaf task detail panel for an existing task. */
export function openTaskDetailPanel(plugin: PMPlugin, project: Project, taskId: string): void {
  void (async () => {
    const leaf = plugin.app.workspace.getRightLeaf(false)
    if (!leaf) return
    await leaf.setViewState({
      type: CASEFILE_TASK_DETAIL_VIEW_TYPE,
      active: true,
      state: { projectPath: project.filePath, taskId }
    })
    await plugin.app.workspace.revealLeaf(leaf)
  })()
}

/**
 * Every task-open path (board card, table row, context menu, case switcher)
 * routes through openTaskModal, so the recents list is stamped here.
 */
function recordRecentCase(plugin: PMPlugin, project: Project, task: Task): void {
  const list = plugin.settings.recentCases ?? []
  if (list[0]?.path === project.filePath && list[0]?.id === task.id) return
  plugin.settings.recentCases = pushRecent(list, { path: project.filePath, id: task.id })
  void plugin.saveSettings()
}

export function openTaskModal(plugin: PMPlugin, project: Project, opts: OpenTaskModalOpts): void {
  if (opts.task) recordRecentCase(plugin, project, opts.task)
  // Every view routes task-opening through this factory, so the modal-vs-panel
  // setting lives here. New-task creation always uses the modal — a panel for a
  // not-yet-persisted task has no autosave target.
  if (opts.task && plugin.settings.openTaskIn === 'panel') {
    openTaskDetailPanel(plugin, project, opts.task.id)
    return
  }
  const open = (): void => {
    new TaskModal(
      plugin.app,
      plugin,
      project,
      opts.task ?? null,
      opts.parentId ?? null,
      opts.onSave,
      opts.defaults
    ).open()
  }
  // Tasks loaded via metadataCache have an empty description until the file
  // body is read. Pre-load (no-op if already hydrated) so the modal renders the
  // real description in one paint.
  if (opts.task) {
    const task = opts.task
    void (async () => {
      await plugin.store.loadTaskBody(task)
      open()
    })()
  } else {
    open()
  }
}

export interface OpenProjectModalOpts {
  project?: Project | null
  onSave: (project: Project) => void | Promise<void>
}

export function openProjectModal(plugin: PMPlugin, opts: OpenProjectModalOpts): void {
  const open = (): void => {
    new ProjectModal(plugin.app, plugin, opts.project ?? null, opts.onSave).open()
  }
  if (opts.project) {
    const project = opts.project
    void (async () => {
      await plugin.store.loadProjectBody(project)
      open()
    })()
  } else {
    open()
  }
}

export function openProjectPicker(plugin: PMPlugin, projects: Project[], onChoose: (project: Project) => void): void {
  new ProjectPickerModal(plugin.app, projects, onChoose).open()
}

export function openTaskPicker(plugin: PMPlugin, tasks: Task[], onChoose: (task: Task) => void): void {
  new TaskPickerModal(plugin.app, tasks, onChoose).open()
}

interface CaseEntry {
  project: Project
  task: Task
}

/**
 * Global case switcher: picks over every keyed task across all projects.
 * An empty query lists recently opened cases, most recent first; stale
 * recents (deleted task/project, key removed) are skipped silently.
 */
export function openCasePicker(plugin: PMPlugin, projects: Project[]): void {
  new CasePickerModal(plugin, projects).open()
}

class CasePickerModal extends SuggestModal<CaseEntry> {
  private entries: CaseEntry[]
  private recents: CaseEntry[]

  constructor(
    private plugin: PMPlugin,
    projects: Project[]
  ) {
    super(plugin.app)
    this.setPlaceholder('Open case…')
    this.entries = projects.flatMap((project) => flattenTasks(project.tasks).map(({ task }) => ({ project, task })))
    const byPath = new Map(projects.map((p) => [p.filePath, p]))
    this.recents = (plugin.settings.recentCases ?? []).flatMap((r) => {
      const project = byPath.get(r.path)
      const task = project ? findTaskById(project, r.id) : null
      return project && task ? [{ project, task }] : []
    })
  }

  getSuggestions(query: string): CaseEntry[] {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!tokens.length) return this.recents.length ? this.recents : this.entries
    return this.entries.filter((e) => {
      const hay = `${e.task.key ?? ''} ${e.task.title}`.toLowerCase()
      return tokens.every((t) => hay.includes(t))
    })
  }

  renderSuggestion(entry: CaseEntry, el: HTMLElement): void {
    const { task, project } = entry
    el.addClass('mod-complex')
    const content = el.createDiv({ cls: 'suggestion-content' })
    content.createDiv({ cls: 'suggestion-title', text: task.key ? `${task.key} · ${task.title}` : task.title })
    const config = this.plugin.store.configFor(project)
    const status = config.statuses.find((s) => s.id === task.status)?.label ?? task.status
    const severity = task.severity
      ? (config.severities.find((s) => s.id === task.severity)?.label ?? task.severity)
      : ''
    content.createDiv({ cls: 'suggestion-note', text: severity ? `${status} · ${severity}` : status })
  }

  onChooseSuggestion(entry: CaseEntry): void {
    // Honors the openTaskIn setting; TaskModal persists edits via store.updateTask.
    openTaskModal(this.plugin, entry.project, {
      task: entry.task,
      onSave: () => {
        this.plugin.refreshProjectViews()
      }
    })
  }
}

export function openImportModal(
  plugin: PMPlugin,
  project: Project,
  onImportComplete?: () => void | Promise<void>
): void {
  const modal = new ImportModal(plugin.app, plugin)
  modal.setProject(project)
  if (onImportComplete) {
    modal.setOnImportComplete(() => {
      void onImportComplete()
    })
  }
  modal.open()
}
