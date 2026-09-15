import { ItemView, TFile, WorkspaceLeaf, setIcon } from 'obsidian'
import type PMPlugin from '../main'
import type { Task } from '../types'
import { caseTimelineEvents, displayStamp } from '../soc/timeline'
import { renderKeyChip } from '../ui/composites/issueMeta'
import { safeAsync } from '../utils'

export const CASEFILE_TIMELINE_VIEW_TYPE = 'casefile-case-timeline'

interface TimelineViewState {
  projectPath: string
  taskId: string
  [key: string]: unknown
}

/**
 * Read-only right-leaf case timeline: the chronological story of one case,
 * built by caseTimelineEvents from stored facts only — nothing invented.
 * ponytail: static snapshot per setState — live file-watch rerender isn't
 * worth the watcher plumbing for a read-only view; the header refresh button
 * re-reads on demand.
 */
export class TimelineView extends ItemView {
  private projectPath = ''
  private taskId = ''
  private task: Task | null = null

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: PMPlugin
  ) {
    super(leaf)
    this.navigation = false
  }

  getViewType(): string {
    return CASEFILE_TIMELINE_VIEW_TYPE
  }
  getDisplayText(): string {
    return this.task ? this.task.key || this.task.title : 'Case timeline'
  }
  getIcon(): string {
    return 'history'
  }

  async setState(state: TimelineViewState, result: unknown): Promise<void> {
    if (state.projectPath && state.taskId) {
      this.projectPath = state.projectPath
      this.taskId = state.taskId
      await this.loadTask()
      this.render()
    }
    await super.setState(state, result as import('obsidian').ViewStateResult)
  }

  getState(): TimelineViewState {
    return { projectPath: this.projectPath, taskId: this.taskId }
  }

  private async loadTask(): Promise<void> {
    this.task = null
    const file = this.app.vault.getAbstractFileByPath(this.projectPath)
    if (!(file instanceof TFile)) return
    const project = await this.plugin.store.loadProject(file)
    const live = project?.taskIndex.get(this.taskId)?.task
    if (!live) return
    // Comments live in the note body — hydrate them before reading the story.
    await this.plugin.store.loadTaskBody(live)
    this.task = live
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.addClass('pm-root', 'pm-timeline-view')
    if (!this.task) {
      contentEl.createDiv({ cls: 'pm-empty-state', text: 'No case selected.' })
      return
    }
    const task = this.task

    // ── Header: key · title · refresh ───────────────────────────────────────
    const header = contentEl.createDiv('pm-tl-header')
    if (task.key) renderKeyChip(header, task.key)
    header.createSpan({ cls: 'pm-tl-title', text: task.title })
    header.createDiv('pm-td-header-spacer')
    const refreshBtn = header.createSpan({ cls: 'pm-td-note-btn' })
    setIcon(refreshBtn, 'refresh-cw')
    refreshBtn.setAttribute('aria-label', 'Refresh timeline')
    refreshBtn.addEventListener(
      'click',
      safeAsync(async () => {
        await this.loadTask()
        this.render()
      })
    )

    const events = caseTimelineEvents(task)
    if (!events.length) {
      contentEl.createDiv({ cls: 'pm-tl-empty', text: 'No timeline data yet' })
      return
    }
    const list = contentEl.createDiv('pm-tl-list')
    for (const e of events) {
      const row = list.createDiv('pm-tl-event')
      // Comments and activity read as annotations; lifecycle stays the story.
      if (e.kind === 'comment' || e.kind === 'activity') row.addClass('pm-tl-event--minor')
      row.createDiv('pm-tl-dot')
      row.createSpan({ cls: 'pm-tl-at', text: displayStamp(e.at) })
      row.createSpan({ cls: 'pm-tl-label', text: e.label })
      if (e.detail) row.createDiv({ cls: 'pm-tl-detail', text: e.detail })
    }
  }
}
