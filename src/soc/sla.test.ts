import { describe, expect, it } from 'vitest'
import { makeTask, type SlaPolicy } from '../types'
import { defangIoc } from './ioc'
import { anchorDisclosure } from './LifecyclePanel'
import { formatSlaRemaining, slaAtRisk, slaState } from './sla'

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

describe('slaState', () => {
  it('has no result for a resolution stamped before the clock started', () => {
    expect(slaState(incident({ resolvedAt: '2026-07-30T07:00:00.000Z' }), POLICIES, T0)).toBeNull()
  })

  it('returns null for non-incidents, missing severity, and unknown policy', () => {
    expect(slaState(makeTask({ issueType: 'task', severity: 'sev1' }), POLICIES, T0)).toBeNull()
    expect(slaState(makeTask({ issueType: 'incident' }), POLICIES, T0)).toBeNull()
    expect(slaState(makeTask({ issueType: 'incident', severity: 'sev9' }), POLICIES, T0)).toBeNull()
  })

  it('runs the response clock until respondedAt', () => {
    const s = slaState(incident(), POLICIES, T0 + 30 * MIN)
    expect(s).toMatchObject({ phase: 'response', breached: false, done: false })
    expect(s?.remainingMs).toBe(30 * MIN)
  })

  it('breaches the response phase with overshoot', () => {
    const s = slaState(incident(), POLICIES, T0 + 90 * MIN)
    expect(s).toMatchObject({ phase: 'response', breached: true })
    expect(s?.remainingMs).toBe(-30 * MIN)
  })

  it('switches to the resolution clock once responded', () => {
    const s = slaState(incident({ respondedAt: '2026-07-30T08:20:00.000Z' }), POLICIES, T0 + 120 * MIN)
    expect(s).toMatchObject({ phase: 'resolution', breached: false, done: false })
    expect(s?.remainingMs).toBe(120 * MIN)
  })

  it('stops the clock at resolvedAt and judges the breach against that instant', () => {
    const onTime = slaState(
      incident({ respondedAt: '2026-07-30T08:20:00.000Z', resolvedAt: '2026-07-30T11:00:00.000Z' }),
      POLICIES,
      T0 + 9999 * MIN // now is irrelevant once done
    )
    expect(onTime).toMatchObject({ phase: 'resolution', breached: false, done: true })

    const late = slaState(incident({ resolvedAt: '2026-07-30T13:00:00.000Z' }), POLICIES, T0)
    expect(late).toMatchObject({ breached: true, done: true })
    expect(late?.remainingMs).toBe(-60 * MIN)
  })

  it('anchors at createdAt when detectedAt is unset', () => {
    const t = incident({ detectedAt: '', createdAt: '2026-07-30T09:00:00.000Z' })
    const s = slaState(t, POLICIES, Date.parse('2026-07-30T09:30:00.000Z'))
    expect(s?.remainingMs).toBe(30 * MIN)
  })

  it('runs no clock for a policy with a blank (0) target, instead of breaching at creation', () => {
    // A half-filled settings row saved the blank side as 0.
    const halfResponse = { sev1: { responseMins: 0, resolutionMins: 240 } }
    const halfResolution = { sev1: { responseMins: 30, resolutionMins: 0 } }
    expect(slaState(incident(), halfResponse, T0 + 1000)).toBeNull()
    expect(slaState(incident({ respondedAt: '2026-07-30T08:05:00.000Z' }), halfResolution, T0 + 6 * MIN)).toBeNull()
    expect(slaState(incident(), { sev1: { responseMins: -5, resolutionMins: 240 } }, T0)).toBeNull()
  })

  it('has no result for an unreadable resolvedAt, rather than calling it met', () => {
    for (const resolvedAt of ['unknown', '30/07/2026 09:00']) {
      expect(slaState(incident({ resolvedAt }), POLICIES, T0 + 9999 * MIN)).toBeNull()
    }
  })
})

describe('anchorDisclosure (lifecycle panel)', () => {
  it('says the clock runs from creation only when a clock and a creation time exist', () => {
    const t = (over: Parameters<typeof makeTask>[0]) => incident({ detectedAt: '', ...over })
    expect(anchorDisclosure(t({ createdAt: '2026-07-30T08:00:00.000Z' }), POLICIES)).toBe(
      'SLA runs from case creation — detection time not recorded'
    )
    expect(anchorDisclosure(t({ createdAt: '' }), POLICIES)).toBe(
      'SLA has no start — no readable detection or creation time'
    )
    expect(anchorDisclosure(incident(), POLICIES)).toBeNull()
    // A blank target is no clock, so there is nothing to disclose.
    expect(anchorDisclosure(t({}), { sev1: { responseMins: 0, resolutionMins: 240 } })).toBeNull()
  })
})

describe('slaAtRisk', () => {
  const policy = POLICIES.sev1
  it('amber under 25% remaining, not above, always when breached, never when done', () => {
    const mk = (remainingMs: number, breached = false, done = false) => ({
      phase: 'response' as const,
      deadline: 0,
      remainingMs,
      breached,
      done
    })
    expect(slaAtRisk(mk(16 * MIN), policy)).toBe(false) // >25% of 60m
    expect(slaAtRisk(mk(14 * MIN), policy)).toBe(true) // <25%
    expect(slaAtRisk(mk(-5 * MIN, true), policy)).toBe(true)
    expect(slaAtRisk(mk(-5 * MIN, true, true), policy)).toBe(false)
  })
})

describe('formatSlaRemaining', () => {
  it('formats hours, minutes and overshoot', () => {
    expect(formatSlaRemaining(125 * MIN)).toBe('2h 05m')
    expect(formatSlaRemaining(37 * MIN)).toBe('37m')
    expect(formatSlaRemaining(-72 * MIN)).toBe('+1h 12m')
    expect(formatSlaRemaining(0)).toBe('0m')
  })

  it('rolls into days past 24 hours, because nobody reads 476 hours', () => {
    expect(formatSlaRemaining(24 * 60 * MIN)).toBe('1d 0h')
    expect(formatSlaRemaining(25 * 60 * MIN + 30 * MIN)).toBe('1d 1h')
    // The live board case: a breached lab incident showing '+476h 46m'.
    expect(formatSlaRemaining(-(476 * 60 + 46) * MIN)).toBe('+19d 20h')
    // The boundary holds on the minute side: 23h 59m is still hours.
    expect(formatSlaRemaining((23 * 60 + 59) * MIN)).toBe('23h 59m')
  })
})

describe('defangIoc', () => {
  it('neutralizes urls, domains, emails; passes hashes through', () => {
    expect(defangIoc('http://evil.example.com/x', 'url')).toBe('hxxp://evil[.]example[.]com/x')
    expect(defangIoc('https://evil.example.com', 'url')).toBe('hxxps://evil[.]example[.]com')
    expect(defangIoc('evil.example.com', 'domain')).toBe('evil[.]example[.]com')
    expect(defangIoc('45.33.12.8', 'ip')).toBe('45[.]33[.]12[.]8')
    expect(defangIoc('bad@evil.com', 'email')).toBe('bad[at]evil[.]com')
    expect(defangIoc('d41d8cd98f00b204e9800998ecf8427e', 'hash')).toBe('d41d8cd98f00b204e9800998ecf8427e')
  })
})
