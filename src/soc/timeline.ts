import type { Task } from '../types'
import { isoToLocalInput } from './LifecyclePanel'

/** One row of the case-timeline view. `at` is the stored stamp, verbatim. */
export interface TimelineEvent {
  at: string
  kind: 'created' | 'detected' | 'responded' | 'contained' | 'resolved' | 'completed' | 'comment' | 'activity'
  label: string
  detail?: string
}

/* Lifecycle stamps in workflow order; labels match the LifecyclePanel rows. */
const LIFECYCLE = [
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
  if (task.completed) events.push({ at: task.completed, kind: 'completed', label: 'Completed' })
  for (const e of task.activity) {
    // Same wording as renderActivitySection: '—' stands in for an empty side.
    events.push({ at: e.at, kind: 'activity', label: e.field, detail: `${e.from || '—'} → ${e.to || '—'}` })
  }
  for (const c of task.comments ?? []) {
    events.push({ at: c.at, kind: 'comment', label: 'Comment', detail: c.text })
  }
  return events.sort((a, b) => {
    const ta = eventTime(a.at)
    const tb = eventTime(b.at)
    if (Number.isNaN(ta)) return Number.isNaN(tb) ? 0 : 1
    if (Number.isNaN(tb)) return -1
    return ta - tb
  })
}
