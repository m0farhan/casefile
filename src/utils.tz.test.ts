import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formatDateLong, formatDateShort, stringifyCustomValue } from './utils'

// Node re-reads TZ when it is assigned, so this file runs west of UTC
// whatever the machine's zone; restored after, in case the worker is reused.
beforeAll(() => {
  vi.stubEnv('TZ', 'America/New_York')
})
afterAll(() => {
  vi.unstubAllEnvs()
})

/** How the formatters' own options render a local calendar day, whatever the locale. */
const localDay = (y: number, m: number, d: number, year = false): string =>
  new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(year ? { year: '2-digit' as const } : {})
  })

describe('date formatters west of UTC', () => {
  it('runs in a zone behind UTC, so a UTC-midnight reading would show the day before', () => {
    expect(new Date('2026-09-26T00:00:00Z').getTimezoneOffset()).toBeGreaterThan(0)
  })

  it('show a date-only value (a due date) as that calendar day', () => {
    expect(formatDateShort('2026-09-26')).toBe(localDay(2026, 9, 26))
    expect(formatDateLong('2026-09-26')).toBe(localDay(2026, 9, 26, true))
  })

  it('still show a timestamp as the local date of that instant', () => {
    expect(formatDateLong('2026-09-26T14:00:00.000Z')).toBe(localDay(2026, 9, 26, true))
    // 02:00 UTC on the 27th is still the evening of the 26th in New York.
    expect(formatDateShort('2026-09-27T02:00:00Z')).toBe(localDay(2026, 9, 26))
  })
})

describe('stringifyCustomValue', () => {
  it('shows a number that is not a number (a cleared number field) as blank, not "NaN"', () => {
    expect(stringifyCustomValue(Number.NaN)).toBe('')
    expect(stringifyCustomValue(Number.POSITIVE_INFINITY)).toBe('')
    expect(stringifyCustomValue(0)).toBe('0')
    expect(stringifyCustomValue(2.5)).toBe('2.5')
  })
})
