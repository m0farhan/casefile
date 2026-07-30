import { describe, expect, it } from 'vitest'
import { Temporal } from '../dates'
import {
  DEFAULT_PRIORITIES,
  DEFAULT_SEVERITIES,
  DEFAULT_STATUSES,
  makeDefaultFilter,
  makeTask,
  type FilterState,
  type Task
} from '../types'
import {
  applyTaskFilter,
  applyTaskFilterFlat,
  applyTaskFilterPromote,
  countActiveFilters,
  isFilterActive,
  matchesFilter
} from './TaskFilter'
import { flattenTasks } from './TaskTreeOps'

function task(overrides: Partial<Task> & { id: string }): Task {
  return makeTask(overrides)
}

function filter(overrides: Partial<FilterState> = {}): FilterState {
  return { ...makeDefaultFilter(), ...overrides }
}

describe('isFilterActive', () => {
  it('returns false for the default filter', () => {
    expect(isFilterActive(makeDefaultFilter())).toBe(false)
  })

  it('returns true when text is set', () => {
    expect(isFilterActive(filter({ text: 'foo' }))).toBe(true)
  })

  it('returns true when any list filter has entries', () => {
    expect(isFilterActive(filter({ statuses: ['todo'] }))).toBe(true)
    expect(isFilterActive(filter({ priorities: ['high'] }))).toBe(true)
    expect(isFilterActive(filter({ assignees: ['alice'] }))).toBe(true)
    expect(isFilterActive(filter({ tags: ['urgent'] }))).toBe(true)
  })

  it('returns true when dueDateFilter is not "any"', () => {
    expect(isFilterActive(filter({ dueDateFilter: 'overdue' }))).toBe(true)
  })

  it('ignores showArchived (matches legacy semantics)', () => {
    expect(isFilterActive(filter({ showArchived: true }))).toBe(false)
  })
})

describe('countActiveFilters', () => {
  it('counts each active filter once', () => {
    expect(countActiveFilters(makeDefaultFilter())).toBe(0)
    expect(
      countActiveFilters(
        filter({
          text: 'x',
          statuses: ['todo'],
          priorities: ['high'],
          assignees: ['a'],
          tags: ['t'],
          dueDateFilter: 'overdue',
          showArchived: true
        })
      )
    ).toBe(7)
  })

  it('counts showArchived', () => {
    expect(countActiveFilters(filter({ showArchived: true }))).toBe(1)
  })
})

describe('matchesFilter', () => {
  it('hides archived tasks when showArchived is false', () => {
    const t = task({ id: 'a', archived: true })
    expect(matchesFilter(t, filter())).toBe(false)
    expect(matchesFilter(t, filter({ showArchived: true }))).toBe(true)
  })

  it('matches text against title, status, priority, assignees, and tags', () => {
    const t = task({ id: 'a', title: 'Refactor parser', assignees: ['Bob'], tags: ['cleanup'] })
    expect(matchesFilter(t, filter({ text: 'parser' }))).toBe(true)
    expect(matchesFilter(t, filter({ text: 'BOB' }))).toBe(true)
    expect(matchesFilter(t, filter({ text: 'cleanup' }))).toBe(true)
    expect(matchesFilter(t, filter({ text: 'unrelated' }))).toBe(false)
  })

  it('matches a task id pasted into the search box', () => {
    const t = task({ id: 'ci9q78ljy7xcz0out', title: 'Refactor parser' })
    expect(matchesFilter(t, filter({ text: 'ci9q78ljy7xcz0out' }))).toBe(true)
    expect(matchesFilter(t, filter({ text: '  ci9q78ljy7xcz0out\n' }))).toBe(true)
    expect(matchesFilter(t, filter({ text: 'CI9Q78LJY7XCZ0OUT' }))).toBe(true)
  })

  it('does not match a partial id, so ids never pollute ordinary text search', () => {
    const t = task({ id: 'ci9q78ljy7xcz0out', title: 'Refactor parser' })
    expect(matchesFilter(t, filter({ text: 'out' }))).toBe(false)
    expect(matchesFilter(t, filter({ text: 'ci9q78' }))).toBe(false)
  })

  it('ignores a whitespace-only query', () => {
    const t = task({ id: 'a', title: 'Refactor parser' })
    expect(matchesFilter(t, filter({ text: '   ' }))).toBe(true)
  })

  it('filters by status, priority, assignees, tags', () => {
    const t = task({ id: 'a', status: 'in-progress', priority: 'high', assignees: ['Alice'], tags: ['x'] })
    expect(matchesFilter(t, filter({ statuses: ['in-progress'] }))).toBe(true)
    expect(matchesFilter(t, filter({ statuses: ['done'] }))).toBe(false)
    expect(matchesFilter(t, filter({ priorities: ['high'] }))).toBe(true)
    expect(matchesFilter(t, filter({ priorities: ['low'] }))).toBe(false)
    expect(matchesFilter(t, filter({ assignees: ['Alice'] }))).toBe(true)
    expect(matchesFilter(t, filter({ assignees: ['Bob'] }))).toBe(false)
    expect(matchesFilter(t, filter({ tags: ['x'] }))).toBe(true)
    expect(matchesFilter(t, filter({ tags: ['y'] }))).toBe(false)
  })

  it('treats no-date dueDateFilter correctly', () => {
    expect(matchesFilter(task({ id: 'a', due: '' }), filter({ dueDateFilter: 'no-date' }))).toBe(true)
    expect(matchesFilter(task({ id: 'b', due: '2026-01-01' }), filter({ dueDateFilter: 'no-date' }))).toBe(false)
  })
})

describe('applyTaskFilter (tree-shaped)', () => {
  it('keeps tasks that match and rebuilds subtask trees', () => {
    const tasks = [
      task({ id: 'a', status: 'todo', subtasks: [task({ id: 'a1', status: 'todo' })] }),
      task({ id: 'b', status: 'done' })
    ]
    const out = applyTaskFilter(tasks, filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(out.map((t) => t.id)).toEqual(['a'])
    expect(out[0].subtasks.map((t) => t.id)).toEqual(['a1'])
  })

  it('drops the entire subtree when the parent is filtered out (strict tree)', () => {
    const tasks = [task({ id: 'a', status: 'done', subtasks: [task({ id: 'a1', status: 'todo' })] })]
    const out = applyTaskFilter(tasks, filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(out).toEqual([])
  })

  it('does not mutate the input tree', () => {
    const child = task({ id: 'a1', status: 'done' })
    const parent = task({ id: 'a', status: 'todo', subtasks: [child] })
    const out = applyTaskFilter([parent], filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(parent.subtasks).toEqual([child])
    expect(out[0].subtasks).toEqual([])
  })
})

describe('applyTaskFilterPromote', () => {
  it('lifts a matching grandchild to the slot of its dropped parent', () => {
    const tasks = [
      task({
        id: 'root',
        status: 'todo',
        subtasks: [task({ id: 'mid', status: 'done', subtasks: [task({ id: 'leaf', status: 'todo' })] })]
      })
    ]
    const out = applyTaskFilterPromote(tasks, filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(out.map((t) => t.id)).toEqual(['root'])
    expect(out[0].subtasks.map((t) => t.id)).toEqual(['leaf'])
  })

  it('promotes orphans all the way to top level when ancestors are dropped', () => {
    const tasks = [
      task({
        id: 'root',
        status: 'done',
        subtasks: [task({ id: 'mid', status: 'done', subtasks: [task({ id: 'leaf', status: 'todo' })] })]
      })
    ]
    const out = applyTaskFilterPromote(tasks, filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(out.map((t) => t.id)).toEqual(['leaf'])
  })

  it('preserves a promoted task’s own subtree', () => {
    const tasks = [
      task({
        id: 'root',
        status: 'done',
        subtasks: [
          task({
            id: 'mid',
            status: 'todo',
            subtasks: [task({ id: 'leaf', status: 'todo' })]
          })
        ]
      })
    ]
    const out = applyTaskFilterPromote(tasks, filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(out.map((t) => t.id)).toEqual(['mid'])
    expect(out[0].subtasks.map((t) => t.id)).toEqual(['leaf'])
  })

  it('drops branches with no matching descendants', () => {
    const tasks = [
      task({ id: 'a', status: 'done', subtasks: [task({ id: 'a1', status: 'done' })] }),
      task({ id: 'b', status: 'todo' })
    ]
    const out = applyTaskFilterPromote(tasks, filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(out.map((t) => t.id)).toEqual(['b'])
  })
})

describe('applyTaskFilterFlat', () => {
  it('returns only entries whose task matches', () => {
    const tasks = [task({ id: 'a', status: 'todo' }), task({ id: 'b', status: 'done' })]
    const flat = flattenTasks(tasks)
    const out = applyTaskFilterFlat(flat, filter({ statuses: ['todo'] }), DEFAULT_STATUSES)
    expect(out.map((f) => f.task.id)).toEqual(['a'])
  })

  it('respects showArchived', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b', archived: true })]
    const flat = flattenTasks(tasks)
    expect(applyTaskFilterFlat(flat, filter(), DEFAULT_STATUSES).map((f) => f.task.id)).toEqual(['a'])
    expect(applyTaskFilterFlat(flat, filter({ showArchived: true }), DEFAULT_STATUSES).map((f) => f.task.id)).toEqual([
      'a',
      'b'
    ])
  })
})

describe('severity/verdict filters and key search', () => {
  const incident = makeTask({ id: 'i1', key: 'SOC-3', severity: 'sev1', verdict: 'pending', title: 'Beacon triage' })
  const plain = makeTask({ id: 'p1', title: 'Refactor build' })

  it('filters by severity', () => {
    const f: FilterState = { ...makeDefaultFilter(), severities: ['sev1'] }
    expect(matchesFilter(incident, f)).toBe(true)
    expect(matchesFilter(plain, f)).toBe(false)
  })

  it('filters by verdict', () => {
    const f: FilterState = { ...makeDefaultFilter(), verdicts: ['pending'] }
    expect(matchesFilter(incident, f)).toBe(true)
    expect(matchesFilter(plain, f)).toBe(false)
  })

  it('free text matches the issue key, case-insensitive', () => {
    const f: FilterState = { ...makeDefaultFilter(), text: 'soc-3' }
    expect(matchesFilter(incident, f)).toBe(true)
    expect(matchesFilter(plain, f)).toBe(false)
  })

  it('counts severity/verdict as active filters', () => {
    const f: FilterState = { ...makeDefaultFilter(), severities: ['sev1'], verdicts: ['pending'] }
    expect(isFilterActive(f)).toBe(true)
    expect(countActiveFilters(f)).toBe(2)
  })
})

describe('query bar (JQL-lite) end to end', () => {
  const queryCtx = {
    priorities: DEFAULT_PRIORITIES,
    severities: DEFAULT_SEVERITIES,
    currentUser: 'Alice',
    today: Temporal.PlainDate.from('2026-07-30')
  }
  const incident = makeTask({
    id: 'i1',
    key: 'SOC-3',
    title: 'C2 beacon triage',
    issueType: 'incident',
    status: 'in-progress',
    severity: 'sev1',
    assignees: ['Alice'],
    due: '2026-07-29'
  })
  const q = (text: string): FilterState => filter({ text })
  const match = (text: string, t: Task): boolean => matchesFilter(t, q(text), DEFAULT_STATUSES, queryCtx)

  it('matches a full structured query plus free text', () => {
    expect(match('type:incident status:!done sev:>=sev2 beacon', incident)).toBe(true)
  })

  it('fails when any single term fails', () => {
    expect(match('type:incident status:!done sev:>=sev2 beacon', { ...incident, status: 'done' })).toBe(false)
    expect(match('type:incident status:!done sev:>=sev2 beacon', { ...incident, severity: 'sev3' })).toBe(false)
    expect(match('type:incident status:!done sev:>=sev2 beacon', { ...incident, issueType: 'task' })).toBe(false)
    expect(match('type:incident status:!done sev:>=sev2 beacon', { ...incident, title: 'Refactor build' })).toBe(false)
  })

  it('free text alone still matches by title substring (regression)', () => {
    expect(match('beacon', incident)).toBe(true)
    expect(match('unrelated', incident)).toBe(false)
  })

  it('resolves assignee:me through queryCtx.currentUser', () => {
    expect(match('assignee:me', incident)).toBe(true)
    expect(match('assignee:me', { ...incident, assignees: ['Bob'] })).toBe(false)
    // Without a currentUser, 'me' stays a literal name.
    expect(matchesFilter(incident, q('assignee:me'), DEFAULT_STATUSES)).toBe(false)
  })

  it('due:overdue works with the injected today and the status catalog', () => {
    expect(match('due:overdue', incident)).toBe(true)
    expect(match('due:overdue', { ...incident, status: 'done' })).toBe(false)
  })

  it('key prefix search works through the query bar', () => {
    expect(match('key:soc', incident)).toBe(true)
    expect(match('key:argus', incident)).toBe(false)
  })

  it('archived:true still requires showArchived (the early gate wins)', () => {
    const archived = { ...incident, archived: true }
    expect(matchesFilter(archived, q('archived:true'), DEFAULT_STATUSES, queryCtx)).toBe(false)
    expect(
      matchesFilter(archived, filter({ text: 'archived:true', showArchived: true }), DEFAULT_STATUSES, queryCtx)
    ).toBe(true)
    expect(
      matchesFilter(incident, filter({ text: 'archived:true', showArchived: true }), DEFAULT_STATUSES, queryCtx)
    ).toBe(false)
  })

  it('an unknown field falls through to free text and filters accordingly', () => {
    expect(match('flavor:sour', incident)).toBe(false)
    expect(match('c2:beacon', incident)).toBe(false)
  })

  it('garbage in the search box never throws', () => {
    expect(() => match(': ::: status: !>= "', incident)).not.toThrow()
  })
})
