import {
  ButtonComponent,
  ExtraButtonComponent,
  ItemView,
  Menu,
  WorkspaceLeaf,
  TFile,
  setTooltip,
  type TAbstractFile,
  type ViewStateResult
} from 'obsidian'
import type PMPlugin from '../main'
import { type Project, type ViewMode, type FilterState, type SavedView, makeDefaultFilter, makeId } from '../types'
import { truncateTitle, safeAsync } from '../utils'
import type { SubView } from './SubView'
import { TableView } from './table/TableView'
import type { TableViewState } from './table/TableView'
import { GanttView } from './gantt/GanttView'
import { KanbanView } from './KanbanView'
import { BacklogView } from './BacklogView'
import { ReportsView } from './reports/ReportsView'
import { openProjectModal, openTaskModal } from '../ui/ModalFactory'
import { AlertIntakeModal } from '../modals/AlertIntakeModal'
import { openHandoverModal } from '../soc/HandoverModal'
import { ViewSwitcher } from '../ui/primitives/ViewSwitcher'
import { ProjectHeader } from '../ui/composites/ProjectHeader'
import { setQuerySlaPolicies } from '../store/QueryParser'
import { taskFolderForProjectPath } from '../store/layout'
import { openPhishAnalysis } from './PhishAnalysisView'

export const PM_PROJECT_VIEW_TYPE = 'casefile-project'

interface ProjectViewState {
  filePath: string
  /** Set by a rename or move of this same board: keep the mode the analyst picked. Never saved. */
  keepView?: boolean
  [key: string]: unknown
}

/** A saved view's filter, or the live one, copied whole: the filter dropdowns edit their arrays in place. */
const copyFilter = (f: FilterState): FilterState => JSON.parse(JSON.stringify(f)) as FilterState

export class ProjectView extends ItemView {
  plugin: PMPlugin
  project: Project | null = null
  filePath = ''
  currentView: ViewMode
  filter: FilterState = makeDefaultFilter()
  activeSavedViewId: string | null = null
  private subview: SubView | null = null

  /**
   * Every board, in one menu, switching in this leaf. The board you are on is
   * ticked rather than hidden, so the menu always shows the whole set and you
   * can see where you are. Edit and New are here too, because this is now the
   * only control on the board that is about the board itself.
   */
  async showBoardMenu(anchor?: MouseEvent): Promise<void> {
    const here = this.project
    const menu = new Menu()
    let projects: Project[] = []
    try {
      projects = await this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder)
    } catch {
      // Say so rather than showing an empty menu that reads as "no other boards".
      menu.addItem((i) => i.setTitle('Could not read your boards').setDisabled(true))
    }
    for (const p of [...projects].sort((a, b) => a.title.localeCompare(b.title))) {
      menu.addItem((item) =>
        item
          .setTitle(`${p.icon} ${p.title}`)
          .setChecked(p.filePath === here?.filePath)
          .onClick(
            safeAsync(async () => {
              if (p.filePath === here?.filePath) return
              const file = this.app.vault.getAbstractFileByPath(p.filePath)
              if (file instanceof TFile) await this.plugin.router.switchToBoard(this.leaf, file)
            })
          )
      )
    }
    menu.addSeparator()
    menu.addItem((item) =>
      item
        .setTitle('New board…')
        .setIcon('plus')
        .onClick(() => {
          openProjectModal(this.plugin, {
            onSave: async (project) => {
              await this.plugin.router.openProjectByPath(project.filePath)
            }
          })
        })
    )
    if (here) {
      menu.addItem((item) =>
        item
          .setTitle('Edit this board')
          .setIcon('settings')
          .onClick(() => {
            openProjectModal(this.plugin, {
              project: here,
              onSave: (updated) => {
                this.project = updated
                this.renderProjectToolbar()
                this.renderCurrentView()
              }
            })
          })
      )
    }
    // From the palette there is no pointer to anchor to, so it opens where the
    // analyst is looking rather than in the window corner.
    if (anchor && (anchor.clientX || anchor.clientY)) menu.showAtMouseEvent(anchor)
    else menu.showAtPosition({ x: activeWindow.innerWidth / 2 - 120, y: activeWindow.innerHeight / 4 })
  }

  /** The project this leaf is showing, for palette commands that act on it. */
  projectRef(): Project | null {
    return this.project ?? null
  }

  /** The board, when it is the open view — the palette's "Group board by…" needs it. */
  kanban(): KanbanView | null {
    return this.subview instanceof KanbanView ? this.subview : null
  }
  private savedTableViewState: TableViewState | null = null
  private toolbarEl!: HTMLElement
  private headerEl!: HTMLElement
  private bodyEl!: HTMLElement
  private header: ProjectHeader | null = null
  private titleEl2!: HTMLElement
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null
  private reloadDebounceTimer: number | null = null
  private initialized = false
  /** File path whose default view mode has been applied, so reloads don't reset a user's mode switch. */
  private defaultViewAppliedFor: string | null = null
  /** View mode of the last renderCurrentView, so only real switches animate (data refreshes never re-fade). */
  private lastRenderedView: ViewMode | null = null

  constructor(leaf: WorkspaceLeaf, plugin: PMPlugin) {
    super(leaf)
    this.plugin = plugin
    this.currentView = plugin.settings.defaultView
    this.navigation = false
  }

  getViewType(): string {
    return PM_PROJECT_VIEW_TYPE
  }
  getDisplayText(): string {
    return truncateTitle(this.project?.title ?? 'Board', 10)
  }
  getIcon(): string {
    return 'chart-gantt'
  }

  async setState(state: ProjectViewState, result: unknown): Promise<void> {
    if (state.filePath && state.filePath !== this.filePath) {
      // The same board at a new path: the mode the analyst switched to stays,
      // instead of the board's default view coming back as if newly opened.
      if (state.keepView === true && this.defaultViewAppliedFor === this.filePath) {
        this.defaultViewAppliedFor = state.filePath
      }
      this.filePath = state.filePath
      await this.loadProject()
    }
    await super.setState(state, result as ViewStateResult)
  }

  getState(): ProjectViewState {
    return { filePath: this.filePath }
  }

  onOpen(): Promise<void> {
    // Setup only. setState is the sole loader: it is the only place filePath is
    // set, and it loads the project itself. onOpen runs purely to guarantee the
    // scaffold and listeners exist for hosts that open the view without setState.
    this.ensureInitialized()
    return Promise.resolve()
  }

  onClose(): Promise<void> {
    if (this.reloadDebounceTimer !== null) {
      window.clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = null
    }
    if (this.keydownHandler) {
      this.containerEl.removeEventListener('keydown', this.keydownHandler)
      this.keydownHandler = null
    }
    this.subview?.destroy?.()
    this.subview = null
    return Promise.resolve()
  }

  // Some workspace plugins (Pane Relief, Hover Editor) restore a deferred leaf by
  // calling setState without ever calling onOpen. Run the one-time DOM and listener
  // setup from whichever entry point fires first so the view never renders into a
  // missing scaffold or loses its file-change and keyboard handlers.
  private ensureInitialized(): void {
    if (this.initialized) return
    this.initialized = true

    this.containerEl.addClass('pm-view')
    const root = this.contentEl
    root.empty()
    root.addClass('pm-root')
    this.toolbarEl = root.createDiv('pm-toolbar')
    this.headerEl = root.createDiv('pm-project-header-mount')
    this.bodyEl = root.createDiv('pm-content')

    // The SLA chip tick is plugin-level (main.ts) since 2.21 — see PS-08.

    this.keydownHandler = (e: KeyboardEvent) => {
      this.subview?.handleKeyDown?.(e)
    }
    this.containerEl.addEventListener('keydown', this.keydownHandler)
    if (!this.containerEl.hasAttribute('tabindex')) {
      this.containerEl.setAttribute('tabindex', '-1')
    }

    const reloadIfRelevant = (filePath: string) => {
      if (!this.project || !this.filePath) return false
      const taskFolder = taskFolderForProjectPath(this.filePath)
      return filePath.startsWith(taskFolder) || filePath === this.filePath
    }
    const scheduleReload = (): void => {
      if (this.reloadDebounceTimer !== null) window.clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = window.setTimeout(
        safeAsync(async () => {
          this.reloadDebounceTimer = null
          await this.loadProject()
        }),
        300
      )
    }
    const isNote = (file: TAbstractFile): file is TFile => file instanceof TFile && file.extension === 'md'
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile) || !reloadIfRelevant(file.path)) return
        if (this.plugin.store.consumeSelfWrite(file.path)) return
        scheduleReload()
      })
    )
    // A case note created or renamed from outside (Sync, the file explorer,
    // another plugin). Listening to modify and delete alone left the board on
    // its old object: a card drag then recreated a renamed note at its old
    // path, a second case with the same id, and a synced-in case stayed off
    // the board until some other change.
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (!isNote(file) || !reloadIfRelevant(file.path)) return
        if (this.plugin.store.consumeSelfWrite(file.path)) return
        scheduleReload()
      })
    )
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!isNote(file) || !(reloadIfRelevant(file.path) || reloadIfRelevant(oldPath))) return
        // Both markers are consumed, so neither is left for a later event.
        const self = [this.plugin.store.consumeSelfWrite(file.path), this.plugin.store.consumeSelfWrite(oldPath)]
        // This board's own note: the plugin re-keys its settings and points
        // this view at the new path (main.ts, rekeyProjectPath).
        if (self.some(Boolean) || oldPath === this.filePath) return
        scheduleReload()
      })
    )
    this.registerEvent(
      this.app.vault.on(
        'delete',
        safeAsync(async (file) => {
          if (!reloadIfRelevant(file.path)) return
          if (this.plugin.store.consumeSelfWrite(file.path)) return
          await this.loadProject()
        })
      )
    )
  }

  private async loadProject(): Promise<void> {
    this.ensureInitialized()
    const file = this.app.vault.getAbstractFileByPath(this.filePath)
    if (!(file instanceof TFile)) {
      this.renderMissingProject()
      return
    }
    this.project = await this.plugin.store.loadProject(file)
    if (!this.project) {
      this.renderMissingProject()
      return
    }
    this.plugin.applyCollapsedState(this.project)
    if (this.defaultViewAppliedFor !== this.filePath) {
      this.defaultViewAppliedFor = this.filePath
      this.currentView = this.plugin.store.configFor(this.project).defaultView
    }
    this.loadFilterFromSettings()
    ;(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.()
    this.renderProjectToolbar()
    this.renderProjectHeader()
    this.renderCurrentView()
  }

  private loadFilterFromSettings(): void {
    const saved = this.plugin.settings.projectFilters[this.filePath]
    if (saved) {
      this.filter = saved.filter
      this.activeSavedViewId = saved.activeSavedViewId
    } else {
      this.filter = makeDefaultFilter()
      this.activeSavedViewId = null
    }
  }

  private async persistFilter(): Promise<void> {
    if (!this.filePath) return
    // The entry also holds the board's swimlane grouping (KanbanView.setLaneGroup):
    // replacing it whole dropped the lanes on every filter keystroke.
    this.plugin.settings.projectFilters[this.filePath] = {
      ...this.plugin.settings.projectFilters[this.filePath],
      filter: this.filter,
      activeSavedViewId: this.activeSavedViewId
    }
    await this.plugin.saveSettings()
  }

  private renderMissingProject(): void {
    this.toolbarEl.empty()
    this.headerEl.empty()
    this.header = null
    this.bodyEl.empty()
    const msg = this.bodyEl.createDiv('pm-empty-state')
    msg.createEl('h3', { text: 'Board not found' })
    msg.createEl('p', { text: `No board at ${this.filePath}. It may have been deleted or renamed.` })
  }

  /**
   * The board note lists cases, but the folder its path says they are in is
   * not there: the note or its folder was renamed outside Responder. An empty
   * board would say there are no cases, which is not known; the store also
   * refuses every save of it, so `taskIds` is never wiped.
   */
  private renderDetached(detached: NonNullable<Project['detached']>): void {
    const msg = this.bodyEl.createDiv('pm-empty-state')
    msg.createEl('h3', { text: 'Cases not found' })
    msg.createEl('p', {
      text:
        `This board lists ${detached.recorded} case${detached.recorded === 1 ? '' : 's'}, but ${detached.folder} ` +
        'is not there. Its note or its folder was renamed or moved outside Responder. Rename it back and ' +
        'the cases show again; until then nothing on this board is saved.'
    })
  }

  private renderProjectHeader(): void {
    if (!this.project) return
    this.headerEl.empty()
    const config = this.plugin.store.configFor(this.project)
    // The `sla:` query field reads these in every subview's matchesFilter call.
    setQuerySlaPolicies(this.plugin.settings.slaPolicies)
    this.header = new ProjectHeader(this.headerEl, {
      project: this.project,
      statuses: config.statuses,
      severities: config.severities,
      // A plain board records no verdicts, so it offers no filter on them.
      verdicts: config.boardType === 'plain' ? undefined : config.verdicts,
      queryCtx: {
        priorities: config.priorities,
        severities: config.severities,
        currentUser: this.plugin.settings.currentUser,
        slaPolicies: this.plugin.settings.slaPolicies
      },
      filter: this.filter,
      activeSavedViewId: this.activeSavedViewId,
      onFilterChange: () => this.handleFilterMutation(),
      onClearFilter: () => this.handleClearFilter(),
      onSavedViewSelect: (id) => this.handleSavedViewSelect(id),
      onSavedViewSave: (name) => this.handleSavedViewSave(name),
      onSavedViewUpdate: (id) => this.handleSavedViewUpdate(id),
      onSavedViewDelete: (id) => this.handleSavedViewDelete(id)
    })
  }

  private handleFilterMutation(): void {
    if (this.activeSavedViewId !== null) {
      this.activeSavedViewId = null
      this.header?.setActiveSavedViewId(null)
    } else {
      this.header?.notifyMutation()
    }
    void this.persistFilter()
    this.refreshSubview()
  }

  private handleClearFilter(): void {
    Object.assign(this.filter, makeDefaultFilter())
    this.activeSavedViewId = null
    void this.persistFilter()
    this.header?.refresh()
    this.refreshSubview()
  }

  private handleSavedViewSelect(id: string | null): void {
    if (!this.project) return
    let tableState: TableViewState | undefined
    if (id === null) {
      Object.assign(this.filter, makeDefaultFilter())
      this.activeSavedViewId = null
    } else {
      const sv = this.project.savedViews.find((v) => v.id === id)
      if (!sv) return
      // A copy: sharing its arrays let the next dropdown click rewrite the saved view on disk.
      Object.assign(this.filter, copyFilter(sv.filter))
      this.activeSavedViewId = sv.id
      if (sv.viewMode && sv.viewMode !== this.currentView) {
        this.currentView = sv.viewMode
        this.renderProjectToolbar()
      }
      // Only a view that opens the table applies its sort. One saved from
      // another view holds just the save-time placeholder, which would reset
      // the analyst's own table sort.
      if (this.currentView === 'table') {
        tableState = { sortKey: sv.sortKey as TableViewState['sortKey'], sortDir: sv.sortDir }
      }
    }
    void this.persistFilter()
    this.header?.refresh()
    this.renderCurrentView(tableState)
  }

  private async handleSavedViewSave(name: string): Promise<void> {
    if (!this.project) return
    const sortMeta =
      this.subview instanceof TableView ? this.subview.getViewState() : { sortKey: 'status', sortDir: 'asc' as const }
    const sv: SavedView = {
      id: makeId(),
      name,
      filter: copyFilter(this.filter),
      sortKey: sortMeta.sortKey,
      sortDir: sortMeta.sortDir,
      viewMode: this.currentView
    }
    this.project.savedViews.push(sv)
    this.activeSavedViewId = sv.id
    await this.plugin.store.saveProject(this.project)
    void this.persistFilter()
    this.header?.refresh()
  }

  private async handleSavedViewUpdate(id: string): Promise<void> {
    if (!this.project) return
    const sv = this.project.savedViews.find((v) => v.id === id)
    if (!sv) return
    sv.filter = copyFilter(this.filter)
    sv.viewMode = this.currentView
    if (this.subview instanceof TableView) {
      const ts = this.subview.getViewState()
      sv.sortKey = ts.sortKey
      sv.sortDir = ts.sortDir
    }
    await this.plugin.store.saveProject(this.project)
    this.header?.refresh()
  }

  private async handleSavedViewDelete(id: string): Promise<void> {
    if (!this.project) return
    this.project.savedViews = this.project.savedViews.filter((v) => v.id !== id)
    if (this.activeSavedViewId === id) this.activeSavedViewId = null
    await this.plugin.store.saveProject(this.project)
    void this.persistFilter()
    this.header?.refresh()
  }

  private refreshSubview(): void {
    this.subview?.render()
  }

  private renderProjectToolbar(): void {
    if (!this.project) return
    this.toolbarEl.empty()

    const left = this.toolbarEl.createDiv('pm-toolbar-left')
    // The icon was a second way to open the board settings the gear already
    // opens two controls away. It is the board menu now: the one control on the
    // board that says the word "board", and the one-click way to another one.
    const iconEl = left.createSpan({
      text: this.project.icon,
      cls: 'pm-toolbar-icon',
      attr: { 'aria-label': 'Switch board', role: 'button', tabindex: '0' }
    })
    setTooltip(iconEl, 'Switch board')
    iconEl.addEventListener('click', (e) => {
      void this.showBoardMenu(e)
    })
    iconEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        // The view's own keydown would also open the selected table row.
        e.stopPropagation()
        void this.showBoardMenu()
      }
    })

    this.titleEl2 = left.createEl('h2', { text: this.project.title, cls: 'pm-toolbar-title' })
    this.titleEl2.contentEditable = 'true'
    this.titleEl2.addEventListener(
      'blur',
      safeAsync(async () => {
        if (!this.project) return
        const next = this.titleEl2.textContent?.trim() ?? ''
        // A board title cannot be empty (the board dialog refuses one too), and
        // an unchanged blur is not an edit: it used to rewrite the board note
        // and restamp updatedAt. Either way the header shows the real title.
        if (!next || next === this.project.title) {
          this.titleEl2.textContent = this.project.title
          return
        }
        // Title set before the rename so re-renders mid-move already show
        // it. v3: the board folder and file carry the new name; on refusal
        // (target folder occupied) revert the header and keep the old title.
        const prev = this.project.title
        this.project.title = next
        if (!(await this.plugin.renameProjectFiles(this.project, next))) {
          this.project.title = prev
          this.titleEl2.textContent = prev
          return
        }
        this.filePath = this.project.filePath
        await this.plugin.store.saveProject(this.project)
      })
    )

    new ViewSwitcher<ViewMode>(this.toolbarEl, {
      options: [
        { id: 'table', icon: 'table', label: 'Table' },
        { id: 'gantt', icon: 'git-fork', label: 'Gantt' },
        { id: 'kanban', icon: 'layout-dashboard', label: 'Board' },
        { id: 'backlog', icon: 'rows-3', label: 'Backlog' },
        { id: 'reports', icon: 'bar-chart-3', label: 'Reports' }
      ],
      active: this.currentView,
      onChange: (mode) => {
        this.currentView = mode
        this.renderCurrentView()
      }
    })

    const right = this.toolbarEl.createDiv('pm-toolbar-right')
    new ButtonComponent(right)
      .setButtonText('+ add task')
      .setCta()
      .onClick(() => {
        if (!this.project) return
        openTaskModal(this.plugin, this.project, {
          onSave: async () => {
            await this.refreshProject()
          }
        })
      })

    if (this.currentView === 'gantt') {
      new ButtonComponent(right).setButtonText('+ milestone').onClick(() => {
        if (!this.project) return
        openTaskModal(this.plugin, this.project, {
          // No start: the Start field is hidden for a milestone, so a default
          // of today was saved unseen, and its dependency arrow ended there.
          defaults: { type: 'milestone', start: '' },
          onSave: async () => {
            await this.refreshProject()
          }
        })
      })
    }

    new ExtraButtonComponent(right)
      .setIcon('clipboard-paste')
      .setTooltip('New case from pasted alert')
      .onClick(() => {
        if (!this.project) return
        new AlertIntakeModal(this.plugin.app, this.plugin, this.project, () => this.refreshProject()).open()
      })

    // Beside the paste door on purpose: both are intake. One takes the alert a
    // tool raised, the other takes the mail a user reported, and an analyst
    // reaching for either is looking at the same corner of the same toolbar.
    new ExtraButtonComponent(right)
      .setIcon('fish')
      .setTooltip('Analyse a phishing email')
      .onClick(() => openPhishAnalysis(this.plugin))

    // Vault-wide, not this project — the tooltip says so, because it sits in a
    // project toolbar. It is here because the board is what is on screen at the
    // end of a shift.
    new ExtraButtonComponent(right)
      .setIcon('clipboard-list')
      .setTooltip('Shift handover (whole vault)')
      .onClick(() => openHandoverModal(this.plugin))

    new ExtraButtonComponent(right)
      .setIcon('settings')
      .setTooltip('Board settings')
      .onClick(() => {
        openProjectModal(this.plugin, {
          project: this.project,
          onSave: (updated) => {
            this.project = updated
            this.renderProjectToolbar()
            this.renderCurrentView()
          }
        })
      })
  }

  /** `tableState` is a sort to open the table with (a saved view's), applied over the one captured from the old table. */
  private renderCurrentView(tableState?: TableViewState): void {
    if (!this.project) return

    let savedGanttScroll: ReturnType<GanttView['getScrollPosition']> | null = null
    let savedGanttLabelWidth: number | null = null
    if (this.currentView === 'gantt' && this.subview instanceof GanttView) {
      savedGanttScroll = this.subview.getScrollPosition()
      savedGanttLabelWidth = this.subview.getLabelWidth()
    }

    let savedTableScrollTop: number | null = null
    if (this.subview instanceof TableView) {
      this.savedTableViewState = this.subview.getViewState()
      if (this.currentView === 'table') {
        savedTableScrollTop = this.subview.getScrollTop()
      }
    } else if (this.currentView !== 'table') {
      this.savedTableViewState = null
    }
    if (tableState) this.savedTableViewState = tableState

    this.subview?.destroy?.()
    this.bodyEl.empty()
    this.subview = null
    if (this.project.detached) {
      this.renderDetached(this.project.detached)
      return
    }

    switch (this.currentView) {
      case 'table': {
        const table = new TableView(
          this.bodyEl,
          this.project,
          this.plugin,
          () => this.refreshProject(),
          this.filter,
          this.savedTableViewState ?? undefined
        )
        if (savedTableScrollTop !== null) table.setPendingScrollTop(savedTableScrollTop)
        this.subview = table
        break
      }
      case 'gantt': {
        const gantt = new GanttView(this.bodyEl, this.project, this.plugin, () => this.refreshProject(), this.filter)
        if (savedGanttScroll) gantt.setPendingScroll(savedGanttScroll)
        if (savedGanttLabelWidth !== null) gantt.setLabelWidth(savedGanttLabelWidth)
        this.subview = gantt
        break
      }
      case 'kanban':
        this.subview = new KanbanView(this.bodyEl, this.project, this.plugin, () => this.refreshProject(), this.filter)
        break
      case 'backlog':
        this.subview = new BacklogView(this.bodyEl, this.project, this.plugin, () => this.refreshProject(), this.filter)
        break
      case 'reports':
        this.subview = new ReportsView(this.bodyEl, this.project, this.plugin, () => this.refreshProject(), this.filter)
        break
    }
    this.bodyEl.toggleClass('pm-content--kanban', this.currentView === 'kanban')
    const switched = this.lastRenderedView !== this.currentView
    this.lastRenderedView = this.currentView
    this.bodyEl.toggleClass('gs-view-enter', switched)
    this.bodyEl.toggleClass('gs-stagger', switched && this.currentView === 'kanban')
    this.subview?.render()
  }

  /**
   * Re-render after a plugin-initiated mutation. Store mutators update
   * project.tasks in place before they await the save, so memory is already
   * current and no disk reload is needed. External edits come in through the
   * vault listeners in ensureInitialized. Prefers the subview's in-place refresh
   * over a full destroy-and-rebuild.
   */
  async refreshProject(): Promise<void> {
    if (!this.project) return
    if (this.reloadDebounceTimer !== null) {
      window.clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = null
    }
    if (this.subview?.refresh) {
      this.subview.refresh()
    } else if (this.subview) {
      this.subview.render()
    } else {
      this.renderCurrentView()
    }
  }
}
