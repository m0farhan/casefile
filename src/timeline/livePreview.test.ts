import { EditorSelection, EditorState, StateEffect, type Extension, type TransactionSpec } from '@codemirror/state'
import { EditorView, type DecorationSet, type ViewUpdate, type WidgetType } from '@codemirror/view'
import { editorLivePreviewField } from 'obsidian'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent } from '../../test/fakeDom'
import { CLS } from './dom'
import {
  buildTimelineDecorations,
  noteTimelineExtension,
  NoteTimelinePlugin,
  readTimelines,
  type NoteTimelineCallbacks
} from './livePreview'

// Obsidian's Live Preview flag, as a real field, so source mode can be tested;
// a state built without it reads as Live Preview, as in any other test.
vi.mock('obsidian', async (importOriginal) => {
  const { StateField } = await import('@codemirror/state')
  return {
    ...(await importOriginal<object>()),
    editorLivePreviewField: StateField.define<boolean>({ create: () => true, update: (v) => v })
  }
})

// Widgets build their DOM with Obsidian's global helpers; FakeEl stands in.
beforeAll(() => {
  type Info = ConstructorParameters<typeof FakeEl>[1]
  vi.stubGlobal('createDiv', (o?: Info) => new FakeEl('div', o))
  vi.stubGlobal('createSpan', (o?: Info) => new FakeEl('span', o))
})
afterAll(() => vi.unstubAllGlobals())

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

const callbacks = (): NoteTimelineCallbacks => ({
  onKindClick: vi.fn<NoteTimelineCallbacks['onKindClick']>(),
  onAddEvent: vi.fn<NoteTimelineCallbacks['onAddEvent']>(),
  onHeaderMenu: vi.fn<NoteTimelineCallbacks['onHeaderMenu']>(),
  onDefang: vi.fn<NoteTimelineCallbacks['onDefang']>()
})

/** A position by 0-based line and column. */
const pos = (state: EditorState, line: number, ch = 0): number => state.doc.line(line + 1).from + ch

function stateOf(lines: string[], anchor: [number, number] = [0, 0], head = anchor, extensions: Extension = []) {
  const blank = EditorState.create({ doc: lines.join('\n') })
  const selection = EditorSelection.single(pos(blank, ...anchor), pos(blank, ...head))
  return EditorState.create({ doc: lines.join('\n'), selection, extensions })
}

function build(state: EditorState, cb = callbacks(), visible = [{ from: 0, to: state.doc.length }]) {
  return buildTimelineDecorations(state, readTimelines(state.doc), visible, cb)
}

interface Seen {
  line: number
  ch: number
  to: number
  cls?: string
  widget?: WidgetType & { toDOM(view: EditorView): HTMLElement }
  side?: number
}

function seen(state: EditorState, set: DecorationSet): Seen[] {
  const out: Seen[] = []
  set.between(0, state.doc.length, (from, to, d) => {
    const spec = d.spec as { class?: string; widget?: Seen['widget']; side?: number }
    const line = state.doc.lineAt(from)
    out.push({ line: line.number - 1, ch: from - line.from, to: to - line.from, cls: spec.class, ...spec })
  })
  return out
}

/** The classes on each decorated line, by 0-based line. */
function lineClasses(state: EditorState, set: DecorationSet): Map<number, string[]> {
  const map = new Map<number, string[]>()
  for (const s of seen(state, set)) {
    if (s.widget || s.to !== s.ch || !s.cls) continue
    map.set(s.line, [...(map.get(s.line) ?? []), ...s.cls.split(' ')])
  }
  return map
}

/** Every mark as the text it covers and its class. */
function marks(state: EditorState, set: DecorationSet): { line: number; text: string; cls: string }[] {
  return seen(state, set)
    .filter((s) => !s.widget && s.to > s.ch && s.cls)
    .map((s) => ({ line: s.line, text: state.doc.line(s.line + 1).text.slice(s.ch, s.to), cls: s.cls ?? '' }))
}

const widgets = (state: EditorState, set: DecorationSet) =>
  seen(state, set)
    .filter((s) => s.widget)
    .map((s) => ({ line: s.line, ch: s.ch, to: s.to, name: s.widget?.constructor.name, side: s.side }))

const activeLines = (state: EditorState): number[] =>
  [...lineClasses(state, build(state).decorations)].filter(([, c]) => c.includes(CLS.active)).map(([l]) => l)

describe('noteTimelineExtension: the ClickFix sample', () => {
  const state = stateOf(CLICKFIX)
  const { decorations } = build(state)
  const lines = lineClasses(state, decorations)

  it('leaves the heading alone and marks the marker line', () => {
    expect(lines.has(0)).toBe(false)
    expect(lines.get(1)).toEqual([CLS.line, CLS.markerLine])
  })

  it('makes each event a card: its bullet line on top, its details below, coloured by kind', () => {
    expect(lines.get(2)).toEqual(
      expect.arrayContaining([CLS.line, CLS.ev, CLS.cardTop, CLS.cardBottom, CLS.first, 'cf-ntl-k-observed'])
    )
    expect(lines.get(3)).toEqual(expect.arrayContaining([CLS.line, CLS.ev, CLS.cardTop, CLS.gap, 'cf-ntl-k-web']))
    expect(lines.get(3)).not.toContain(CLS.cardBottom)
    expect(lines.get(4)).toEqual(expect.arrayContaining([CLS.line, CLS.detail, CLS.cardBottom, 'cf-ntl-k-web']))
    expect(lines.get(4)).not.toContain(CLS.ev)
    expect(lines.get(5)).toEqual(expect.arrayContaining([CLS.ev, CLS.explicit, CLS.gap, 'cf-ntl-k-execution']))
    expect(lines.get(6)).toEqual(expect.arrayContaining([CLS.ev, CLS.cardTop, CLS.explicit, 'cf-ntl-k-file']))
    expect(lines.get(7)).toEqual(
      expect.arrayContaining([CLS.detail, CLS.source, CLS.cardBottom, CLS.explicit, 'cf-ntl-k-file'])
    )
    // 11:06:15 to 11:31 is a long gap.
    expect(lines.get(8)).toEqual(expect.arrayContaining([CLS.ev, CLS.gapLong, 'cf-ntl-k-detection']))
    expect(lines.get(8)).not.toContain(CLS.gap)
    // No time, so no gap above it; the last card closes the rail.
    expect(lines.get(9)).toEqual(
      expect.arrayContaining([CLS.ev, CLS.cardTop, CLS.cardBottom, CLS.last, CLS.explicit, 'cf-ntl-k-response'])
    )
    expect(lines.get(9)).not.toEqual(expect.arrayContaining([CLS.gap]))
    // Only the first and last cards carry those ends.
    expect([...lines].filter(([, c]) => c.includes(CLS.first)).map(([l]) => l)).toEqual([2])
    expect([...lines].filter(([, c]) => c.includes(CLS.last)).map(([l]) => l)).toEqual([9])
  })

  it('marks the lead word, the time and its seconds, the kind word and its colon', () => {
    const m = marks(state, decorations)
    expect(m).toEqual(
      expect.arrayContaining([
        { line: 2, text: 'On', cls: CLS.lead },
        { line: 3, text: 'At', cls: CLS.lead },
        { line: 3, text: '11:05:40', cls: CLS.time },
        { line: 3, text: ':40', cls: CLS.sec },
        { line: 3, text: ',', cls: CLS.lead },
        { line: 5, text: 'Execution', cls: CLS.tag },
        { line: 5, text: ':', cls: CLS.colon },
        { line: 5, text: 'T1204.004', cls: CLS.att },
        { line: 6, text: 'Download', cls: CLS.tag },
        { line: 9, text: 'Response', cls: CLS.tag }
      ])
    )
    expect(m.find((x) => x.line === 2 && x.cls === CLS.time)?.text).toMatch(/^3 May 2025, 11:04/)
  })

  it('marks indicators as chips, the defanged ones not live', () => {
    const iocs = marks(state, decorations).filter((x) => x.cls.split(' ').includes(CLS.ioc))
    expect(iocs.map((x) => x.text)).toEqual(expect.arrayContaining(['promptcraft[.]online']))
    expect(iocs.find((x) => x.line === 3)?.text).toMatch(/^hxxps:\/\/eemmbryequo\[\.\]shop/)
    expect(iocs.some((x) => x.cls.includes(CLS.iocLive))).toBe(false)
  })

  it('replaces the marker text with the header and puts each widget where the card needs it', () => {
    const w = widgets(state, decorations)
    expect(w).toContainEqual({ line: 1, ch: 0, to: CLICKFIX[1].length, name: 'HeaderWidget', side: undefined })
    // A node at the text start of every event, before the caret.
    expect(w.filter((x) => x.name === 'NodeWidget')).toEqual(
      [2, 3, 5, 6, 8, 9].map((line) => ({ line, ch: 2, to: 2, name: 'NodeWidget', side: -1 }))
    )
    // A band above every timed event after the first; none above the untimed one.
    expect(w.filter((x) => x.name === 'BandWidget').map((x) => x.line)).toEqual([3, 5, 6, 8])
    expect(w.filter((x) => x.name === 'UntimedWidget')).toEqual([
      { line: 9, ch: 2, to: 2, name: 'UntimedWidget', side: -1 }
    ])
    // The Source footer's icon, at its text start.
    expect(w).toContainEqual({ line: 7, ch: 6, to: 6, name: 'IconWidget', side: -1 })
    expect(w.filter((x) => x.name === 'AddWidget')).toEqual([
      { line: 9, ch: CLICKFIX[9].length, to: CLICKFIX[9].length, name: 'AddWidget', side: 1 }
    ])
    expect(w.some((x) => x.name === 'GhostWidget')).toBe(false)
  })

  it('makes the marker text, and only it, an atomic range', () => {
    const { atomic } = build(state)
    expect(seen(state, atomic).map((s) => [s.line, s.ch, s.to])).toEqual([[1, 0, CLICKFIX[1].length]])
  })
})

describe('noteTimelineExtension: the active card', () => {
  it('follows the caret onto every line of its event, details included', () => {
    expect(activeLines(stateOf(CLICKFIX, [4, 8]))).toEqual([3, 4])
    expect(activeLines(stateOf(CLICKFIX, [3, 0]))).toEqual([3, 4])
    expect(activeLines(stateOf(CLICKFIX, [9, 5]))).toEqual([9])
  })

  it('covers every event a selection touches, and none from the marker or outside the list', () => {
    expect(activeLines(stateOf(CLICKFIX, [5, 3], [6, 3]))).toEqual([5, 6, 7])
    expect(activeLines(stateOf(CLICKFIX, [1, 0]))).toEqual([])
    expect(activeLines(stateOf(CLICKFIX, [0, 3]))).toEqual([])
  })

  it('keeps a blank line inside the list on the card above, as the menu reads it', () => {
    const state = stateOf(['%% timeline %%', '- 11:04 a', '', '- 11:05 b'], [2, 0])
    const lines = lineClasses(state, build(state).decorations)
    expect(lines.get(1)).not.toContain(CLS.cardBottom)
    expect(lines.get(2)).toEqual(expect.arrayContaining([CLS.detail, CLS.cardBottom, CLS.active]))
    expect(lines.get(3)).not.toContain(CLS.active)
  })
})

describe('noteTimelineExtension: what it reads off the text', () => {
  it('underlines a live indicator and dashes an approximate time', () => {
    const state = stateOf(['%% timeline %%', '- Around 11:07 fetched https://promptcraft.online/a.ps1'])
    const m = marks(state, build(state).decorations)
    expect(m).toContainEqual({ line: 1, text: '11:07', cls: `${CLS.time} ${CLS.approx}` })
    const ioc = m.find((x) => x.cls.split(' ').includes(CLS.ioc))
    expect(ioc?.text).toBe('https://promptcraft.online/a.ps1')
    expect(ioc?.cls.split(' ')).toContain(CLS.iocLive)
  })

  it('chips indicators on detail lines too, since the header counts them', () => {
    const state = stateOf(['%% timeline %%', '- 11:04 a', '    - seen at https://evil.example/x (T1059)'])
    const m = marks(state, build(state).decorations).filter((x) => x.line === 2)
    expect(m.find((x) => x.cls.includes(CLS.iocLive))?.text).toBe('https://evil.example/x')
    expect(m).toContainEqual({ line: 2, text: 'T1059', cls: CLS.att })
  })

  it('shows the ghost hint on an empty event, without a "time not recorded" chip', () => {
    const state = stateOf(['%% timeline %%', '- 11:04 a', '- '])
    const w = widgets(state, build(state).decorations)
    expect(w).toContainEqual({ line: 2, ch: 2, to: 2, name: 'GhostWidget', side: 1 })
    expect(w.some((x) => x.name === 'UntimedWidget')).toBe(false)
    expect(w.filter((x) => x.name === 'NodeWidget').map((x) => x.line)).toEqual([1, 2])
  })

  it('draws a day band where the date changes', () => {
    const state = stateOf(['%% timeline %%', '- On 3 May 2025, 23:50 a', '- On 4 May 2025, 00:10 b'])
    expect(lineClasses(state, build(state).decorations).get(2)).toContain(CLS.day)
  })

  it('draws the header alone for a marker with no list under it', () => {
    const state = stateOf(['%% timeline %%', 'Just prose.'])
    const { decorations } = build(state)
    expect(widgets(state, decorations).map((w) => w.name)).toEqual(['HeaderWidget'])
    expect([...lineClasses(state, decorations).keys()]).toEqual([0])
  })

  it('does nothing in a note without the marker, or with it only inside a code block', () => {
    expect(readTimelines(stateOf(['- 11:04 a', '- 11:05 b']).doc)).toEqual([])
    const fenced = stateOf(['```', '%% timeline %%', '- 11:04 a', '```'])
    expect(build(fenced).decorations.size).toBe(0)
    expect(build(fenced).atomic.size).toBe(0)
  })

  it('draws only the timelines in view, but keeps every marker atomic', () => {
    const lines = ['%% timeline %%', '- 11:04 a', ...Array<string>(20).fill('prose'), '%% timeline %%', '- 11:05 b']
    const state = stateOf(lines)
    const { decorations, atomic } = build(state, callbacks(), [{ from: 0, to: pos(state, 3) }])
    expect([...lineClasses(state, decorations).keys()]).toEqual([0, 1])
    expect(seen(state, atomic).map((s) => s.line)).toEqual([0, 22])
  })
})

describe('noteTimelineExtension: widgets', () => {
  const view = {} as EditorView
  const widgetOf = (state: EditorState, cb: NoteTimelineCallbacks, name: string, line: number) => {
    const found = seen(state, build(state, cb).decorations).find(
      (s) => s.widget?.constructor.name === name && s.line === line
    )
    if (!found?.widget) throw new Error(`no ${name} on line ${line}`)
    return found.widget
  }
  const dom = (w: Seen['widget'] & object) => w.toDOM(view) as unknown as FakeEl

  it('opens the kind picker from the node, without moving the caret', () => {
    const cb = callbacks()
    const node = dom(widgetOf(stateOf(CLICKFIX), cb, 'NodeWidget', 5))
    expect(node.getAttribute('role')).toBe('button')
    expect(node.getAttribute('tabindex')).toBe('0')
    const down = fakeEvent('mousedown')
    node.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    const click = fakeEvent('click')
    node.dispatchEvent(click)
    expect(cb.onKindClick).toHaveBeenCalledExactlyOnceWith(view, 5, click)
  })

  it('opens the kind picker from the node by keyboard too', () => {
    vi.stubGlobal(
      'MouseEvent',
      class {
        constructor(
          readonly type: string,
          init: object
        ) {
          Object.assign(this, init)
        }
      }
    )
    const cb = callbacks()
    const node = dom(widgetOf(stateOf(CLICKFIX), cb, 'NodeWidget', 2))
    const key = fakeEvent('keydown', { key: 'Enter' })
    node.dispatchEvent(key)
    expect(key.defaultPrevented).toBe(true)
    expect(cb.onKindClick).toHaveBeenCalledOnce()
    expect(vi.mocked(cb.onKindClick).mock.calls[0].slice(0, 2)).toEqual([view, 2])
  })

  it('wires the header menu and Defang to the marker line', () => {
    const cb = callbacks()
    const state = stateOf(['Intro', '%% timeline %%', '- 11:04 fetched https://promptcraft.online/a.ps1'])
    const header = dom(widgetOf(state, cb, 'HeaderWidget', 1))
    const click = fakeEvent('click')
    header.find(`.${CLS.menu}`).dispatchEvent(click)
    expect(cb.onHeaderMenu).toHaveBeenCalledExactlyOnceWith(view, 1, click)
    header.find(`.${CLS.defang}`).click()
    expect(cb.onDefang).toHaveBeenCalledExactlyOnceWith(view, 1)
    const down = fakeEvent('mousedown')
    header.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
  })

  it('adds an event from the row under the last card, and gives the editor focus so typing goes into it', () => {
    for (const press of [
      (row: FakeEl) => row.click(),
      (row: FakeEl) => row.dispatchEvent(fakeEvent('keydown', { key: 'Enter' }))
    ]) {
      const cb = callbacks()
      const focus = vi.fn<() => void>()
      const focusable = { focus } as unknown as EditorView
      press(widgetOf(stateOf(CLICKFIX), cb, 'AddWidget', 9).toDOM(focusable) as unknown as FakeEl)
      expect(cb.onAddEvent).toHaveBeenCalledExactlyOnceWith(focusable, 1)
      // After the edit, which put the caret on the new bullet.
      expect(focus).toHaveBeenCalledOnce()
      expect(focus.mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(cb.onAddEvent).mock.invocationCallOrder[0])
    }
  })

  it('moves the caret onto a right-clicked node or add row, so the menu is built for what was clicked', () => {
    // The caret sits in the Detection event; Obsidian builds its menu at the caret.
    const state = stateOf(CLICKFIX, [8, 3])
    for (const [name, line, at] of [
      ['NodeWidget', 5, pos(state, 5, 2)],
      ['AddWidget', 9, pos(state, 9, CLICKFIX[9].length)]
    ] as const) {
      const dispatch = vi.fn<(spec: TransactionSpec) => void>()
      const posAtDOM = vi.fn<(el: unknown) => number>(() => at)
      const right = { dispatch, posAtDOM } as unknown as EditorView
      const el = widgetOf(state, callbacks(), name, line).toDOM(right) as unknown as FakeEl
      el.dispatchEvent(fakeEvent('contextmenu'))
      expect(posAtDOM).toHaveBeenCalledWith(el)
      expect(dispatch).toHaveBeenCalledExactlyOnceWith({ selection: { anchor: at } })
    }
  })

  it("opens the header's own menu on a right-click, and leaves the caret off the marker", () => {
    // Obsidian's editor menu, built at the caret, has Insert items that write
    // there: on the marker, they would join it and end the timeline.
    const state = stateOf(CLICKFIX, [8, 3])
    const cb = callbacks()
    const dispatch = vi.fn<(spec: TransactionSpec) => void>()
    const right = { dispatch, posAtDOM: () => pos(state, 1) } as unknown as EditorView
    const header = widgetOf(state, cb, 'HeaderWidget', 1).toDOM(right) as unknown as FakeEl
    const menu = fakeEvent('contextmenu')
    header.dispatchEvent(menu)
    expect(cb.onHeaderMenu).toHaveBeenCalledExactlyOnceWith(right, 1, menu)
    // Obsidian's editor menu leaves a handled right-click alone.
    expect(menu.defaultPrevented).toBe(true)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("moves the caret onto a right-clicked band, chip, icon or ghost, which the browser's own right-click does not", () => {
    // Display only, they let a left click through to the editor; a right-click
    // on one leaves the caret where it was, maybe in another event.
    const lines = ['%% timeline %%', '- 11:04 a', '- 11:05 b', '    - Source: EDR process tree', '- ']
    const state = stateOf(lines, [1, 3])
    for (const [name, line, at] of [
      ['BandWidget', 2, pos(state, 2, 2)],
      ['IconWidget', 3, pos(state, 3, 6)],
      ['GhostWidget', 4, pos(state, 4, 2)]
    ] as const) {
      const dispatch = vi.fn<(spec: TransactionSpec) => void>()
      const posAtDOM = vi.fn<(el: unknown) => number>(() => at)
      const right = { dispatch, posAtDOM } as unknown as EditorView
      const el = widgetOf(state, callbacks(), name, line).toDOM(right) as unknown as FakeEl
      el.dispatchEvent(fakeEvent('contextmenu'))
      expect(posAtDOM).toHaveBeenCalledWith(el)
      expect(dispatch).toHaveBeenCalledExactlyOnceWith({ selection: { anchor: at } })
    }
    const untimed = stateOf(CLICKFIX, [2, 3])
    const dispatch = vi.fn<(spec: TransactionSpec) => void>()
    const right = { dispatch, posAtDOM: () => pos(untimed, 9, 2) } as unknown as EditorView
    ;(widgetOf(untimed, callbacks(), 'UntimedWidget', 9).toDOM(right) as unknown as FakeEl).dispatchEvent(
      fakeEvent('contextmenu')
    )
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ selection: { anchor: pos(untimed, 9, 2) } })
  })

  it('lets clicks on display-only widgets through to the editor, and keeps them for the controls', () => {
    const state = stateOf(CLICKFIX)
    const cb = callbacks()
    const click = new Event('mousedown')
    for (const [name, line] of [
      ['BandWidget', 3],
      ['UntimedWidget', 9],
      ['IconWidget', 7]
    ] as const) {
      expect(widgetOf(state, cb, name, line).ignoreEvent(click)).toBe(false)
    }
    for (const [name, line] of [
      ['NodeWidget', 2],
      ['HeaderWidget', 1],
      ['AddWidget', 9]
    ] as const) {
      expect(widgetOf(state, cb, name, line).ignoreEvent(click)).toBe(true)
    }
  })

  it('keeps its widgets across a keystroke in the text, and rebuilds the node when the kind changes', () => {
    const cb = callbacks()
    const before = stateOf(CLICKFIX, [5, 40])
    const typed = before.update({ changes: { from: pos(before, 5, 40), insert: 'x' } }).state
    for (const [name, line] of [
      ['NodeWidget', 5],
      ['BandWidget', 5],
      ['HeaderWidget', 1],
      ['AddWidget', 9]
    ] as const) {
      expect(widgetOf(typed, cb, name, line).eq(widgetOf(before, cb, name, line))).toBe(true)
    }
    const kind = before.update({ changes: { from: pos(before, 5, 15), to: pos(before, 5, 26), insert: '' } }).state
    expect(widgetOf(kind, cb, 'NodeWidget', 5).eq(widgetOf(before, cb, 'NodeWidget', 5))).toBe(false)
  })
})

describe('NoteTimelinePlugin', () => {
  const fakeView = (state: EditorState, inDescription = false, posAtDOM = () => 0) =>
    ({
      state,
      visibleRanges: [{ from: 0, to: state.doc.length }],
      dom: { closest: (sel: string) => (inDescription && sel === '.pm-modal-description' ? {} : null) },
      posAtDOM,
      // Nothing folded: every line is a visual line of its own.
      lineBlockAt: (at: number) => state.doc.lineAt(at)
    }) as unknown as EditorView

  it('draws in a note editor in Live Preview', () => {
    const plugin = new NoteTimelinePlugin(fakeView(stateOf(CLICKFIX)), callbacks())
    expect(plugin.decorations.size).toBeGreaterThan(0)
    expect(plugin.atomic.size).toBe(1)
  })

  it("stays out of the plugin's own description editor", () => {
    const plugin = new NoteTimelinePlugin(fakeView(stateOf(CLICKFIX), true), callbacks())
    expect(plugin.decorations.size).toBe(0)
    expect(plugin.atomic.size).toBe(0)
  })

  it('stays out of source mode, and redraws when Live Preview comes back', () => {
    const source = stateOf(
      CLICKFIX,
      [0, 0],
      [0, 0],
      editorLivePreviewField.init(() => false)
    )
    const plugin = new NoteTimelinePlugin(fakeView(source), callbacks())
    expect(plugin.decorations.size).toBe(0)
    const live = stateOf(
      CLICKFIX,
      [0, 0],
      [0, 0],
      editorLivePreviewField.init(() => true)
    )
    plugin.update({ startState: source, state: live, view: fakeView(live), transactions: [] } as unknown as ViewUpdate)
    expect(plugin.decorations.size).toBeGreaterThan(0)
    plugin.update({
      startState: live,
      state: source,
      view: fakeView(source),
      transactions: []
    } as unknown as ViewUpdate)
    expect(plugin.decorations.size).toBe(0)
  })

  it('moves the active card when the selection moves', () => {
    const a = stateOf(CLICKFIX, [2, 3])
    const plugin = new NoteTimelinePlugin(fakeView(a), callbacks())
    const b = stateOf(CLICKFIX, [8, 3])
    plugin.update({
      selectionSet: true,
      startState: a,
      state: b,
      view: fakeView(b),
      transactions: []
    } as unknown as ViewUpdate)
    const active = [...lineClasses(b, plugin.decorations)].filter(([, c]) => c.includes(CLS.active))
    expect(active.map(([l]) => l)).toEqual([8])
  })

  it('opens the kind picker from a click on the kind word, and leaves other clicks to the editor', () => {
    const state = stateOf(CLICKFIX)
    const cb = callbacks()
    const view = fakeView(state, false, () => pos(state, 6, 16))
    const plugin = new NoteTimelinePlugin(view, cb)
    const tag = new FakeEl('span', { cls: CLS.tag })
    const word = tag.createSpan({ text: 'Download' })
    const mouse = (type: string, target: FakeEl, button = 0) =>
      fakeEvent(type, { target, button }) as unknown as MouseEvent
    // The press is claimed, so the caret stays; the menu opens on the click.
    // Opened on the press, Obsidian's menu would take the click that follows
    // for a click outside it and close at once.
    expect(plugin.mousedown(mouse('mousedown', word))).toBe(true)
    expect(cb.onKindClick).not.toHaveBeenCalled()
    const click = mouse('click', word)
    expect(plugin.click(click, view)).toBe(true)
    expect(cb.onKindClick).toHaveBeenCalledExactlyOnceWith(view, 6, click)
    const prose = new FakeEl('span')
    expect(plugin.mousedown(mouse('mousedown', prose))).toBe(false)
    expect(plugin.click(mouse('click', prose), view)).toBe(false)
    expect(plugin.mousedown(mouse('mousedown', word, 2))).toBe(false)
    expect(plugin.click(mouse('auxclick', word, 1), view)).toBe(false)
    expect(cb.onKindClick).toHaveBeenCalledOnce()
  })

  it('puts text typed at either edge of the marker on a line above it, so the marker stays whole', () => {
    const lines = ['Intro', '%% timeline %%', '- 11:04 a']
    const state = stateOf(lines)
    const plugin = new NoteTimelinePlugin(fakeView(state), callbacks())
    for (const ch of [0, lines[1].length]) {
      const dispatch = vi.fn<(spec: TransactionSpec) => void>()
      const view = { state, dispatch } as unknown as EditorView
      expect(plugin.typed(view, pos(state, 1, ch), pos(state, 1, ch), 'x')).toBe(true)
      const next = state.update(dispatch.mock.calls[0][0]).state
      expect(next.doc.toString()).toBe(['Intro', 'x', ...lines.slice(1)].join('\n'))
      expect(next.selection.main.head).toBe(pos(state, 1, 1))
      expect(readTimelines(next.doc)).toHaveLength(1)
    }
    // Typing anywhere else, or in source mode, is the editor's.
    const view = { state, dispatch: vi.fn<(spec: TransactionSpec) => void>() } as unknown as EditorView
    expect(plugin.typed(view, pos(state, 0, 5), pos(state, 0, 5), 'x')).toBe(false)
    expect(plugin.typed(view, pos(state, 2), pos(state, 2), 'x')).toBe(false)
    // A deletion read off the DOM (Android's backspace) comes as empty text: not typing.
    expect(plugin.typed(view, pos(state, 1, 13), pos(state, 1, 14), '')).toBe(false)
    const source = stateOf(
      lines,
      [1, 0],
      [1, 0],
      editorLivePreviewField.init(() => false)
    )
    expect(new NoteTimelinePlugin(fakeView(source), callbacks()).typed(view, pos(state, 1), pos(state, 1), 'x')).toBe(
      false
    )
  })

  it("leaves an IME's text to the editor while it composes there", () => {
    // Moving text the IME is still composing would split it from the IME's
    // own node: the next update writes it again. Obsidian's input handlers
    // leave composition alone too.
    const state = stateOf(['%% timeline %%', '- 11:04 a'])
    const plugin = new NoteTimelinePlugin(fakeView(state), callbacks())
    const dispatch = vi.fn<(spec: TransactionSpec) => void>()
    const view = { state, dispatch, compositionStarted: true } as unknown as EditorView
    expect(plugin.typed(view, 0, 0, 'に')).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('opens a line above the marker for a paste at either edge of it, so the paste lands there', () => {
    const lines = ['Intro', '%% timeline %%', '- 11:04 a']
    for (const ch of [0, lines[1].length]) {
      const state = stateOf(lines, [1, ch])
      const plugin = new NoteTimelinePlugin(fakeView(state), callbacks())
      const dispatch = vi.fn<(spec: TransactionSpec) => void>()
      // The editor pastes after this handler, at the caret it leaves.
      expect(plugin.paste({ state, dispatch } as unknown as EditorView)).toBe(false)
      const opened = state.update(dispatch.mock.calls[0][0]).state
      const pasted = opened.update(opened.replaceSelection('https://evil.example/x')).state
      expect(pasted.doc.toString()).toBe(['Intro', 'https://evil.example/x', ...lines.slice(1)].join('\n'))
      expect(readTimelines(pasted.doc)).toHaveLength(1)
    }
    // A paste anywhere else is the editor's alone.
    for (const at of [
      [0, 5],
      [2, 0]
    ] as [number, number][]) {
      const state = stateOf(lines, at)
      const dispatch = vi.fn<(spec: TransactionSpec) => void>()
      expect(
        new NoteTimelinePlugin(fakeView(state), callbacks()).paste({ state, dispatch } as unknown as EditorView)
      ).toBe(false)
      expect(dispatch).not.toHaveBeenCalled()
    }
  })

  it('hands the editor its input guard through the extension', () => {
    const lines = ['%% timeline %%', '- 11:04 a']
    const state = EditorState.create({ doc: lines.join('\n'), extensions: noteTimelineExtension(callbacks()) })
    const plugin = new NoteTimelinePlugin(fakeView(state), callbacks())
    const dispatch = vi.fn<(spec: TransactionSpec) => void>()
    const view = { state, dispatch, plugin: () => plugin } as unknown as EditorView
    const handlers = state.facet(EditorView.inputHandler)
    expect(handlers.some((h) => h(view, 0, 0, 'x', () => state.update({})))).toBe(true)
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('closes a card on its last line drawn when Obsidian folds its details into the bullet line', () => {
    const lines = ['%% timeline %%', '- 11:04 a', '    - seen first', '- 11:05 b', '    - Source: EDR process tree']
    const state = stateOf(lines)
    // A fold joins a bullet line and its details into one visual line, which
    // carries the bullet line's classes; the classes of the lines under the
    // fold are never drawn.
    const folded =
      (...bullets: number[]) =>
      (at: number) => {
        const n = state.doc.lineAt(at).number - 1
        return pos(state, bullets.includes(n - 1) ? n - 1 : n)
      }
    const drawn = (lineStart: (at: number) => number) =>
      lineClasses(
        state,
        buildTimelineDecorations(
          state,
          readTimelines(state.doc),
          [{ from: 0, to: state.doc.length }],
          callbacks(),
          lineStart
        ).decorations
      )
    const last = drawn(folded(3))
    expect(last.get(3)).toEqual(expect.arrayContaining([CLS.cardTop, CLS.cardBottom, CLS.last]))
    expect(last.get(1)).not.toContain(CLS.cardBottom)
    const first = drawn(folded(1))
    expect(first.get(1)).toEqual(expect.arrayContaining([CLS.cardTop, CLS.cardBottom, CLS.first]))
    expect(first.get(4)).toEqual(expect.arrayContaining([CLS.cardBottom, CLS.last]))
    // Nothing folded: each card still ends on its own last line.
    const open = drawn((at) => state.doc.lineAt(at).from)
    expect(open.get(1)).not.toContain(CLS.cardBottom)
    expect(open.get(2)).toContain(CLS.cardBottom)
  })

  it('draws nothing at the end of a timeline folded away with its heading', () => {
    // Obsidian folds a heading down to the next heading of its level. With no
    // blank line before that one, the fold ends where the last card does, and
    // a widget there would show on the heading's line, after its "…".
    const lines = ['## Findings', '%% timeline %%', '- 11:04 a', '- ', '## Summary']
    const state = stateOf(lines)
    const edges = (lineStart?: (at: number) => number) =>
      widgets(
        state,
        buildTimelineDecorations(
          state,
          readTimelines(state.doc),
          [{ from: 0, to: state.doc.length }],
          callbacks(),
          lineStart
        ).decorations
      )
        .filter((w) => w.name === 'AddWidget' || w.name === 'GhostWidget')
        .map((w) => w.name)
    expect(edges()).toEqual(['GhostWidget', 'AddWidget'])
    const foldEnd = pos(state, 3, 2)
    expect(edges((at) => (at <= foldEnd ? 0 : state.doc.lineAt(at).from))).toEqual([])
  })

  it('reads the folds off the view, and redraws when a fold opens or closes', () => {
    const lines = ['%% timeline %%', '- 11:04 a', '- 11:05 b', '    - Source: EDR process tree']
    const state = stateOf(lines)
    let fold = false
    const view = {
      ...fakeView(state),
      lineBlockAt: (at: number) => ({ from: fold && at >= pos(state, 3) ? pos(state, 2) : state.doc.lineAt(at).from })
    } as unknown as EditorView
    const plugin = new NoteTimelinePlugin(view, callbacks())
    expect(lineClasses(state, plugin.decorations).get(3)).toContain(CLS.last)
    fold = true
    // Obsidian folds with an effect: no change to the text or the selection.
    const tr = state.update({ effects: StateEffect.define<null>().of(null) })
    plugin.update({ startState: state, state, view, transactions: [tr] } as unknown as ViewUpdate)
    expect(lineClasses(state, plugin.decorations).get(2)).toContain(CLS.last)
  })

  it('gives the editor its atomic ranges through the extension', () => {
    const state = EditorState.create({ doc: CLICKFIX.join('\n'), extensions: noteTimelineExtension(callbacks()) })
    const sources = state.facet(EditorView.atomicRanges)
    expect(sources).toHaveLength(1)
    const plugin = new NoteTimelinePlugin(fakeView(state), callbacks())
    const view = { plugin: () => plugin } as unknown as EditorView
    expect(sources[0](view)).toBe(plugin.atomic)
  })
})
