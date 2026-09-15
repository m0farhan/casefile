import { describe, expect, it } from 'vitest'
import { makeTask } from '../types'
import { caseTimelineEvents, displayStamp } from './timeline'

describe('caseTimelineEvents', () => {
  it('returns no events for a task with nothing recorded', () => {
    expect(caseTimelineEvents(makeTask({ createdAt: '' }))).toEqual([])
  })

  it('emits one event per set field and skips unset lifecycle stamps', () => {
    const task = makeTask({
      createdAt: '2026-07-30T08:00:00.000Z',
      detectedAt: '2026-07-30T09:00:00.000Z',
      resolvedAt: '2026-08-02T09:00:00.000Z'
    })
    const events = caseTimelineEvents(task)
    expect(events.map((e) => e.kind)).toEqual(['created', 'detected', 'resolved'])
    expect(events.map((e) => e.label)).toEqual(['Created', 'Detected', 'Resolved'])
  })

  it('orders events chronologically across mixed stamp formats', () => {
    // Days apart on purpose: comment stamps parse as viewer-local wall time,
    // so sub-day gaps would make this test timezone-dependent.
    const task = makeTask({
      createdAt: '2026-07-30T08:00:00.000Z',
      detectedAt: '2026-08-03T08:00:00.000Z',
      completed: '2026-08-05',
      comments: [{ at: '2026-08-01 09:30', text: 'Checked the proxy logs' }],
      activity: [{ at: '2026-08-04T10:00:00.000Z', field: 'status', from: 'todo', to: 'done' }]
    })
    expect(caseTimelineEvents(task).map((e) => e.kind)).toEqual([
      'created',
      'comment',
      'detected',
      'activity',
      'completed'
    ])
  })

  it('maps activity entries with the em-dash placeholder for empty sides', () => {
    const task = makeTask({
      createdAt: '',
      activity: [{ at: '2026-08-04T10:00:00.000Z', field: 'severity', from: '', to: 'sev1' }]
    })
    expect(caseTimelineEvents(task)).toEqual([
      { at: '2026-08-04T10:00:00.000Z', kind: 'activity', label: 'severity', detail: '— → sev1' }
    ])
  })

  it('maps comments to their text', () => {
    const task = makeTask({
      createdAt: '',
      comments: [{ at: '2026-08-01 09:30', text: 'Escalated to L2' }]
    })
    expect(caseTimelineEvents(task)).toEqual([
      { at: '2026-08-01 09:30', kind: 'comment', label: 'Comment', detail: 'Escalated to L2' }
    ])
  })

  it('sorts unparseable stamps last, raw value preserved', () => {
    const task = makeTask({
      createdAt: '2026-07-30T08:00:00.000Z',
      activity: [
        { at: 'not a date', field: 'status', from: 'a', to: 'b' },
        { at: '2026-07-29T08:00:00.000Z', field: 'status', from: 'b', to: 'c' }
      ]
    })
    expect(caseTimelineEvents(task).map((e) => e.at)).toEqual([
      '2026-07-29T08:00:00.000Z',
      '2026-07-30T08:00:00.000Z',
      'not a date'
    ])
  })
})

describe('displayStamp', () => {
  it('shows datetimes as viewer-local minute stamps', () => {
    expect(displayStamp('2026-07-30T08:00:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    // Comment stamps are local wall time already — they round-trip unchanged.
    expect(displayStamp('2026-08-01 09:30')).toBe('2026-08-01 09:30')
  })

  it('shows date-only and unparseable stamps raw', () => {
    expect(displayStamp('2026-08-05')).toBe('2026-08-05')
    expect(displayStamp('not a date')).toBe('not a date')
  })
})
