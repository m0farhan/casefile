import { describe, expect, it } from 'vitest'
import { fillProgressOnDone, subtreeIds, typeOptions } from './TaskFormFields'
import { DEFAULT_ISSUE_TYPES, DEFAULT_STATUSES, makeTask } from '../types'
import { flattenTasks } from '../store/TaskTreeOps'

describe('subtreeIds — parent picker cycle guard', () => {
  const grandchild = makeTask({ title: 'grandchild' })
  const child = makeTask({ title: 'child', subtasks: [grandchild] })
  const edited = makeTask({ title: 'edited', subtasks: [child] })
  const sibling = makeTask({ title: 'sibling' })

  it('collects the task itself plus every descendant', () => {
    const ids = subtreeIds(edited)
    expect(ids.has(edited.id)).toBe(true)
    expect(ids.has(child.id)).toBe(true)
    expect(ids.has(grandchild.id)).toBe(true)
    expect(ids.has(sibling.id)).toBe(false)
  })

  it('excludes the whole subtree from parent options, keeps siblings', () => {
    // Mirrors the picker's filter. The pre-fix filter (t.id !== edited.id)
    // kept child and grandchild in the options — picking either created an
    // index cycle and an infinite ancestor walk.
    const excluded = subtreeIds(edited)
    const parents = flattenTasks([edited, sibling])
      .map((f) => f.task)
      .filter((t) => !excluded.has(t.id))
    expect(parents.map((t) => t.id)).toEqual([sibling.id])
  })
})

describe('typeOptions — parentPickerEnabled (I4)', () => {
  it('offers Subtask of… when the host has a working parent picker', () => {
    const ids = typeOptions(DEFAULT_ISSUE_TYPES, true).map((o) => o.id)
    expect(ids).toContain('__subtask__')
    expect(ids).toContain('__milestone__')
    for (const t of DEFAULT_ISSUE_TYPES) expect(ids).toContain(t.id)
  })

  it('omits only the subtask option when the parent picker is disabled', () => {
    const ids = typeOptions(DEFAULT_ISSUE_TYPES, false).map((o) => o.id)
    expect(ids).not.toContain('__subtask__')
    expect(ids).toContain('__milestone__')
    for (const t of DEFAULT_ISSUE_TYPES) expect(ids).toContain(t.id)
  })
})

describe('fillProgressOnDone', () => {
  /** Picks a status the way the editors do: set it, then fill against the status on disk. */
  const pick = (task: ReturnType<typeof makeTask>, status: string, saved: string, filledFrom?: number) => {
    task.status = status
    return fillProgressOnDone(task, saved, DEFAULT_STATUSES, filledFrom)
  }

  it('a Done pick fills progress at once, and reopening before a save puts back what it replaced', () => {
    const task = makeTask({ status: 'todo', progress: 25 })
    task.progress = 50 // a slider move before the pick does not keep the case short of done
    const from = pick(task, 'done', 'todo')
    expect(task.progress).toBe(100)
    expect(pick(task, 'in-progress', 'todo', from)).toBeUndefined()
    expect(task.progress).toBe(50)
  })

  it('a slider move after the pick wins, and a milestone never gets progress', () => {
    const task = makeTask({ status: 'todo', progress: 25 })
    const from = pick(task, 'done', 'todo')
    task.progress = 75
    pick(task, 'todo', 'todo', from)
    expect(task.progress).toBe(75)
    const milestone = makeTask({ type: 'milestone', status: 'todo', progress: 0 })
    expect(pick(milestone, 'done', 'todo')).toBeUndefined()
    expect(milestone.progress).toBe(0)
  })

  it('fills against the saved status: Done → In progress → Done on a case saved Done fills nothing', () => {
    const task = makeTask({ status: 'done', progress: 30 })
    let held = pick(task, 'in-progress', 'done')
    held = pick(task, 'done', 'done', held)
    expect(held).toBeUndefined()
    expect(task.progress).toBe(30)
  })

  it('moving between two closing statuses keeps what the first fill replaced', () => {
    const statuses = [
      ...DEFAULT_STATUSES,
      { id: 'cancelled', label: 'Cancelled', color: '#888', icon: '', complete: true }
    ]
    const task = makeTask({ status: 'todo', progress: 25 })
    let held = pick(task, 'done', 'todo')
    task.status = 'cancelled'
    held = fillProgressOnDone(task, 'todo', statuses, held)
    expect(task.progress).toBe(100)
    pick(task, 'todo', 'todo', held)
    expect(task.progress).toBe(25)
  })
})
