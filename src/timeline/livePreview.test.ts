import {
  EditorSelection,
  EditorState,
  RangeSet,
  StateEffect,
  type Extension,
  type TransactionSpec
} from '@codemirror/state'
import { EditorView, type Decoration, type DecorationSet, type ViewUpdate, type WidgetType } from '@codemirror/view'
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

/**
 * One line as CodeMirror's renderer reads the set: its text runs and widgets
 * in order, each with the classes of the marks it is drawn inside.
 */
function drawn(state: EditorState, set: DecorationSet, line: number): { piece: string; in: string[] }[] {
  const { from, to } = state.doc.line(line + 1)
  const out: { piece: string; in: string[] }[] = []
  const classes = (active: readonly Decoration[]) => active.map((m) => String((m.spec as { class?: string }).class))
  RangeSet.spans<Decoration>([set], from, to, {
    span(a, b, active) {
      out.push({ piece: state.doc.sliceString(a, b), in: classes(active) })
    },
    point(_a, _b, d, active) {
      const widget = (d.spec as { widget?: WidgetType }).widget
      if (widget) out.push({ piece: `<${widget.constructor.name}>`, in: classes(active) })
    }
  })
  return out
}

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

/** The steps sample from the styles spec (screen 8). */
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

/** The chain sample from the styles spec (screen 9). */
const CHAIN = [
  '## Process chain',
  '%% timeline chain %%',
  '- Initial process: cmd.exe',
  '    - Terminal process: nltest.exe',
  '        - User context: domain\\user1',
  '            - Execution: nltest /domain_trusts'
]

type Shown = Seen['widget'] & object
const view = {} as EditorView
const widgetAt = (state: EditorState, name: string, line: number, handlers = callbacks()): Shown => {
  const found = seen(state, build(state, handlers).decorations).find(
    (s) => s.widget?.constructor.name === name && s.line === line
  )
  if (!found?.widget) throw new Error(`no ${name} on line ${line}`)
  return found.widget
}
const shown = (w: Shown, v = view) => w.toDOM(v) as unknown as FakeEl

describe('noteTimelineExtension: every style', () => {
  it('reads the marker of every style, and keeps each one atomic', () => {
    for (const marker of ['%% timeline steps %%', '%% timeline chain %%', '%% timeline Steps %%']) {
      const state = stateOf(['Intro', marker, '- a'])
      expect(readTimelines(state.doc)).toHaveLength(1)
      expect(seen(state, build(state).atomic).map((s) => [s.line, s.ch, s.to])).toEqual([[1, 0, marker.length]])
    }
  })

  it('never draws a block widget', () => {
    for (const lines of [CLICKFIX, STEPS, CHAIN]) {
      const state = stateOf(lines)
      const specs = seen(state, build(state).decorations).map((s) => s.widget && (s as { block?: boolean }).block)
      expect(specs.some(Boolean)).toBe(false)
    }
  })

  it("redraws the header when the marker's style changes the same list", () => {
    const events = stateOf(['%% timeline %%', '- Alert fired: x'])
    const steps = stateOf(['%% timeline steps %%', '- Alert fired: x'])
    const a = widgetAt(events, 'HeaderWidget', 0)
    const b = widgetAt(steps, 'HeaderWidget', 0)
    expect(a.eq(b)).toBe(false)
    expect(shown(b).find(`.${CLS.title}`).getText()).toBe('Steps')
    expect(shown(b).find(`.${CLS.meta}`).getText()).toBe('1 step')
  })

  it('keeps the text typed at an edge of a steps marker off it', () => {
    const lines = ['Intro', '%% timeline steps %%', '- a']
    const state = stateOf(lines)
    const plugin = new NoteTimelinePlugin(
      {
        state,
        visibleRanges: [{ from: 0, to: state.doc.length }],
        dom: { closest: () => null },
        lineBlockAt: (at: number) => state.doc.lineAt(at)
      } as unknown as EditorView,
      callbacks()
    )
    const dispatch = vi.fn<(spec: TransactionSpec) => void>()
    expect(plugin.typed({ state, dispatch } as unknown as EditorView, pos(state, 1), pos(state, 1), 'x')).toBe(true)
    expect(state.update(dispatch.mock.calls[0][0]).state.doc.line(3).text).toBe(lines[1])
  })
})

describe('noteTimelineExtension: User and Host kinds', () => {
  it('colours a user or host event by its kind, written or read off the text', () => {
    const state = stateOf([
      '%% timeline %%',
      '- 21:34 Host: DESKTOP1.domain.local, the finance workstation',
      '- 21:35 the account VANTARA\\maya.chen was disabled',
      '- 21:36 User: domain\\user1 ran it'
    ])
    const lines = lineClasses(state, build(state).decorations)
    expect(lines.get(1)).toEqual(expect.arrayContaining(['cf-ntl-k-host', CLS.explicit]))
    expect(lines.get(2)).toContain('cf-ntl-k-user')
    expect(lines.get(2)).not.toContain(CLS.explicit)
    expect(lines.get(3)).toEqual(expect.arrayContaining(['cf-ntl-k-user', CLS.explicit]))
    expect(marks(state, build(state).decorations)).toContainEqual({ line: 1, text: 'Host', cls: CLS.tag })
  })
})

describe('noteTimelineExtension: steps', () => {
  const state = stateOf(STEPS)
  const { decorations } = build(state)
  const lines = lineClasses(state, decorations)
  const w = widgets(state, decorations)

  it('draws each step as a numbered row on the rail, with no kind, gap or time-not-recorded', () => {
    expect(lines.get(1)).toEqual([CLS.line, CLS.markerLine])
    for (const n of [2, 3, 4, 5, 6, 7]) {
      expect(lines.get(n)).toEqual(
        expect.arrayContaining([CLS.line, CLS.steps, CLS.ev, CLS.step, CLS.cardTop, CLS.cardBottom])
      )
      expect(lines.get(n)?.some((c) => c.startsWith('cf-ntl-k-') || c === CLS.gap)).toBe(false)
    }
    expect([...lines].filter(([, c]) => c.includes(CLS.first)).map(([l]) => l)).toEqual([2])
    expect(w.filter((x) => x.name === 'StepNodeWidget')).toEqual(
      [2, 3, 4, 5, 6, 7].map((line) => ({ line, ch: 2, to: 2, name: 'StepNodeWidget', side: -1 }))
    )
    expect(w.some((x) => ['NodeWidget', 'BandWidget', 'UntimedWidget'].includes(x.name ?? ''))).toBe(false)
    expect(shown(widgetAt(state, 'StepNodeWidget', 5)).getText()).toBe('4')
  })

  it('puts the label and the time as written on a row above the value', () => {
    const m = marks(state, decorations)
    expect(m.filter((x) => x.line === 2)).toEqual(
      expect.arrayContaining([
        { line: 2, text: '21:34 Alert fired: ', cls: CLS.head },
        { line: 2, text: '21:34', cls: CLS.time },
        { line: 2, text: 'Alert fired', cls: CLS.label },
        { line: 2, text: ': ', cls: CLS.sep },
        { line: 2, text: 'Potential Recon Activity Via Nltest.EXE', cls: CLS.value }
      ])
    )
    // No time written, no chip: nothing says it is missing.
    expect(m.filter((x) => x.line === 3).map((x) => x.cls)).not.toContain(CLS.time)
    expect(m).toContainEqual({ line: 3, text: 'On host: ', cls: CLS.head })
  })

  it('sets a value in monospace when its shape names it, else in the body font', () => {
    const value = (line: number) =>
      marks(state, decorations).find((x) => x.line === line && x.cls.startsWith(CLS.value))
    expect(value(4)).toEqual({ line: 4, text: 'domain\\user1', cls: `${CLS.value} ${CLS.mono}` })
    expect(value(5)?.cls).toBe(`${CLS.value} ${CLS.mono}`)
    expect(value(6)).toEqual({ line: 6, text: 'nltest /domain_trusts', cls: `${CLS.value} ${CLS.mono}` })
    expect(value(2)?.cls).toBe(CLS.value)
    // An internal host name is a Hostname.
    expect(value(3)).toEqual({ line: 3, text: 'DESKTOP1.domain.local', cls: `${CLS.value} ${CLS.mono}` })
  })

  it('sets a value in monospace when its label names a host, a user or a process', () => {
    const s = stateOf(['%% timeline steps %%', '- On host: WS01', '- User: anita.garcia', '- Alert fired: Recon'])
    const m = marks(s, build(s).decorations).filter((x) => x.cls.startsWith(CLS.value))
    expect(m.map((x) => [x.text, x.cls])).toEqual([
      ['WS01', `${CLS.value} ${CLS.mono}`],
      ['anita.garcia', `${CLS.value} ${CLS.mono}`],
      ['Recon', CLS.value]
    ])
  })

  it('reads a step with no label as all value, and a time with no label as its own row', () => {
    const s = stateOf(['%% timeline steps %%', '- the analyst closed the alert', '- 21:40 escalated to tier 2'])
    const m = marks(s, build(s).decorations)
    expect(m).toContainEqual({ line: 1, text: 'the analyst closed the alert', cls: CLS.value })
    expect(m.filter((x) => x.line === 1).map((x) => x.cls)).not.toContain(CLS.head)
    expect(m).toContainEqual({ line: 2, text: '21:40 ', cls: CLS.head })
    expect(m).toContainEqual({ line: 2, text: 'escalated to tier 2', cls: CLS.value })
  })

  it('draws the closing Details bullet as facts rows, not a step', () => {
    expect(lines.get(8)).toEqual(expect.arrayContaining([CLS.steps, CLS.facts, CLS.ev, CLS.factsHead, CLS.cardTop]))
    expect(lines.get(8)).not.toContain(CLS.step)
    expect(lines.get(9)).toEqual(expect.arrayContaining([CLS.facts, CLS.detail, CLS.fact]))
    expect(lines.get(11)).toContain(CLS.fact)
    expect(lines.get(12)).toEqual(expect.arrayContaining([CLS.facts, CLS.factMore, CLS.cardBottom, CLS.last]))
    expect(lines.get(7)).not.toContain(CLS.last)
    const m = marks(state, decorations)
    expect(m).toEqual(
      expect.arrayContaining([
        { line: 9, text: 'Alert ID: ', cls: CLS.factKey },
        { line: 9, text: 'Alert ID', cls: CLS.label },
        // A fact's value is an identifier: monospace, as in the facts row it stands for.
        { line: 9, text: 'SEC-2023-0704-0001', cls: `${CLS.value} ${CLS.mono}` },
        { line: 11, text: 'Host: ', cls: CLS.factKey },
        { line: 12, text: '192.168.56.95', cls: CLS.factMoreText }
      ])
    )
    // The line under a fact starts on its value's column: a hidden copy of the key holds the width.
    expect(w).toContainEqual(expect.objectContaining({ line: 12, ch: 6, name: 'FactPadWidget', side: -1 }))
    expect(w.filter((x) => x.name === 'StepNodeWidget').map((x) => x.line)).not.toContain(8)
  })

  it('chips no indicator in a step, but keeps the header counting the live ones', () => {
    const s = stateOf(['%% timeline steps %%', '- Fetched: https://promptcraft.online/a.ps1'])
    const { decorations: d } = build(s)
    expect(marks(s, d).some((x) => x.cls.split(' ').includes(CLS.ioc))).toBe(false)
    expect(widgets(s, d).some((x) => x.name === 'IconWidget')).toBe(false)
    expect(
      shown(widgetAt(s, 'HeaderWidget', 0))
        .find(`.${CLS.live}`)
        .getText()
    ).toBe('1 live indicator · Defang')
  })

  it('hints at what an empty step could say', () => {
    const s = stateOf(['%% timeline steps %%', '- Alert fired: x', '- '])
    const ghost = widgets(s, build(s).decorations).filter((x) => x.name === 'GhostWidget')
    expect(ghost).toEqual([{ line: 2, ch: 2, to: 2, name: 'GhostWidget', side: 1 }])
    expect(shown(widgetAt(s, 'GhostWidget', 2)).getText()).toBe('Label: what you saw')
  })

  it('keeps every row drawn and marks the one the caret is in', () => {
    const active = (at: [number, number]) =>
      [...lineClasses(state, build(stateOf(STEPS, at)).decorations)]
        .filter(([, c]) => c.includes(CLS.active))
        .map(([l]) => l)
    expect(active([5, 20])).toEqual([5])
    expect(active([10, 4])).toEqual([8, 9, 10, 11, 12])
  })

  it('adds a step from the row under the list', () => {
    const cb = callbacks()
    const focus = vi.fn<() => void>()
    const row = shown(widgetAt(state, 'AddWidget', 12, cb), { focus } as unknown as EditorView)
    expect(row.getText()).toBe('Add step')
    row.click()
    expect(cb.onAddEvent).toHaveBeenCalledExactlyOnceWith(expect.anything(), 1)
    expect(focus).toHaveBeenCalledOnce()
  })
})

describe('noteTimelineExtension: process chain', () => {
  const state = stateOf(CHAIN)
  const { decorations } = build(state)
  const lines = lineClasses(state, decorations)
  const w = widgets(state, decorations)

  it('draws each link as a card, the root and its spawned children apart', () => {
    expect(lines.get(2)).toEqual(
      expect.arrayContaining([CLS.line, CLS.chain, CLS.root, CLS.ev, CLS.proc, CLS.procEnd, CLS.first])
    )
    expect(lines.get(2)).not.toContain(CLS.spawned)
    for (const n of [3, 4, 5]) {
      expect(lines.get(n)).toEqual(expect.arrayContaining([CLS.chain, CLS.child, CLS.proc, CLS.procEnd, CLS.spawned]))
    }
    expect(lines.get(5)).toContain(CLS.last)
    // A chain has no rail of events, cards or gaps.
    const events: string[] = [CLS.cardTop, CLS.gap, CLS.step]
    expect([...lines.values()].flat().some((c) => events.includes(c))).toBe(false)
  })

  it("draws a 'Spawns' connector above every child, and the role after every label and its ': '", () => {
    expect(w.filter((x) => x.name === 'SpawnWidget')).toEqual([
      { line: 3, ch: 6, to: 6, name: 'SpawnWidget', side: -1 },
      { line: 4, ch: 10, to: 10, name: 'SpawnWidget', side: -1 },
      { line: 5, ch: 14, to: 14, name: 'SpawnWidget', side: -1 }
    ])
    const roles = w.filter((x) => x.name === 'RoleWidget')
    expect(roles.map((x) => [x.line, x.ch, x.side])).toEqual([
      [2, 19, -1],
      [3, 24, -1],
      [4, 24, -1],
      [5, 25, -1]
    ])
    // In the label's row after the ': ' (shown while editing), so the colon stays with the label.
    const row = drawn(state, decorations, 2).filter((p) => p.piece !== '- ')
    expect(row.map((p) => p.piece)).toEqual(['Initial process', ': ', '<RoleWidget>', '<IconWidget>', 'cmd.exe'])
    expect(row.map((p) => p.in.includes(CLS.head))).toEqual([true, true, true, false, false])
    expect(shown(widgetAt(state, 'RoleWidget', 2)).getText()).toBe('Root process')
    const child = shown(widgetAt(state, 'RoleWidget', 3))
    expect([child.getText(), child.hasClass(CLS.role), child.hasClass(CLS.roleAlone)]).toEqual([
      'Spawned child',
      true,
      false
    ])
    const spawn = shown(widgetAt(state, 'SpawnWidget', 3))
    expect(spawn.getText()).toBe('Spawns')
    expect(widgetAt(state, 'SpawnWidget', 3).ignoreEvent(new Event('mousedown'))).toBe(false)
  })

  it('sets every value in monospace after an icon for what it names', () => {
    const m = marks(state, decorations)
    expect(m).toEqual(
      expect.arrayContaining([
        { line: 2, text: 'Initial process: ', cls: CLS.head },
        { line: 2, text: 'Initial process', cls: CLS.label },
        { line: 2, text: 'cmd.exe', cls: `${CLS.value} ${CLS.mono}` },
        { line: 5, text: 'nltest /domain_trusts', cls: `${CLS.value} ${CLS.mono}` }
      ])
    )
    const icons = w.filter((x) => x.name === 'IconWidget')
    expect(icons.map((x) => [x.line, x.ch, x.side])).toEqual([
      [2, 19, 2],
      [3, 24, 2],
      [4, 24, 2],
      [5, 25, 2]
    ])
    const icon = widgetAt(state, 'IconWidget', 3) as unknown as { icon: string; cls: string }
    expect([icon.icon, icon.cls]).toEqual(['activity', CLS.valueIcon])
  })

  it("keeps a link's notes in its card, and a second root apart from the first", () => {
    const s = stateOf(['%% timeline chain %%', '- Initial process: cmd.exe', '    started by the user', '- Second: x'])
    const l = lineClasses(s, build(s).decorations)
    expect(l.get(1)).not.toContain(CLS.procEnd)
    expect(l.get(2)).toEqual(expect.arrayContaining([CLS.chain, CLS.root, CLS.detail, CLS.procEnd]))
    expect(l.get(3)).toEqual(expect.arrayContaining([CLS.root, CLS.proc, CLS.procEnd, CLS.last]))
    expect(l.get(3)).not.toContain(CLS.first)
  })

  it('gives a link with no label its role just before the value, and hints at an empty one', () => {
    const s = stateOf(['%% timeline chain %%', '- cmd.exe', '    - '])
    const found = widgets(s, build(s).decorations)
    // After the text's start, then the icon: Obsidian measures a list line's
    // hanging indent from the first thing after its bullet, the role here.
    expect(found.filter((x) => x.line === 1).map((x) => [x.name, x.ch, x.side])).toEqual([
      ['RoleWidget', 2, 1],
      ['IconWidget', 2, 2]
    ])
    expect(shown(widgetAt(s, 'RoleWidget', 1)).hasClass(CLS.roleAlone)).toBe(true)
    expect(found.filter((x) => x.line === 2).map((x) => x.name)).toEqual(['SpawnWidget', 'GhostWidget', 'AddWidget'])
    expect(shown(widgetAt(s, 'GhostWidget', 2)).getText()).toBe('Label: process or command')
  })

  it('adds a child of the last link when the plugin can, else a link', () => {
    const plain = callbacks()
    const row = shown(widgetAt(state, 'AddWidget', 5, plain), { focus: () => {} } as unknown as EditorView)
    expect(row.getText()).toBe('Add link')
    row.click()
    expect(plain.onAddEvent).toHaveBeenCalledExactlyOnceWith(expect.anything(), 1)
    const onAddChild = vi.fn<NonNullable<NoteTimelineCallbacks['onAddChild']>>()
    const cb = { ...callbacks(), onAddChild }
    const child = shown(widgetAt(state, 'AddWidget', 5, cb), { focus: () => {} } as unknown as EditorView)
    expect(child.getText()).toBe('Add a child it spawned')
    child.click()
    expect(onAddChild).toHaveBeenCalledExactlyOnceWith(expect.anything(), 5)
    expect(cb.onAddEvent).not.toHaveBeenCalled()
    expect(widgetAt(state, 'AddWidget', 5, cb).eq(widgetAt(state, 'AddWidget', 5, plain))).toBe(true)
  })

  it('marks the card the caret is in, its notes too', () => {
    const s = stateOf(['%% timeline chain %%', '- a: x', '    note', '    - b: y'], [2, 3])
    const active = [...lineClasses(s, build(s).decorations)].filter(([, c]) => c.includes(CLS.active))
    expect(active.map(([l]) => l)).toEqual([1, 2])
  })
})
