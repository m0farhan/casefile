import { describe, expect, it } from 'vitest'
import { pushRecent, RECENT_CASES_MAX, type RecentCase } from './recents'

const e = (n: number, path = 'Projects/Cases/A.md'): RecentCase => ({ path, id: `t${n}` })

describe('pushRecent', () => {
  it('prepends the newest entry', () => {
    expect(pushRecent([e(1)], e(2))).toEqual([e(2), e(1)])
  })

  it('dedups by path+id, moving the entry to the front', () => {
    expect(pushRecent([e(1), e(2)], e(2))).toEqual([e(2), e(1)])
  })

  it('treats the same task id in different projects as distinct', () => {
    const other = { path: 'Projects/Cases/B.md', id: 't1' }
    expect(pushRecent([e(1)], other)).toEqual([other, e(1)])
  })

  it('caps at the max, dropping the oldest', () => {
    let list: RecentCase[] = []
    for (let i = 0; i < RECENT_CASES_MAX + 3; i++) list = pushRecent(list, e(i))
    expect(list).toHaveLength(RECENT_CASES_MAX)
    expect(list[0]).toEqual(e(RECENT_CASES_MAX + 2))
    expect(list.at(-1)).toEqual(e(3))
  })

  it('does not mutate the input list', () => {
    const input = [e(1)]
    pushRecent(input, e(2))
    expect(input).toEqual([e(1)])
  })
})
