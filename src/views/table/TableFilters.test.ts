import { describe, expect, it } from 'vitest'
import { DEFAULT_SEVERITIES, DEFAULT_SLA_POLICIES, DEFAULT_STATUSES, makeTask } from '../../types'
import type { Task } from '../../types'
import { compareTask, lastUpdated } from './TableFilters'
import type { TableState } from './TableRenderer'

function state(sortKey: string, sortDir: 'asc' | 'desc' = 'asc'): TableState {
  return { sortKey, sortDir } as unknown as TableState
}

const sort = (severities: string[], key: string, dir: 'asc' | 'desc' = 'asc'): string[] =>
  severities
    .map((severity) => makeTask({ severity }))
    .sort((a, b) => compareTask(a, b, state(key, dir), DEFAULT_STATUSES, DEFAULT_SEVERITIES))
    .map((t) => t.severity)

describe('compareTask severity sort', () => {
  it('orders by catalog rank ascending (most severe first)', () => {
    expect(sort(['sev3', 'sev1', 'sev4', 'sev2'], 'severity')).toEqual(['sev1', 'sev2', 'sev3', 'sev4'])
  })

  it('descending inverts the catalog order', () => {
    expect(sort(['sev3', 'sev1', 'sev4'], 'severity', 'desc')).toEqual(['sev4', 'sev3', 'sev1'])
  })

  it("'' (none) and unknown ids sort last on ascending", () => {
    expect(sort(['', 'sev2', 'mystery', 'sev1'], 'severity')).toEqual(['sev1', 'sev2', '', 'mystery'])
  })

  it("a pre-retirement saved view's sortKey 'priority' is a stable no-op, never a crash", () => {
    const a = makeTask({ severity: 'sev1' })
    const b = makeTask({ severity: 'sev4' })
    expect(compareTask(a, b, state('priority'), DEFAULT_STATUSES, DEFAULT_SEVERITIES)).toBe(0)
  })
})

describe('compareTask updated sort and lastUpdated', () => {
  const entry = (at: string) => ({ at, field: 'status', from: 'todo', to: 'done' })
  // makeTask stamps createdAt = wall-clock now, which would outrank any fixed
  // historic activity timestamp — every test task pins createdAt explicitly.
  const task = (title: string, overrides: Partial<Task>) =>
    makeTask({ title, createdAt: '2026-01-01T00:00:00.000Z', ...overrides })
  const sortTitles = (tasks: Task[], dir: 'asc' | 'desc' = 'desc'): string[] =>
    [...tasks]
      .sort((a, b) => compareTask(a, b, state('updated', dir), DEFAULT_STATUSES, DEFAULT_SEVERITIES))
      .map((t) => t.title)

  it('descending orders newest activity first', () => {
    const stale = task('stale', { activity: [entry('2026-02-01T10:00:00.000Z')] })
    const fresh = task('fresh', { activity: [entry('2026-03-01T10:00:00.000Z')] })
    const mid = task('mid', { activity: [entry('2026-02-01T10:00:00.000Z'), entry('2026-02-15T10:00:00.000Z')] })
    expect(sortTitles([stale, fresh, mid])).toEqual(['fresh', 'mid', 'stale'])
  })

  it('a task with no activity falls back to its createdAt', () => {
    const quiet = task('quiet', { createdAt: '2026-02-10T00:00:00.000Z' })
    const older = task('older', { activity: [entry('2026-02-01T10:00:00.000Z')] })
    const newer = task('newer', { activity: [entry('2026-02-20T10:00:00.000Z')] })
    expect(sortTitles([older, quiet, newer])).toEqual(['newer', 'quiet', 'older'])
  })

  it('ascending flips the order', () => {
    const stale = task('stale', { activity: [entry('2026-02-01T10:00:00.000Z')] })
    const fresh = task('fresh', { activity: [entry('2026-03-01T10:00:00.000Z')] })
    expect(sortTitles([stale, fresh], 'asc')).toEqual(['stale', 'fresh'])
  })

  it('lastUpdated picks a completed date newer than every activity entry', () => {
    const t = task('t', { activity: [entry('2026-02-01T10:00:00.000Z')], completed: '2026-02-05' })
    expect(lastUpdated(t)).toBe('2026-02-05')
  })

  it('lastUpdated is null when the task carries no timestamp at all', () => {
    expect(lastUpdated(makeTask({ createdAt: '', activity: [], completed: '' }))).toBeNull()
  })
})

describe('compareTask sla sort', () => {
  const NOW = Date.parse('2026-01-01T12:00:00Z')
  const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()
  // sev1 default policy: 60m response / 240m resolution.
  const incident = (title: string, detectedMinsAgo: number, extra: Partial<Task> = {}) =>
    makeTask({ title, issueType: 'incident', severity: 'sev1', detectedAt: minsAgo(detectedMinsAgo), ...extra })
  const sortTitles = (tasks: Task[], dir: 'asc' | 'desc' = 'asc'): string[] =>
    [...tasks]
      .sort((a, b) =>
        compareTask(a, b, state('sla', dir), DEFAULT_STATUSES, DEFAULT_SEVERITIES, DEFAULT_SLA_POLICIES, NOW)
      )
      .map((t) => t.title)

  it('running clocks order by remaining time — breached (overshoot) first, then closest to breach', () => {
    const far = incident('far', 10) // 50m left on the 60m response clock
    const close = incident('close', 50) // 10m left
    const breached = incident('breached', 120) // 60m over
    expect(sortTitles([far, close, breached])).toEqual(['breached', 'close', 'far'])
  })

  it('tasks with no running clock sort after every running clock', () => {
    const noClock = makeTask({ title: 'no clock' }) // plain task: slaState is null
    const breached = incident('breached', 120)
    expect(sortTitles([noClock, breached])).toEqual(['breached', 'no clock'])
  })

  it('resolved and done-status tasks sort last, after no-clock tasks', () => {
    const resolved = incident('resolved', 500, { resolvedAt: minsAgo(400) })
    const doneStatus = makeTask({ title: 'done status', status: 'done' })
    const noClock = makeTask({ title: 'no clock' })
    const running = incident('running', 10)
    expect(sortTitles([resolved, doneStatus, noClock, running])).toEqual([
      'running',
      'no clock',
      'resolved',
      'done status'
    ])
  })

  it('descending flips the whole order', () => {
    const running = incident('running', 10)
    const noClock = makeTask({ title: 'no clock' })
    const resolved = incident('resolved', 500, { resolvedAt: minsAgo(400) })
    expect(sortTitles([running, noClock, resolved], 'desc')).toEqual(['resolved', 'no clock', 'running'])
  })
})
