import type PMPlugin from '../../main'
import type { FilterState, Project, Task } from '../../types'
import { matchesFilter } from '../../store/TaskFilter'
import { flattenTasks } from '../../store/TaskTreeOps'
import { svgEl } from '../../utils'
import { formatSlaRemaining } from '../../soc/sla'
import type { SubView } from '../SubView'
import {
  lifecycleDurations,
  openedClosedPerWeek,
  slaCompliance,
  timeInStatus,
  verdictBreakdown,
  type DurationStat,
  type LifecyclePhases
} from './reportData'

const WEEKS = 12

/**
 * Reports: hand-rolled SVG per the gantt precedent — no chart library, raw
 * counts labelled on every mark, no smoothing, missing data reported as
 * "no data". Respects the active project filter.
 */
export class ReportsView implements SubView {
  constructor(
    private container: HTMLElement,
    private project: Project,
    private plugin: PMPlugin,
    private onRefresh: () => Promise<void>,
    private filter: FilterState
  ) {}

  render(): void {
    this.container.empty()
    const root = this.container.createDiv('pm-reports')
    const cfg = this.plugin.store.configFor(this.project)
    const queryCtx = {
      priorities: cfg.priorities,
      severities: cfg.severities,
      currentUser: this.plugin.settings.currentUser
    }
    // Reports are historical: archiving a closed case must not erase it from
    // the charts, so the corpus always includes archived tasks.
    const reportFilter: FilterState = { ...this.filter, showArchived: true }
    const tasks = flattenTasks(this.project.tasks)
      .map((f) => f.task)
      .filter((t) => matchesFilter(t, reportFilter, cfg.statuses, queryCtx))
    const incidents = tasks.filter((t) => t.issueType === 'incident')
    const now = Date.now()

    this.renderOpenedClosed(root, tasks, now)
    this.renderTimeInStatus(root, tasks, now)
    this.renderVerdicts(root, incidents)
    this.renderSlaCompliance(root, incidents, now)
    this.renderLifecycleDurations(root, incidents)
  }

  private section(root: HTMLElement, title: string): HTMLElement {
    const s = root.createDiv('pm-report-section')
    s.createEl('h4', { text: title, cls: 'pm-modal-section-title' })
    return s
  }

  private renderOpenedClosed(root: HTMLElement, tasks: Task[], now: number): void {
    const s = this.section(root, `Opened vs closed per week (last ${WEEKS})`)
    const buckets = openedClosedPerWeek(tasks, WEEKS, now)
    const max = Math.max(1, ...buckets.map((b) => Math.max(b.opened, b.closed)))
    const barW = 12
    const groupW = barW * 2 + 14
    const h = 120
    const labelH = 30
    const w = buckets.length * groupW + 8
    const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h + labelH}`, class: 'pm-report-svg' })
    svg.setCssProps({ '--report-w': `${w}px` })
    buckets.forEach((b, i) => {
      const x = 4 + i * groupW
      const openedH = Math.round((b.opened / max) * (h - 16))
      const closedH = Math.round((b.closed / max) * (h - 16))
      svg.appendChild(
        svgEl('rect', { x, y: h - openedH, width: barW, height: openedH, class: 'pm-report-bar--opened', rx: 2 })
      )
      svg.appendChild(
        svgEl('rect', {
          x: x + barW + 2,
          y: h - closedH,
          width: barW,
          height: closedH,
          class: 'pm-report-bar--closed',
          rx: 2
        })
      )
      if (b.opened) {
        const t = svgEl('text', { x: x + barW / 2, y: h - openedH - 3, class: 'pm-report-count' })
        t.textContent = String(b.opened)
        svg.appendChild(t)
      }
      if (b.closed) {
        const t = svgEl('text', { x: x + barW + 2 + barW / 2, y: h - closedH - 3, class: 'pm-report-count' })
        t.textContent = String(b.closed)
        svg.appendChild(t)
      }
      const label = svgEl('text', {
        x: x + groupW / 2 - 7,
        y: h + 18,
        class: 'pm-report-week',
        transform: `rotate(-38 ${x + groupW / 2 - 7} ${h + 18})`
      })
      label.textContent = b.label.slice(5) // "W31"
      svg.appendChild(label)
    })
    s.appendChild(svg)
    const legend = s.createDiv('pm-report-legend')
    legend.createSpan({ cls: 'pm-report-legend-swatch pm-report-bar--opened' })
    legend.createSpan({ text: 'Opened' })
    legend.createSpan({ cls: 'pm-report-legend-swatch pm-report-bar--closed' })
    legend.createSpan({ text: 'Closed' })
  }

  private renderTimeInStatus(root: HTMLElement, tasks: Task[], now: number): void {
    const s = this.section(root, 'Time in status')
    const rows = timeInStatus(tasks, now)
    if (!rows.length) {
      s.createDiv({ cls: 'pm-report-empty', text: 'No data.' })
      return
    }
    const cfg = this.plugin.store.configFor(this.project)
    const max = Math.max(...rows.map((r) => r.totalMs))
    for (const row of rows) {
      const status = cfg.statuses.find((st) => st.id === row.statusId)
      const line = s.createDiv('pm-report-hrow')
      line.createSpan({ cls: 'pm-report-hlabel', text: status?.label ?? row.statusId })
      const track = line.createDiv('pm-report-htrack')
      const fill = track.createDiv('pm-report-hfill')
      fill.setCssProps({
        '--report-fill': `${Math.max(2, Math.round((row.totalMs / max) * 100))}%`,
        '--report-color': status?.color ?? 'var(--gs-ink-subtle)'
      })
      line.createSpan({ cls: 'pm-report-hvalue', text: formatSlaRemaining(row.totalMs) })
    }
  }

  private renderVerdicts(root: HTMLElement, incidents: Task[]): void {
    const s = this.section(root, 'Incident verdicts')
    const rows = verdictBreakdown(incidents)
    if (!rows.length) {
      s.createDiv({ cls: 'pm-report-empty', text: 'No incidents in the current filter.' })
      return
    }
    const cfg = this.plugin.store.configFor(this.project)
    const max = Math.max(...rows.map((r) => r.count))
    for (const row of rows) {
      const verdict = cfg.verdicts.find((v) => v.id === row.verdictId)
      const line = s.createDiv('pm-report-hrow')
      line.createSpan({ cls: 'pm-report-hlabel', text: verdict?.label ?? (row.verdictId || 'No verdict') })
      const track = line.createDiv('pm-report-htrack')
      const fill = track.createDiv('pm-report-hfill')
      fill.setCssProps({
        '--report-fill': `${Math.max(2, Math.round((row.count / max) * 100))}%`,
        '--report-color': verdict?.color ?? 'var(--gs-ink-subtle)'
      })
      line.createSpan({ cls: 'pm-report-hvalue', text: String(row.count) })
    }
  }

  private renderSlaCompliance(root: HTMLElement, incidents: Task[], now: number): void {
    const s = this.section(root, 'Response/resolution target compliance')
    const rows = slaCompliance(incidents, this.plugin.settings.slaPolicies, now)
    if (!rows.length) {
      s.createDiv({ cls: 'pm-report-empty', text: 'No incidents in the current filter.' })
      return
    }
    const cfg = this.plugin.store.configFor(this.project)
    const grid = s.createDiv('pm-report-tiles')
    for (const row of rows) {
      const sev = cfg.severities.find((x) => x.id === row.severityId)
      const tile = grid.createDiv('pm-report-tile')
      tile.createDiv({
        cls: 'pm-report-tile-title',
        text: sev?.label ?? (row.severityId === 'none' ? 'No severity' : row.severityId)
      })
      const resolved = row.met + row.breached
      const pct = resolved ? Math.round((row.met / resolved) * 100) : null
      tile.createDiv({
        cls: 'pm-report-tile-value',
        text: pct === null ? 'No resolved data' : `${pct}% met`
      })
      tile.createDiv({
        cls: 'pm-report-tile-detail',
        text: `${row.met} met · ${row.breached} breached · ${row.open} open · ${row.noData} no data`
      })
    }
  }

  private renderLifecycleDurations(root: HTMLElement, incidents: Task[]): void {
    const s = this.section(root, 'Time to respond / contain / resolve')
    const { overall, bySeverity } = lifecycleDurations(incidents)
    if (!overall.respond && !overall.contain && !overall.resolve) {
      s.createDiv({ cls: 'pm-report-empty', text: 'No lifecycle data yet.' })
      return
    }
    const cfg = this.plugin.store.configFor(this.project)
    const grid = s.createDiv('pm-report-tiles')
    const tile = (title: string, phases: LifecyclePhases) => {
      const el = grid.createDiv('pm-report-tile')
      el.createDiv({ cls: 'pm-report-tile-title', text: title })
      const detail = (label: string, stat: DurationStat | null) => {
        el.createDiv({
          cls: 'pm-report-tile-detail',
          text: stat
            ? `${label} · mean ${formatSlaRemaining(stat.meanMs)} · median ${formatSlaRemaining(stat.medianMs)} · n=${stat.n}`
            : `${label} · no data`
        })
      }
      detail('Respond', phases.respond)
      detail('Contain', phases.contain)
      detail('Resolve', phases.resolve)
    }
    tile('All severities', overall)
    for (const row of bySeverity) {
      const sev = cfg.severities.find((x) => x.id === row.severityId)
      tile(sev?.label ?? (row.severityId === 'none' ? 'No severity' : row.severityId), row)
    }
  }
}
