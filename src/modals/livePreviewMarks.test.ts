import { describe, expect, it } from 'vitest'
import { computeInlineMarks, fenceMap } from './livePreviewMarks'

describe('computeInlineMarks', () => {
  it('marks **bold** with both marker runs hidden', () => {
    expect(computeInlineMarks('a **bold** b')).toEqual([
      {
        from: 2,
        to: 10,
        cls: 'strong',
        markers: [
          [2, 4],
          [8, 10]
        ]
      }
    ])
  })

  it('marks *italic* with asterisks', () => {
    expect(computeInlineMarks('*it*')).toEqual([
      {
        from: 0,
        to: 4,
        cls: 'em',
        markers: [
          [0, 1],
          [3, 4]
        ]
      }
    ])
  })

  it('marks _italic_ with underscores', () => {
    expect(computeInlineMarks('say _hi_ now')).toEqual([
      {
        from: 4,
        to: 8,
        cls: 'em',
        markers: [
          [4, 5],
          [7, 8]
        ]
      }
    ])
  })

  it('never reads **x** as italic (even runs do not pair as em)', () => {
    const marks = computeInlineMarks('**x**')
    expect(marks).toHaveLength(1)
    expect(marks[0].cls).toBe('strong')
  })

  it('reads ***x*** as bold+italic sharing the range', () => {
    const marks = computeInlineMarks('***x***')
    expect(marks).toEqual([
      {
        from: 0,
        to: 7,
        cls: 'strong',
        markers: [
          [0, 2],
          [5, 7]
        ]
      },
      {
        from: 0,
        to: 7,
        cls: 'em',
        markers: [
          [2, 3],
          [4, 5]
        ]
      }
    ])
  })

  it('marks `code` spans', () => {
    expect(computeInlineMarks('x `y` z')).toEqual([
      {
        from: 2,
        to: 5,
        cls: 'code',
        markers: [
          [2, 3],
          [4, 5]
        ]
      }
    ])
  })

  it('pairs double-backtick runs by equal length', () => {
    const marks = computeInlineMarks('a ``co`de`` b')
    expect(marks).toEqual([
      {
        from: 2,
        to: 11,
        cls: 'code',
        markers: [
          [2, 4],
          [9, 11]
        ]
      }
    ])
  })

  it('lets inline code win over emphasis inside it', () => {
    const marks = computeInlineMarks('`*not em*`')
    expect(marks).toHaveLength(1)
    expect(marks[0].cls).toBe('code')
  })

  it('leaves unclosed markers raw', () => {
    expect(computeInlineMarks('**open')).toEqual([])
    expect(computeInlineMarks('*open')).toEqual([])
    expect(computeInlineMarks('`open')).toEqual([])
    expect(computeInlineMarks('open**')).toEqual([])
  })

  it('leaves whitespace-flanked asterisks raw (2 * 3 * 4)', () => {
    expect(computeInlineMarks('2 * 3 * 4')).toEqual([])
  })

  it('leaves intra-word underscores raw (snake_case_name)', () => {
    expect(computeInlineMarks('snake_case_name')).toEqual([])
  })

  it('leaves __x__ raw (bold is ** only, even _ runs never pair)', () => {
    expect(computeInlineMarks('__x__')).toEqual([])
  })

  it('leaves runs of four or more raw', () => {
    expect(computeInlineMarks('****x****')).toEqual([])
  })

  it('handles several ranges on one line in order', () => {
    const marks = computeInlineMarks('**a** and *b* and `c`')
    expect(marks.map((m) => m.cls)).toEqual(['strong', 'em', 'code'])
    expect(marks.map((m) => [m.from, m.to])).toEqual([
      [0, 5],
      [10, 13],
      [18, 21]
    ])
  })

  it('returns nothing for a plain line', () => {
    expect(computeInlineMarks('just words')).toEqual([])
  })
})

describe('fenceMap', () => {
  it('flags fence delimiters and the lines between them', () => {
    expect(fenceMap('a\n```\n**raw**\n```\n**b**')).toEqual([false, true, true, true, false])
  })

  it('supports tilde fences', () => {
    expect(fenceMap('~~~\nx\n~~~')).toEqual([true, true, true])
  })

  it('treats an unclosed fence as running to the end', () => {
    expect(fenceMap('```\na\nb')).toEqual([true, true, true])
  })

  it('does not close a backtick fence with tildes', () => {
    expect(fenceMap('```\n~~~\n```')).toEqual([true, true, true])
  })

  it('flags nothing without fences', () => {
    expect(fenceMap('a\nb')).toEqual([false, false])
  })
})
