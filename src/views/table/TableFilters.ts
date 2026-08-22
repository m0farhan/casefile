import type { Task, StatusConfig, SeverityConfig, SlaPolicy } from '../../types'
import type { TableState } from './TableRenderer'
import { statusSortOrder, isTerminalStatus } from '../../utils'
import { slaState } from '../../soc/sla'

export function compareTask(
  a: Task,
  b: Task,
  state: TableState,
  statuses: StatusConfig[] = [],
  severities: SeverityConfig[] = [],
  // Optional so pre-'sla' callers compile unchanged; pass both for the 'sla' key.
  slaPolicies: Record<string, SlaPolicy> = {},
  now: number = Date.now()
): number {
  const dir = state.sortDir === 'asc' ? 1 : -1
  switch (state.sortKey) {
    case 'title':
      return dir * a.title.localeCompare(b.title)
    case 'status':
      return dir * (statusSortOrder(a.status, statuses) - statusSortOrder(b.status, statuses))
    case 'severity':
      return dir * (severityOrder(a.severity, severities) - severityOrder(b.severity, severities))
    case 'due':
      return dir * (a.due || 'zzz').localeCompare(b.due || 'zzz')
    case 'assignees':
      return dir * (a.assignees[0] ?? '').localeCompare(b.assignees[0] ?? '')
    case 'progress':
      return dir * (a.progress - b.progress)
    case 'sla': {
      // JSM queue parity: ascending = closest-to-breach first (breached = most
      // negative remaining, so plain remainingMs order). No running clock sorts
      // after all running clocks; done/terminal tasks after those.
      const ra = slaSortRank(a, statuses, slaPolicies, now)
      const rb = slaSortRank(b, statuses, slaPolicies, now)
      return dir * (ra.bucket !== rb.bucket ? ra.bucket - rb.bucket : ra.remaining - rb.remaining)
    }
    // A pre-retirement saved view can still carry sortKey 'priority': it lands here (unsorted).
    default:
      return 0
  }
}

/** Bucket 0 = running clock (ordered by remainingMs), 1 = no clock, 2 = done/terminal. */
function slaSortRank(
  task: Task,
  statuses: StatusConfig[],
  policies: Record<string, SlaPolicy>,
  now: number
): { bucket: number; remaining: number } {
  const state = slaState(task, policies, now)
  if (isTerminalStatus(task.status, statuses) || state?.done) return { bucket: 2, remaining: 0 }
  if (!state) return { bucket: 1, remaining: 0 }
  return { bucket: 0, remaining: state.remainingMs }
}

/** Catalog index (0 = most severe); '' (none) and unknown ids sort last. */
function severityOrder(sev: string, severities: SeverityConfig[]): number {
  const idx = severities.findIndex((cfg) => cfg.id === sev)
  return idx >= 0 ? idx : 999
}
