import { describe, expect, it } from 'vitest'
import { recurrenceLabel } from './KanbanCard'

describe('recurrenceLabel', () => {
  it('uses the plain adverb for every-1 intervals', () => {
    expect(recurrenceLabel({ interval: 'weekly', every: 1 })).toBe('Repeats weekly')
    expect(recurrenceLabel({ interval: 'daily', every: 1 })).toBe('Repeats daily')
  })

  it('spells out multi-unit intervals', () => {
    expect(recurrenceLabel({ interval: 'weekly', every: 2 })).toBe('Repeats every 2 weeks')
    expect(recurrenceLabel({ interval: 'monthly', every: 3 })).toBe('Repeats every 3 months')
  })
})
