import { setIcon } from 'obsidian'
import type { IocType } from '../types'
import { formatDay, type EventKind, type TimelineGap, type TimelineSummary } from './parse'

/**
 * The note timeline's pieces, built one way for Reading view and the Live
 * Preview widgets so both draw the same look (note-timeline.css). Each
 * builder appends to `parent` and returns what it built, so a caller can move
 * it into place or hand it to CodeMirror from a widget's toDOM. What the
 * builders show is the parser's reading; the derived parts say so.
 */

export const CLS = {
  // Header (the marker line)
  header: 'cf-ntl-header',
  headerIcon: 'cf-ntl-header-icon',
  title: 'cf-ntl-title',
  meta: 'cf-ntl-meta',
  derived: 'cf-ntl-derived',
  live: 'cf-ntl-live',
  defang: 'cf-ntl-defang',
  menu: 'cf-ntl-menu',
  // Widgets
  node: 'cf-ntl-node',
  nodeExplicit: 'cf-ntl-node-explicit',
  nodeKey: 'cf-ntl-node-key',
  band: 'cf-ntl-band',
  bandLong: 'cf-ntl-band-long',
  bandBack: 'cf-ntl-band-back',
  bandDay: 'cf-ntl-band-day',
  gapChip: 'cf-ntl-gap-chip',
  chipIcon: 'cf-ntl-chip-icon',
  breakMark: 'cf-ntl-break',
  longLabel: 'cf-ntl-long-label',
  dayDate: 'cf-ntl-day-date',
  untimed: 'cf-ntl-untimed',
  add: 'cf-ntl-add',
  // Reading view
  list: 'cf-ntl-list',
  item: 'cf-ntl-item',
  link: 'cf-ntl-link',
  iocIcon: 'cf-ntl-ioc-icon',
  sourceIcon: 'cf-ntl-source-icon',
  // Lines: Live Preview .cm-line classes; Reading view puts the same ones on each <li>
  line: 'cf-ntl-line',
  ev: 'cf-ntl-ev',
  detail: 'cf-ntl-detail',
  source: 'cf-ntl-source',
  first: 'cf-ntl-first',
  last: 'cf-ntl-last',
  cardTop: 'cf-ntl-card-top',
  cardBottom: 'cf-ntl-card-bottom',
  explicit: 'cf-ntl-explicit',
  key: 'cf-ntl-key',
  active: 'cf-ntl-active',
  gap: 'cf-ntl-gap',
  gapLong: 'cf-ntl-gap-long',
  day: 'cf-ntl-day',
  markerLine: 'cf-ntl-marker-line',
  // Marks on the text
  lead: 'cf-ntl-lead',
  time: 'cf-ntl-time',
  sec: 'cf-ntl-sec',
  approx: 'cf-ntl-approx',
  tag: 'cf-ntl-tag',
  colon: 'cf-ntl-colon',
  ioc: 'cf-ntl-ioc',
  iocLive: 'cf-ntl-ioc-live',
  att: 'cf-ntl-att'
} as const

/** The colour class every line, card and node of an event carries. */
export const kindClass = (kind: EventKind): string => `cf-ntl-k-${kind}`

const KIND_LABELS: Record<EventKind, string> = {
  observed: 'Observed',
  web: 'Web',
  execution: 'Execution',
  file: 'File / download',
  email: 'Email',
  detection: 'Detection',
  response: 'Response'
}

const KIND_ICONS: Record<EventKind, string | null> = {
  observed: null,
  web: 'globe',
  execution: 'terminal',
  file: 'file',
  email: 'mail',
  detection: 'siren',
  response: 'shield-check'
}

export const kindLabel = (kind: EventKind): string => KIND_LABELS[kind]

/** The lucide icon for an indicator chip. */
export const iocIcon = (type: IocType): string => (type === 'hash' ? 'hash' : type === 'email' ? 'mail' : 'globe')

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

function derivedBadge(parent: HTMLElement): void {
  parent.appendText(' ')
  // Lower-cased by the stylesheet; the text stays in sentence case for the lint and for copy.
  parent.createSpan({ cls: CLS.derived, text: 'Derived' })
}

/**
 * The strip that stands in for the marker line: what the timeline holds, when
 * it runs, and how many indicators in it are live. Defang and the menu are
 * offered only by a caller that can act on them.
 */
export function renderHeader(
  parent: HTMLElement,
  summary: TimelineSummary,
  opts: { onMenu?: (evt: MouseEvent) => void; onDefang?: () => void }
): HTMLElement {
  const { onMenu, onDefang } = opts
  const header = parent.createDiv({ cls: CLS.header })
  setIcon(header.createSpan({ cls: CLS.headerIcon, attr: { 'aria-hidden': 'true' } }), 'git-commit-vertical')
  header.createSpan({ cls: CLS.title, text: 'Timeline' })
  const meta = header.createSpan({ cls: CLS.meta })
  const { first, last } = summary
  const parts = [plural(summary.count, 'event')]
  if (summary.date) parts.push(formatDay(summary.date))
  else if (summary.dateText) parts.push(summary.dateText)
  if (first) parts.push(last && last !== first ? `${first} → ${last}` : first)
  meta.appendText(parts.join(' · '))
  if (summary.span) {
    meta.appendText(` · ${summary.span} span`)
    derivedBadge(meta)
  }
  if (summary.untimed) meta.appendText(` · ${summary.untimed} without a time`)
  if (summary.live) {
    const pill = header.createSpan({ cls: CLS.live, text: plural(summary.live, 'live indicator') })
    if (onDefang) {
      pill.appendText(' · ')
      pill
        .createEl('button', { cls: CLS.defang, text: 'Defang', attr: { type: 'button' } })
        .addEventListener('click', () => onDefang())
    }
  }
  if (onMenu) {
    const menu = header.createEl('button', {
      cls: ['clickable-icon', CLS.menu],
      attr: { type: 'button', 'aria-label': 'Timeline menu' }
    })
    setIcon(menu, 'more-horizontal')
    menu.addEventListener('click', (evt) => onMenu(evt))
  }
  return header
}

/**
 * The event's dot on the rail. Its label names the kind and says when the
 * kind was read off the text rather than written. A caller that makes it
 * clickable (the kind picker) turns the role into a button.
 */
export function renderNode(parent: HTMLElement, kind: EventKind, explicit: boolean, key: boolean): HTMLElement {
  const derived = kind !== 'observed' && !explicit
  const label = `${kindLabel(kind)} event${derived ? ', kind derived from the text' : ''}${key ? ', key event' : ''}`
  const node = parent.createSpan({ cls: [CLS.node, kindClass(kind)], attr: { role: 'img', 'aria-label': label } })
  if (explicit && kind !== 'observed') node.addClass(CLS.nodeExplicit)
  if (key) node.addClass(CLS.nodeKey)
  const icon = KIND_ICONS[kind]
  if (icon) setIcon(node, icon)
  return node
}

/**
 * The band above an event: the derived gap from the event above as a pill, a
 * break in the rail for a long one, a warning when the time runs backwards,
 * or a day band when the date changes. The tooltip says how it was derived.
 */
export function renderGap(parent: HTMLElement, gap: TimelineGap): HTMLElement {
  const band = parent.createDiv({ cls: CLS.band, attr: { title: gap.tooltip } })
  if (gap.dayChange) {
    band.addClass(CLS.bandDay)
    band.createSpan({ cls: CLS.dayDate, text: formatDay(gap.dayChange) })
    band.appendText(` · ${gap.label}`)
    derivedBadge(band)
  } else if (gap.outOfOrder) {
    band.addClass(CLS.bandBack)
    const chip = band.createSpan({ cls: CLS.gapChip })
    setIcon(chip.createSpan({ cls: CLS.chipIcon, attr: { 'aria-hidden': 'true' } }), 'arrow-up')
    chip.appendText(gap.label)
  } else if (gap.long) {
    band.addClass(CLS.bandLong)
    band.createSpan({ cls: CLS.breakMark, attr: { 'aria-hidden': 'true' } })
    band.createSpan({ cls: CLS.longLabel, text: gap.label })
  } else band.createSpan({ cls: CLS.gapChip, text: gap.label })
  return band
}

/** Where a time would be when the bullet has none the parser could read. Display only, never written. */
export function renderUntimedChip(parent: HTMLElement, unread?: string | null): HTMLElement {
  // Lower-cased by the stylesheet, as the mockup shows it.
  const chip = parent.createSpan({ cls: CLS.untimed, text: 'Time not recorded' })
  if (unread) chip.setAttr('title', `Not read as a time: ${unread}`)
  return chip
}

/** The row under the last card that adds an event. */
export function renderAddEvent(parent: HTMLElement, onClick: () => void): HTMLElement {
  const row = parent.createDiv({ cls: CLS.add, attr: { role: 'button', tabindex: '0' } })
  setIcon(row.createSpan({ cls: CLS.chipIcon, attr: { 'aria-hidden': 'true' } }), 'plus')
  row.appendText('Add event')
  row.addEventListener('click', () => onClick())
  row.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onClick()
  })
  return row
}
