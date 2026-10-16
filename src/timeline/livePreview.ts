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
import { CLS, iocIcon, kindClass, renderAddEvent, renderGap, renderHeader, renderNode, renderUntimedChip } from './dom'
import {
  findTimelines,
  indicatorSpans,
  TIMELINE_MARKER,
  type EventKind,
  type Span,
  type TimelineBlock,
  type TimelineGap,
  type TimelineIoc,
  type TimelineSummary
} from './parse'
import { headPieces } from './reading'

/**
 * The note timeline in Live Preview: the list under a `%% timeline %%` line
 * drawn as cards on a rail while it stays editable text. Every line keeps
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
  /** The header's menu button. */
  onHeaderMenu: (view: EditorView, markerLine: number, evt: MouseEvent) => void
  /** The header's Defang button, shown when the timeline has live indicators. */
  onDefang: (view: EditorView, markerLine: number) => void
}

const ATTACK = /\bT\d{4}(?:\.\d{3})?\b/g
const GHOST = '11:07  what happened…'

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// ── Widgets ────────────────────────────────────────────────────────────────
// Each is built by the shared dom.ts builders, so Reading view and Live
// Preview draw the same pieces. eq() compares what the widget shows (and the
// line its clicks report), so typing in a card keeps its DOM. A control
// handles its own clicks (ignoreEvent true) and keeps mousedown from moving
// the caret; a display-only widget lets the click through to the editor.

class HeaderWidget extends WidgetType {
  constructor(
    readonly summary: TimelineSummary,
    readonly markerLine: number,
    readonly handlers: NoteTimelineCallbacks
  ) {
    super()
  }

  eq(other: HeaderWidget): boolean {
    return other.markerLine === this.markerLine && same(other.summary, this.summary)
  }

  toDOM(view: EditorView): HTMLElement {
    const header = renderHeader(createDiv(), this.summary, {
      onMenu: (evt) => this.handlers.onHeaderMenu(view, this.markerLine, evt),
      onDefang: () => this.handlers.onDefang(view, this.markerLine)
    })
    header.addEventListener('mousedown', (e) => e.preventDefault())
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
    node.addEventListener('mousedown', (e) => e.preventDefault())
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

  toDOM(): HTMLElement {
    return renderGap(createDiv(), this.gap)
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

  toDOM(): HTMLElement {
    return renderUntimedChip(createSpan(), this.unread)
  }

  ignoreEvent(): boolean {
    return false
  }
}

/** What an empty event could say. Display only, never written. */
class GhostWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    // CodeMirror's own placeholder class, so the theme draws it faint and unselectable.
    return createSpan({ cls: ['cm-placeholder', 'cf-ntl-ghost'], text: GHOST, attr: { 'aria-hidden': 'true' } })
  }

  ignoreEvent(): boolean {
    return false
  }
}

class AddWidget extends WidgetType {
  constructor(
    readonly markerLine: number,
    readonly handlers: NoteTimelineCallbacks
  ) {
    super()
  }

  eq(other: AddWidget): boolean {
    return other.markerLine === this.markerLine
  }

  toDOM(view: EditorView): HTMLElement {
    const row = renderAddEvent(createDiv(), () => this.handlers.onAddEvent(view, this.markerLine))
    row.addEventListener('mousedown', (e) => e.preventDefault())
    return row
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

  toDOM(): HTMLElement {
    const el = createSpan({ cls: this.cls, attr: { 'aria-hidden': 'true' } })
    setIcon(el, this.icon)
    return el
  }

  ignoreEvent(): boolean {
    return false
  }
}

// ── Decorations ────────────────────────────────────────────────────────────

/** Every timeline in the doc; a note without the marker costs one string scan. */
export function readTimelines(doc: Text): TimelineBlock[] {
  const text = doc.toString()
  return text.includes(TIMELINE_MARKER) ? findTimelines(text.split('\n')) : []
}

/** CodeMirror throws on an empty mark, which would take the whole plugin down: one is skipped instead. */
function mark(out: Range<Decoration>[], cls: string, from: number, to: number, inclusiveStart = false): void {
  if (to > from) out.push(Decoration.mark({ class: cls, inclusiveStart }).range(from, to))
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

/** One card: its line classes, the widgets around it and the marks on its text. */
function decorateEvent(
  out: Range<Decoration>[],
  state: EditorState,
  block: TimelineBlock,
  i: number,
  handlers: NoteTimelineCallbacks
): void {
  const doc = state.doc
  const event = block.events[i]
  const next = block.events.at(i + 1)
  // A blank line before the next event stays on this card, as timelineAt reads it.
  const endLine = next ? next.line - 1 : block.lastLine
  const top = doc.line(event.line + 1)
  const bottom = doc.line(endLine + 1)
  const sel = state.selection.main
  const card: string[] = [CLS.line, kindClass(event.kind)]
  if (event.kindExplicit) card.push(CLS.explicit)
  if (event.key) card.push(CLS.key)
  if (sel.from <= bottom.to && sel.to >= top.from) card.push(CLS.active)
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
    if (n === endLine) cls.push(CLS.cardBottom)
    if (n === endLine && !next) cls.push(CLS.last)
    out.push(Decoration.line({ class: cls.join(' ') }).range(line.from))
  }

  // The band and node sit before the caret at the text start; both position themselves.
  const at = top.from + event.textFrom
  if (gap) out.push(widget(new BandWidget(gap), -1, at))
  out.push(widget(new NodeWidget(event.kind, event.kindExplicit, event.key, event.line, handlers), -1, at))
  if (!event.text.trim()) out.push(widget(new GhostWidget(), 1, top.to))
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
 * The decorations for the timelines in view, and the atomic marker ranges for
 * all of them (a jump or a search can land on one off screen). Exported for
 * tests; the view plugin passes its state, cached blocks and visible ranges.
 */
export function buildTimelineDecorations(
  state: EditorState,
  blocks: TimelineBlock[],
  visible: readonly { from: number; to: number }[],
  handlers: NoteTimelineCallbacks
): { decorations: DecorationSet; atomic: DecorationSet } {
  const doc = state.doc
  const out: Range<Decoration>[] = []
  const atomic: Range<Decoration>[] = []
  for (const block of blocks) {
    const marker = doc.line(block.markerLine + 1)
    const header = Decoration.replace({ widget: new HeaderWidget(block.summary, block.markerLine, handlers) }).range(
      marker.from,
      marker.to
    )
    atomic.push(header)
    const end = doc.line(block.lastLine + 1).to
    if (!visible.some((r) => r.from <= end && r.to >= marker.from)) continue
    out.push(Decoration.line({ class: `${CLS.line} ${CLS.markerLine}` }).range(marker.from), header)
    for (let i = 0; i < block.events.length; i++) decorateEvent(out, state, block, i, handlers)
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
      livePreview(update.startState) !== livePreview(update.state)
    ) {
      this.build(update.view)
    }
  }

  /** A click on a kind word opens the kind picker, as the node does. */
  mousedown(evt: MouseEvent, view: EditorView): boolean {
    const target = evt.target as HTMLElement | null
    const tag = evt.button === 0 ? target?.closest?.(`.${CLS.tag}`) : null
    if (!tag) return false
    this.handlers.onKindClick(view, view.state.doc.lineAt(view.posAtDOM(tag)).number - 1, evt)
    return true
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
    const built = buildTimelineDecorations(view.state, this.blocks, view.visibleRanges, this.handlers)
    this.decorations = built.decorations
    this.atomic = built.atomic
  }
}

/** The Live Preview timeline for Obsidian's markdown editors (registerEditorExtension). */
export function noteTimelineExtension(callbacks: NoteTimelineCallbacks): Extension {
  return ViewPlugin.define((view) => new NoteTimelinePlugin(view, callbacks), {
    decorations: (p) => p.decorations,
    eventHandlers: {
      mousedown(evt, view) {
        return this.mousedown(evt, view)
      }
    },
    provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.atomic ?? Decoration.none)
  })
}
