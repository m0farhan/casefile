import { setIcon, type MarkdownPostProcessorContext } from 'obsidian'
import { defangText } from '../soc/toolbox'
import type { IocType } from '../types'
import { copyDefanged } from '../ui/defangMenu'
import { CLS, iocIcon, kindClass, renderGap, renderHeader, renderNode, renderUntimedChip } from './dom'
import {
  findTimelines,
  indicatorSpans,
  TIMELINE_MARKER,
  type Span,
  type TimelineBlock,
  type TimelineEvent,
  type TimelineGap
} from './parse'

/**
 * The note timeline in Reading view: a markdown post-processor that draws the
 * list under a `%% timeline %%` line as cards on a rail. It only adds classes
 * and widgets around what Obsidian rendered, and wraps text it can match to
 * the parser's reading; what it cannot match stays as rendered. Indicators are
 * shown defanged and links never open: a click copies the link defanged.
 */

const TEXT_NODE = 3
const ELEMENT_NODE = 1
const ATTACK = /\bT\d{4}(?:\.\d{3})?\b/g
const SOURCE = /^\s*source:/i
/** Obsidian's own list furniture, not the bullet's content. */
const FURNITURE = ['list-bullet', 'list-collapse-indicator']

/** The timeline whose list starts in a section's lines, with the note's lines. Null when there is none to draw. */
export function sectionTimeline(
  text: string,
  lineStart: number,
  lineEnd: number
): { block: TimelineBlock; lines: string[] } | null {
  if (!text.includes(TIMELINE_MARKER)) return null
  const lines = text.split(/\r?\n/)
  // The marker is stripped from the rendered DOM; it sits just above the
  // list, in this section or the one before, so the list's first line decides.
  const block = findTimelines(lines).find((b) => b.events.length && b.firstLine >= lineStart && b.firstLine <= lineEnd)
  return block ? { block, lines } : null
}

/** A run of the bullet's leading text and the class it is drawn with; `sec` is the seconds inside a time. */
export interface Piece {
  text: string
  cls: string | null
  sec: Span | null
}

/**
 * The bullet's head as the parser read it, cut into what is styled: the lead
 * word and separators muted, the time as a chip with its seconds, the kind
 * word and its colon. Trailing spaces are left to the text that follows, as
 * markdown trims them off an otherwise empty bullet.
 */
export function headPieces(event: TimelineEvent, line: string): Piece[] {
  const end = event.textFrom + line.slice(event.textFrom, line.length - event.body.length).trimEnd().length
  const pieces: Piece[] = []
  let at = event.textFrom
  const push = (to: number, cls: string | null, sec: Span | null = null) => {
    if (to <= at) return
    const text = line.slice(at, to)
    pieces.push({ text, cls: text.trim() ? cls : null, sec })
    at = to
  }
  if (event.lead) {
    push(event.lead.from, null)
    push(event.lead.to, CLS.lead)
  }
  const t = event.timeSpan
  if (t) {
    push(t.from, null)
    const s = event.secondsSpan
    push(
      t.to,
      event.time?.approx ? `${CLS.time} ${CLS.approx}` : CLS.time,
      s && { from: s.from - t.from, to: s.to - t.from }
    )
  }
  if (event.kindSpan) {
    push(event.kindSpan.from, CLS.lead)
    push(event.kindSpan.to - 1, CLS.tag)
    push(event.kindSpan.to, CLS.colon)
  }
  push(end, CLS.lead)
  return pieces
}

/** A run of rendered text: plain, an indicator chip or an ATT&CK pill. Live indicators and plain runs are defanged. */
export interface Seg {
  text: string
  cls: string | null
  type?: IocType
  live?: boolean
}

/**
 * One rendered text node cut at its indicators and ATT&CK ids. A live
 * indicator is shown defanged; one already defanged stays as written. Plain
 * runs go through defangText too, so nothing it would defang is shown live.
 */
export function splitIndicators(text: string): Seg[] {
  const attack = Array.from(text.matchAll(ATTACK), (m) => ({
    span: { from: m.index, to: m.index + m[0].length },
    type: null,
    live: false
  }))
  const marks = [...indicatorSpans(text), ...attack].sort((a, b) => a.span.from - b.span.from)
  const segs: Seg[] = []
  let at = 0
  const plain = (to: number) => {
    if (to > at) segs.push({ text: defangText(text.slice(at, to)), cls: null })
  }
  for (const { span, type, live } of marks) {
    // An id inside an indicator (…/T1059) is part of the indicator.
    if (span.from < at) continue
    plain(span.from)
    const written = text.slice(span.from, span.to)
    segs.push(
      type ? { text: live ? defangText(written) : written, cls: CLS.ioc, type, live } : { text: written, cls: CLS.att }
    )
    at = span.to
  }
  plain(text.length)
  return segs
}

/**
 * The post-processor. Leaves the section as Obsidian rendered it unless it is
 * a timeline's list whose items match the parser's events one for one.
 */
export function decorateTimelineSections(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
  const info = ctx.getSectionInfo(el)
  const found = info && sectionTimeline(info.text, info.lineStart, info.lineEnd)
  if (!found) return
  const { block, lines } = found
  const lists = Array.from(el.children).filter((c): c is HTMLElement => c.tagName === 'UL')
  const items = lists.flatMap((l) => Array.from(l.children).filter((c): c is HTMLElement => c.tagName === 'LI'))
  if (!items.length || items.length !== block.events.length || lists.some((l) => l.hasClass(CLS.list))) return
  for (const list of lists) list.addClass(CLS.list)
  lists[0].before(renderHeader(el, block.summary, {}))
  block.events.forEach((event, i) => decorateItem(items[i], event, block.gaps[i], lines[event.line]))
}

function decorateItem(li: HTMLElement, event: TimelineEvent, gap: TimelineGap | null, line: string): void {
  li.addClass(CLS.item, kindClass(event.kind))
  if (event.kindExplicit) li.addClass(CLS.explicit)
  if (event.key) li.addClass(CLS.key)
  if (gap) li.addClass(gap.dayChange ? CLS.day : gap.long ? CLS.gapLong : CLS.gap)
  // Collected before anything is added, so only the note's own text is defanged and chipped.
  const texts = textNodes(li, false)
  const first = firstContent(li)
  if (!event.time) {
    const chip = renderUntimedChip(li, event.unread)
    first?.before(chip)
  }
  if (first?.nodeType === TEXT_NODE) wrapHead(first as Text, headPieces(event, line))
  for (const { node, code } of texts) {
    if (code) node.data = defangText(node.data)
    else replaceText(node, splitIndicators(node.data))
  }
  for (const a of Array.from(li.querySelectorAll('a'))) {
    if (!a.hasClass('internal-link') && !a.hasClass('tag')) neutralise(a)
  }
  for (const sub of Array.from(li.children)) {
    if (sub.tagName !== 'UL' && sub.tagName !== 'OL') continue
    for (const d of Array.from(sub.children)) {
      if (d.tagName !== 'LI') continue
      d.addClass(CLS.detail)
      if (!SOURCE.test(d.textContent ?? '')) continue
      d.addClass(CLS.source)
      const icon = d.createSpan({ cls: CLS.sourceIcon, attr: { 'aria-hidden': 'true' } })
      setIcon(icon, 'file-search')
      d.prepend(icon)
    }
  }
  // Band first, then the node: the order a screen reader meets them before the text.
  li.prepend(renderNode(li, event.kind, event.kindExplicit, event.key))
  if (gap) li.prepend(renderGap(li, gap))
}

/** Every text node under el, and whether it is inside code (defanged, never chipped). */
function textNodes(el: Element, code: boolean): { node: Text; code: boolean }[] {
  return Array.from(el.childNodes).flatMap((n) => {
    if (n.nodeType === TEXT_NODE) return [{ node: n as Text, code }]
    if (n.nodeType !== ELEMENT_NODE) return []
    const child = n as HTMLElement
    if (FURNITURE.some((c) => child.hasClass(c))) return []
    return textNodes(child, code || child.tagName === 'CODE' || child.tagName === 'PRE')
  })
}

/** The bullet's first piece of content, past Obsidian's bullet and inside a loose list's paragraph. */
function firstContent(parent: Element): ChildNode | null {
  for (const n of Array.from(parent.childNodes)) {
    if (n.nodeType === TEXT_NODE) {
      if (n.textContent?.trim()) return n
      continue
    }
    if (n.nodeType !== ELEMENT_NODE) continue
    const child = n as HTMLElement
    if (FURNITURE.some((c) => child.hasClass(c))) continue
    return child.tagName === 'P' ? (firstContent(child) ?? child) : child
  }
  return null
}

/** Wraps the head in its pieces when the rendered text starts with it exactly; otherwise leaves it. */
function wrapHead(node: Text, pieces: Piece[]): void {
  const head = pieces.map((p) => p.text).join('')
  const parent = node.parentElement
  if (!head || !parent || !node.data.startsWith(head)) return
  for (const p of pieces) node.before(p.cls ? pieceSpan(parent, p) : p.text)
  node.data = node.data.slice(head.length)
}

function pieceSpan(parent: HTMLElement, p: Piece): HTMLElement {
  const span = parent.createSpan({ cls: (p.cls ?? '').split(' ') })
  if (!p.sec) span.setText(p.text)
  else {
    span.appendText(p.text.slice(0, p.sec.from))
    span.createSpan({ cls: CLS.sec, text: p.text.slice(p.sec.from, p.sec.to) })
    if (p.sec.to < p.text.length) span.appendText(p.text.slice(p.sec.to))
  }
  return span
}

function replaceText(node: Text, segs: Seg[]): void {
  const parent = node.parentElement
  if (!parent || (segs.length <= 1 && !segs[0]?.cls)) {
    node.data = segs[0]?.text ?? ''
    return
  }
  for (const seg of segs) node.before(seg.cls ? segSpan(parent, seg) : seg.text)
  node.remove()
}

function segSpan(parent: HTMLElement, seg: Seg): HTMLElement {
  if (!seg.type) return parent.createSpan({ cls: seg.cls ?? '', text: seg.text })
  const chip = parent.createSpan({ cls: [CLS.ioc, `${CLS.ioc}-${seg.type}`] })
  setIcon(chip.createSpan({ cls: CLS.iocIcon, attr: { 'aria-hidden': 'true' } }), iocIcon(seg.type))
  chip.appendText(seg.text)
  if (seg.live) chip.setAttr('title', 'Shown defanged: the note has it live')
  return chip
}

/** A link in a timeline never opens: it is a button that copies its target defanged. */
function neutralise(a: HTMLElement): void {
  const href = a.getAttribute('href')
  a.removeAttribute('href')
  a.removeAttribute('target')
  a.removeClass('external-link')
  for (const attr of ['aria-label', 'title']) {
    const value = a.getAttribute(attr)
    if (value) a.setAttr(attr, defangText(value))
  }
  a.addClass(CLS.link)
  a.setAttr('role', 'button')
  a.setAttr('tabindex', '0')
  const copy = (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
    if (href) copyDefanged(href)
  }
  a.addEventListener('click', copy)
  a.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') copy(e)
  })
}
