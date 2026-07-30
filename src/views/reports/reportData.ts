import type { SlaPolicy, Task } from '../../types'
import { slaState } from '../../soc/sla'

/**
 * Pure data reducers for the Reports view. Every function takes an explicit
 * `now` and returns plain data — no fabrication: missing inputs are counted
 * as "no data", never interpolated.
 */

export interface WeekBucket {
  /** ISO week label, e.g. "2026-W31" (the Monday-based ISO week of the year). */
  label: string
  opened: number
  closed: number
}

/** ISO-8601 week (year, number) for a date. */
function isoWeek(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return { year: date.getUTCFullYear(), week }
}

function isoWeekLabel(d: Date): string {
  const { year, week } = isoWeek(d)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** Opened (createdAt) vs closed (completed date) counts per ISO week, oldest first. */
export function openedClosedPerWeek(tasks: Task[], weeks: number, now: number): WeekBucket[] {
  const buckets: WeekBucket[] = []
  const index = new Map<string, WeekBucket>()
  for (let i = weeks - 1; i >= 0; i--) {
    const label = isoWeekLabel(new Date(now - i * 7 * 86_400_000))
    const bucket = { label, opened: 0, closed: 0 }
    buckets.push(bucket)
    index.set(label, bucket)
  }
  for (const t of tasks) {
    const created = new Date(t.createdAt)
    if (!Number.isNaN(created.getTime())) {
      const bucket = index.get(isoWeekLabel(created))
      if (bucket) bucket.opened++
    }
    if (t.completed) {
      const closed = new Date(t.completed)
      if (!Number.isNaN(closed.getTime())) {
        const bucket = index.get(isoWeekLabel(closed))
        if (bucket) bucket.closed++
      }
    }
  }
  return buckets
}

export interface StatusTime {
  statusId: string
  totalMs: number
}

/**
 * Total time spent in each status across the given tasks, reconstructed from
 * the activity log: createdAt → first status entry → … → resolvedAt/now.
 * Tasks with no status entries contribute their whole lifetime to their
 * current status (honest: that IS where they've been).
 */
export function timeInStatus(tasks: Task[], now: number): StatusTime[] {
  const totals = new Map<string, number>()
  for (const t of tasks) {
    const start = Date.parse(t.createdAt)
    if (Number.isNaN(start)) continue
    const end = t.resolvedAt ? Date.parse(t.resolvedAt) : now
    const transitions = t.activity
      .filter((a) => a.field === 'status')
      .map((a) => ({ at: Date.parse(a.at), from: a.from, to: a.to }))
      .filter((a) => !Number.isNaN(a.at))
      .sort((a, b) => a.at - b.at)

    let cursor = start
    let current = transitions.length ? transitions[0].from : t.status
    for (const tr of transitions) {
      const upTo = Math.min(Math.max(tr.at, cursor), end)
      totals.set(current, (totals.get(current) ?? 0) + Math.max(0, upTo - cursor))
      cursor = upTo
      current = tr.to
    }
    totals.set(current, (totals.get(current) ?? 0) + Math.max(0, end - cursor))
  }
  return [...totals.entries()]
    .map(([statusId, totalMs]) => ({ statusId, totalMs }))
    .sort((a, b) => b.totalMs - a.totalMs)
}

export interface VerdictCount {
  verdictId: string // '' = no verdict recorded
  count: number
}

export function verdictBreakdown(incidents: Task[]): VerdictCount[] {
  const counts = new Map<string, number>()
  for (const t of incidents) counts.set(t.verdict, (counts.get(t.verdict) ?? 0) + 1)
  return [...counts.entries()].map(([verdictId, count]) => ({ verdictId, count })).sort((a, b) => b.count - a.count)
}

export interface SlaComplianceRow {
  severityId: string
  /** Resolved incidents that met / breached the resolution target. */
  met: number
  breached: number
  /** Incidents with no usable clock (no policy/timestamps) — reported, never guessed. */
  noData: number
  /** Still open (clock running) — excluded from the percentage. */
  open: number
}

export function slaCompliance(incidents: Task[], policies: Record<string, SlaPolicy>, now: number): SlaComplianceRow[] {
  const rows = new Map<string, SlaComplianceRow>()
  for (const t of incidents) {
    const sev = t.severity || 'none'
    let row = rows.get(sev)
    if (!row) {
      row = { severityId: sev, met: 0, breached: 0, noData: 0, open: 0 }
      rows.set(sev, row)
    }
    const state = slaState(t, policies, now)
    if (!state) {
      row.noData++
    } else if (!state.done) {
      row.open++
    } else if (state.breached) {
      row.breached++
    } else {
      row.met++
    }
  }
  return [...rows.values()].sort((a, b) => a.severityId.localeCompare(b.severityId))
}
