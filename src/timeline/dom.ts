import { setIcon } from 'obsidian'
import type { IocType } from '../types'
import {
  formatDay,
  type ChainLink,
  type EventKind,
  type TimelineBlock,
  type TimelineGap,
  type TimelineStyle,
  type TimelineSummary
} from './parse'

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
  stepNode: 'cf-ntl-step-node',
  role: 'cf-ntl-role',
  roleAlone: 'cf-ntl-role-alone',
  spawn: 'cf-ntl-spawn',
  valueIcon: 'cf-ntl-value-icon',
  // Reading view
  list: 'cf-ntl-list',
  item: 'cf-ntl-item',
  link: 'cf-ntl-link',
  iocIcon: 'cf-ntl-ioc-icon',
  sourceIcon: 'cf-ntl-source-icon',
  card: 'cf-ntl-card',
  factsList: 'cf-ntl-facts-list',
  factsTitle: 'cf-ntl-facts-title',
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
  // Steps and chains: the style on every line or list, then each part
  steps: 'cf-ntl-steps',
  chain: 'cf-ntl-chain',
  step: 'cf-ntl-step',
  facts: 'cf-ntl-facts',
  factsHead: 'cf-ntl-facts-head',
  fact: 'cf-ntl-fact',
  factMore: 'cf-ntl-fact-more',
  proc: 'cf-ntl-proc',
  procEnd: 'cf-ntl-proc-end',
  root: 'cf-ntl-root',
  child: 'cf-ntl-child',
  spawned: 'cf-ntl-spawned',
  // Marks on the text
  lead: 'cf-ntl-lead',
  time: 'cf-ntl-time',
  sec: 'cf-ntl-sec',
  approx: 'cf-ntl-approx',
  tag: 'cf-ntl-tag',
  colon: 'cf-ntl-colon',
  ioc: 'cf-ntl-ioc',
  iocLive: 'cf-ntl-ioc-live',
  att: 'cf-ntl-att',
  head: 'cf-ntl-head',
  label: 'cf-ntl-label',
  sep: 'cf-ntl-sep',
  value: 'cf-ntl-value',
  mono: 'cf-ntl-mono',
  factKey: 'cf-ntl-fact-key',
  factPad: 'cf-ntl-fact-pad',
  factMoreText: 'cf-ntl-fact-more-text'
} as const

/** The colour class every line, card and node of an event carries. */
export const kindClass = (kind: EventKind): string => `cf-ntl-k-${kind}`

const KIND_LABELS: Record<EventKind, string> = {
  observed: 'Observed',
  web: 'Web',
  execution: 'Execution',
  file: 'File / download',
  email: 'Email',
  user: 'User',
  host: 'Host',
  detection: 'Detection',
  response: 'Response'
}

const KIND_ICONS: Record<EventKind, string | null> = {
  observed: null,
  web: 'globe',
  execution: 'terminal',
  file: 'file',
  email: 'mail',
  user: 'user',
  host: 'monitor',
  detection: 'siren',
  response: 'shield-check'
}

export const kindLabel = (kind: EventKind): string => KIND_LABELS[kind]

/** The lucide icon for an indicator chip. */
export const iocIcon = (type: IocType): string => (type === 'hash' ? 'hash' : type === 'email' ? 'mail' : 'globe')

/** A program a link runs, by its file name: what Details calls a File path, but a process here. */
const PROGRAM_FILE = /\.(?:exe|bat|cmd|com|ps1|vbs|hta|msi|scr)$/i

/**
 * A chain link's value icon, by what the value names: a program run is the
 * root's terminal or a child's activity, then a user, a host, a place on the
 * web, a file; anything else a dot.
 */
export function linkIcon(link: Pick<ChainLink, 'valueKind' | 'valueText' | 'depth'>): string {
  const kind = link.valueKind
  if (kind === 'Command line' || (kind === 'File path' && PROGRAM_FILE.test(link.valueText.replace(/["']/g, '')))) {
    return link.depth === 0 ? 'terminal' : 'activity'
  }
  if (kind === 'User') return 'user'
  if (kind === 'Hostname') return 'monitor'
  if (kind === 'URL' || kind === 'Domain' || kind === 'IP') return 'globe'
  return kind === 'File path' ? 'file' : 'circle-dot'
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** What a header counts besides the summary: an events header says its times, steps and chains their own parts. */
export type HeaderShape =
  | { style: 'events' }
  | { style: 'steps'; steps: number; facts: boolean }
  | { style: 'chain'; links: number; spawns: number }

export function headerShape(block: TimelineBlock): HeaderShape {
  if (block.style === 'steps') return { style: 'steps', steps: block.steps.length, facts: block.facts.length > 0 }
  if (block.style === 'chain') {
    return { style: 'chain', links: block.links.length, spawns: block.links.filter((l) => l.parent !== null).length }
  }
  return { style: 'events' }
}

const HEADS: Record<TimelineStyle, { icon: string; title: string }> = {
  events: { icon: 'git-commit-vertical', title: 'Timeline' },
  steps: { icon: 'list-ordered', title: 'Steps' },
  chain: { icon: 'git-fork', title: 'Process chain' }
}

function derivedBadge(parent: HTMLElement): void {
  parent.appendText(' ')
  // Lower-cased by the stylesheet; the text stays in sentence case for the lint and for copy.
  parent.createSpan({ cls: CLS.derived, text: 'Derived' })
}

/**
 * The strip that stands in for the marker line: what the timeline holds, when
 * it runs, and how many indicators in it are live. Steps count their steps and
 * chains their links instead of times. Defang and the menu are offered only by
 * a caller that can act on them.
 */
export function renderHeader(
  parent: HTMLElement,
  summary: TimelineSummary,
  opts: { onMenu?: (evt: MouseEvent) => void; onDefang?: () => void },
  shape: HeaderShape = { style: 'events' }
): HTMLElement {
  const { onMenu, onDefang } = opts
  const header = parent.createDiv({ cls: CLS.header })
  setIcon(header.createSpan({ cls: CLS.headerIcon, attr: { 'aria-hidden': 'true' } }), HEADS[shape.style].icon)
  header.createSpan({ cls: CLS.title, text: HEADS[shape.style].title })
  const meta = header.createSpan({ cls: CLS.meta })
  if (shape.style === 'steps') meta.appendText(plural(shape.steps, 'step') + (shape.facts ? ' · details below' : ''))
  else if (shape.style === 'chain') {
    meta.appendText(plural(shape.links, 'link') + (shape.spawns ? ` · ${plural(shape.spawns, 'spawn')}` : ''))
  } else {
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
  }
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

/** A step's number on the rail, in place of its bullet. */
export function renderStepNode(parent: HTMLElement, n: number): HTMLElement {
  return parent.createSpan({ cls: [CLS.node, CLS.stepNode], text: String(n) })
}

/** What sits between a chain link and each link it spawned: read off the indent, nothing to type. */
export function renderSpawn(parent: HTMLElement): HTMLElement {
  const spawn = parent.createDiv({ cls: CLS.spawn, text: 'Spawns' })
  setIcon(spawn.createSpan({ cls: CLS.chipIcon, attr: { 'aria-hidden': 'true' } }), 'arrow-down')
  return spawn
}

/** The row under the last card that adds an event, or what the style calls one. */
export function renderAddEvent(parent: HTMLElement, onClick: () => void, label = 'Add event'): HTMLElement {
  const row = parent.createDiv({ cls: CLS.add, attr: { role: 'button', tabindex: '0' } })
  setIcon(row.createSpan({ cls: CLS.chipIcon, attr: { 'aria-hidden': 'true' } }), 'plus')
  row.appendText(label)
  row.addEventListener('click', () => onClick())
  row.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onClick()
  })
  return row
}
