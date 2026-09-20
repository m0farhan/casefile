import { describe, expect, it } from 'vitest'
import { dueUrgency, withUserResponse } from './utils'
import { DEFAULT_STATUSES, makeTask, type StatusConfig } from './types'
import { today } from './dates'

const statuses: StatusConfig[] = [
  { id: 'todo', label: 'To do', color: '', icon: '', complete: false },
  { id: 'done', label: 'Done', color: '', icon: '', complete: true }
]

const inDays = (n: number): string => today().add({ days: n }).toString()

describe('dueUrgency', () => {
  it('flags an open task past its due date as overdue', () => {
    expect(dueUrgency(makeTask({ status: 'todo', due: inDays(-3) }), statuses)).toBe('overdue')
  })

  it('flags an open task due within three days as near', () => {
    expect(dueUrgency(makeTask({ status: 'todo', due: inDays(0) }), statuses)).toBe('near')
    expect(dueUrgency(makeTask({ status: 'todo', due: inDays(2) }), statuses)).toBe('near')
  })

  it('leaves an open task due further out plain', () => {
    expect(dueUrgency(makeTask({ status: 'todo', due: inDays(3) }), statuses)).toBe('normal')
    expect(dueUrgency(makeTask({ status: 'todo', due: inDays(30) }), statuses)).toBe('normal')
  })

  it('leaves a terminal task plain whatever its due date', () => {
    expect(dueUrgency(makeTask({ status: 'done', due: inDays(-30) }), statuses)).toBe('normal')
    expect(dueUrgency(makeTask({ status: 'done', due: inDays(-1) }), statuses)).toBe('normal')
    expect(dueUrgency(makeTask({ status: 'done', due: inDays(1) }), statuses)).toBe('normal')
  })

  it('leaves a task with no due date plain', () => {
    expect(dueUrgency(makeTask({ status: 'todo', due: '' }), statuses)).toBe('normal')
  })
})

describe('withUserResponse', () => {
  const ids = (list: StatusConfig[] | null) => list?.map((s) => s.id)
  const PRE_2_26: StatusConfig[] = [
    { id: 'todo', label: 'To Do', color: '#b8a06b', icon: '', complete: false },
    { id: 'in-progress', label: 'In Progress', color: '#6ba3d6', icon: '', complete: false },
    { id: 'blocked', label: 'Blocked', color: '#c47070', icon: '', complete: false },
    { id: 'review', label: 'In Review', color: '#8b72be', icon: '', complete: false },
    { id: 'done', label: 'Done', color: '#79b58d', icon: '', complete: true },
    { id: 'cancelled', label: 'Cancelled', color: '#767491', icon: '', complete: true }
  ]

  it("inserts User Response before the list's first terminal status", () => {
    expect(ids(withUserResponse(PRE_2_26))).toEqual([
      'todo',
      'in-progress',
      'blocked',
      'review',
      'user-response',
      'done',
      'cancelled'
    ])
  })

  it('upgrades a three-status vault to exactly the four shipped statuses', () => {
    const saved: StatusConfig[] = [
      { id: 'todo', label: 'To Do', color: '#b8a06b', icon: '', complete: false },
      { id: 'in-progress', label: 'In Progress', color: '#6ba3d6', icon: '', complete: false },
      { id: 'done', label: 'Done', color: '#79b58d', icon: '', complete: true }
    ]
    expect(withUserResponse(saved)).toEqual(DEFAULT_STATUSES)
  })

  it('removes nothing and rewrites nothing: every saved entry survives byte-identical', () => {
    const curated: StatusConfig[] = [
      { id: 'todo', label: 'Queue', color: '#111111', icon: 'inbox', complete: false },
      { id: 'blocked', label: 'Escalated — Tier 2', color: '#abcdef', icon: '', complete: false },
      { id: 'done', label: 'Closed', color: '#79b58d', icon: '', complete: true }
    ]
    const out = withUserResponse(curated)
    expect(out?.filter((s) => s.id !== 'user-response')).toEqual(curated)
  })

  it("never hands back the caller's array, so the DEFAULT_STATUSES constant cannot be mutated", () => {
    const before = DEFAULT_STATUSES.length
    const input: StatusConfig[] = [{ id: 'done', label: 'Done', color: '', icon: '', complete: true }]
    const out = withUserResponse(input)
    expect(out).not.toBe(input)
    expect(input).toHaveLength(1)
    expect(DEFAULT_STATUSES).toHaveLength(before)
  })

  it('is a no-op once the status exists, so a deleted User Response is never resurrected', () => {
    expect(withUserResponse(DEFAULT_STATUSES)).toBeNull()
    expect(withUserResponse([...DEFAULT_STATUSES].reverse())).toBeNull()
  })

  it('appends when no status is marked terminal, rather than dropping the entry', () => {
    const noneComplete: StatusConfig[] = [{ id: 'todo', label: 'To Do', color: '', icon: '', complete: false }]
    expect(ids(withUserResponse(noneComplete))).toEqual(['todo', 'user-response'])
  })
})
