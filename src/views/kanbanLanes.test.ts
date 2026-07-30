import { describe, expect, it } from 'vitest'
import { DEFAULT_PRIORITIES, makeTask, type Task } from '../types'
import { computeLanes, isLaneGroup } from './kanbanLanes'

const noEpic = { epicOf: () => null, priorities: DEFAULT_PRIORITIES }

function task(overrides: Partial<Task> & { id: string }): Task {
  return makeTask(overrides)
}

describe('computeLanes', () => {
  it("groupBy 'none' returns a single unlabeled lane with all tasks", () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b' })]
    const lanes = computeLanes(tasks, 'none', noEpic)
    expect(lanes).toHaveLength(1)
    expect(lanes[0].label).toBe('')
    expect(lanes[0].tasks).toEqual(tasks)
  })

  it('groups by epic ancestor with key+title labels and a final No-epic lane', () => {
    const epic = task({ id: 'e1', key: 'SOC-1', title: 'Detection uplift', issueType: 'epic' })
    const orphan = task({ id: 'o1' })
    const child = task({ id: 'c1' })
    const lanes = computeLanes([orphan, child], 'epic', {
      ...noEpic,
      epicOf: (id) => (id === 'c1' ? epic : null)
    })
    expect(lanes.map((l) => l.label)).toEqual(['SOC-1 · Detection uplift', 'No epic'])
    expect(lanes[0].tasks).toEqual([child])
    expect(lanes[1].tasks).toEqual([orphan])
  })

  it('epic lane label falls back to the title when the epic has no key', () => {
    const epic = task({ id: 'e1', key: '', title: 'Keyless epic', issueType: 'epic' })
    const lanes = computeLanes([task({ id: 'c1' })], 'epic', { ...noEpic, epicOf: () => epic })
    expect(lanes.map((l) => l.label)).toEqual(['Keyless epic'])
  })

  it('groups by first assignee, sorted, with Unassigned last', () => {
    const tasks = [
      task({ id: 'a', assignees: ['zoe', 'amir'] }),
      task({ id: 'b', assignees: [] }),
      task({ id: 'c', assignees: ['amir'] })
    ]
    const lanes = computeLanes(tasks, 'assignee', noEpic)
    expect(lanes.map((l) => l.label)).toEqual(['amir', 'zoe', 'Unassigned'])
    expect(lanes[0].tasks.map((t) => t.id)).toEqual(['c'])
    expect(lanes[1].tasks.map((t) => t.id)).toEqual(['a'])
    expect(lanes[2].tasks.map((t) => t.id)).toEqual(['b'])
  })

  it('groups by priority in catalog order, skipping empty lanes, unknowns trailing', () => {
    const tasks = [
      task({ id: 'a', priority: 'low' }),
      task({ id: 'b', priority: 'critical' }),
      task({ id: 'c', priority: 'p0-custom' })
    ]
    const lanes = computeLanes(tasks, 'priority', noEpic)
    expect(lanes.map((l) => l.label)).toEqual(['Critical', 'Low', 'p0-custom'])
  })

  it('groups by bucket in BUCKETS order with No bucket last, skipping empty lanes', () => {
    const tasks = [
      task({ id: 'a', bucket: 'none' }),
      task({ id: 'b', bucket: 'later' }),
      task({ id: 'c', bucket: 'this-week' })
    ]
    const lanes = computeLanes(tasks, 'bucket', noEpic)
    expect(lanes.map((l) => l.label)).toEqual(['This week', 'Later', 'No bucket'])
  })
})

describe('isLaneGroup', () => {
  it('accepts the five groupings and rejects anything else', () => {
    for (const id of ['none', 'epic', 'assignee', 'priority', 'bucket']) {
      expect(isLaneGroup(id)).toBe(true)
    }
    expect(isLaneGroup('status')).toBe(false)
    expect(isLaneGroup(undefined)).toBe(false)
  })
})
