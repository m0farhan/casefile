import { describe, expect, it } from 'vitest'
import { makeTask, type StatusConfig, type Task } from '../types'
import {
  addTaskToTree,
  cloneTaskSubtree,
  collectAllAssignees,
  collectAllTags,
  deleteTaskFromTree,
  filterArchived,
  findTask,
  flattenTasks,
  mergeMissingSubtasks,
  moveTaskInTree,
  totalLoggedHours,
  updateTaskInTree
} from './TaskTreeOps'

function task(overrides: Partial<Task> & { id: string }): Task {
  return makeTask(overrides)
}

describe('flattenTasks', () => {
  it('flattens a single-level list with depth 0', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b' })]
    const flat = flattenTasks(tasks)
    expect(flat).toHaveLength(2)
    expect(flat[0]).toMatchObject({ depth: 0, parentId: null, visible: true })
    expect(flat[1]).toMatchObject({ depth: 0, parentId: null, visible: true })
  })

  it('assigns depth and parentId to subtasks', () => {
    const tasks = [task({ id: 'a', subtasks: [task({ id: 'a1' })] })]
    const flat = flattenTasks(tasks)
    expect(flat[1]).toMatchObject({ depth: 1, parentId: 'a', visible: true })
  })

  it('marks descendants of a collapsed parent as invisible', () => {
    const tasks = [task({ id: 'a', collapsed: true, subtasks: [task({ id: 'a1' })] })]
    const flat = flattenTasks(tasks)
    expect(flat[0].visible).toBe(true)
    expect(flat[1].visible).toBe(false)
  })

  it('propagates invisibility through multiple levels', () => {
    const grandchild = task({ id: 'a1x' })
    const child = task({ id: 'a1', subtasks: [grandchild] })
    const root = task({ id: 'a', collapsed: true, subtasks: [child] })
    const flat = flattenTasks([root])
    expect(flat.find((f) => f.task.id === 'a1x')?.visible).toBe(false)
  })
})

describe('findTask', () => {
  it('finds a top-level task', () => {
    const target = task({ id: 'b' })
    expect(findTask([task({ id: 'a' }), target], 'b')).toBe(target)
  })

  it('finds a nested task', () => {
    const target = task({ id: 'deep' })
    const tasks = [task({ id: 'a', subtasks: [task({ id: 'a1', subtasks: [target] })] })]
    expect(findTask(tasks, 'deep')).toBe(target)
  })

  it('returns null when the id is not found', () => {
    expect(findTask([task({ id: 'a' })], 'missing')).toBeNull()
  })
})

describe('updateTaskInTree', () => {
  it('updates a top-level task and bumps updatedAt', () => {
    const t = task({ id: 'a', title: 'Old', updatedAt: '2020-01-01T00:00:00.000Z' })
    const tasks = [t]
    expect(updateTaskInTree(tasks, 'a', { title: 'New' })).toBe(true)
    expect(t.title).toBe('New')
    expect(t.updatedAt).not.toBe('2020-01-01T00:00:00.000Z')
  })

  it('updates a nested task', () => {
    const child = task({ id: 'c', title: 'Old' })
    const tasks = [task({ id: 'a', subtasks: [child] })]
    expect(updateTaskInTree(tasks, 'c', { title: 'New' })).toBe(true)
    expect(child.title).toBe('New')
  })

  it('returns false when the id is not found', () => {
    expect(updateTaskInTree([task({ id: 'a' })], 'missing', { title: 'x' })).toBe(false)
  })
})

describe('deleteTaskFromTree', () => {
  it('removes a top-level task', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b' })]
    expect(deleteTaskFromTree(tasks, 'a')).toBe(true)
    expect(tasks.map((t) => t.id)).toEqual(['b'])
  })

  it('removes a nested task', () => {
    const tasks = [task({ id: 'a', subtasks: [task({ id: 'a1' }), task({ id: 'a2' })] })]
    expect(deleteTaskFromTree(tasks, 'a1')).toBe(true)
    expect(tasks[0].subtasks.map((t) => t.id)).toEqual(['a2'])
  })

  it('returns false when the id is not found', () => {
    expect(deleteTaskFromTree([task({ id: 'a' })], 'missing')).toBe(false)
  })
})

describe('addTaskToTree', () => {
  it('appends at top level when parentId is null', () => {
    const tasks = [task({ id: 'a' })]
    addTaskToTree(tasks, task({ id: 'b' }), null)
    expect(tasks.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('appends under the named parent', () => {
    const tasks = [task({ id: 'a', subtasks: [] })]
    addTaskToTree(tasks, task({ id: 'a1' }), 'a')
    expect(tasks[0].subtasks.map((t) => t.id)).toEqual(['a1'])
  })

  it('falls back to top-level when the parent id is unknown', () => {
    const tasks = [task({ id: 'a' })]
    addTaskToTree(tasks, task({ id: 'orphan' }), 'missing')
    expect(tasks.map((t) => t.id)).toEqual(['a', 'orphan'])
  })
})

describe('moveTaskInTree', () => {
  it('moves a task before a sibling', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })]
    expect(moveTaskInTree(tasks, 'c', 'a', 'before')).toBe(true)
    expect(tasks.map((t) => t.id)).toEqual(['c', 'a', 'b'])
  })

  it('moves a task after a sibling', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })]
    expect(moveTaskInTree(tasks, 'a', 'c', 'after')).toBe(true)
    expect(tasks.map((t) => t.id)).toEqual(['b', 'c', 'a'])
  })

  it('recurses into subtask lists', () => {
    const tasks = [task({ id: 'p', subtasks: [task({ id: 'x' }), task({ id: 'y' })] })]
    expect(moveTaskInTree(tasks, 'y', 'x', 'before')).toBe(true)
    expect(tasks[0].subtasks.map((t) => t.id)).toEqual(['y', 'x'])
  })

  it('returns false when source and target are not siblings', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'p', subtasks: [task({ id: 'x' })] })]
    expect(moveTaskInTree(tasks, 'a', 'x', 'before')).toBe(false)
  })
})

describe('filterArchived', () => {
  it('drops archived tasks at each level', () => {
    const tasks = [
      task({ id: 'a', archived: true }),
      task({ id: 'b', subtasks: [task({ id: 'b1', archived: true }), task({ id: 'b2' })] })
    ]
    const filtered = filterArchived(tasks)
    expect(filtered.map((t) => t.id)).toEqual(['b'])
    expect(filtered[0].subtasks.map((t) => t.id)).toEqual(['b2'])
  })

  it('does not mutate the input tree', () => {
    const original = [task({ id: 'a', archived: true })]
    filterArchived(original)
    expect(original.map((t) => t.id)).toEqual(['a'])
  })
})

describe('collectAllAssignees', () => {
  it('returns a sorted, deduplicated list across nested tasks', () => {
    const tasks = [
      task({ id: 'a', assignees: ['Bob', 'Alice'] }),
      task({ id: 'b', subtasks: [task({ id: 'b1', assignees: ['Alice', 'Carol'] })] })
    ]
    expect(collectAllAssignees(tasks)).toEqual(['Alice', 'Bob', 'Carol'])
  })

  it('merges the extra list in', () => {
    const tasks = [task({ id: 'a', assignees: ['Alice'] })]
    expect(collectAllAssignees(tasks, ['Dave'])).toEqual(['Alice', 'Dave'])
  })

  it('filters out empty strings', () => {
    const tasks = [task({ id: 'a', assignees: ['', 'Alice'] })]
    expect(collectAllAssignees(tasks)).toEqual(['Alice'])
  })
})

describe('collectAllTags', () => {
  it('returns a sorted, deduplicated list', () => {
    const tasks = [
      task({ id: 'a', tags: ['foo', 'bar'] }),
      task({ id: 'b', subtasks: [task({ id: 'b1', tags: ['bar', 'baz'] })] })
    ]
    expect(collectAllTags(tasks)).toEqual(['bar', 'baz', 'foo'])
  })
})

describe('totalLoggedHours', () => {
  it('returns 0 when no logs exist', () => {
    expect(totalLoggedHours(task({ id: 'a' }))).toBe(0)
  })

  it('sums hours across logs', () => {
    const t = task({
      id: 'a',
      timeLogs: [
        { date: '2026-04-01', hours: 2, note: '' },
        { date: '2026-04-02', hours: 3.5, note: '' }
      ]
    })
    expect(totalLoggedHours(t)).toBe(5.5)
  })
})

describe('cloneTaskSubtree — Responder field semantics', () => {
  it('resets key, audit trail, verdict and lifecycle stamps; copies iocs/attack by value', () => {
    const source = makeTask({
      id: 'src-1',
      key: 'SOC-9',
      issueType: 'incident',
      severity: 'sev1',
      verdict: 'true-positive',
      occurredAt: '2026-06-30T23:00:00Z',
      detectedAt: '2026-07-01T00:00:00Z',
      respondedAt: '2026-07-01T01:00:00Z',
      containedAt: '2026-07-01T02:00:00Z',
      resolvedAt: '2026-07-01T03:00:00Z',
      iocs: [{ type: 'ip', value: '1.2.3.4' }],
      attack: ['T1566'],
      activity: [{ at: '2026-07-01T01:00:00Z', field: 'status', from: 'todo', to: 'done' }]
    })
    const clone = cloneTaskSubtree(source, true)

    expect(clone.key).toBe('')
    expect(clone.activity).toEqual([])
    expect(clone.comments).toBeUndefined()
    expect(clone.verdict).toBe('')
    expect(clone.occurredAt).toBe('')
    expect(clone.detectedAt).toBe('')
    expect(clone.respondedAt).toBe('')
    expect(clone.containedAt).toBe('')
    expect(clone.resolvedAt).toBe('')
    // kept: the shape of the investigation
    expect(clone.issueType).toBe('incident')
    expect(clone.severity).toBe('sev1')
    expect(clone.iocs).toEqual(source.iocs)
    expect(clone.attack).toEqual(source.attack)
    // by value, not aliased
    expect(clone.iocs).not.toBe(source.iocs)
    expect(clone.iocs[0]).not.toBe(source.iocs[0])
    expect(clone.attack).not.toBe(source.attack)
  })
})

describe('cloneTaskSubtree — a duplicate is new work', () => {
  const STATUSES: StatusConfig[] = [
    { id: 'todo', label: 'Todo', color: '#888', icon: '', complete: false },
    { id: 'done', label: 'Done', color: '#0a0', icon: '', complete: true }
  ]

  it('resets a terminal status to the default and clears completed, per node', () => {
    // Cloning done+completed while the verdict resets would mint a
    // closed-without-verdict incident.
    const child = makeTask({ id: 'c', status: 'done', completed: '2026-01-02' })
    const source = makeTask({
      id: 's',
      status: 'done',
      completed: '2026-01-01',
      verdict: 'true-positive',
      subtasks: [child]
    })
    const clone = cloneTaskSubtree(source, true, STATUSES)
    expect(clone.status).toBe('todo')
    expect(clone.completed).toBe('')
    expect(clone.verdict).toBe('')
    expect(clone.subtasks[0].status).toBe('todo')
    expect(clone.subtasks[0].completed).toBe('')
  })

  it('keeps a non-terminal status but still clears completed', () => {
    const clone = cloneTaskSubtree(makeTask({ id: 's', status: 'todo', completed: '2026-01-01' }), false, STATUSES)
    expect(clone.status).toBe('todo')
    expect(clone.completed).toBe('')
  })
})

describe('mergeMissingSubtasks', () => {
  it('preserves a live subtask missing from a stale patch array', () => {
    const liveA = task({ id: 'a', title: 'A' })
    const liveB = task({ id: 'b', title: 'B' })
    const live = task({ id: 'p', subtasks: [liveA, liveB] })
    const staleA = task({ id: 'a', title: 'A renamed' }) // the clone predates B

    const merged = mergeMissingSubtasks(live, [staleA], [])

    expect(merged.map((t) => t.id)).toEqual(['a', 'b'])
    expect(merged[0]).toBe(staleA) // patch wins for what it contains
    expect(merged[1]).toBe(liveB) // the live object rides along untouched
  })

  it('removes a subtask (and its live descendants) only when explicitly listed', () => {
    const b = task({ id: 'b', subtasks: [task({ id: 'b1' })] })
    const live = task({ id: 'p', subtasks: [task({ id: 'a' }), b] })

    const merged = mergeMissingSubtasks(live, [task({ id: 'a' })], ['b'])

    expect(flattenTasks(merged).map((f) => f.task.id)).toEqual(['a'])
  })

  it('re-attaches a preserved nested subtask under its old parent in the patched tree', () => {
    const grand = task({ id: 'g' })
    const live = task({ id: 'p', subtasks: [task({ id: 'a', subtasks: [grand] })] })
    const staleA = task({ id: 'a', subtasks: [] }) // clone predates g

    const merged = mergeMissingSubtasks(live, [staleA], [])

    expect(merged[0]).toBe(staleA)
    expect(merged[0].subtasks.map((t) => t.id)).toEqual(['g'])
    expect(merged[0].subtasks[0]).toBe(grand)
  })
})
