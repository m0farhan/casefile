import type { EditorState, Extension, Range, StateField, Text } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate
} from '@codemirror/view'
import { editorLivePreviewField, setIcon } from 'obsidian'
import {
  CLS,
  headerShape,
  iocIcon,
  kindClass,
  linkIcon,
  renderAddEvent,
  renderGap,
  renderHeader,
  renderNode,
  renderSpawn,
  renderStepNode,
  renderUntimedChip,
  type HeaderShape
} from './dom'
import {
  findTimelines,
  indicatorSpans,
  mayHoldTimeline,
  type EventKind,
  type Labelled,
  type Span,
  type TimelineBlock,
  type TimelineGap,
  type TimelineIoc,
  type TimelineStyle,
  type TimelineSummary
} from './parse'
import { headPieces } from './reading'

/**
 * The note timeline in Live Preview: the list under a `%% timeline %%` line
 * drawn as cards on a rail while it stays editable text (as numbered steps,
 * or as a process chain's cards, for the other markers). Every line keeps
 * its own text and caret positions; the look comes from classes on each
 * .cm-line, marks on the text and small inline widgets (note-timeline.css),
 * never block widgets or vertical margins. The marker line's text is replaced
 * by the header and is atomic, so the caret never lands inside `%%`. Clicks
 * the editor cannot act on itself go to the callbacks, which the plugin wires
 * to the timeline actions. Line numbers given to them are 0-based, as the
 * parser and Obsidian's Editor count.
 */

export interface NoteTimelineCallbacks {
  /** The node or the kind word was clicked on an event line: open the kind picker. */
  onKindClick: (view: EditorView, line: number, evt: MouseEvent) => void
  /** "Add event" under the last card. */
  onAddEvent: (view: EditorView, markerLine: number) => void
  /** A chain's add row: a child under the link on `line`. Without it the row adds a link, as onAddEvent does. */
  onAddChild?: (view: EditorView, line: number) => void
  /** The header's menu button. */
  onHeaderMenu: (view: EditorView, markerLine: number, evt: MouseEvent) => void
  /** The header's Defang button, shown when the timeline has live indicators. */
  onDefang: (view: EditorView, markerLine: number) => void
}

const ATTACK = /\bT\d{4}(?:\.\d{3})?\b/g
/** What an empty item could say, by style. */
const GHOST: Record<TimelineStyle, string> = {
  events: '11:07  what happened…',
  steps: 'Label: what you saw',
  chain: 'Label: process or command'
}
/** What the row under the last item adds, by style. */
const ADD: Record<TimelineStyle, string> = { events: 'Add event', steps: 'Add step', chain: 'Add link' }

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// ── Widgets ────────────────────────────────────────────────────────────────
// Each is built by the shared dom.ts builders, so Reading view and Live
// Preview draw the same pieces. eq() compares what the widget shows (and the
// line its clicks report), so typing in a card keeps its DOM. A control
// handles its own clicks (ignoreEvent true) and keeps mousedown from moving
// the caret; a display-only widget lets the click through to the editor.

/**
 * A widget is not text: a right-click on one leaves the caret where it was,
 * maybe in another event or another timeline, and Obsidian builds its editor
 * menu at the caret. The caret moves onto the widget first; the menu is built
 * after this listener, as the event bubbles up to the editor.
 */
function menuHere(el: HTMLElement, view: EditorView): HTMLElement {
  el.addEventListener('contextmenu', () => view.dispatch({ selection: { anchor: view.posAtDOM(el) } }))
  return el
}

/** A control also keeps a press from moving the caret: its click acts instead. */
function control(el: HTMLElement, view: EditorView): HTMLElement {
  el.addEventListener('mousedown', (e) => e.preventDefault())
  return menuHere(el, view)
}

class HeaderWidget extends WidgetType {
  constructor(
    readonly summary: TimelineSummary,
    readonly shape: HeaderShape,
    readonly markerLine: number,
    readonly handlers: NoteTimelineCallbacks
  ) {
    super()
  }

  eq(other: HeaderWidget): boolean {
    return other.markerLine === this.markerLine && same(other.summary, this.summary) && same(other.shape, this.shape)
  }

  toDOM(view: EditorView): HTMLElement {
    const onMenu = (evt: MouseEvent) => this.handlers.onHeaderMenu(view, this.markerLine, evt)
    const header = renderHeader(
      createDiv(),
      this.summary,
      { onMenu, onDefang: () => this.handlers.onDefang(view, this.markerLine) },
      this.shape
    )
    header.addEventListener('mousedown', (e) => e.preventDefault())
    // A right-click opens the header's own menu. Obsidian's, built at the
    // caret, would need the caret on the marker, and its Insert items would
    // then write onto the marker line and end the timeline.
    header.addEventListener('contextmenu', (evt) => {
      evt.preventDefault()
      onMenu(evt)
    })
    return header
  }

  ignoreEvent(): boolean {
    return true
  }
}

class NodeWidget extends WidgetType {
  constructor(
    readonly kind: EventKind,
    readonly explicit: boolean,
    readonly key: boolean,
    readonly line: number,
    readonly handlers: NoteTimelineCallbacks
  ) {
    super()
  }

  eq(other: NodeWidget): boolean {
    return (
      other.kind === this.kind && other.explicit === this.explicit && other.key === this.key && other.line === this.line
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const node = renderNode(createDiv(), this.kind, this.explicit, this.key)
    // The kind picker opens from it: a button, which the stylesheet gives a pointer and a touch area.
    node.setAttr('role', 'button')
    node.setAttr('tabindex', '0')
    node.setAttr('aria-label', `${node.getAttribute('aria-label') ?? ''} (set event kind)`)
    const open = (evt: MouseEvent) => this.handlers.onKindClick(view, this.line, evt)
    control(node, view)
    node.addEventListener('click', open)
    node.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      // The menu opens at a mouse event; from the keyboard, at the node.
      const r = node.getBoundingClientRect()
      open(new MouseEvent('click', { clientX: r.left, clientY: r.bottom }))
    })
    return node
  }

  ignoreEvent(): boolean {
    return true
  }
}

class BandWidget extends WidgetType {
  constructor(readonly gap: TimelineGap) {
    super()
  }

  eq(other: BandWidget): boolean {
    return same(other.gap, this.gap)
  }

  toDOM(view: EditorView): HTMLElement {
    return menuHere(renderGap(createDiv(), this.gap), view)
  }

  ignoreEvent(): boolean {
    return false
  }
}

class UntimedWidget extends WidgetType {
  constructor(readonly unread: string | null) {
    super()
  }

  eq(other: UntimedWidget): boolean {
    return other.unread === this.unread
  }

  toDOM(view: EditorView): HTMLElement {
    return menuHere(renderUntimedChip(createSpan(), this.unread), view)
  }

  ignoreEvent(): boolean {
    return false
  }
}

/** What an empty event could say. Display only, never written. */
/** A fact's key, hidden: the line under the fact starts on its value's column. */
class FactPadWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }

  eq(other: FactPadWidget): boolean {
    return other.text === this.text
  }

  toDOM(): HTMLElement {
    return createSpan({ cls: [CLS.factKey, CLS.factPad], text: this.text, attr: { 'aria-hidden': 'true' } })
  }
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }

  eq(other: GhostWidget): boolean {
    return other.text === this.text
  }

  toDOM(view: EditorView): HTMLElement {
    // CodeMirror's own placeholder class, so the theme draws it faint and unselectable.
    const ghost = createSpan({
      cls: ['cm-placeholder', 'cf-ntl-ghost'],
      text: this.text,
      attr: { 'aria-hidden': 'true' }
    })
    return menuHere(ghost, view)
  }

  ignoreEvent(): boolean {
    return false
  }
}

/** A step's number, standing in for its bullet. Display only. */
class StepNodeWidget extends WidgetType {
  constructor(readonly n: number) {
    super()
  }

  eq(other: StepNodeWidget): boolean {
    return other.n === this.n
  }

  toDOM(view: EditorView): HTMLElement {
    return menuHere(renderStepNode(createDiv(), this.n), view)
  }

  ignoreEvent(): boolean {
    return false
  }
}

/** A chain link's role, read off its depth: after the label, or just before the value when there is none. */
class RoleWidget extends WidgetType {
  constructor(
    readonly role: string,
    readonly alone: boolean
  ) {
    super()
  }

  eq(other: RoleWidget): boolean {
    return other.role === this.role && other.alone === this.alone
  }

  toDOM(view: EditorView): HTMLElement {
    const role = createSpan({ cls: CLS.role, text: this.role })
    if (this.alone) role.addClass(CLS.roleAlone)
    return menuHere(role, view)
  }

  ignoreEvent(): boolean {
    return false
  }
}

/** The 'Spawns' connector in the band above a child link. */
class SpawnWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(view: EditorView): HTMLElement {
    return menuHere(renderSpawn(createDiv()), view)
  }

  ignoreEvent(): boolean {
    return false
  }
}

class AddWidget extends WidgetType {
  /** `childOf`: in a chain, the last link, which the row adds a child to when the plugin can. */
  constructor(
    readonly markerLine: number,
    readonly handlers: NoteTimelineCallbacks,
    readonly style: TimelineStyle = 'events',
    readonly childOf: number | null = null
  ) {
    super()
  }

  eq(other: AddWidget): boolean {
    return other.markerLine === this.markerLine && other.style === this.style && other.childOf === this.childOf
  }

  toDOM(view: EditorView): HTMLElement {
    const { onAddChild } = this.handlers
    const line = this.childOf
    const child = onAddChild && line !== null ? () => onAddChild(view, line) : null
    // The row keeps the editor from taking focus on the press, so it is given
    // focus after the edit, with the caret on the new bullet, for typing.
    const row = renderAddEvent(
      createDiv(),
      () => {
        if (child) child()
        else this.handlers.onAddEvent(view, this.markerLine)
        view.focus()
      },
      child ? 'Add a child it spawned' : ADD[this.style]
    )
    return control(row, view)
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** An indicator chip's type icon, or the Source footer's. */
class IconWidget extends WidgetType {
  constructor(
    readonly icon: string,
    readonly cls: string
  ) {
    super()
  }

  eq(other: IconWidget): boolean {
    return other.icon === this.icon && other.cls === this.cls
  }

  toDOM(view: EditorView): HTMLElement {
    const el = createSpan({ cls: this.cls, attr: { 'aria-hidden': 'true' } })
    setIcon(el, this.icon)
    return menuHere(el, view)
  }

  ignoreEvent(): boolean {
    return false
  }
}

// ── Decorations ────────────────────────────────────────────────────────────

/** Every timeline in the doc; a note without the marker costs one string scan. */
export function readTimelines(doc: Text): TimelineBlock[] {
  const text = doc.toString()
  return mayHoldTimeline(text) ? findTimelines(text.split('\n')) : []
}

/**
 * CodeMirror throws on an empty mark, which would take the whole plugin down:
 * one is skipped instead. `inclusiveEnd` draws a widget at its end with side
 * -1 inside it.
 */
function mark(out: Range<Decoration>[], cls: string, from: number, to: number, inclusiveEnd = false): void {
  if (to > from) out.push(Decoration.mark({ class: cls, inclusiveEnd }).range(from, to))
}
const widget = (w: WidgetType, side: number, at: number): Range<Decoration> =>
  Decoration.widget({ widget: w, side }).range(at)

/** Indicator chips with their icon inside, and ATT&CK pills not inside one. */
function indicatorMarks(out: Range<Decoration>[], from: number, iocs: TimelineIoc[], attack: Span[]): void {
  for (const { span, type, live } of iocs) {
    const cls = [CLS.ioc, `${CLS.ioc}-${type}`]
    if (live) cls.push(CLS.iocLive)
    // The icon sits just before the chip, outside it: Obsidian's own URL and
    // email spans split a mark around them, so an icon inside the chip drew
    // as a second, empty box.
    mark(out, cls.join(' '), from + span.from, from + span.to)
    const icon = [CLS.iocIcon, `${CLS.iocIcon}-${type}`]
    if (live) icon.push(`${CLS.iocIcon}-live`)
    out.push(widget(new IconWidget(iocIcon(type), icon.join(' ')), -1, from + span.from))
  }
  for (const s of attack) {
    if (!iocs.some((i) => s.from < i.span.to && s.to > i.span.from)) mark(out, CLS.att, from + s.from, from + s.to)
  }
}

/** Where the visual line holding a position starts; a fold makes one of several lines. */
type LineStart = (pos: number) => number

/**
 * The lines a card is drawn on, `line` to `endLine`: null when it is folded
 * away with a heading or a list item above it, where it is not drawn and a
 * widget at its end would show after that fold's "…". Folded details join the
 * card's first line, and a joined line is drawn with that line's classes only:
 * the card closes on `shownEnd`, the last line still drawn.
 */
function cardLines(state: EditorState, line: number, endLine: number, lineStart: LineStart) {
  const doc = state.doc
  const top = doc.line(line + 1)
  if (lineStart(top.from) < top.from) return null
  const bottom = doc.line(endLine + 1)
  const sel = state.selection.main
  return {
    top,
    bottom,
    shownEnd: Math.max(line, doc.lineAt(lineStart(bottom.from)).number - 1),
    active: sel.from <= bottom.to && sel.to >= top.from
  }
}

/** One card: its line classes, the widgets around it and the marks on its text. */
function decorateEvent(
  out: Range<Decoration>[],
  state: EditorState,
  block: TimelineBlock,
  i: number,
  handlers: NoteTimelineCallbacks,
  lineStart: LineStart
): void {
  const doc = state.doc
  const event = block.events[i]
  const next = block.events.at(i + 1)
  // A blank line before the next event stays on this card, as timelineAt reads it.
  const endLine = next ? next.line - 1 : block.lastLine
  const drawn = cardLines(state, event.line, endLine, lineStart)
  if (!drawn) return
  const { top, bottom, shownEnd } = drawn
  const card: string[] = [CLS.line, kindClass(event.kind)]
  if (event.kindExplicit) card.push(CLS.explicit)
  if (event.key) card.push(CLS.key)
  if (drawn.active) card.push(CLS.active)
  const gap = block.gaps[i]

  for (let n = event.line; n <= endLine; n++) {
    const line = doc.line(n + 1)
    const cls = [...card]
    if (n === event.line) {
      cls.push(CLS.ev, CLS.cardTop)
      if (i === 0) cls.push(CLS.first)
      if (gap) cls.push(gap.dayChange ? CLS.day : gap.long ? CLS.gapLong : CLS.gap)
    } else {
      cls.push(CLS.detail)
      const detail = event.details.find((d) => d.line === n)
      if (detail?.source) {
        cls.push(CLS.source)
        // The detail's text is the line trimmed, its list marker dropped: it ends where the line's text does.
        const at = line.from + line.text.trimEnd().length - detail.text.length
        out.push(widget(new IconWidget('file-search', CLS.sourceIcon), -1, at))
      }
      if (detail) {
        const attack = Array.from(line.text.matchAll(ATTACK), (m) => ({ from: m.index, to: m.index + m[0].length }))
        indicatorMarks(out, line.from, indicatorSpans(line.text), attack)
      }
    }
    if (n === shownEnd) cls.push(CLS.cardBottom)
    if (n === shownEnd && !next) cls.push(CLS.last)
    out.push(Decoration.line({ class: cls.join(' ') }).range(line.from))
  }

  // The band and node sit before the caret at the text start; both position themselves.
  const at = top.from + event.textFrom
  if (gap) out.push(widget(new BandWidget(gap), -1, at))
  out.push(widget(new NodeWidget(event.kind, event.kindExplicit, event.key, event.line, handlers), -1, at))
  if (!event.text.trim()) out.push(widget(new GhostWidget(GHOST.events), 1, top.to))
  else if (!event.time) out.push(widget(new UntimedWidget(event.unread), -1, at))

  let col = event.textFrom
  for (const p of headPieces(event, top.text)) {
    if (p.cls) mark(out, p.cls, top.from + col, top.from + col + p.text.length)
    if (p.sec) mark(out, CLS.sec, top.from + col + p.sec.from, top.from + col + p.sec.to)
    col += p.text.length
  }
  indicatorMarks(out, top.from, event.iocs, event.attack)

  if (!next) out.push(widget(new AddWidget(block.markerLine, handlers), 1, bottom.to))
}

/**
 * A label over its value, `at` the line's start: the text from `from` to the
 * value as one row (headCls, which the stylesheet ends with a line break, so
 * the value starts the row below), the label and the ': ' after it marked in
 * it, and the value. No row when nothing comes before the value. The row
 * takes in a widget at the value's start with side -1.
 */
function labelledMarks(
  out: Range<Decoration>[],
  at: number,
  l: Labelled,
  from: number,
  headCls: string,
  valueCls: string
): void {
  mark(out, headCls, at + from, at + l.value.from, true)
  if (l.label) {
    mark(out, CLS.label, at + l.label.from, at + l.label.to)
    mark(out, CLS.sep, at + l.label.to, at + l.value.from)
  }
  mark(out, valueCls, at + l.value.from, at + l.value.to)
}

const valueClass = (kind: string | null): string => (kind ? `${CLS.value} ${CLS.mono}` : CLS.value)

/**
 * One step, or the closing Details bullet and its facts: rows on the rail
 * with no card of their own until the caret is in one. A step's number
 * stands in for its bullet; its time is drawn only when written, and no
 * indicator is chipped (the header still counts the live ones).
 */
function decorateStep(
  out: Range<Decoration>[],
  state: EditorState,
  block: TimelineBlock,
  i: number,
  handlers: NoteTimelineCallbacks,
  lineStart: LineStart
): void {
  const doc = state.doc
  const event = block.events[i]
  const step = block.steps.at(i)
  const next = block.events.at(i + 1)
  const endLine = next ? next.line - 1 : block.lastLine
  const drawn = cardLines(state, event.line, endLine, lineStart)
  if (!drawn) return
  const { top, bottom, shownEnd } = drawn
  const base: string[] = [CLS.line, CLS.steps]
  if (!step) base.push(CLS.facts)
  if (drawn.active) base.push(CLS.active)
  // The facts are the closing bullet's detail lines.
  const facts = new Map(step ? [] : block.facts.map((f) => [f.line, f]))
  const more = new Map(step ? [] : block.facts.flatMap((f) => f.more.map((m) => [m.line, { fact: f, span: m.span }])))

  for (let n = event.line; n <= endLine; n++) {
    const line = doc.line(n + 1)
    const cls = [...base]
    if (n === event.line) {
      cls.push(CLS.ev, CLS.cardTop, step ? CLS.step : CLS.factsHead)
      if (i === 0) cls.push(CLS.first)
    } else {
      cls.push(CLS.detail)
      const fact = facts.get(n)
      if (fact) {
        cls.push(CLS.fact)
        labelledMarks(
          out,
          line.from,
          fact,
          fact.label?.from ?? fact.value.from,
          CLS.factKey,
          // A fact's value is an identifier, whatever its shape.
          valueClass('fact')
        )
      } else {
        const extra = more.get(n)
        if (extra) {
          cls.push(CLS.factMore)
          const { label, value } = extra.fact
          const key = label ? doc.line(extra.fact.line + 1).text.slice(label.from, value.from) : ''
          if (key) out.push(widget(new FactPadWidget(key), -1, line.from + extra.span.from))
          mark(out, CLS.factMoreText, line.from + extra.span.from, line.from + extra.span.to)
        }
      }
    }
    if (n === shownEnd) cls.push(CLS.cardBottom)
    if (n === shownEnd && !next) cls.push(CLS.last)
    out.push(Decoration.line({ class: cls.join(' ') }).range(line.from))
  }

  if (step) {
    const at = top.from
    out.push(widget(new StepNodeWidget(step.n), -1, at + event.textFrom))
    if (!event.text.trim()) out.push(widget(new GhostWidget(GHOST.steps), 1, top.to))
    // The time as written opens the label row, its lead word muted.
    if (event.lead) mark(out, CLS.lead, at + event.lead.from, at + event.lead.to)
    const t = event.timeSpan
    if (t) mark(out, event.time?.approx ? `${CLS.time} ${CLS.approx}` : CLS.time, at + t.from, at + t.to)
    const sec = event.secondsSpan
    if (sec) mark(out, CLS.sec, at + sec.from, at + sec.to)
    labelledMarks(out, at, step, event.textFrom, CLS.head, valueClass(step.valueKind))
  }
  if (!next) out.push(widget(new AddWidget(block.markerLine, handlers, 'steps'), 1, bottom.to))
}

/**
 * One link of a process chain: a card from its bullet to the next link, its
 * notes in it, at its own depth (the note's indent). A child has the 'Spawns'
 * connector in the band above it; the role beside the label is read off the
 * depth; the value is monospace after an icon for what it names.
 */
function decorateLink(
  out: Range<Decoration>[],
  state: EditorState,
  block: TimelineBlock,
  k: number,
  handlers: NoteTimelineCallbacks,
  lineStart: LineStart
): void {
  const doc = state.doc
  const link = block.links[k]
  const next = block.links.at(k + 1)
  const endLine = next ? next.line - 1 : block.lastLine
  const drawn = cardLines(state, link.line, endLine, lineStart)
  if (!drawn) return
  const { top, bottom, shownEnd } = drawn
  const root = link.parent === null
  const base: string[] = [CLS.line, CLS.chain, root ? CLS.root : CLS.child]
  if (drawn.active) base.push(CLS.active)

  for (let n = link.line; n <= endLine; n++) {
    const cls = [...base]
    if (n === link.line) {
      cls.push(CLS.ev, CLS.proc)
      if (k === 0) cls.push(CLS.first)
      if (!root) cls.push(CLS.spawned)
    } else cls.push(CLS.detail)
    if (n === shownEnd) cls.push(CLS.procEnd)
    if (n === shownEnd && !next) cls.push(CLS.last)
    out.push(Decoration.line({ class: cls.join(' ') }).range(doc.line(n + 1).from))
  }

  const at = top.from
  if (!root) out.push(widget(new SpawnWidget(), -1, at + link.textFrom))
  if (!link.label && !link.valueText) out.push(widget(new GhostWidget(GHOST.chain), 1, top.to))
  else {
    // After the ': ', in the label's row; with no label, first after the bullet
    // and then the icon: Obsidian measures a list line's hanging indent from
    // the first thing after its bullet, so that must be on the bullet's row.
    if (link.label) out.push(widget(new RoleWidget(link.role, false), -1, at + link.value.from))
    else out.push(widget(new RoleWidget(link.role, true), 1, at + link.textFrom))
    labelledMarks(out, at, link, link.label?.from ?? link.value.from, CLS.head, `${CLS.value} ${CLS.mono}`)
    if (link.valueText) out.push(widget(new IconWidget(linkIcon(link), CLS.valueIcon), 2, at + link.value.from))
  }
  if (!next) out.push(widget(new AddWidget(block.markerLine, handlers, 'chain', link.line), 1, bottom.to))
}

/**
 * The decorations for the timelines in view, and the atomic marker ranges for
 * all of them (a jump or a search can land on one off screen). Exported for
 * tests; the view plugin passes its state, cached blocks, visible ranges and
 * its line blocks, which know Obsidian's folds.
 */
export function buildTimelineDecorations(
  state: EditorState,
  blocks: TimelineBlock[],
  visible: readonly { from: number; to: number }[],
  handlers: NoteTimelineCallbacks,
  lineStart: LineStart = (pos) => state.doc.lineAt(pos).from
): { decorations: DecorationSet; atomic: DecorationSet } {
  const doc = state.doc
  const out: Range<Decoration>[] = []
  const atomic: Range<Decoration>[] = []
  for (const block of blocks) {
    const marker = doc.line(block.markerLine + 1)
    const header = Decoration.replace({
      widget: new HeaderWidget(block.summary, headerShape(block), block.markerLine, handlers)
    }).range(marker.from, marker.to)
    atomic.push(header)
    const end = doc.line(block.lastLine + 1).to
    if (!visible.some((r) => r.from <= end && r.to >= marker.from)) continue
    out.push(Decoration.line({ class: `${CLS.line} ${CLS.markerLine}` }).range(marker.from), header)
    if (block.style === 'chain') {
      for (let k = 0; k < block.links.length; k++) decorateLink(out, state, block, k, handlers, lineStart)
      continue
    }
    const decorate = block.style === 'steps' ? decorateStep : decorateEvent
    for (let i = 0; i < block.events.length; i++) decorate(out, state, block, i, handlers, lineStart)
  }
  return { decorations: Decoration.set(out, true), atomic: Decoration.set(atomic) }
}

// ── The view plugin ────────────────────────────────────────────────────────

/** Obsidian's flag; absent outside Obsidian (tests), where the extension always draws. */
function livePreview(state: EditorState): boolean {
  const field = editorLivePreviewField as StateField<boolean> | undefined
  return !field || state.field(field, false) !== false
}

/** Exported for tests; noteTimelineExtension registers it. */
export class NoteTimelinePlugin implements PluginValue {
  decorations: DecorationSet = Decoration.none
  atomic: DecorationSet = Decoration.none
  private doc: Text | null = null
  private blocks: TimelineBlock[] = []

  constructor(
    view: EditorView,
    private readonly handlers: NoteTimelineCallbacks
  ) {
    this.build(view)
  }

  update(update: ViewUpdate): void {
    if (
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      // Obsidian folds and unfolds with an effect, which moves a card's end.
      update.transactions.some((tr) => tr.effects.length > 0) ||
      livePreview(update.startState) !== livePreview(update.state)
    ) {
      this.build(update.view)
    }
  }

  /** The kind word under a left-button event, if any. */
  private tagAt(evt: MouseEvent): Element | null {
    const target = evt.target as HTMLElement | null
    return evt.button === 0 ? (target?.closest?.(`.${CLS.tag}`) ?? null) : null
  }

  /** A press on a kind word is claimed, so the caret stays; the click opens the picker. */
  mousedown(evt: MouseEvent): boolean {
    return this.tagAt(evt) !== null
  }

  /**
   * A click on a kind word opens the kind picker, as the node does. Opened on
   * the press, Obsidian's menu took the click that ends it for a click
   * outside the menu, and closed at once.
   */
  click(evt: MouseEvent, view: EditorView): boolean {
    const tag = this.tagAt(evt)
    if (!tag) return false
    this.handlers.onKindClick(view, view.state.doc.lineAt(view.posAtDOM(tag)).number - 1, evt)
    return true
  }

  /**
   * Text typed with the caret at an edge of a marker would join the marker
   * and turn the timeline back into a plain list. It goes on a line of its
   * own above the marker instead.
   */
  typed(view: EditorView, from: number, to: number, text: string): boolean {
    // A deletion read off the DOM comes here with no text: that is not typing.
    // Text an IME is still composing stays where the IME has it: moved, it
    // would be written again by the next update, as Obsidian's own handlers know.
    if (!text || view.compositionStarted) return false
    const marker = this.markerAt(from, to)
    if (marker < 0) return false
    view.dispatch({
      changes: { from: marker, insert: `${text}\n` },
      selection: { anchor: marker + text.length },
      userEvent: 'input.type'
    })
    return true
  }

  /** A paste at an edge of a marker would join it too: a line is opened above the marker, and the editor pastes there. */
  paste(view: EditorView): boolean {
    const { from, to } = view.state.selection.main
    const marker = this.markerAt(from, to)
    if (marker >= 0) view.dispatch({ changes: { from: marker, insert: '\n' }, selection: { anchor: marker } })
    return false
  }

  /** The start of the marker that from..to lies at an edge of (or across), or -1. */
  private markerAt(from: number, to: number): number {
    let marker = -1
    this.atomic.between(from, to, (start, end) => {
      if (start <= from && to <= end) marker = start
    })
    return marker
  }

  private build(view: EditorView): void {
    // Source mode shows the markdown as written; the description editor is the plugin's own, not a note.
    if (!livePreview(view.state) || view.dom.closest('.pm-modal-description')) {
      this.decorations = this.atomic = Decoration.none
      return
    }
    if (view.state.doc !== this.doc) {
      this.doc = view.state.doc
      this.blocks = readTimelines(this.doc)
    }
    const built = buildTimelineDecorations(
      view.state,
      this.blocks,
      view.visibleRanges,
      this.handlers,
      (pos) => view.lineBlockAt(pos).from
    )
    this.decorations = built.decorations
    this.atomic = built.atomic
  }
}

/** The Live Preview timeline for Obsidian's markdown editors (registerEditorExtension). */
export function noteTimelineExtension(callbacks: NoteTimelineCallbacks): Extension {
  return ViewPlugin.define((view) => new NoteTimelinePlugin(view, callbacks), {
    decorations: (p) => p.decorations,
    eventHandlers: {
      mousedown(evt) {
        return this.mousedown(evt)
      },
      click(evt, view) {
        return this.click(evt, view)
      },
      paste(_evt, view) {
        return this.paste(view)
      }
    },
    provide: (p) => [
      EditorView.atomicRanges.of((view) => view.plugin(p)?.atomic ?? Decoration.none),
      EditorView.inputHandler.of((view, from, to, text) => view.plugin(p)?.typed(view, from, to, text) ?? false)
    ]
  })
}
