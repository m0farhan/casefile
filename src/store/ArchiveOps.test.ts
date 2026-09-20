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
