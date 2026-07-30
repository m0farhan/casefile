import { describe, expect, it } from 'vitest'
import { makeTask, type SlaPolicy } from '../types'
import { defangIoc } from './ioc'
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
