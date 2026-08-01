import type { Task, StatusConfig, SeverityConfig } from '../../types'
import type { TableState } from './TableRenderer'
import { statusSortOrder } from '../../utils'

export function compareTask(
  a: Task,
  b: Task,
  state: TableState,
  statuses: StatusConfig[] = [],
  severities: SeverityConfig[] = []
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
    // A pre-retirement saved view can still carry sortKey 'priority': it lands here (unsorted).
    default:
      return 0
  }
}

/** Catalog index (0 = most severe); '' (none) and unknown ids sort last. */
function severityOrder(sev: string, severities: SeverityConfig[]): number {
  const idx = severities.findIndex((cfg) => cfg.id === sev)
  return idx >= 0 ? idx : 999
}
