import { describe, expect, it } from 'vitest'
import { subtreeIds, typeOptions } from './TaskFormFields'
import { DEFAULT_ISSUE_TYPES, makeTask } from '../types'
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
