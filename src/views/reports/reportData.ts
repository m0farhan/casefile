import type { SlaPolicy, StatusConfig, Task } from '../../types'
import { slaAnchor, slaPolicy, slaState } from '../../soc/sla'
import { isTerminalStatus } from '../../utils'

/**
 * Pure data reducers for the Reports view. Every function takes an explicit
 * `now` and returns plain data — no fabrication: missing inputs are counted
 * as "no data", never interpolated.
 */

// Project lives in types.ts, which a concurrent change owns — the optional
// field is added by augmentation instead, as recents.ts does for settings.
// Fold into types.ts when convenient.
declare module '../../types' {
  interface Project {
    /**
     * "Reset reports": the Reports tab counts only cases created at or after
     * this ISO instant. Absent means all time. Nothing is deleted — every case
     * stays on the board, and clearing this brings them back into the counts.
     */
    reportsSince?: string
  }
}

/** The cases a reset report counts, and how many it leaves out and why. */
export interface ReportBaseline {
  counted: Task[]
  /** Created before the reset. */
  before: number
  /** Creation time missing or unreadable, so it cannot be placed either side of the reset. */
  undated: number
  /**
   * The left-out cases themselves (either reason). The counts cannot show the
   * open work among them, so the banner and the empty texts must: an open
   * Critical from before the reset would otherwise read as no work.
   */
  leftOut: Task[]
}

/**
 * Split the corpus at the reset instant. A case whose creation time cannot be
 * read is left out and counted as such, rather than guessed into either side:
 * counting it would put a case the analyst reset away back into the numbers,
 * and dropping it silently would hide that it exists.
 */
export function sinceBaseline(tasks: Task[], since: string | undefined): ReportBaseline {
  const from = since ? Date.parse(since) : Number.NaN
  if (Number.isNaN(from)) return { counted: tasks, before: 0, undated: 0, leftOut: [] }
  const counted: Task[] = []
  const leftOut: Task[] = []
  let before = 0
  let undated = 0
  for (const task of tasks) {
    const at = Date.parse(task.createdAt)
    if (!Number.isNaN(at) && at >= from) {
      counted.push(task)
      continue
    }
    if (Number.isNaN(at)) undated++
    else before++
    leftOut.push(task)
  }
  return { counted, before, undated, leftOut }
}

export interface WeekBucket {
  /** ISO week label, e.g. "2026-W31" (the Monday-based ISO week of the year). */
  label: string
  opened: number
  closed: number
}

/**
 * ISO-8601 week label of a calendar day (month 0-based; an out-of-range day
 * rolls over, as Date.UTC does). The arithmetic runs in UTC only so that it
 * has no zone of its own: the caller decides which day it means.
 */
function isoWeekLabel(y: number, m0: number, d: number): string {
  const date = new Date(Date.UTC(y, m0, d))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const year = date.getUTCFullYear()
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** The week of the analyst's local calendar day at this instant. */
const localWeekLabel = (d: Date): string => isoWeekLabel(d.getFullYear(), d.getMonth(), d.getDate())

/**
 * Opened (createdAt) vs closed (completed date) counts per ISO week of the
 * analyst's local calendar, oldest first. createdAt is an instant, read on
 * the local calendar; completed is already a local date and is taken as
 * written. Mixing the two on one clock put a case's close a week before its
 * open, and missed today's closures for hours around midnight.
 *
 * With `since` (a reset), weeks that end before the reset are not returned:
 * the reset leaves out every case created before it, so those weeks would
 * draw as quiet weeks when they were never counted.
 */
export function openedClosedPerWeek(tasks: Task[], weeks: number, now: number, since?: string): WeekBucket[] {
  const buckets: WeekBucket[] = []
  const index = new Map<string, WeekBucket>()
  const today = new Date(now)
  const reset = since ? new Date(since) : null
  // 'YYYY-Www' labels sort as strings; '' keeps every week.
  const first = reset && !Number.isNaN(reset.getTime()) ? localWeekLabel(reset) : ''
  for (let i = weeks - 1; i >= 0; i--) {
    // Calendar steps, not 7 × 24h: a fixed step skips a week across a DST change.
    const label = isoWeekLabel(today.getFullYear(), today.getMonth(), today.getDate() - 7 * i)
    if (label < first) continue
    const bucket = { label, opened: 0, closed: 0 }
    buckets.push(bucket)
    index.set(label, bucket)
  }
  for (const t of tasks) {
    const created = new Date(t.createdAt)
    if (!Number.isNaN(created.getTime())) {
      const bucket = index.get(localWeekLabel(created))
      if (bucket) bucket.opened++
    }
    if (t.completed) {
      // 'YYYY-MM-DD' parses as UTC midnight, so the UTC getters read back the
      // date as written. Never re-zone it: west of UTC that is the day before.
      const closed = new Date(t.completed)
      if (!Number.isNaN(closed.getTime())) {
        const bucket = index.get(isoWeekLabel(closed.getUTCFullYear(), closed.getUTCMonth(), closed.getUTCDate()))
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
 * Total time spent in each open status across the given tasks, reconstructed
 * from the activity log: createdAt → first status entry → … → now. Tasks with
 * no status entries contribute their whole lifetime to their current status
 * (honest: that IS where they've been).
 *
 * Terminal statuses are left out. Only incidents carry a resolvedAt, so a
 * Done bar that stopped there read about zero for incidents and grew every
 * day for every other task, flattening the working statuses beside it. The
 * clock runs to now for every task, so a reopened case counts its time after
 * the reopen, and an unreadable resolvedAt can no longer turn it into NaN.
 */
export function timeInStatus(tasks: Task[], statuses: StatusConfig[], now: number): StatusTime[] {
  const totals = new Map<string, number>()
  for (const t of tasks) {
    const start = Date.parse(t.createdAt)
    if (Number.isNaN(start)) continue
    const end = now
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
    .filter(([statusId]) => !isTerminalStatus(statusId, statuses))
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
  /** Resolved within the resolution target, with no late response. */
  met: number
  /** Any target already missed: a late response, a late resolution, or a live clock past its deadline. */
  breached: number
  /** Incidents with no usable clock (no policy/timestamps) — reported, never guessed. */
  noData: number
  /** Still open (clock running) — excluded from the percentage. */
  open: number
}

export interface DurationStat {
  /** Incidents with both endpoints stamped — the "n=" shown in the UI. */
  n: number
  meanMs: number
  medianMs: number
}

export interface LifecyclePhases {
  /** detectedAt → respondedAt. Null = no incident had both stamps. */
  respond: DurationStat | null
  /** detectedAt → containedAt. */
  contain: DurationStat | null
  /** detectedAt → resolvedAt. */
  resolve: DurationStat | null
}

export interface LifecycleRow extends LifecyclePhases {
  severityId: string
}

interface PhaseSamples {
  respond: number[]
  contain: number[]
  resolve: number[]
}

const LIFECYCLE_PHASES = [
  ['respond', 'respondedAt'],
  ['contain', 'containedAt'],
  ['resolve', 'resolvedAt']
] as const

function durationStat(samples: number[]): DurationStat | null {
  if (!samples.length) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return {
    n: sorted.length,
    meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    medianMs: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  }
}

/**
 * Mean/median time-to-respond/contain/resolve measured from the SLA anchor
 * (detection, else case creation), overall and per severity. Only incidents
 * with both endpoints stamped contribute; an endpoint before the anchor is
 * ignored (same guard as the lifecycle panel's summary). No stamps → null,
 * never a made-up number. `measured` counts the incidents that gave at least
 * one sample and `measuredFromCreated` those among them anchored at creation,
 * so the disclosure describes the numbers shown and not the whole filter.
 */
export function lifecycleDurations(incidents: Task[]): {
  overall: LifecyclePhases
  bySeverity: LifecycleRow[]
  measured: number
  measuredFromCreated: number
} {
  const emptySamples = (): PhaseSamples => ({ respond: [], contain: [], resolve: [] })
  const overall = emptySamples()
  const bySev = new Map<string, PhaseSamples>()
  let measured = 0
  let measuredFromCreated = 0
  for (const t of incidents) {
    const anchor = slaAnchor(t)
    const start = Date.parse(anchor.iso)
    if (Number.isNaN(start)) continue
    let contributed = false
    for (const [phase, key] of LIFECYCLE_PHASES) {
      const end = Date.parse(t[key])
      if (Number.isNaN(end) || end < start) continue
      contributed = true
      const sevId = t.severity || 'none'
      let sev = bySev.get(sevId)
      if (!sev) {
        sev = emptySamples()
        bySev.set(sevId, sev)
      }
      overall[phase].push(end - start)
      sev[phase].push(end - start)
    }
    if (contributed) {
      measured++
      if (anchor.from === 'created') measuredFromCreated++
    }
  }
  const toPhases = (s: PhaseSamples): LifecyclePhases => ({
    respond: durationStat(s.respond),
    contain: durationStat(s.contain),
    resolve: durationStat(s.resolve)
  })
  return {
    overall: toPhases(overall),
    bySeverity: [...bySev.entries()]
      .map(([severityId, s]) => ({ severityId, ...toPhases(s) }))
      .sort((a, b) => a.severityId.localeCompare(b.severityId)),
    measured,
    measuredFromCreated
  }
}

/**
 * Of the incidents with a clock (the met, breached and open ones in
 * slaCompliance), how many run it from case creation because no detection
 * time was recorded. The compliance tile prints this rather than mixing
 * anchors in one number silently (SD-03), counted over the incidents its
 * numbers describe: a no-data incident has no clock to run from anywhere.
 */
export function clockAnchors(
  incidents: Task[],
  policies: Record<string, SlaPolicy>,
  now: number
): { clocked: number; fromCreated: number } {
  let clocked = 0
  let fromCreated = 0
  for (const t of incidents) {
    if (!slaState(t, policies, now)) continue
    clocked++
    if (slaAnchor(t).from === 'created') fromCreated++
  }
  return { clocked, fromCreated }
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
    const policy = slaPolicy(t, policies)
    if (!state || !policy) {
      row.noData++
      continue
    }
    // slaState describes the clock running now, so once respondedAt is
    // stamped a late response is gone from it. Same margin as the case report.
    const lateResponse = Date.parse(t.respondedAt) > Date.parse(slaAnchor(t).iso) + policy.responseMins * 60_000
    if (state.breached || lateResponse) {
      // Breached beats open: a deadline that has already passed is a fact, not
      // a pending outcome. Counting an overdue live case as merely "running"
      // kept it out of the denominator, so the board could read 100% targets
      // met while every open case sat hours past its clock.
      row.breached++
    } else if (!state.done) {
      row.open++
    } else {
      row.met++
    }
  }
  return [...rows.values()].sort((a, b) => a.severityId.localeCompare(b.severityId))
}

export interface ReportSummary {
  open: number
  incidents: number
  closedThisWeek: number
  truePositives: number
  /** met / (met + breached) across severities; null until a clock has finished or breached. */
  slaMetPct: number | null
}

/** Headline numbers for the summary row — every value reuses the reducers above. */
export function reportSummary(
  tasks: Task[],
  incidents: Task[],
  isTerminal: (statusId: string) => boolean,
  policies: Record<string, SlaPolicy>,
  now: number
): ReportSummary {
  // The reports corpus deliberately includes archived tasks (history must
  // survive archiving), but archived is closed-for-work regardless of status —
  // an archived never-closed task is not open work.
  const open = tasks.filter((t) => !t.archived && !isTerminal(t.status)).length
  const closedThisWeek = openedClosedPerWeek(tasks, 1, now)[0]?.closed ?? 0
  const truePositives = incidents.filter((t) => t.verdict === 'true-positive').length
  const rows = slaCompliance(incidents, policies, now)
  const met = rows.reduce((n, r) => n + r.met, 0)
  const breached = rows.reduce((n, r) => n + r.breached, 0)
  const denom = met + breached
  return {
    open,
    incidents: incidents.length,
    closedThisWeek,
    truePositives,
    slaMetPct: denom ? Math.round((met / denom) * 100) : null
  }
}

export interface SeverityCount {
  severityId: string // '' = no severity set
  count: number
}

/** Open (non-terminal, non-archived) incidents per severity, in config order; unset severity last. Zero rows omitted. */
export function openBySeverity(
  incidents: Task[],
  isTerminal: (statusId: string) => boolean,
  severityOrder: string[]
): SeverityCount[] {
  const counts = new Map<string, number>()
  for (const t of incidents) {
    if (t.archived || isTerminal(t.status)) continue
    const sev = t.severity || ''
    counts.set(sev, (counts.get(sev) ?? 0) + 1)
  }
  const order = [...severityOrder, '']
  const known = order.filter((id) => counts.has(id)).map((id) => ({ severityId: id, count: counts.get(id) ?? 0 }))
  const stray = [...counts.keys()]
    .filter((k) => !order.includes(k))
    .map((k) => ({ severityId: k, count: counts.get(k) ?? 0 }))
  return [...known, ...stray]
}
