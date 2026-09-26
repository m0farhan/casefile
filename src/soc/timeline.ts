import type { Task } from '../types'
import { activityValue } from './ioc'
import { isoToLocalInput } from './LifecyclePanel'

/** One row of the case-timeline view. `at` is the stored stamp, verbatim. */
export interface TimelineEvent {
  at: string
  kind:
    | 'created'
    | 'occurred'
    | 'detected'
    | 'responded'
    | 'contained'
    | 'resolved'
    | 'completed'
    | 'comment'
    | 'activity'
  label: string
  detail?: string
}

/* Lifecycle stamps in workflow order; labels match the LifecyclePanel rows. */
const LIFECYCLE = [
  { key: 'occurredAt', kind: 'occurred', label: 'Occurred' },
  { key: 'detectedAt', kind: 'detected', label: 'Detected' },
  { key: 'respondedAt', kind: 'responded', label: 'Responded' },
  { key: 'containedAt', kind: 'contained', label: 'Contained' },
  { key: 'resolvedAt', kind: 'resolved', label: 'Resolved' }
] as const

/** Sort key. Stored stamps mix ISO datetimes, comment 'YYYY-MM-DD HH:mm', and
 * date-only 'YYYY-MM-DD' — the space is normalized to ISO's 'T' for comparison
 * only, never for display. NaN (unparseable) is the comparator's sort-last case. */
function eventTime(at: string): number {
  return Date.parse(at.replace(' ', 'T'))
}

/** Viewer-local minute stamp (the activity-row idiom), raw value when the Date
 * round-trip can't represent it: date-only stamps would grow an invented wall
 * time on the wrong side of midnight for west-of-UTC viewers, and an
 * unparseable stamp has nothing better than itself to show. */
export function displayStamp(at: string): string {
  if (!at.includes('T') && !at.includes(' ')) return at
  return isoToLocalInput(at.replace(' ', 'T')).replace('T', ' ') || at
}

/**
 * The chronological story of one case: one event per stored fact — creation,
 * each set lifecycle stamp, completion, every activity entry, every comment.
 * Nothing is invented; an empty field contributes no event. Ties keep this
 * insertion order (sort is stable); unparseable stamps sort last.
 */
export function caseTimelineEvents(task: Task): TimelineEvent[] {
  const events: TimelineEvent[] = []
  if (task.createdAt) events.push({ at: task.createdAt, kind: 'created', label: 'Created' })
  for (const f of LIFECYCLE) {
    if (task[f.key]) events.push({ at: task[f.key], kind: f.kind, label: f.label })
  }
  // `completed` is a local date with no time, written in the same save as the
  // status change that closed the case. Parsed as a date it is UTC midnight,
  // which sorted the close before the events that led to it, usually before
  // Created. It sorts at that status entry instead; a date set by hand or by
  // import has no entry, so it sorts at the end of that local day.
  let closeKey = Number.NaN
  if (task.completed) {
    events.push({ at: task.completed, kind: 'completed', label: 'Completed' })
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(task.completed)
    const close = dateOnly
      ? task.activity.filter((e) => e.field === 'status' && isoToLocalInput(e.at).startsWith(task.completed)).pop()
      : undefined
    closeKey = eventTime(close?.at ?? (dateOnly ? `${task.completed}T23:59:59.999` : task.completed))
  }
  for (const e of task.activity) {
    // Same wording as renderActivitySection: '—' stands in for an empty side.
    // Indicator values are stored raw and shown defanged, like everywhere else.
    const detail = `${activityValue(e.field, e.from) || '—'} → ${activityValue(e.field, e.to) || '—'}`
    events.push({ at: e.at, kind: 'activity', label: e.field, detail })
  }
  for (const c of task.comments ?? []) {
    events.push({ at: c.at, kind: 'comment', label: 'Comment', detail: c.text })
  }
  const key = (e: TimelineEvent) => (e.kind === 'completed' ? closeKey : eventTime(e.at))
  return events.sort((a, b) => {
    const ta = key(a)
    const tb = key(b)
    if (Number.isNaN(ta)) return Number.isNaN(tb) ? 0 : 1
    if (Number.isNaN(tb)) return -1
    return ta - tb
  })
}
