import { parsePlainDate, Temporal, today } from '../dates'
import type { DueDateFilter, FilterState, StatusConfig, Task } from '../types'
import { isTerminalStatus } from '../utils'
import { evaluateQuery, parseQuery, type QueryCtx } from './QueryParser'
import type { FlatTask } from './TaskTreeOps'

export function isFilterActive(filter: FilterState): boolean {
  return !!(
    filter.text ||
    filter.statuses.length ||
    filter.priorities.length ||
    filter.severities.length ||
    filter.verdicts.length ||
    filter.assignees.length ||
    filter.tags.length ||
    filter.dueDateFilter !== 'any'
  )
}

export function countActiveFilters(filter: FilterState): number {
  let count = 0
  if (filter.text) count++
  if (filter.statuses.length) count++
  if (filter.priorities.length) count++
  if (filter.severities.length) count++
  if (filter.verdicts.length) count++
  if (filter.assignees.length) count++
  if (filter.tags.length) count++
  if (filter.dueDateFilter !== 'any') count++
  if (filter.showArchived) count++
  return count
}

export function matchesFilter(
  task: Task,
  filter: FilterState,
  statuses: StatusConfig[] = [],
  queryCtx?: Partial<QueryCtx>
): boolean {
  // Note: this gate runs before any query term, so `archived:true` in the query
  // bar only has effect once showArchived is also on — by design.
  if (task.archived && !filter.showArchived) return false
  const compiled = parseQuery(filter.text)
  if (compiled.terms.length) {
    const ctx: QueryCtx = {
      statuses,
      priorities: [],
      severities: [],
      currentUser: '',
      today: today(),
      ...queryCtx
    }
    if (!evaluateQuery(compiled, task, ctx)) return false
  }
  // Free-text words (non-field terms) keep the original substring semantics below.
  const q = compiled.freeText.toLowerCase()
  if (q) {
    if (
      !(
        task.id.toLowerCase() === q ||
        (task.key !== '' && task.key.toLowerCase().includes(q)) ||
        task.title.toLowerCase().includes(q) ||
        task.status.includes(q) ||
        task.priority.includes(q) ||
        task.assignees.some((a) => a.toLowerCase().includes(q)) ||
        task.tags.some((t) => t.toLowerCase().includes(q))
      )
    ) {
      return false
    }
  }
  if (filter.statuses.length && !filter.statuses.includes(task.status)) return false
  if (filter.priorities.length && !filter.priorities.includes(task.priority)) return false
  if (filter.severities.length && !filter.severities.includes(task.severity)) return false
  if (filter.verdicts.length && !filter.verdicts.includes(task.verdict)) return false
  if (filter.assignees.length && !task.assignees.some((a) => filter.assignees.includes(a))) return false
  if (filter.tags.length && !task.tags.some((t) => filter.tags.includes(t))) return false
  if (filter.dueDateFilter !== 'any' && !matchDueDateFilter(task, filter.dueDateFilter, statuses)) return false
  return true
}

export function applyTaskFilter(
  tasks: Task[],
  filter: FilterState,
  statuses: StatusConfig[] = [],
  queryCtx?: Partial<QueryCtx>
): Task[] {
  return tasks
    .filter((t) => matchesFilter(t, filter, statuses, queryCtx))
    .map((t) => (t.subtasks.length ? { ...t, subtasks: applyTaskFilter(t.subtasks, filter, statuses, queryCtx) } : t))
}

/**
 * Tree-shaped filter that lifts orphaned matching descendants to the slot of
 * their dropped ancestor. Used by the gantt view so a matching subtask doesn't
 * disappear when its parent doesn't match.
 */
export function applyTaskFilterPromote(
  tasks: Task[],
  filter: FilterState,
  statuses: StatusConfig[] = [],
  queryCtx?: Partial<QueryCtx>
): Task[] {
  const result: Task[] = []
  for (const t of tasks) {
    const filteredSubs = t.subtasks.length ? applyTaskFilterPromote(t.subtasks, filter, statuses, queryCtx) : []
    if (matchesFilter(t, filter, statuses, queryCtx)) {
      result.push({ ...t, subtasks: filteredSubs })
    } else {
      result.push(...filteredSubs)
    }
  }
  return result
}

export function applyTaskFilterFlat(
  flat: FlatTask[],
  filter: FilterState,
  statuses: StatusConfig[] = [],
  queryCtx?: Partial<QueryCtx>
): FlatTask[] {
  return flat.filter(({ task }) => matchesFilter(task, filter, statuses, queryCtx))
}

function matchDueDateFilter(task: Task, filter: DueDateFilter, statuses: StatusConfig[]): boolean {
  if (filter === 'no-date') return !task.due
  const due = parsePlainDate(task.due)
  if (!due) return false
  const now = today()

  switch (filter) {
    case 'overdue':
      return Temporal.PlainDate.compare(due, now) < 0 && !isTerminalStatus(task.status, statuses)
    case 'this-week': {
      const daysToEnd = 7 - (now.dayOfWeek % 7)
      const endOfWeek = now.add({ days: daysToEnd })
      return Temporal.PlainDate.compare(due, now) >= 0 && Temporal.PlainDate.compare(due, endOfWeek) <= 0
    }
    case 'this-month':
      return due.year === now.year && due.month === now.month && Temporal.PlainDate.compare(due, now) >= 0
    default:
      return true
  }
}
