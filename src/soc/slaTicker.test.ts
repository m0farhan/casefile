import { describe, expect, it } from 'vitest'
import { makeTask, type SlaPolicy } from '../types'
import { slaChipView } from './slaTicker'

const POLICIES: Record<string, SlaPolicy> = {
  sev1: { responseMins: 60, resolutionMins: 240 }
}

const T0 = Date.parse('2026-07-30T08:00:00.000Z')
const MIN = 60_000

function incident(overrides: Parameters<typeof makeTask>[0] = {}) {
  return makeTask({
    issueType: 'incident',
    severity: 'sev1',
    detectedAt: '2026-07-30T08:00:00.000Z',
    ...overrides
  })
}

describe('slaChipView', () => {
  it('renders nothing without a clock or when resolved on time', () => {
    expect(slaChipView(makeTask({ issueType: 'task' }), POLICIES, T0)).toBeNull()
    expect(slaChipView(incident({ resolvedAt: '2026-07-30T11:00:00.000Z' }), POLICIES, T0 + 500 * MIN)).toBeNull()
  })

  it('shows a live response countdown, amber when at risk', () => {
    expect(slaChipView(incident(), POLICIES, T0 + 23 * MIN)).toEqual({
      text: 'Respond 37m',
      warn: false,
      breach: false,
      live: true
    })
    expect(slaChipView(incident(), POLICIES, T0 + 50 * MIN)).toMatchObject({ text: 'Respond 10m', warn: true })
  })

  it('shows the resolution clock once responded, red with overshoot when breached', () => {
    const t = incident({ respondedAt: '2026-07-30T08:20:00.000Z' })
    expect(slaChipView(t, POLICIES, T0 + 115 * MIN)).toMatchObject({ text: 'Resolve 2h 05m', warn: false })
    expect(slaChipView(t, POLICIES, T0 + 312 * MIN)).toEqual({
      text: 'Resolve +1h 12m',
      warn: false,
      breach: true,
      live: true
    })
  })

  it('freezes a late resolution as a steady breach record (not live)', () => {
    const t = incident({ resolvedAt: '2026-07-30T14:05:00.000Z' })
    expect(slaChipView(t, POLICIES, T0 + 9999 * MIN)).toEqual({
      text: 'Breached +2h 05m',
      warn: false,
      breach: true,
      live: false
    })
  })
})
