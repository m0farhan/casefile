import { describe, expect, it } from 'vitest'
import { DEFAULT_STATUSES, makeTask, type StatusConfig } from '../types'
import { dueForAutoArchive } from './ArchiveOps'

const NOW = '2026-09-20'

// Not the shipped list: the point of these tests is that terminal-ness comes
// from the config, so the config under test names a terminal status that is
// NOT 'done' and a non-terminal one.
const STATUSES: StatusConfig[] = [
  ...DEFAULT_STATUSES,
  { id: 'review', label: 'In Review', color: '#8b72be', icon: '', complete: false },
  { id: 'cancelled', label: 'Cancelled', color: '#767491', icon: '', complete: true }
]

const due = (overrides: Parameters<typeof makeTask>[0], days = 2): boolean =>
  dueForAutoArchive(makeTask(overrides), STATUSES, days, NOW)

describe('dueForAutoArchive', () => {
  it('archives a closed case once it is old enough', () => {
    expect(due({ status: 'done', completed: '2026-09-18' })).toBe(true)
    expect(due({ status: 'done', completed: '2026-09-01' })).toBe(true)
  })

  it('waits until the window has actually passed', () => {
    expect(due({ status: 'done', completed: '2026-09-19' })).toBe(false)
    expect(due({ status: 'done', completed: '2026-09-20' })).toBe(false)
  })

  it('follows the status config, not the id', () => {
    expect(due({ status: 'cancelled', completed: '2026-09-01' })).toBe(true)
    expect(due({ status: 'review', completed: '2026-09-01' })).toBe(false)
    expect(due({ status: 'user-response', completed: '2026-09-01' })).toBe(false)
  })

  it('never moves a case whose completion date is missing, unreadable or in the future', () => {
    expect(due({ status: 'done', completed: '' })).toBe(false)
    expect(due({ status: 'done', completed: 'yesterday' })).toBe(false)
    expect(due({ status: 'done', completed: '2026-12-01' })).toBe(false)
  })

  it('never takes a case twice: an archive entry in the log disarms it for good', () => {
    const entry = { at: '2026-09-19T10:00:00.000Z', field: 'archived', from: '2026-09-01', to: 'auto' }
    expect(due({ status: 'done', completed: '2026-09-01', activity: [entry] })).toBe(false)
    // Including one the analyst restored by hand — it stays on the board.
    const restored = { ...entry, to: 'restored' }
    expect(due({ status: 'done', completed: '2026-09-01', activity: [restored] })).toBe(false)
  })

  it('is a no-op on a case that is already archived', () => {
    expect(due({ status: 'done', completed: '2026-09-01', archived: true })).toBe(false)
  })

  it('reads the window the analyst set', () => {
    expect(due({ status: 'done', completed: '2026-09-18' }, 7)).toBe(false)
    expect(due({ status: 'done', completed: '2026-09-10' }, 7)).toBe(true)
  })
})

describe('dueForAutoArchive — the clock starts when the case landed in Done', () => {
  const NOW_T = '2026-09-20T12:00:00.000Z'
  const moved = (at: string, to = 'done') => ({ at, field: 'status', from: 'in-progress', to })
  const dueAt = (activity: { at: string; field: string; from: string; to: string }[], days = 2): boolean =>
    dueForAutoArchive(makeTask({ status: 'done', completed: '2026-09-18', activity }), STATUSES, days, NOW_T)

  it('measures 48 hours from the move, not two flips of the calendar', () => {
    // The regression: closed at 23:50 on the 18th, whole-day arithmetic made
    // this due on the 20th — about 25 hours after the case was closed.
    expect(dueAt([moved('2026-09-18T23:50:00.000Z')])).toBe(false)
    expect(dueAt([moved('2026-09-18T11:59:00.000Z')])).toBe(true)
    expect(dueAt([moved('2026-09-18T12:00:00.000Z')])).toBe(true) // exactly 48h
  })

  it('restarts when the case moves between two closing statuses', () => {
    expect(dueAt([moved('2026-09-10T09:00:00.000Z'), moved('2026-09-20T09:00:00.000Z', 'cancelled')])).toBe(false)
  })

  it('ignores a log whose newest status move left the case open', () => {
    // Status on the task did not come from the log, so the date is all we have.
    expect(dueAt([moved('2026-09-01T09:00:00.000Z'), moved('2026-09-20T09:00:00.000Z', 'review')])).toBe(true)
  })

  it('falls back to the completion date when the log never recorded the move', () => {
    expect(dueAt([])).toBe(true) // completed 2026-09-18, two whole days ago
    expect(dueForAutoArchive(makeTask({ status: 'done', completed: '' }), STATUSES, 2, NOW_T)).toBe(false)
  })

  it('never takes a case whose landing stamp is in the future', () => {
    expect(dueAt([moved('2026-09-25T09:00:00.000Z')])).toBe(false)
  })
})

describe('dueForAutoArchive — a completion date is the proof of closure', () => {
  const NOW_T = '2026-09-20T12:00:00.000Z'
  const moved = (at: string, to = 'done') => ({ at, field: 'status', from: 'in-progress', to })

  it('never archives a case with no completion date, however old the log entry is', () => {
    // The regression: moving the clock onto the activity log made the log
    // answer both "when did it land" and "was it ever really closed". A case
    // dragged to Done with its date cleared became archivable on a timer that
    // renames its file with no confirmation.
    const task = makeTask({ status: 'done', completed: '', activity: [moved('2026-01-01T09:00:00.000Z')] })
    expect(dueForAutoArchive(task, STATUSES, 2, NOW_T)).toBe(false)
  })

  it('still archives when both the date and the log are there', () => {
    const task = makeTask({
      status: 'done',
      completed: '2026-09-10',
      activity: [moved('2026-09-10T09:00:00.000Z')]
    })
    expect(dueForAutoArchive(task, STATUSES, 2, NOW_T)).toBe(true)
  })

  it('compares the fallback against the analyst’s own calendar, not UTC', () => {
    // `completed` is written from the local calendar. Slicing the UTC instant
    // put the two on different days for anyone west of UTC every evening.
    const task = makeTask({ status: 'done', completed: '2026-09-18' })
    const local = new Date('2026-09-20T12:00:00.000Z')
    const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
    // Whatever zone this runs in, the answer follows the local date.
    const age = Number(expected.slice(8)) - 18
    expect(dueForAutoArchive(task, STATUSES, 2, NOW_T)).toBe(age >= 2)
  })
})
