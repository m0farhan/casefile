import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, makeProject, makeTask, type SlaPolicy } from '../../types'
import { buildHandover } from '../../soc/handover'
import { lifecycleDurations, openedClosedPerWeek, slaCompliance, timeInStatus, verdictBreakdown } from './reportData'

const NOW = Date.parse('2026-07-30T12:00:00.000Z') // a Thursday, ISO week 2026-W31
const DAY = 86_400_000

describe('openedClosedPerWeek', () => {
  it('buckets createdAt and completed into ISO weeks, oldest first', () => {
    const tasks = [
      makeTask({ createdAt: '2026-07-29T08:00:00.000Z', completed: '2026-07-30' }), // this week, both
      makeTask({ createdAt: '2026-07-21T08:00:00.000Z' }), // last week, opened only
      makeTask({ createdAt: '2020-01-01T00:00:00.000Z' }) // outside the window — dropped
    ]
    const buckets = openedClosedPerWeek(tasks, 2, NOW)
    expect(buckets.map((b) => b.label)).toEqual(['2026-W30', '2026-W31'])
    expect(buckets[0]).toMatchObject({ opened: 1, closed: 0 })
    expect(buckets[1]).toMatchObject({ opened: 1, closed: 1 })
  })
})

describe('timeInStatus', () => {
  it('reconstructs per-status time from the activity log', () => {
    const t = makeTask({
      createdAt: new Date(NOW - 3 * DAY).toISOString(),
      status: 'in-progress',
      activity: [{ at: new Date(NOW - 1 * DAY).toISOString(), field: 'status', from: 'todo', to: 'in-progress' }]
    })
    const result = timeInStatus([t], NOW)
    const byId = new Map(result.map((r) => [r.statusId, r.totalMs]))
    expect(byId.get('todo')).toBe(2 * DAY)
    expect(byId.get('in-progress')).toBe(1 * DAY)
  })

  it('a task with no transitions contributes its lifetime to its current status', () => {
    const t = makeTask({ createdAt: new Date(NOW - 5 * DAY).toISOString(), status: 'todo' })
    expect(timeInStatus([t], NOW)).toEqual([{ statusId: 'todo', totalMs: 5 * DAY }])
  })

  it('stops the clock at resolvedAt', () => {
    const t = makeTask({
      createdAt: new Date(NOW - 4 * DAY).toISOString(),
      resolvedAt: new Date(NOW - 2 * DAY).toISOString(),
      status: 'done'
    })
    expect(timeInStatus([t], NOW)[0].totalMs).toBe(2 * DAY)
  })
})

describe('verdictBreakdown + slaCompliance', () => {
  const POLICIES: Record<string, SlaPolicy> = { sev1: { responseMins: 60, resolutionMins: 240 } }
  const incident = (over: Parameters<typeof makeTask>[0]) =>
    makeTask({ issueType: 'incident', severity: 'sev1', detectedAt: '2026-07-30T00:00:00.000Z', ...over })

  it('counts verdicts including unset', () => {
    const rows = verdictBreakdown([
      incident({ verdict: 'false-positive' }),
      incident({ verdict: 'false-positive' }),
      incident({})
    ])
    expect(rows).toEqual([
      { verdictId: 'false-positive', count: 2 },
      { verdictId: '', count: 1 }
    ])
  })

  it('splits met / breached / open / noData honestly', () => {
    const met = incident({ resolvedAt: '2026-07-30T03:00:00.000Z' }) // 3h < 4h target
    const breached = incident({ resolvedAt: '2026-07-30T09:00:00.000Z' }) // 9h > 4h
    const open = incident({})
    const noPolicy = makeTask({ issueType: 'incident', severity: 'sev9' })
    const rows = slaCompliance([met, breached, open, noPolicy], POLICIES, NOW)
    expect(rows).toEqual([
      { severityId: 'sev1', met: 1, breached: 1, noData: 0, open: 1 },
      { severityId: 'sev9', met: 0, breached: 0, noData: 1, open: 0 }
    ])
  })
})

describe('lifecycleDurations', () => {
  const HOUR = 3_600_000
  const inc = (over: Parameters<typeof makeTask>[0]) =>
    makeTask({ issueType: 'incident', severity: 'sev1', detectedAt: '2026-07-30T00:00:00.000Z', ...over })

  it('computes mean and median per phase over stamped incidents only', () => {
    const { overall } = lifecycleDurations([
      inc({ respondedAt: '2026-07-30T01:00:00.000Z', resolvedAt: '2026-07-30T04:00:00.000Z' }),
      inc({ respondedAt: '2026-07-30T03:00:00.000Z' }),
      inc({ respondedAt: '2026-07-30T08:00:00.000Z' }),
      inc({}) // no endpoints stamped — contributes nothing
    ])
    expect(overall.respond).toEqual({ n: 3, meanMs: 4 * HOUR, medianMs: 3 * HOUR })
    expect(overall.contain).toBeNull()
    expect(overall.resolve).toEqual({ n: 1, meanMs: 4 * HOUR, medianMs: 4 * HOUR })
  })

  it('even sample count → median is the midpoint of the two middle values', () => {
    const { overall } = lifecycleDurations([
      inc({ containedAt: '2026-07-30T01:00:00.000Z' }),
      inc({ containedAt: '2026-07-30T02:00:00.000Z' })
    ])
    expect(overall.contain).toEqual({ n: 2, meanMs: 1.5 * HOUR, medianMs: 1.5 * HOUR })
  })

  it('groups by severity, sorted, with a separate overall aggregate', () => {
    const { overall, bySeverity } = lifecycleDurations([
      inc({ severity: 'sev2', containedAt: '2026-07-30T06:00:00.000Z' }),
      inc({ containedAt: '2026-07-30T02:00:00.000Z' })
    ])
    expect(bySeverity.map((r) => r.severityId)).toEqual(['sev1', 'sev2'])
    expect(bySeverity[0].contain).toMatchObject({ n: 1, meanMs: 2 * HOUR })
    expect(bySeverity[1].contain).toMatchObject({ n: 1, meanMs: 6 * HOUR })
    expect(overall.contain).toMatchObject({ n: 2, meanMs: 4 * HOUR })
  })

  it('ignores endpoints before detectedAt and incidents without detectedAt', () => {
    const { overall, bySeverity } = lifecycleDurations([
      inc({ respondedAt: '2026-07-29T23:00:00.000Z' }), // before detection
      makeTask({ issueType: 'incident', respondedAt: '2026-07-30T01:00:00.000Z' }) // no detectedAt
    ])
    expect(overall).toEqual({ respond: null, contain: null, resolve: null })
    expect(bySeverity).toEqual([])
  })
})

describe('buildHandover', () => {
  it('is deterministic and structured for a fixed fixture and now', () => {
    const project = makeProject('SOC', 'Projects/SOC.md')
    const inc = makeTask({
      key: 'SOC-1',
      title: 'Beacon triage',
      issueType: 'incident',
      severity: 'sev1',
      status: 'in-progress',
      detectedAt: '2026-07-30T11:30:00.000Z',
      activity: [
        { at: '2026-07-30T11:40:00.000Z', field: 'status', from: 'todo', to: 'in-progress' },
        { at: '2026-07-20T00:00:00.000Z', field: 'priority', from: 'low', to: 'high' } // outside window
      ]
    })
    const blocked = makeTask({ key: 'SOC-2', title: 'Waiting on vendor', status: 'blocked', assignees: ['Farhan'] })
    project.tasks.push(inc, blocked)

    const md = buildHandover([project], DEFAULT_SETTINGS, '2026-07-30T12:00:00.000Z')

    expect(md).toContain('# Shift handover')
    expect(md).toContain('## Open incidents')
    expect(md).toContain('### SEV1')
    // sev1 policy: response 60m from 11:30 -> 30m left at 12:00
    expect(md).toContain('SOC-1 Beacon triage — in-progress · response target in 30m')
    expect(md).toContain('last: status → in-progress at 2026-07-30T11:40:00.000Z')
    expect(md).toContain('status: todo → in-progress (2026-07-30T11:40:00.000Z)')
    expect(md).not.toContain('priority: low') // outside the 12h window
    // 30m left of a 60m response target = under 25%? No — 50%, so not at risk.
    expect(md).toContain('## Response/resolution targets at risk\n\nNone.')
    expect(md).toContain('- SOC-2 Waiting on vendor · Farhan')

    // Deterministic: identical output on a second run.
    expect(buildHandover([project], DEFAULT_SETTINGS, '2026-07-30T12:00:00.000Z')).toBe(md)
  })
})
