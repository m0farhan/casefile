import { describe, expect, it } from 'vitest'
import { mapRawToTask } from './YamlHydrator'

describe('mapRawToTask numbers written as text', () => {
  // Read as absent, these were written back as progress: 0 and no estimate.
  it('keeps a progress or estimate typed as text, and guesses at nothing else', () => {
    const typed = mapRawToTask({ progress: '60%', timeEstimate: ' 1.5 ' })
    expect([typed.progress, typed.timeEstimate]).toEqual([60, 1.5])
    const odd = mapRawToTask({ progress: 'abc', timeEstimate: '30m' })
    expect([odd.progress, odd.timeEstimate]).toEqual([0, undefined])
  })
})
