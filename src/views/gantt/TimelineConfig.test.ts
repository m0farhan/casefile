import { describe, expect, it } from 'vitest'
import { today } from '../../dates'
import { makeTask, type GanttGranularity } from '../../types'
import { MAX_DAYS, buildTimelineConfig, outOfRange } from './TimelineConfig'

const GRANULARITIES: GanttGranularity[] = ['day', 'week', 'month', 'quarter']

// A mistyped year used to stretch the range to every stored date, so one due
// of 9999-12-31 made each render loop over about 2.9 million days.
describe('buildTimelineConfig range ceiling', () => {
  it.each(GRANULARITIES)('stays within MAX_DAYS for a year typo at %s granularity', (g) => {
    for (const due of ['9999-12-31', '2206-09-26', '0206-01-01']) {
      const cfg = buildTimelineConfig([makeTask({ start: '', due })], g)
      expect(cfg.totalDays).toBeLessThanOrEqual(MAX_DAYS[g])
    }
  })

  it.each(GRANULARITIES)('stays within MAX_DAYS for real dates near the edge of reach at %s granularity', (g) => {
    const now = today()
    const half = Math.floor(MAX_DAYS[g] / 2)
    for (let off = half - 40; off <= half; off++) {
      const task = makeTask({ start: now.subtract({ days: off }).toString(), due: now.add({ days: off }).toString() })
      expect(buildTimelineConfig([task], g).totalDays).toBeLessThanOrEqual(MAX_DAYS[g])
    }
  })

  it('still widens the range for dates within reach', () => {
    const due = today().add({ days: 200 })
    const cfg = buildTimelineConfig([makeTask({ start: '', due: due.toString() })], 'day')
    expect(outOfRange(cfg, due)).toBe(false)
  })

  it('draws a board of old cases whose whole span fits, however far from today', () => {
    const start = today().subtract({ days: 480 })
    const due = start.add({ days: 9 })
    const cfg = buildTimelineConfig([makeTask({ start: start.toString(), due: due.toString() })], 'day')
    expect(outOfRange(cfg, start)).toBe(false)
    expect(outOfRange(cfg, due)).toBe(false)
    expect(outOfRange(cfg, today())).toBe(false)
    expect(cfg.totalDays).toBeLessThanOrEqual(MAX_DAYS.day)
  })

  it('leaves a far date outside the range instead of stretching to it', () => {
    const cfg = buildTimelineConfig([makeTask({ start: '', due: '2206-09-26' })], 'day')
    expect(outOfRange(cfg, today())).toBe(false)
    expect(cfg.totalDays).toBeLessThan(100)
  })
})
