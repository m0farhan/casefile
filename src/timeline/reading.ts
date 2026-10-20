import { MarkdownView, setIcon, type MarkdownPostProcessorContext, type Plugin, type TFile } from 'obsidian'
import { defangText } from '../soc/toolbox'
import type { IocType } from '../types'
import { copyDefanged } from '../ui/defangMenu'
import {
  CLS,
  headerShape,
  iocIcon,
  kindClass,
  linkIcon,
  linkKind,
  renderGap,
  renderHeader,
  renderNode,
  renderSpawn,
  renderStepNode,
  renderUntimedChip
} from './dom'
import {
  defangTimelineText,
  findTimelines,
  indicatorSpans,
  mayHoldTimeline,
  type ChainLink,
  type Span,
  type TimelineBlock,
  type TimelineEvent,
  type TimelineFact,
  type TimelineGap,
  type TimelineStep
} from './parse'

/**
 * The note timeline in Reading view: a markdown post-processor that draws the
 * list under a `%% timeline %%` line as cards on a rail (numbered steps, or a
 * process chain's cards, for the other markers). It only adds classes and
 * widgets around what Obsidian rendered, and wraps text it can match to the
 * parser's reading; what it cannot match stays as rendered. Indicators are
 * shown defanged and links never open: a click copies the link defanged.
 */

const TEXT_NODE = 3
const ELEMENT_NODE = 1
const ATTACK = /\bT\d{4}(?:\.\d{3})?\b/g
const SOURCE = /^\s*source:/i
/** A line that starts a list item of its own, as a fact's bullet does. */
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])(?:\s|$)/
/** Obsidian's own list furniture, not the bullet's content. */
const FURNITURE = ['list-bullet', 'list-collapse-indicator']

/** The last note text read, so the sections of one render parse it once. */
let parsed: { text: string; lines: string[]; blocks: TimelineBlock[] } | null = null

function timelinesOf(text: string): { lines: string[]; blocks: TimelineBlock[] } {
  if (parsed?.text !== text) {
    const marked = mayHoldTimeline(text)
    const lines = marked ? text.split(/\r?\n/) : []
    parsed = { text, lines, blocks: marked ? findTimelines(lines) : [] }
  }
  return parsed
}

/** The timeline whose list starts in a section's lines, with the note's lines. Null when there is none to draw. */
export function sectionTimeline(
  text: string,
  lineStart: number,
  lineEnd: number
): { block: TimelineBlock; lines: string[] } | null {
  const { lines, blocks } = timelinesOf(text)
  // The marker is stripped from the rendered DOM; it sits just above the
  // list, in this section or the one before, so the list's first line decides.
  const block = blocks.find((b) => b.events.length && b.firstLine >= lineStart && b.firstLine <= lineEnd)
  return block ? { block, lines } : null
}

/**
 * What Reading view draws from beyond each list's own text: which lists have
 * a marker above them, how far above, and in which style. ponytail: a marker
 * moved to another list in one edit keeps the shape and is missed; key each
 * timeline by its list's text if that turns up.
 */
const shapeOf = (blocks: TimelineBlock[]): string =>
  blocks
    .filter((b) => b.events.length)
    .map((b) => `${b.style} ${b.firstLine - b.markerLine}`)
    .join()

/**
 * Per note, the shape Reading view was drawn from, kept for a note with no
 * timeline too. The post-processor only seeds it: a change from outside
 * reaches Reading view before the metadata cache reports it, and Obsidian
 * redraws only the sections it touched, such as the marker's own. Recording
 * the new shape then would leave the list drawn from the old one for good.
 */
const drawnShape = new Map<string, string>()

/**
 * Redraws Reading view when a note's timelines change but no list's own text
 * does. Obsidian keeps a rendered section while its HTML is unchanged, and the
 * marker renders to an empty paragraph of its own (or to nothing in the
 * paragraph above), so adding or removing it, or the blank line under it,
 * never reaches the post-processor. Editor changes arrive as 'quick-preview';
 * changes from outside (sync, another app) as the metadata cache's 'changed'.
 */
export function redrawOnTimelineChange(plugin: Plugin): void {
  const { workspace, metadataCache } = plugin.app
  const check = (file: TFile, data: string) => {
    const shape = shapeOf(timelinesOf(data).blocks)
    if ((drawnShape.get(file.path) ?? '') === shape) return
    drawnShape.set(file.path, shape)
    for (const leaf of workspace.getLeavesOfType('markdown')) {
      // A view in Live Preview redraws its hidden Reading half too, for when it is shown.
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) leaf.view.previewMode.rerender(true)
    }
  }
  plugin.registerEvent(workspace.on('quick-preview', check))
  plugin.registerEvent(metadataCache.on('changed', check))
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
 * runs are defanged too, as Defang timeline defangs, so nothing it would
 * defang is shown live.
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
    if (to > at) segs.push({ text: defangTimelineText(text.slice(at, to)), cls: null })
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
  if (!info) return
  if (!drawnShape.has(ctx.sourcePath)) drawnShape.set(ctx.sourcePath, shapeOf(timelinesOf(info.text).blocks))
  const found = sectionTimeline(info.text, info.lineStart, info.lineEnd)
  if (!found) return
  const { block, lines } = found
  const lists = Array.from(el.children).filter((c): c is HTMLElement => c.tagName === 'UL')
  const items = lists.flatMap((l) => Array.from(l.children).filter((c): c is HTMLElement => c.tagName === 'LI'))
  const extra = items.length - block.events.length
  // Obsidian marks each item with its line in the section; an unmarked list
  // can only be matched by its count.
  const onItsLine = (event: TimelineEvent, i: number) => {
    const at = items[i].getAttribute('data-line')
    return at === null ? extra === 0 : info.lineStart + Number(at) === event.line
  }
  if (extra < 0 || !block.events.every(onItsLine) || lists.some((l) => l.hasClass(CLS.list))) return
  // A chain's links are every item, nested ones too: Markdown must nest them as the note reads them.
  const links =
    block.style === 'chain' ? chainItems(items.slice(0, block.events.length), block.links, info.lineStart) : []
  if (!links) return
  if (extra) {
    // Markdown runs the list on past the timeline (an unindented line
    // continues the bullet above): the items after it stay a plain list
    // below, as Live Preview shows them.
    const last = lists[lists.length - 1]
    const rest = last.cloneNode(false) as HTMLElement
    last.after(rest)
    rest.append(...items.slice(block.events.length))
  }
  for (const list of lists) list.addClass(CLS.list)
  if (block.style !== 'events') for (const list of lists) list.addClass(CLS[block.style])
  lists[0].before(renderHeader(el, block.summary, {}, headerShape(block)))
  if (block.style === 'steps') {
    block.steps.forEach((step, i) => decorateStep(items[i], step, lines[step.event.line]))
    if (block.facts.length) {
      // The facts go in a list of their own below the steps, off their rail.
      const details = items[block.events.length - 1]
      const facts = el.createEl('ul', { cls: CLS.factsList })
      lists[lists.length - 1].after(facts)
      facts.append(details)
      lists.push(facts)
      decorateFacts(details, block.facts, lines, info.lineStart)
    }
  } else if (block.style === 'chain') {
    links.forEach((item, k) => decorateLink(item, block.links[k], lines[block.links[k].line]))
  } else block.events.forEach((event, i) => decorateItem(items[i], event, block.gaps[i], lines[event.line]))
  // Obsidian loads an embedded note (![[…]]) into a card after the
  // post-processors ran, and again when that note changes: what it adds is
  // disarmed and defanged like the card's own text.
  const observer = new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach(disarmAdded)
  })
  for (const list of lists) observer.observe(list, { childList: true, subtree: true })
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
    if (code) node.data = defangTimelineText(node.data)
    else replaceText(node, splitIndicators(node.data))
  }
  disarm(li)
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

const isList = (n: ChildNode): boolean => n.nodeType === ELEMENT_NODE && /^[OU]L$/.test((n as HTMLElement).tagName)
const isFurniture = (n: ChildNode): boolean =>
  n.nodeType === ELEMENT_NODE && FURNITURE.some((c) => (n as HTMLElement).hasClass(c))

/** The items of the lists directly under an item. */
const subItems = (li: HTMLElement): HTMLElement[] =>
  Array.from(li.children)
    .filter((c) => isList(c))
    .flatMap((l) => Array.from(l.children).filter((c): c is HTMLElement => c.tagName === 'LI'))

/**
 * Every item of a chain's list, nested ones too, in note order: one per link,
 * each on its link's line where Obsidian marks it. Null when Markdown nested
 * the list otherwise (a one-space indent is a child to the parser and a
 * sibling to Markdown): the list is left as rendered.
 */
function chainItems(roots: HTMLElement[], links: ChainLink[], lineStart: number): HTMLElement[] | null {
  const tree = (li: HTMLElement): HTMLElement[] => [li, ...subItems(li).flatMap(tree)]
  const all = roots.flatMap(tree)
  if (all.length !== links.length) return null
  const ok = all.every((li, k) => {
    const at = li.getAttribute('data-line')
    return at === null || lineStart + Number(at) === links[k].line
  })
  return ok ? all : null
}

/**
 * The item's text as a label row over its value. The rendered text must
 * start with `head`, the text before the value as written; drawHead draws
 * that row from the parser's reading instead (none when there is no head).
 * What follows, up to a nested list, becomes the value, and what comes after
 * a line break in it a line of `noteCls` below. Left as rendered, and null,
 * when the text does not start as written.
 */
function labelAndValue(
  item: HTMLElement,
  head: string,
  drawHead: ((row: HTMLElement) => void) | null,
  valueCls: string[],
  noteCls: string
): HTMLElement | null {
  const first = firstContent(item)
  const parent = first?.parentElement
  // Markdown trims the spaces off the end of an item that is all head.
  const written = head.trimEnd()
  if (first?.nodeType !== TEXT_NODE || !parent || !(first as Text).data.startsWith(written)) return null
  const text = first as Text
  if (drawHead) {
    const row = parent.createDiv({ cls: CLS.head })
    text.before(row)
    drawHead(row)
  }
  text.data = text.data.slice(written.length).trimStart()
  const value = parent.createDiv({ cls: [CLS.value, ...valueCls] })
  text.before(value)
  const nodes = Array.from(parent.childNodes)
  const rest = nodes.slice(nodes.indexOf(text))
  const end = rest.findIndex(isList)
  value.append(...(end < 0 ? rest : rest.slice(0, end)))
  const inValue = Array.from(value.childNodes)
  const br = inValue.findIndex((n) => (n as HTMLElement).tagName === 'BR')
  if (br >= 0) {
    const note = parent.createDiv({ cls: noteCls })
    value.after(note)
    inValue[br].remove()
    note.append(...inValue.slice(br + 1))
  }
  return value
}

/**
 * Steps and chains chip nothing: the note's own text under el is defanged
 * before anything is added, as Defang reads a line (a program's file name,
 * cmd.exe, is no domain). The label row is drawn from the parser's text only
 * where the defanged text still starts with it, so Defang left it as written.
 */
function defangAll(el: HTMLElement): void {
  for (const { node } of textNodes(el, false)) defangNode(node)
}

/** A step: its number on the rail, its label and the time as written above its value. */
function decorateStep(li: HTMLElement, step: TimelineStep, line: string): void {
  li.addClass(CLS.item, CLS.step)
  defangAll(li)
  const { event } = step
  const t = event.timeSpan
  const time: Piece | null = t && {
    text: line.slice(t.from, t.to),
    cls: event.time?.approx ? `${CLS.time} ${CLS.approx}` : CLS.time,
    sec: event.secondsSpan && { from: event.secondsSpan.from - t.from, to: event.secondsSpan.to - t.from }
  }
  const head = line.slice(event.textFrom, step.value.from)
  labelAndValue(
    li,
    head,
    head.trim()
      ? (row) => {
          if (step.labelText !== null) row.createSpan({ cls: CLS.label, text: step.labelText })
          if (time) pieceSpan(row, time)
        }
      : null,
    linkKind(step) ? [CLS.mono] : [],
    CLS.detail
  )
  disarm(li)
  for (const d of subItems(li)) d.addClass(CLS.detail)
  li.prepend(renderStepNode(li, step.n))
}

/** The closing Details bullet: its word as a title over its facts, each a key over its value. */
function decorateFacts(li: HTMLElement, facts: TimelineFact[], lines: string[], lineStart: number): void {
  li.addClass(CLS.facts)
  defangAll(li)
  const title = firstContent(li)
  if (title?.nodeType === TEXT_NODE && title.parentElement) {
    title.before(title.parentElement.createSpan({ cls: CLS.factsTitle, text: (title as Text).data.trim() }))
    title.remove()
  }
  // Each item is a fact a bullet starts, found by its line where Obsidian marks it, else in order.
  const bulleted = facts.filter((f) => LIST_ITEM.test(lines[f.line]))
  subItems(li).forEach((item, i) => {
    const at = item.getAttribute('data-line')
    const fact = at === null ? bulleted[i] : facts.find((f) => f.line === lineStart + Number(at))
    if (!fact) return
    item.addClass(CLS.fact)
    const line = lines[fact.line]
    const head = line.slice(fact.label?.from ?? fact.value.from, fact.value.from)
    labelAndValue(
      item,
      head,
      fact.labelText === null ? null : (row) => row.createSpan({ cls: CLS.factKey, text: fact.labelText ?? '' }),
      // A fact's value is an identifier, whatever its shape.
      [CLS.mono],
      CLS.factMore
    )
  })
  disarm(li)
}

/**
 * A chain link: its own content in a card, the links it spawned below the
 * card, and the 'Spawns' connector above it when it is a child. The card has
 * the label and the role over the value, which is monospace after its icon.
 */
function decorateLink(li: HTMLElement, link: ChainLink, line: string): void {
  li.addClass(link.parent === null ? CLS.root : CLS.child)
  const card = li.createDiv({ cls: CLS.card })
  card.append(...Array.from(li.childNodes).filter((n) => n !== card && !isList(n) && !isFurniture(n)))
  li.prepend(card)
  // The card holds the link's own text only: each link below defangs its own.
  defangAll(card)
  const head = line.slice(link.label?.from ?? link.value.from, link.value.from)
  const value = labelAndValue(
    card,
    head,
    (row) => {
      if (link.labelText !== null) row.createSpan({ cls: CLS.label, text: link.labelText })
      row.createSpan({ cls: CLS.role, text: link.role })
    },
    [CLS.mono],
    CLS.detail
  )
  if (value && link.valueText) {
    const icon = value.createSpan({ cls: CLS.valueIcon, attr: { 'aria-hidden': 'true' } })
    setIcon(icon, linkIcon(link))
    value.prepend(icon)
  }
  disarm(card)
  if (link.parent !== null) li.prepend(renderSpawn(li))
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

/** Content added to a card after it was drawn: its text defanged, its links and iframes disarmed. */
function disarmAdded(node: Node): void {
  if (node.nodeType === TEXT_NODE) defangNode(node as Text)
  else if (node.nodeType === ELEMENT_NODE) {
    for (const { node: text } of textNodes(node as Element, false)) defangNode(text)
    disarm(node as HTMLElement)
  }
}

function defangNode(node: Text): void {
  const data = defangTimelineText(node.data)
  if (data !== node.data) node.data = data
}

/**
 * Every link under el (el included) neutralised, past internal links and
 * tags, which still open. An iframe would load its page in the card: it
 * becomes a link that copies the page defanged.
 */
function disarm(el: HTMLElement): void {
  const within = (tag: string) => [
    ...(el.matches(tag) ? [el] : []),
    ...Array.from(el.querySelectorAll<HTMLElement>(tag))
  ]
  for (const frame of within('iframe')) {
    const page = frame.getAttribute('src')
    const link = page && frame.parentElement?.createEl('a', { text: defangText(page), attr: { href: page } })
    if (!link) continue
    neutralise(link)
    frame.replaceWith(link)
  }
  for (const a of within('a')) {
    if (!a.hasClass('internal-link') && !a.hasClass('tag') && !a.hasClass(CLS.link)) neutralise(a)
  }
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
