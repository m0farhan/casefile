import type { Task, GanttGranularity } from '../../types'
import { flattenTasks } from '../../store/TaskTreeOps'
import { Temporal, today, parsePlainDate } from '../../dates'

export const ROW_HEIGHT = 44
export const HEADER_HEIGHT = 56
export const LABEL_WIDTH = 280
export const BAR_PADDING = 8
export const BAR_BORDER_RADIUS = 7

export const DAY_WIDTH: Record<GanttGranularity, number> = {
  day: 44,
  week: 22,
  month: 9,
  quarter: 5
}

export interface TimelineCfg {
  startDate: Temporal.PlainDate
  endDate: Temporal.PlainDate
  dayWidth: number
  granularity: GanttGranularity
  totalDays: number
  totalWidth: number
}

const MIN_DAYS: Record<GanttGranularity, number> = {
  day: 30,
  week: 90,
  month: 365,
  quarter: 365
}

// ponytail: a fixed ceiling on the chart span per granularity (about 2, 6, 20
// and 40 years). One mistyped year, 2206 for 2026, would otherwise stretch every
// per-day loop (grid, header, snap points) over tens of thousands of days on
// each refresh. Raise a value if real cases ever need a wider view.
export const MAX_DAYS: Record<GanttGranularity, number> = {
  day: 732,
  week: 2192,
  month: 7305,
  quarter: 14610
}

export function buildTimelineConfig(tasks: Task[], granularity: GanttGranularity): TimelineCfg {
  const allTasks = flattenTasks(tasks).map((f) => f.task)
  const now = today()
  const dates: Temporal.PlainDate[] = [now]
  for (const t of allTasks) {
    for (const d of [parsePlainDate(t.start), parsePlainDate(t.due)]) {
      if (d) dates.push(d)
    }
  }
  const earliestOf = (ds: Temporal.PlainDate[]) =>
    ds.reduce((min, d) => (Temporal.PlainDate.compare(d, min) < 0 ? d : min), ds[0])
  const latestOf = (ds: Temporal.PlainDate[]) =>
    ds.reduce((max, d) => (Temporal.PlainDate.compare(d, max) > 0 ? d : max), ds[0])

  // Room for the 7 + 14 days of padding and the month snap (up to 30 days) below.
  const edges = 51
  let startDate = earliestOf(dates)
  let endDate = latestOf(dates)
  // A board whose dates and today all fit keeps every one, however far from
  // today they sit. Only a span too wide for MAX_DAYS (a mistyped year, most
  // often) falls back to the dates this close to today; rows with a date the
  // range misses say so in text.
  // ponytail: the fallback centres on today, so a board with more than MAX_DAYS
  // of real dates loses its oldest (or latest) bars. Pick the densest window
  // instead if such boards turn up.
  if (endDate.since(startDate, { largestUnit: 'days' }).days + edges > MAX_DAYS[granularity]) {
    const reach = Math.floor((MAX_DAYS[granularity] - edges) / 2)
    const earliest = now.subtract({ days: reach })
    const latest = now.add({ days: reach })
    const inReach = dates.filter(
      (d) => Temporal.PlainDate.compare(d, earliest) >= 0 && Temporal.PlainDate.compare(d, latest) <= 0
    )
    startDate = earliestOf(inReach)
    endDate = latestOf(inReach)
  }

  // Add padding
  startDate = startDate.subtract({ days: 7 })
  endDate = endDate.add({ days: 14 })

  // Enforce minimum visible range based on granularity
  const currentSpan = endDate.since(startDate, { largestUnit: 'days' }).days
  if (currentSpan < MIN_DAYS[granularity]) {
    const extra = Math.ceil((MIN_DAYS[granularity] - currentSpan) / 2)
    startDate = startDate.subtract({ days: extra })
    endDate = endDate.add({ days: extra })
  }

  // Snap to month start for cleaner headers
  if (granularity === 'week' || granularity === 'month' || granularity === 'quarter') {
    startDate = startDate.with({ day: 1 })
  }

  const dayWidth = DAY_WIDTH[granularity]
  const totalDays = endDate.since(startDate, { largestUnit: 'days' }).days
  return {
    startDate,
    endDate,
    dayWidth,
    granularity,
    totalDays,
    totalWidth: totalDays * dayWidth
  }
}

export function dateToX(cfg: TimelineCfg, date: Temporal.PlainDate): number {
  return date.since(cfg.startDate, { largestUnit: 'days' }).days * cfg.dayWidth
}

/**
 * True when a day falls outside the drawn range. No bar, diamond or arrow can
 * stand for that day truthfully, so its row states the date in text instead.
 */
export function outOfRange(cfg: TimelineCfg, date: Temporal.PlainDate): boolean {
  return Temporal.PlainDate.compare(date, cfg.startDate) < 0 || Temporal.PlainDate.compare(date, cfg.endDate) >= 0
}

export function xToDate(cfg: TimelineCfg, x: number): Temporal.PlainDate {
  return cfg.startDate.add({ days: Math.round(x / cfg.dayWidth) })
}

/**
 * Returns snap-point X positions for the given granularity.
 * - day: every day border
 * - week: every Monday + mid-week (Thursday)
 * - month: 1st, ~8th, ~15th, ~22nd of each month
 * - quarter: 1st of each month
 */
export function getSnapPoints(cfg: TimelineCfg): number[] {
  const points: number[] = []
  const { startDate, totalDays, dayWidth, granularity } = cfg

  for (let i = 0; i <= totalDays; i++) {
    const d = startDate.add({ days: i })
    const x = i * dayWidth

    if (granularity === 'day') {
      points.push(x)
    } else if (granularity === 'week') {
      // Temporal dayOfWeek: Mon=1..Sun=7
      if (d.dayOfWeek === 1 || d.dayOfWeek === 4) points.push(x)
    } else if (granularity === 'month') {
      if (d.day === 1 || d.day === 8 || d.day === 15 || d.day === 22) points.push(x)
    } else if (granularity === 'quarter') {
      if (d.day === 1) points.push(x)
    }
  }
  return points
}

/** Snap an x position to the nearest snap point within a threshold. */
export function snapX(x: number, snapPoints: number[], threshold: number): number {
  let closest = x
  let minDist = Infinity
  for (const sp of snapPoints) {
    const dist = Math.abs(x - sp)
    if (dist < minDist) {
      minDist = dist
      closest = sp
    }
    if (sp > x + threshold) break // snap points are sorted, no need to continue
  }
  return minDist <= threshold ? closest : x
}

export function getWeekNumber(d: Temporal.PlainDate): number {
  return d.weekOfYear ?? 0
}
