import { describe, expect, it } from 'vitest'
import { DEFAULT_SEVERITIES, DEFAULT_STATUSES, makeTask } from '../../types'
import { compareTask } from './TableFilters'
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
