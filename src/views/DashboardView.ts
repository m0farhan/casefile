import { ItemView, WorkspaceLeaf, TFile } from 'obsidian'
import type PMPlugin from '../main'
import { renderProjectListToolbar, renderProjectListContent } from './ProjectListRenderer'
import type { ProjectListContext } from './ProjectListRenderer'
import { taskFolderForProjectPath } from '../store/layout'

export const PM_DASHBOARD_VIEW_TYPE = 'casefile-dashboard'

export class DashboardView extends ItemView {
  private plugin: PMPlugin
  private toolbarEl!: HTMLElement
  private bodyEl!: HTMLElement
  private renderToken = 0
  private reloadDebounceTimer: number | null = null
  /**
   * Each drawn board's note and case folder, from the last render. Boards are
   * listed wherever they are filed, so a change under one of these counts
   * even outside the default folder; listening to that folder alone left
   * those cards' counts and locations stale.
   */
  private watched: string[] = []

  constructor(leaf: WorkspaceLeaf, plugin: PMPlugin) {
    super(leaf)
    this.plugin = plugin
    this.navigation = false
  }

  getViewType(): string {
    return PM_DASHBOARD_VIEW_TYPE
  }
  getDisplayText(): string {
    return 'Boards'
  }
  getIcon(): string {
    return 'chart-gantt'
  }

  onOpen(): Promise<void> {
    this.containerEl.addClass('pm-view')
    const root = this.contentEl
    root.empty()
    root.addClass('pm-root')
    this.toolbarEl = root.createDiv('pm-toolbar')
    this.bodyEl = root.createDiv('pm-content')
    this.render()
    this.registerVaultListeners()
    return Promise.resolve()
  }

  onClose(): Promise<void> {
    if (this.reloadDebounceTimer !== null) {
      window.clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = null
    }
    return Promise.resolve()
  }

  private registerVaultListeners(): void {
    const isRelevant = (path: string) => {
      const folder = this.plugin.settings.projectsFolder
      // Empty folder = vault root: everything is in scope.
      if (folder === '' || path === folder || path.startsWith(`${folder}/`)) return true
      return this.watched.some((w) => path === w || path.startsWith(`${w}/`))
    }
    const scheduleReload = (path: string, always = false) => {
      if (!always && !isRelevant(path)) return
      if (this.reloadDebounceTimer !== null) window.clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = window.setTimeout(() => {
        this.reloadDebounceTimer = null
        this.render()
      }, 300)
    }
    this.registerEvent(this.app.vault.on('create', (file) => scheduleReload(file.path)))
    this.registerEvent(this.app.vault.on('modify', (file) => scheduleReload(file.path)))
    this.registerEvent(this.app.vault.on('delete', (file) => scheduleReload(file.path)))
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        scheduleReload(file.path)
        scheduleReload(oldPath)
      })
    )
    // A board created, synced in or moved outside every watched path: seen
    // once Obsidian has indexed it as one, which a vault 'create' comes before.
    // ponytail: a board moved between two unwatched folders is caught here,
    // through its new path, not through its rename.
    this.registerEvent(
      this.app.metadataCache.on('changed', (file, _data, cache) => {
        if (cache.frontmatter?.['pm-project'] === true) scheduleReload(file.path, true)
      })
    )
  }

  render(): void {
    const ctx = this.makeCtx()
    renderProjectListToolbar(ctx)
    this.bodyEl.empty()
    this.bodyEl.addClass('pm-project-list-container')
    void this.renderList(ctx)
  }

  private async renderList(ctx: ProjectListContext): Promise<void> {
    const projects = await renderProjectListContent(ctx)
    if (!ctx.isStale()) this.watched = projects.flatMap((p) => [p.filePath, taskFolderForProjectPath(p.filePath)])
  }

  private makeCtx(): ProjectListContext {
    const token = ++this.renderToken
    return {
      plugin: this.plugin,
      toolbarEl: this.toolbarEl,
      contentEl: this.bodyEl,
      isStale: () => token !== this.renderToken,
      openProjectFile: (file: TFile) => this.plugin.router.openProject(file)
    }
  }
}
