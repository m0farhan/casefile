import type { Recurrence, Task } from '../types'
import { makeTask } from '../types'
import type { TaskNotesTaskInfo } from './tasknotes'

/** One selected TaskNotes task with its link references already resolved to vault paths. */
export interface TaskNotesImportItem {
  path: string
  info: TaskNotesTaskInfo
  /** Resolved `projects` link paths; the first one that is also being imported becomes the parent. */
  parentPaths: string[]
  /** Resolved `blockedBy` paths; entries that are also being imported become dependencies. */
  blockedByPaths: string[]
}

export interface TaskNotesImportOptions {
  defaultStatus: string
  defaultPriority: string
  /** TaskNotes' task-identification tag, stripped from imported tags (usually "task"). */
  taskTag: string
  /** TaskNotes' archive tag, stripped from imported tags (usually "archived"). */
  archiveTag: string
}

const RRULE_INTERVALS: Record<string, Recurrence['interval']> = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly'
}

/**
 * Map an RRULE to our recurrence model. FREQ and INTERVAL are carried over;
 * BY*, COUNT and UNTIL are not. A one-day BYDAY, BYMONTHDAY or BYMONTH (what
 * every TaskNotes preset writes) is the task's own anchor day, so "Repeats
 * weekly" still says what the rule does. A BYDAY listing several days
 * (weekdays, Mon/Wed/Fri) is not: the label would understate it, so that rule
 * is dropped, as is a FREQ the model has no interval for (HOURLY).
 */
function mapRecurrence(rrule: string | undefined): Recurrence | undefined {
  const freq = rrule?.match(/FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/)
  if (!rrule || !freq) return undefined
  // Split into parts rather than one regex over the whole rule, so the check
  // stays linear however long a hand edit made it.
  if (rrule.split(/[;:\s]/).some((part) => part.startsWith('BYDAY=') && part.includes(','))) return undefined
  const every = rrule.match(/INTERVAL=(\d+)/)
  return { interval: RRULE_INTERVALS[freq[1]], every: every ? parseInt(every[1], 10) : 1 }
}

/**
 * Frontmatter keys a TaskNotes note uses for values this conversion already
 * carries onto the case (under TaskNotes' default names). They are not kept
 * as extra properties beside the case's own, where they would go stale and
 * contradict it after the first edit.
 * ponytail: default names only; a custom TaskNotes field mapping or a
 * property-based task marker is excluded when the caller passes those names.
 */
export const TASKNOTES_MAPPED_KEYS = [
  'scheduled',
  'completedDate',
  'dateCreated',
  'dateModified',
  'projects',
  'blockedBy',
  'timeEntries'
]

/** One TaskNotes time entry as its API returns it. */
interface TaskNotesTimeEntry {
  startTime?: string
  endTime?: string
  description?: string
}

/**
 * TaskNotes time entries as time logs: the day the entry started, the hours
 * between its start and end, and its description. An entry without a readable
 * start and a later end (one still running) has no duration yet and is left
 * out rather than guessed.
 */
function mapTimeEntries(entries: unknown): Task['timeLogs'] {
  if (!Array.isArray(entries)) return undefined
  const logs: NonNullable<Task['timeLogs']> = []
  for (const e of entries as TaskNotesTimeEntry[]) {
    const start = Date.parse(e?.startTime ?? '')
    const end = Date.parse(e?.endTime ?? '')
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue
    logs.push({
      date: new Date(start).toISOString().slice(0, 10),
      hours: Math.round(((end - start) / 3_600_000) * 100) / 100,
      note: typeof e.description === 'string' ? e.description : ''
    })
  }
  return logs.length ? logs : undefined
}

function dateOnly(value: string | undefined): string {
  return value ? value.slice(0, 10) : ''
}

function mapItemToTask(item: TaskNotesImportItem, opts: TaskNotesImportOptions): Task {
  const info = item.info
  const task = makeTask({
    title: info.title || item.path.slice(item.path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
    status: info.status || opts.defaultStatus,
    priority: info.priority || opts.defaultPriority,
    start: dateOnly(info.scheduled),
    due: dateOnly(info.due),
    completed: dateOnly(info.completedDate),
    tags: (info.tags ?? []).filter((t) => t !== opts.taskTag && t !== opts.archiveTag),
    recurrence: mapRecurrence(info.recurrence)
  })
  if (info.timeEstimate && info.timeEstimate > 0) {
    task.timeEstimate = Math.round((info.timeEstimate / 60) * 100) / 100
  }
  const timeLogs = mapTimeEntries((info as TaskNotesTaskInfo & { timeEntries?: unknown }).timeEntries)
  if (timeLogs) task.timeLogs = timeLogs
  if (info.dateCreated) task.createdAt = info.dateCreated
  if (info.dateModified) task.updatedAt = info.dateModified
  if (info.archived) task.archived = true
  return task
}

/**
 * Convert resolved TaskNotes tasks into a task forest: project links between
 * imported tasks become parent/child edges (first match wins, cycles break to
 * root), and blockedBy references between imported tasks become dependencies.
 * References to notes outside the import selection are dropped.
 */
export function buildImportForest(
  items: TaskNotesImportItem[],
  opts: TaskNotesImportOptions
): { roots: Task[]; byPath: Map<string, Task> } {
  const byPath = new Map<string, Task>()
  for (const item of items) {
    byPath.set(item.path, mapItemToTask(item, opts))
  }

  const parentOf = new Map<string, string>()
  for (const item of items) {
    const candidate = item.parentPaths.find((p) => p !== item.path && byPath.has(p))
    if (!candidate) continue
    // Walk the ancestor chain; adopting a parent whose ancestry includes this
    // task would create a cycle, so such a task stays a root.
    let ancestor: string | undefined = candidate
    let cycle = false
    while (ancestor) {
      if (ancestor === item.path) {
        cycle = true
        break
      }
      ancestor = parentOf.get(ancestor)
    }
    if (!cycle) parentOf.set(item.path, candidate)
  }

  const roots: Task[] = []
  for (const item of items) {
    const task = byPath.get(item.path)
    if (!task) continue
    const parentPath = parentOf.get(item.path)
    if (parentPath) {
      const parent = byPath.get(parentPath)
      if (parent) {
        task.type = 'subtask'
        parent.subtasks.push(task)
        continue
      }
    }
    roots.push(task)
  }

  for (const item of items) {
    const task = byPath.get(item.path)
    if (!task) continue
    task.dependencies = item.blockedByPaths
      .filter((p) => p !== item.path && byPath.has(p))
      .map((p) => byPath.get(p)?.id)
      .filter((id): id is string => !!id)
  }

  return { roots, byPath }
}
