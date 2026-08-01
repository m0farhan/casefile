import { MarkdownView, Menu, Plugin, Notice, TFile, TFolder, normalizePath } from 'obsidian'
import { DEFAULT_SETTINGS, type PMSettings, type Project, type Task } from './types'
import { flattenTasks, findTask } from './store/TaskTreeOps'
import { ProjectStore } from './store'
import type { TaskSource } from './store'
import { PMSettingTab } from './settings'
import { ProjectView, PM_PROJECT_VIEW_TYPE } from './views/ProjectView'
import { DashboardView, PM_DASHBOARD_VIEW_TYPE } from './views/DashboardView'
import { TaskDetailView, CASEFILE_TASK_DETAIL_VIEW_TYPE } from './views/TaskDetailView'
import { registerStyleguide } from './views/styleguide/StyleguideView'
import { PMViewRouter } from './views/PMViewRouter'
import {
  openProjectModal,
  openTaskModal,
  openProjectPicker,
  openTaskPicker,
  openCasePicker,
  openImportModal,
  confirmDialog,
  promptText
} from './ui/ModalFactory'
import { Notifier } from './components/Notifier'
import { buildHandover } from './soc/handover'
import { ensureFolder } from './store/vaultFs'
import { migrateProjects } from './migration'
import { isCasesLayout, isProjectFolderLayout, projectFileName, taskFolderForProjectPath } from './store/layout'
import { safeAsync } from './utils'

export default class PMPlugin extends Plugin {
  settings: PMSettings = { ...DEFAULT_SETTINGS }
  store!: TaskSource
  notifier!: Notifier
  router!: PMViewRouter
  undoStack: Array<{ undo: () => Promise<void>; redo: () => Promise<void> }> = []
  redoStack: Array<{ undo: () => Promise<void>; redo: () => Promise<void> }> = []

  pushUndo(entry: { undo: () => Promise<void>; redo: () => Promise<void> }): void {
    this.undoStack.push(entry)
    if (this.undoStack.length > 20) this.undoStack.shift()
    this.redoStack = []
  }

  async undoLastAction(): Promise<void> {
    const entry = this.undoStack.pop()
    if (entry) {
      await entry.undo()
      this.redoStack.push(entry)
    }
  }

  async redoLastAction(): Promise<void> {
    const entry = this.redoStack.pop()
    if (entry) {
      await entry.redo()
      this.undoStack.push(entry)
    }
  }

  async onload(): Promise<void> {
    await this.loadSettings()
    this.store = new ProjectStore(this.app, () => this.settings)
    this.store.registerCacheInvalidation(this)
    this.notifier = new Notifier(this)
    this.router = new PMViewRouter(this)

    this.registerView(PM_PROJECT_VIEW_TYPE, (leaf) => new ProjectView(leaf, this))
    this.registerView(PM_DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf, this))
    this.registerView(CASEFILE_TASK_DETAIL_VIEW_TYPE, (leaf) => new TaskDetailView(leaf, this))
    if (__STYLEGUIDE__) registerStyleguide(this)

    this.app.workspace.onLayoutReady(
      safeAsync(async () => {
        await migrateProjects(this)
        await this.cleanupStaleProjectFilters()
      })
    )

    this.addRibbonIcon('chart-gantt', 'Project manager', async () => {
      await this.router.openDashboard()
    })

    this.addCommand({
      id: 'open-projects',
      name: 'Open projects pane',
      callback: () => {
        void this.router.openDashboard()
      }
    })

    this.addCommand({
      id: 'open-case',
      name: 'Open case',
      callback: () => {
        void this.openCaseSwitcher()
      }
    })

    this.addCommand({
      id: 'new-project',
      name: 'Create new project',
      callback: () => {
        openProjectModal(this, {
          onSave: async (project) => {
            await this.router.openProjectByPath(project.filePath)
          }
        })
      }
    })

    this.addCommand({
      id: 'new-task',
      name: 'Create new task',
      callback: () => {
        void this.pickProjectThenCreateTask(null)
      }
    })

    this.addCommand({
      id: 'new-subtask',
      name: 'Create new subtask',
      callback: () => {
        void this.pickProjectThenCreateTask('pick-parent')
      }
    })

    this.addCommand({
      id: 'undo-last-action',
      name: 'Undo last action',
      callback: () => {
        void this.undoLastAction()
      }
    })

    this.addCommand({
      id: 'redo-last-action',
      name: 'Redo last action',
      callback: () => {
        void this.redoLastAction()
      }
    })

    this.addCommand({
      id: 'import-notes-as-tasks',
      name: 'Import notes as tasks',
      callback: () => {
        void this.importNotes()
      }
    })

    this.addCommand({
      id: 'migrate-to-cases-layout',
      name: 'Move cases and tasks into tidy folders',
      callback: () => {
        void this.migrateToCasesLayout()
      }
    })

    this.addCommand({
      id: 'migrate-to-project-folders',
      name: 'Move each case into its own folder',
      callback: () => {
        void this.migrateToProjectFolders()
      }
    })

    this.addCommand({
      id: 'nest-subtask-files',
      name: 'Nest subtasks under their parent tasks',
      callback: () => {
        void this.nestSubtaskFiles()
      }
    })

    this.addCommand({
      id: 'adopt-issue-keys',
      name: 'Adopt issue keys for a project',
      callback: () => {
        void this.adoptIssueKeysFlow()
      }
    })

    this.addCommand({
      id: 'new-incident-from-template',
      name: 'New incident from template',
      callback: () => {
        void this.newIncidentFromTemplate()
      }
    })

    this.addCommand({
      id: 'generate-shift-handover',
      name: 'Generate shift handover',
      callback: () => {
        void this.generateShiftHandover()
      }
    })

    this.addCommand({
      id: 'create-task-from-selection',
      name: 'Create task from selection',
      editorCheckCallback: (checking, editor) => {
        const selection = editor.getSelection().trim()
        if (!selection) return false
        if (checking) return true
        void this.createTaskFromText(selection)
        return true
      }
    })

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor) => {
        const selection = editor.getSelection().trim()
        if (!selection) return
        menu.addItem((item) =>
          item
            .setTitle('Create task from selection')
            .setIcon('list-plus')
            .onClick(() => void this.createTaskFromText(selection))
        )
      })
    )

    this.addCommand({
      id: 'open-current-as-project',
      name: 'Open current file as project',
      checkCallback: (checking: boolean) => {
        const md = this.app.workspace.getActiveViewOfType(MarkdownView)
        const file = md?.file
        if (!file) return false
        const cache = this.app.metadataCache.getFileCache(file)
        if (cache?.frontmatter?.['pm-project'] !== true) return false
        if (checking) return true
        void md.leaf.setViewState({ type: PM_PROJECT_VIEW_TYPE, state: { filePath: file.path } })
        return true
      }
    })

    this.applyMotionPreference()
    this.addSettingTab(new PMSettingTab(this.app, this))
    this.notifier.start()
  }

  onunload(): void {
    this.notifier.stop()
  }

  /** Movement effects are CSS-gated on this body class so modals/popovers inherit it too. */
  applyMotionPreference(): void {
    activeDocument.body.classList.toggle('gs-reduce-motion', this.settings.reduceAnimations)
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<PMSettings> | null
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {})
    if (!saved?.statuses?.length) this.settings.statuses = DEFAULT_SETTINGS.statuses
    if (!saved?.priorities?.length) this.settings.priorities = DEFAULT_SETTINGS.priorities
    if (!saved?.issueTypes?.length) this.settings.issueTypes = DEFAULT_SETTINGS.issueTypes
    if (!saved?.severities?.length) this.settings.severities = DEFAULT_SETTINGS.severities
    if (!saved?.verdicts?.length) this.settings.verdicts = DEFAULT_SETTINGS.verdicts
    if (!saved?.slaPolicies || !Object.keys(saved.slaPolicies).length) {
      this.settings.slaPolicies = DEFAULT_SETTINGS.slaPolicies
    }
    if (!saved?.incidentTemplates?.length) this.settings.incidentTemplates = DEFAULT_SETTINGS.incidentTemplates
    if (!this.settings.projectFilters) this.settings.projectFilters = {}
    if (!this.settings.collapsedTasks) this.settings.collapsedTasks = {}
    if (!this.settings.collapsedKanbanColumns) this.settings.collapsedKanbanColumns = {}
    // Old-plugin data.json (or older fork versions) lack the new filter arrays.
    for (const entry of Object.values(this.settings.projectFilters)) {
      entry.filter.severities ??= []
      entry.filter.verdicts ??= []
    }

    let migrated = false
    for (const s of this.settings.statuses) {
      if (s.complete === undefined) {
        s.complete = s.id === 'done' || s.id === 'cancelled'
        migrated = true
      }
    }

    // ganttHideDone was a global gantt toggle; replaced by per-project filter.statuses
    // excluding terminal statuses. Seed projects whose filter has no status selection yet.
    const legacy = (saved ?? {}) as { ganttHideDone?: boolean }
    if (legacy.ganttHideDone === true) {
      const nonTerminal = this.settings.statuses.filter((s) => !s.complete).map((s) => s.id)
      for (const entry of Object.values(this.settings.projectFilters)) {
        if (entry.filter.statuses.length === 0) {
          entry.filter.statuses = nonTerminal
        }
      }
      migrated = true
    }

    if (migrated) await this.saveSettings()
  }

  async cleanupStaleProjectFilters(): Promise<void> {
    let dirty = false
    const prune = <T>(record: Record<string, T>): Record<string, T> => {
      const kept: Record<string, T> = {}
      for (const [path, entry] of Object.entries(record)) {
        if (this.app.vault.getAbstractFileByPath(path)) {
          kept[path] = entry
        } else {
          dirty = true
        }
      }
      return kept
    }
    this.settings.projectFilters = prune(this.settings.projectFilters)
    this.settings.collapsedTasks = prune(this.settings.collapsedTasks)
    this.settings.collapsedKanbanColumns = prune(this.settings.collapsedKanbanColumns)
    if (dirty) await this.saveSettings()
  }

  /**
   * Overlay the persisted collapsed-task state onto a freshly loaded project.
   * Projects with no record yet keep whatever legacy frontmatter said.
   */
  applyCollapsedState(project: Project): void {
    const ids = this.settings.collapsedTasks[project.filePath]
    if (!ids) return
    const set = new Set(ids)
    for (const { task } of flattenTasks(project.tasks)) {
      task.collapsed = set.has(task.id)
    }
  }

  /** Persist the project's current collapsed flags. Call after toggling task.collapsed. */
  async persistCollapsedState(project: Project): Promise<void> {
    this.settings.collapsedTasks[project.filePath] = flattenTasks(project.tasks)
      .filter((f) => f.task.collapsed)
      .map((f) => f.task.id)
    await this.saveSettings()
  }

  /**
   * Flip a task's collapsed flag and persist. Resolves the task by id against
   * the live tree so it works even when a view renders filtered clones.
   */
  async toggleTaskCollapsed(project: Project, taskId: string): Promise<void> {
    const task = findTask(project.tasks, taskId)
    if (!task) return
    task.collapsed = !task.collapsed
    await this.persistCollapsedState(project)
  }

  isKanbanColumnCollapsed(project: Project, statusId: string): boolean {
    return (this.settings.collapsedKanbanColumns[project.filePath] ?? []).includes(statusId)
  }

  /** Flip a kanban column's collapsed flag and persist. Mirrors toggleTaskCollapsed. */
  async toggleKanbanColumnCollapsed(project: Project, statusId: string): Promise<void> {
    const current = this.settings.collapsedKanbanColumns[project.filePath] ?? []
    this.settings.collapsedKanbanColumns[project.filePath] = current.includes(statusId)
      ? current.filter((id) => id !== statusId)
      : [...current, statusId]
    await this.saveSettings()
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  showNotice(msg: string, duration = 3000): void {
    new Notice(msg, duration)
  }

  /** Re-render every open project view, e.g. after a settings change affects rendering. */
  refreshProjectViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(PM_PROJECT_VIEW_TYPE)) {
      if (leaf.view instanceof ProjectView) void leaf.view.refreshProject()
    }
  }

  /** Global case switcher over every task (keys shown when present); empty query lists recent cases. */
  private async openCaseSwitcher(): Promise<void> {
    const projects = await this.store.loadAllProjects(this.settings.projectsFolder)
    const hasTasks = projects.some((p) => p.tasks.length > 0)
    if (!hasTasks) {
      this.showNotice('No cases yet. Create a project and add tasks first.')
      return
    }
    openCasePicker(this, projects)
  }

  /** Show project picker, then open TaskModal to create a task (optionally pick parent for subtask) */
  private async newIncidentFromTemplate(): Promise<void> {
    const projects = await this.store.loadAllProjects(this.settings.projectsFolder)
    if (!projects.length) {
      this.showNotice('No projects yet. Create a project first.')
      return
    }
    openProjectPicker(this, projects, (project) => {
      const templates = this.settings.incidentTemplates
      if (!templates.length) {
        this.showNotice('No incident templates configured in settings.')
        return
      }
      const menu = new Menu()
      for (const tpl of templates) {
        menu.addItem((item) =>
          item
            .setTitle(tpl.name)
            .setIcon('siren')
            .onClick(() => {
              this.openTaskModalForProject(project, null, {
                ...tpl.taskDefaults,
                tags: [...(tpl.taskDefaults.tags ?? [])],
                description: tpl.bodyMarkdown,
                detectedAt: new Date().toISOString()
              })
            })
        )
      }
      menu.showAtPosition({ x: window.innerWidth / 2 - 100, y: window.innerHeight / 3 })
    })
  }

  private async generateShiftHandover(): Promise<void> {
    const projects = await this.store.loadAllProjects(this.settings.projectsFolder)
    const md = buildHandover(projects, this.settings, new Date().toISOString())
    const path = this.settings.handoverPath || 'SOC/Handover.md'
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    if (folder) await ensureFolder(this.app, folder)
    const existing = this.app.vault.getAbstractFileByPath(path)
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, md)
    } else {
      await this.app.vault.create(path, md)
    }
    await this.app.workspace.openLinkText(path, '', true)
  }

  /**
   * One-time move from the legacy layout (case file + sibling `X_tasks`
   * folder sprawling in the projects folder) into `Cases/` + `Tasks/<case>/`.
   * Uses fileManager.renameFile so every wikilink — including hand-written
   * ones — updates automatically. Path-keyed settings are re-keyed so
   * filters and collapse state survive.
   */
  private async migrateToCasesLayout(): Promise<void> {
    const root = this.settings.projectsFolder
    const projects = await this.store.loadAllProjects(root)
    const legacy = projects.filter((p) => !isCasesLayout(p.filePath) && !isProjectFolderLayout(p.filePath))
    if (!legacy.length) {
      this.showNotice('All cases already use the Cases/Tasks layout.')
      return
    }
    const ok = await confirmDialog(
      this.app,
      `Move ${legacy.length} case file(s) into ${root}/Cases and their task folders into ${root}/Tasks. Links to the moved notes update automatically.`,
      'Move'
    )
    if (!ok) return
    await this.store.ensureFolder(`${root}/Cases`)
    await this.store.ensureFolder(`${root}/Tasks`)

    let moved = 0
    for (const p of legacy) {
      const oldPath = p.filePath
      const oldTaskFolder = taskFolderForProjectPath(oldPath)
      const base = oldPath.slice(oldPath.lastIndexOf('/') + 1)
      const newPath = normalizePath(`${root}/Cases/${base}`)

      const file = this.app.vault.getAbstractFileByPath(oldPath)
      if (!file) continue
      await this.app.fileManager.renameFile(file, newPath)
      const taskFolder = this.app.vault.getAbstractFileByPath(oldTaskFolder)
      if (taskFolder) {
        await this.app.fileManager.renameFile(taskFolder, normalizePath(`${root}/Tasks/${base.replace(/\.md$/, '')}`))
      }
      await this.rekeyProjectPath(oldPath, newPath)
      moved++
    }
    await this.saveSettings()
    this.showNotice(`Moved ${moved} case(s) into the Cases/Tasks layout.`)
  }

  /**
   * v3 migration: give every case its own self-contained folder at the vault
   * root (`<Name>/<Name>.md` + `<Name>/Tasks/…`), then point the projects
   * folder setting at the root so new projects land there too. Empty leftover
   * folders (`<root>/Cases`, `<root>/Tasks`, the old projects folder) are
   * removed; anything non-empty — like unrelated notes — is left untouched.
   */
  private async migrateToProjectFolders(): Promise<void> {
    if (!(this.store instanceof ProjectStore)) return
    const store = this.store
    const root = this.settings.projectsFolder
    const projects = await store.loadAllProjects(root)
    // Pending = not already at `<Name>/<Name>.md` under the vault root.
    const pending = projects.filter((p) => {
      const name = p.filePath.slice(p.filePath.lastIndexOf('/') + 1).replace(/\.md$/, '')
      return p.filePath !== `${name}/${name}.md`
    })
    if (!pending.length) {
      if (root !== '') {
        this.settings.projectsFolder = ''
        await this.saveSettings()
      }
      this.showNotice('Every case already lives in its own folder at the vault root.')
      return
    }
    const ok = await confirmDialog(
      this.app,
      `Move ${pending.length} case(s) into their own folders at the vault root (one folder per case, holding its file and tasks). Links to the moved notes update automatically, and new projects will be created at the vault root.`,
      'Move'
    )
    if (!ok) return

    let cases = 0
    let files = 0
    const occupied: string[] = []
    for (const p of pending) {
      const result = await store.moveProjectToOwnFolder(p, '')
      if (result === 'occupied') {
        occupied.push(p.filePath.split('/').pop()?.replace(/\.md$/, '') ?? p.filePath)
        continue
      }
      if (!result) continue
      await this.rekeyProjectPath(result.from, result.to)
      cases++
      files += result.files
    }

    // Sweep leftover skeleton folders, but only when truly empty — the old
    // projects folder can hold unrelated notes that must stay put. The vault
    // root itself is never swept.
    const leftovers = root ? [`${root}/Cases`, `${root}/Tasks`, root] : ['Cases', 'Tasks']
    for (const path of leftovers) {
      const folder = this.app.vault.getAbstractFileByPath(path)
      if (folder instanceof TFolder && folder.children.length === 0) {
        await this.app.fileManager.trashFile(folder)
      }
    }
    this.settings.projectsFolder = ''
    await this.saveSettings()

    const parts = [`Moved ${cases} case(s) (${files} file(s)) into their own folders at the vault root.`]
    if (occupied.length) {
      parts.push(`Skipped ${occupied.length} case(s) whose folder name is already taken: ${occupied.join(', ')}.`)
    }
    new Notice(parts.join('\n'), 10000)
  }

  /**
   * A project file moved: re-key every path-keyed setting (filters, collapse
   * state, recent cases) and re-target open project views. Callers save
   * settings themselves (batched flows save once at the end).
   */
  private async rekeyProjectPath(oldPath: string, newPath: string): Promise<void> {
    for (const map of [
      this.settings.projectFilters as Record<string, unknown>,
      this.settings.collapsedTasks as Record<string, unknown>,
      this.settings.collapsedKanbanColumns as Record<string, unknown>
    ]) {
      if (map[oldPath] !== undefined) {
        map[newPath] = map[oldPath]
        Reflect.deleteProperty(map, oldPath)
      }
    }
    for (const r of this.settings.recentCases ?? []) {
      if (r.path === oldPath) r.path = newPath
    }
    for (const leaf of this.app.workspace.getLeavesOfType(PM_PROJECT_VIEW_TYPE)) {
      const view = leaf.view
      if (view instanceof ProjectView && view.filePath === oldPath) {
        await leaf.setViewState({ type: PM_PROJECT_VIEW_TYPE, state: { filePath: newPath } })
      }
    }
  }

  /**
   * Apply a project title change to disk. Under v3 this renames the project's
   * folder and file (link-aware) and re-keys path-keyed settings; older
   * layouts change nothing on disk (the frontmatter title is authoritative).
   * Returns false when the rename was refused (target folder occupied).
   */
  async renameProjectFiles(project: Project, newTitle: string): Promise<boolean> {
    if (!(this.store instanceof ProjectStore)) return true
    const moved = await this.store.renameProjectFolder(project, newTitle)
    if (moved === 'occupied') {
      this.showNotice(`A folder named "${projectFileName(newTitle.trim())}" already exists — case not renamed.`)
      return false
    }
    if (moved) {
      await this.rekeyProjectPath(moved.from, moved.to)
      await this.saveSettings()
    }
    return true
  }

  /**
   * One-time move of flat subtask files into their parent task's own folder
   * (`Tasks/<case>/<parent-slug>/<sub-slug>.md`). Link-aware renames, safe to
   * re-run; flat vaults keep loading fine without it.
   */
  private async nestSubtaskFiles(): Promise<void> {
    if (!(this.store instanceof ProjectStore)) return
    const store = this.store
    const projects = await store.loadAllProjects(this.settings.projectsFolder)
    let files = 0
    let cases = 0
    for (const p of projects) {
      const moved = await store.nestSubtaskFiles(p)
      if (moved > 0) {
        files += moved
        cases++
      }
    }
    this.showNotice(
      files > 0 ? `Nested ${files} subtask file(s) across ${cases} case(s).` : 'All subtask files already nested.'
    )
  }

  private async adoptIssueKeysFlow(): Promise<void> {
    if (!(this.store instanceof ProjectStore)) return
    const store = this.store
    const projects = await store.loadAllProjects(this.settings.projectsFolder)
    if (!projects.length) {
      this.showNotice('No projects yet.')
      return
    }
    openProjectPicker(this, projects, (project) => {
      void (async () => {
        const ok = await confirmDialog(
          this.app,
          'Adopt issue keys: keys embedded in titles ("ARGUS-4: …") move to a real key field and the prefix is stripped from the title, which renames those task files. Links to them from notes outside this project’s task files will NOT auto-update. Keyless tasks get fresh keys.',
          'Adopt keys'
        )
        if (!ok) return
        let result = await store.adoptIssueKeys(project)
        if (!result) {
          const prefix = await promptText(this.app, 'Key prefix (letters/digits, e.g. SOC)', 'SOC')
          if (!prefix) return
          result = await store.adoptIssueKeys(project, prefix.trim())
          if (!result) {
            this.showNotice('Invalid prefix — keys not adopted.')
            return
          }
        }
        const parts = [`${result.prefix}: adopted ${result.adopted}, assigned ${result.assigned}.`]
        if (result.renamedBasenames.length) {
          const list = result.renamedBasenames.slice(0, 8).join(', ')
          const more = result.renamedBasenames.length > 8 ? ` and ${result.renamedBasenames.length - 8} more` : ''
          parts.push(`Renamed: ${list}${more}. Check hand-written links to these files.`)
        }
        new Notice(parts.join('\n'), 10000)
        this.refreshProjectViews()
      })()
    })
  }

  private async pickProjectThenCreateTask(mode: null | 'pick-parent'): Promise<void> {
    const projects = await this.store.loadAllProjects(this.settings.projectsFolder)
    if (!projects.length) {
      this.showNotice('No projects yet. Create a project first.')
      return
    }
    openProjectPicker(this, projects, (project) => {
      if (mode === 'pick-parent') {
        const flat = flattenTasks(project.tasks)
        if (!flat.length) {
          this.showNotice('No tasks in this project. Create a task first.')
          return
        }
        openTaskPicker(
          this,
          flat.map((f) => f.task),
          (parentTask) => {
            this.openTaskModalForProject(project, parentTask.id)
          }
        )
      } else {
        this.openTaskModalForProject(project, null)
      }
    })
  }

  private openTaskModalForProject(project: Project, parentId: string | null, defaults?: Partial<Task>): void {
    openTaskModal(this, project, {
      parentId,
      defaults,
      onSave: async () => {
        await this.store.saveProject(project)
        await this.router.openProjectByPath(project.filePath)
      }
    })
  }

  /** Open the task modal pre-filled from selected text, targeting a chosen project. */
  private async createTaskFromText(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return

    const newlineIdx = trimmed.indexOf('\n')
    const defaults: Partial<Task> =
      newlineIdx === -1
        ? { title: trimmed }
        : { title: trimmed.slice(0, newlineIdx).trim(), description: trimmed.slice(newlineIdx + 1).trim() }

    const projects = await this.store.loadAllProjects(this.settings.projectsFolder)
    if (!projects.length) {
      this.showNotice('No projects yet. Create a project first.')
      return
    }
    if (projects.length === 1) {
      this.openTaskModalForProject(projects[0], null, defaults)
      return
    }
    openProjectPicker(this, projects, (project) => {
      this.openTaskModalForProject(project, null, defaults)
    })
  }

  private async importNotes(): Promise<void> {
    const activeLeaves = this.app.workspace.getLeavesOfType(PM_PROJECT_VIEW_TYPE)
    let activeProject: Project | null = null

    for (const leaf of activeLeaves) {
      if (!(leaf.view instanceof ProjectView)) continue
      if (leaf.view.project) {
        activeProject = leaf.view.project
        break
      }
    }

    if (activeProject) {
      const project = activeProject
      const onImportComplete = async () => {
        await this.router.openProjectByPath(project.filePath)
      }
      openImportModal(this, activeProject, onImportComplete)
      return
    }

    const projects = await this.store.loadAllProjects(this.settings.projectsFolder)
    if (!projects.length) {
      this.showNotice('No projects yet. Create a project first.')
      return
    }

    openProjectPicker(this, projects, (project) => {
      const onImportComplete = async () => {
        await this.router.openProjectByPath(project.filePath)
      }
      openImportModal(this, project, onImportComplete)
    })
  }
}
