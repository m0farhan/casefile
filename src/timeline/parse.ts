import type { IocType } from '../types'
import { NAME_LIKE, detectDetailField } from '../soc/detailKind'
import { detectIocType, extractIocsFromText } from '../soc/ioc'
import { defangText } from '../soc/toolbox'

/**
 * The note timeline's reader: the bullet list under a `%% timeline %%` line,
 * read as an incident's events. Pure: lines in, a description out, nothing
 * written back. What it cannot read stays as written and is said to be unread,
 * never guessed: a bullet without a time it can read is "time not recorded",
 * and every gap and span it reports is derived from two written times. The
 * marker names the style the list is drawn in; the block rules are the same
 * for every style.
 */

export const TIMELINE_MARKER = '%% timeline %%'

/** Events in time (the plain marker), numbered steps, or a process chain. */
export type TimelineStyle = 'events' | 'steps' | 'chain'

const MARKER = /^%% timeline(?: (\S+))? %%$/

/** The marker line for a style. */
export const markerFor = (style: TimelineStyle): string =>
  style === 'events' ? TIMELINE_MARKER : `%% timeline ${style} %%`

/** The style a marker line names, the style word in any case; null when the line is no marker. */
export function markerStyle(line: string): TimelineStyle | null {
  const m = MARKER.exec(line.trim())
  if (!m) return null
  const word = m[1]?.toLowerCase()
  return word === undefined ? 'events' : word === 'steps' || word === 'chain' ? word : null
}

/** Whether a note may hold a timeline, before it is split into lines: one string scan. */
export const mayHoldTimeline = (text: string): boolean => text.includes('%% timeline')

export type EventKind = 'observed' | 'web' | 'execution' | 'file' | 'email' | 'user' | 'host' | 'detection' | 'response'

/** Columns in the full line string, end exclusive. */
export interface Span {
  from: number
  to: number
}

export interface DayDate {
  y: number
  m: number
  d: number
}

/**
 * A time as the analyst wrote it. `raw` is the time phrase verbatim (no lead
 * word); `date` is stated on this bullet or carried from the last bullet that
 * stated one (`dateStated` says which); `minutes` counts from midnight on the
 * clock as written. The zone is kept as written and never converted.
 */
export interface EventTime {
  raw: string
  date: DayDate | null
  /** A date as written whose day cannot be read (10/9/26: day/month order
   * unknown). Kept verbatim: it names the same day as an equal text, and no
   * other day can be ordered against it. */
  dateText: string | null
  dateStated: boolean
  minutes: number | null
  seconds: number | null
  ms: number | null
  approx: boolean
  zone: string | null
  end: { minutes: number; seconds: number | null } | null
}

export interface TimelineDetail {
  line: number
  text: string
  source: boolean
}

export interface TimelineIoc {
  span: Span
  type: IocType
  live: boolean
}

export interface TimelineEvent {
  line: number
  lastLine: number
  indent: string
  /** The bullet text after the list marker and a task's box. */
  text: string
  /** Column where text starts. */
  textFrom: number
  /** Lead word(s) such as "On", "At", "~". */
  lead: Span | null
  time: EventTime | null
  timeSpan: Span | null
  secondsSpan: Span | null
  /** A leading token that looks like a time but is not read. */
  unread: string | null
  kind: EventKind
  kindExplicit: boolean
  /** The kind word including its colon. */
  kindSpan: Span | null
  key: boolean
  iocs: TimelineIoc[]
  attack: Span[]
  details: TimelineDetail[]
  /** Text after the lead, the time phrase, its trailing comma and the kind. */
  body: string
}

export interface TimelineGap {
  label: string
  long: boolean
  outOfOrder: boolean
  approx: boolean
  dayChange: DayDate | null
  tooltip: string
}

export interface TimelineSummary {
  /** The first date written as numbers (10/9/26), as written, when no date could be read. */
  dateText: string | null
  count: number
  date: DayDate | null
  first: string | null
  last: string | null
  span: string | null
  untimed: number
  live: number
}

/** A label before ': ' and the value after it, as columns of the line, and what the value is by its shape. */
export interface Labelled {
  /** Null when the text is all value. */
  label: Span | null
  labelText: string | null
  /** Empty (from === to) when there is none. */
  value: Span
  valueText: string
  /** detectDetailField's name for the value (Email, IP, URL, Domain, Hash, File path, …); null when its shape does not say. */
  valueKind: string | null
}

/** A numbered step: an event's text after its time phrase, read as label and value. */
export interface TimelineStep extends Labelled {
  /** 1 for the first step, in note order. */
  n: number
  /** The bullet, with its time (null when none is written) and details. */
  event: TimelineEvent
}

/** One fact under the closing Details or Facts bullet: its label is the key, null for a line that is not 'Key: value'. */
export interface TimelineFact extends Labelled {
  /** The detail line it starts on. */
  line: number
  /** The plain lines under it: more of its value (the IP under Host), each with its text and the text's columns. */
  more: { line: number; span: Span; text: string }[]
}

/** A link of a process chain: any bullet in the block. */
export interface ChainLink extends Labelled {
  line: number
  /** Last line of the link with its notes and the links under it: what move and delete take. */
  lastLine: number
  indent: string
  /** Column where the bullet's text starts, after its marker and a task's box. */
  textFrom: number
  /** 0 for a top-level bullet. */
  depth: number
  /** Index in `links` of the link it hangs under; null for a root. */
  parent: number | null
  /** Derived from the depth, display only. */
  role: 'Root process' | 'Spawned child'
  /** Its plain lines (code included), up to its first child. */
  notes: TimelineDetail[]
}

export interface TimelineBlock {
  markerLine: number
  style: TimelineStyle
  /** First event line; the marker line when the list is empty. */
  firstLine: number
  /** Last line of the last event, details included; the marker line when empty. */
  lastLine: number
  events: TimelineEvent[]
  /** gaps[i] sits above events[i]; gaps[0] is null. */
  gaps: (TimelineGap | null)[]
  summary: TimelineSummary
  /** Steps style: every event but a closing Details or Facts bullet. Empty in the other styles. */
  steps: TimelineStep[]
  /** Steps style: the facts under the last event when it is a Details or Facts bullet (not a step then). */
  facts: TimelineFact[]
  /** Chain style: every bullet in the block, in note order. Empty in the other styles. */
  links: ChainLink[]
}

// ─── The block ───────────────────────────────────────────────────────────────

const BULLET = /^([ \t]*)[-*+](?:[ \t]+|$)/
/** A task's box after the list marker, '[ ]', '[x]' or any one character as Obsidian reads it: part of the marker. */
const TASK_BOX = /^\[.\](?:[ \t]+|$)/
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
/** A fence opened in an event's detail, at any indent, after a sub-bullet's marker too. */
const DETAIL_FENCE = /^\s*(?:(?:[-*+]|\d{1,3}[.)])[ \t]+)?(`{3,}|~{3,})/
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/
/** A frontmatter fence: exactly '---', a CR allowed, as Obsidian reads it. */
const FRONTMATTER_FENCE = /^---\r?$/
const DETAIL_MARKER = /^(?:[-*+]|\d{1,3}[.)])[ \t]+/

const isBlank = (s: string | undefined): boolean => !s?.trim()
const indentOf = (s: string): number => s.length - s.trimStart().length

/**
 * The line that closes the note's YAML frontmatter, or -1 when it has none.
 * Read as Obsidian reads it: '---' on the first line, closed by the next line
 * that is exactly '---'.
 */
export function frontmatterEnd(lines: string[]): number {
  if (!FRONTMATTER_FENCE.test(lines[0] ?? '')) return -1
  return lines.findIndex((l, i) => i > 0 && FRONTMATTER_FENCE.test(l))
}

/**
 * Every timeline in a note, in order. A marker inside a fenced code block is
 * an example, not a timeline, so fences are skipped; so is the frontmatter,
 * where a marker would only break the note's properties.
 */
export function findTimelines(lines: string[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = []
  let fence = ''
  for (let i = frontmatterEnd(lines) + 1; i < lines.length; i++) {
    const f = FENCE.exec(lines[i])?.[1]
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = ''
      continue
    }
    const style = f ? null : markerStyle(lines[i])
    if (f) fence = f
    else if (style) {
      const block = readBlock(lines, i, style)
      blocks.push(block)
      i = block.lastLine
    }
  }
  return blocks
}

/**
 * The list under one marker: top-level bullets are events, anything indented
 * under one is its detail. It runs on across one blank line followed by more
 * of the list, and ends at anything else: a heading, two blank lines, a
 * paragraph or a less indented line. A fenced code block in an event, opened
 * in a detail or on the bullet itself, is its detail to the closing fence, '#'
 * lines and blank lines included; a line back at the list's indent ends it, as
 * Markdown ends the list item.
 */
function readBlock(lines: string[], markerLine: number, style: TimelineStyle): TimelineBlock {
  let i = markerLine + 1
  if (isBlank(lines[i]) && BULLET.test(lines[i + 1] ?? '')) i++
  const events: TimelineEvent[] = []
  // Changes Defang timeline would make that no event's indicators show: details, and what is not listed.
  let live = 0
  const base = BULLET.exec(lines[i] ?? '')?.[1].length ?? -1
  // A list keeps one bullet character: Markdown starts a new list where '-'
  // turns to '*' or '+', so Reading view draws that as a second list. The
  // timeline ends there too, and both views agree.
  const markOf = (s: string) => s.trimStart()[0]
  const baseMark = base < 0 ? '' : markOf(lines[i])
  const atBase = (s: string) => BULLET.exec(s)?.[1].length === base && markOf(s) === baseMark
  let carry: Carry = { date: null, text: null }
  let fence: { mark: string; indent: number } | null = null
  // Code lines are never a chain's link or a fact, whatever they start with.
  const codeLines = new Set<number>()
  const detail = (line: string, n: number, code: boolean) => {
    const event = events[events.length - 1]
    // Code keeps its indent under its fence, and a '- ' in it is code, not a marker.
    const text = code
      ? line.slice(Math.min(indentOf(line), fence?.indent ?? 0)).trimEnd()
      : line.trim().replace(DETAIL_MARKER, '')
    event.details.push({ line: n, text, source: !code && /^source:/i.test(text) })
    if (code) codeLines.add(n)
    event.lastLine = n
    const found = readIndicators(line)
    live += found.unlisted + found.iocs.filter((s) => s.live).length
  }
  // A marker with no list under it is an empty timeline, drawn with its header.
  if (base < 0) i = lines.length
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (fence && (isBlank(line) || indentOf(line) > base)) {
      if (isBlank(line)) continue
      detail(line, i, true)
      const close = FENCE_CLOSE.exec(line)?.[1]
      if (close && close[0] === fence.mark[0] && close.length >= fence.mark.length) fence = null
      continue
    }
    const unclosed = fence !== null
    fence = null
    if (HEADING.test(line)) break
    const bullet = BULLET.exec(line)
    if (bullet && bullet[1].length === base) {
      if (markOf(line) !== baseMark) break
      // The blank lines an unclosed fence took in are its list item's, so its event's:
      // delete and move take them with it rather than leave two that end the list.
      if (unclosed) events[events.length - 1].lastLine = i - 1
      const textFrom = bullet[0].length + (TASK_BOX.exec(line.slice(bullet[0].length))?.[0].length ?? 0)
      const found = readIndicators(line, textFrom)
      live += found.unlisted
      const event = readEvent(line, i, bullet[1], textFrom, found.iocs, carry)
      if (event.time?.dateStated) carry = { date: event.time.date, text: event.time.dateText }
      events.push(event)
      // '- ```' opens the fence on the bullet itself: its code sits at the text's column.
      const open = FENCE.exec(line.slice(bullet[0].length))?.[1]
      if (open) fence = { mark: open, indent: bullet[0].length }
    } else if (isBlank(line)) {
      const next = lines[i + 1] ?? ''
      if (isBlank(next) || HEADING.test(next) || (indentOf(next) <= base && !atBase(next))) break
    } else if (indentOf(line) > base) {
      const open = DETAIL_FENCE.exec(line)?.[1]
      detail(line, i, false)
      if (open) fence = { mark: open, indent: indentOf(line) }
    } else break
  }
  return {
    markerLine,
    style,
    firstLine: events[0]?.line ?? markerLine,
    lastLine: events.at(-1)?.lastLine ?? markerLine,
    events,
    gaps: events.map((e, n) => (n === 0 ? null : gapBetween(events[n - 1].time, e.time))),
    summary: summarise(events, live),
    ...(style === 'steps' ? readSteps(lines, events, codeLines) : { steps: [], facts: [] }),
    links: style === 'chain' ? readLinks(lines, events, codeLines) : []
  }
}

/** The block and event a line is on. A blank line inside the list belongs to the event above it. */
export function timelineAt(
  blocks: TimelineBlock[],
  line: number
): { block: TimelineBlock; event: TimelineEvent | null } | null {
  for (const block of blocks) {
    if (line === block.markerLine) return { block, event: null }
    if (!block.events.length || line < block.firstLine || line > block.lastLine) continue
    let event = block.events[0]
    for (const e of block.events) if (e.line <= line) event = e
    return { block, event }
  }
  return null
}

// ─── Steps and chains ────────────────────────────────────────────────────────

/** What a step or link is: named by its label, else by its value's shape. */
export type LinkKind =
  | 'process'
  | 'user'
  | 'host'
  | 'network'
  | 'file'
  | 'registry'
  | 'hash'
  | 'email'
  | 'service'
  | 'task'

/** The words a label names a kind with, as an analyst writes them. */
const LABEL_WORDS: Record<LinkKind, string> = {
  process:
    'process proc parent child image executable exe program binary launch launched spawned ran executed execution exec command cmd cmdline commandline script pid',
  user: 'user username account logon login identity principal owner',
  host: 'host hostname workstation endpoint server device computer machine asset laptop dc',
  network:
    'network connection ip address destination remote c2 beacon port domain url site website visited callback dns traffic',
  file: 'file filename dropped drop path artifact payload download downloaded attachment dll document library archive',
  registry: 'registry key hive regkey',
  hash: 'hash md5 sha1 sha256 sha imphash',
  email: 'email mail sender recipient message',
  service: 'service svc driver',
  task: 'task scheduled schtask cron job'
}
const LABEL_KIND = new Map(
  Object.entries(LABEL_WORDS).flatMap(([kind, words]) => words.split(' ').map((w) => [w, kind as LinkKind]))
)

/** The kind a label names, read from its last word back so the head noun decides; null when it names none. */
export function labelKind(label: string | null): LinkKind | null {
  const words = (label ?? '').toLowerCase().split(/[^a-z0-9]+/)
  for (let i = words.length - 1; i >= 0; i--) {
    const named = LABEL_KIND.get(words[i])
    if (named) return named
  }
  return null
}

/** The closing bullet that holds a steps list's facts. */
const FACTS = /^(?:details|facts):?$/i

/**
 * The text of a line from column `from` as label and value: split at the
 * first ': ' when what comes before it reads as a name (as Details reads a
 * pasted 'Field: value'), a label alone when the text ends in ':', else all
 * value.
 */
function labelled(line: string, from: number): Labelled {
  const end = Math.max(from, line.trimEnd().length)
  const text = line.slice(from, end)
  const colon = text.indexOf(': ')
  let label: Span | null = null
  let value: Span = { from, to: end }
  if (colon > 0 && NAME_LIKE.test(text.slice(0, colon))) {
    label = { from, to: from + colon }
    value = { from: end - text.slice(colon + 2).trimStart().length, to: end }
  } else if (text.length > 1 && text.endsWith(':')) {
    label = { from, to: end - 1 }
    value = { from: end, to: end }
  }
  const valueText = line.slice(value.from, value.to)
  return {
    label,
    labelText: label && line.slice(label.from, label.to),
    value,
    valueText,
    valueKind: detectDetailField(valueText)
  }
}

/**
 * Steps: each event is one, read after its time phrase (the kind word is the
 * step's label, not taken off it). A last bullet that says only Details or
 * Facts and has lines under it is not a step: those lines are the facts, a
 * bullet starting each and a plain line under one adding to it.
 */
function readSteps(
  lines: string[],
  events: TimelineEvent[],
  code: Set<number>
): { steps: TimelineStep[]; facts: TimelineFact[] } {
  const last = events.at(-1)
  const closing = last && FACTS.test(last.text.trim()) && last.details.length ? last : null
  const facts: TimelineFact[] = []
  for (const d of closing?.details ?? []) {
    const line = lines[d.line]
    const at = indentOf(line)
    const marker = code.has(d.line) ? undefined : DETAIL_MARKER.exec(line.slice(at))?.[0]
    const fact = facts.at(-1)
    if (!marker && fact) fact.more.push({ line: d.line, span: { from: at, to: line.trimEnd().length }, text: d.text })
    else facts.push({ line: d.line, ...labelled(line, at + (marker?.length ?? 0)), more: [] })
  }
  const steps = events
    .filter((e) => e !== closing)
    .map((event, i) => {
      const line = lines[event.line]
      // After the time phrase and its separator: where a kind word or the body starts.
      const from = event.kindSpan?.from ?? line.length - event.body.length
      return { n: i + 1, event, ...labelled(line, from) }
    })
  return { steps, facts }
}

/**
 * A chain's links: every event is a root, and a bullet in its details hangs
 * under the nearest link above with a smaller indent. A plain line, or any
 * line of code, is a note of the link above it.
 */
function readLinks(lines: string[], events: TimelineEvent[], code: Set<number>): ChainLink[] {
  const links: ChainLink[] = []
  for (const e of events) {
    const at = (line: number, indent: number, textFrom: number, parent: number | null): ChainLink => ({
      line,
      lastLine: line,
      indent: lines[line].slice(0, indent),
      textFrom,
      depth: parent === null ? 0 : links[parent].depth + 1,
      parent,
      role: parent === null ? 'Root process' : 'Spawned child',
      notes: [],
      ...labelled(lines[line], textFrom)
    })
    const start = links.length
    links.push(at(e.line, e.indent.length, e.textFrom, null))
    const path = [start]
    for (const d of e.details) {
      const line = lines[d.line]
      const indent = indentOf(line)
      const marker = code.has(d.line) ? undefined : DETAIL_MARKER.exec(line.slice(indent))?.[0]
      if (!marker) {
        links[path[path.length - 1]].notes.push(d)
        continue
      }
      while (path.length > 1 && links[path[path.length - 1]].indent.length >= indent) path.pop()
      const from = indent + marker.length
      const box = TASK_BOX.exec(line.slice(from))?.[0].length ?? 0
      path.push(links.push(at(d.line, indent, from + box, path[path.length - 1])) - 1)
    }
    // A link runs to the last line before the next one no deeper; the last ones to the event's end.
    const own = links.slice(start)
    own.forEach((l, k) => {
      const next = own.slice(k + 1).find((o) => o.depth <= l.depth)
      l.lastLine = next ? (e.details.filter((d) => d.line < next.line).at(-1)?.line ?? l.line) : e.lastLine
    })
  }
  return links
}

// ─── One bullet ──────────────────────────────────────────────────────────────

const KIND_WORDS: Record<string, EventKind> = {
  detection: 'detection',
  alert: 'detection',
  response: 'response',
  containment: 'response',
  action: 'response',
  execution: 'execution',
  web: 'web',
  file: 'file',
  download: 'file',
  email: 'email',
  user: 'user',
  account: 'user',
  host: 'host',
  workstation: 'host',
  endpoint: 'host',
  server: 'host',
  device: 'host'
}
// Whitespace after the colon, so file:///etc/passwd is a path, not a kind.
const KIND = new RegExp(`^(${Object.keys(KIND_WORDS).join('|')}):(?:[ \\t]+|$)`, 'i')
const KEY = /^\*\*[^*\s].*?\*\*/
const ATTACK = /\bT\d{4}(?:\.\d{3})?\b/g

const INLINE_CODE = /`[^`]+`/
const LOLBIN = /\b(?:powershell|pwsh|cmd|mshta|rundll32|regsvr32|certutil|wscript|cscript|bitsadmin)\b/i
const EXE_EXT = /\.(?:exe|ps1|hta|dll|bat|vbs|js|scr)(?![\w-])/i
// ponytail: a path is a drive, %VAR%\, UNC \\host or a two-segment /a/b at a
// word start; a one-segment /tmp is missed. Widen it when a real miss shows up.
const PATH = /(?:^|[\s"'`(=])(?:[a-z]:\\|%\w+%\\|\\\\\w|~?\/[\w.-]+\/[\w.-])/i

function readEvent(
  line: string,
  lineNo: number,
  indent: string,
  textFrom: number,
  iocs: TimelineIoc[],
  carried: Carry
): TimelineEvent {
  const text = line.slice(textFrom)
  const head = readHead(text, carried)
  const shift = (s: Span | null): Span | null => s && { from: s.from + textFrom, to: s.to + textFrom }
  const kindMatch = KIND.exec(text.slice(head.rest))
  const body = text.slice(head.rest + (kindMatch?.[0].length ?? 0))
  return {
    line: lineNo,
    lastLine: lineNo,
    indent,
    text,
    textFrom,
    lead: shift(head.lead),
    time: head.time,
    timeSpan: shift(head.timeSpan),
    secondsSpan: shift(head.secondsSpan),
    unread: head.unread,
    kind: kindMatch ? KIND_WORDS[kindMatch[1].toLowerCase()] : deriveKind(body, iocs),
    kindExplicit: kindMatch !== null,
    kindSpan: kindMatch && shift({ from: head.rest, to: head.rest + kindMatch[1].length + 1 }),
    key: KEY.test(body),
    iocs,
    attack: [...text.matchAll(ATTACK)].map((m) => ({ from: textFrom + m.index, to: textFrom + m.index + m[0].length })),
    details: [],
    body
  }
}

/**
 * The kind the text implies when none is written. Detection, response and
 * host are the analyst's calls, never read off the text.
 */
function deriveKind(body: string, iocs: TimelineIoc[]): EventKind {
  const has = (...types: IocType[]) => iocs.some((i) => types.includes(i.type))
  if (INLINE_CODE.test(body) || LOLBIN.test(body) || EXE_EXT.test(body)) return 'execution'
  if (has('hash') || PATH.test(body)) return 'file'
  if (has('url', 'domain', 'ip')) return 'web'
  if (has('email')) return 'email'
  // A DOMAIN\user token, as Details names one; Windows\Temp is a folder, BUILTIN\x a group.
  if (body.split(/\s+/).some((t) => t.includes('\\') && detectDetailField(t) === 'User')) return 'user'
  return 'observed'
}

// ─── The time phrase ─────────────────────────────────────────────────────────

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]
const MONTH =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const DMY = new RegExp(`^(\\d{1,2})[ \\t]+${MONTH}\\.?,?[ \\t]+(\\d{4})`, 'i')
const MDY = new RegExp(`^${MONTH}\\.?[ \\t]+(\\d{1,2}),?[ \\t]+(\\d{4})`, 'i')
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/
/** 10/9/26 or 10/09/2026: two numbers then the year, day/month order unknown. */
const NUMERIC_DATE = /^\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})(?!\d)/
/** 2026/10/09: year first, so the order is known. */
const YMD_SLASH = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?!\d)/
const DATE_TIME_SEP = /^,?[ \t]+/
const ISO_DATE_TIME_SEP = /^(?:T|,?[ \t]+)/

const LEAD = /^(?:(?:on|at|around|about|approximately|approx\.?|by)[ \t]+|~[ \t]*)+/i
const APPROX_LEAD = /around|about|approx|~/i
const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/
// 'a.m.' with its dots; a full stop after 'AM' ends a sentence, not the time.
const MERIDIEM = /^ ?([ap](?:m|\.m\.?))(?![a-z\d])/i
const RANGE_END = /^[–-](\d{1,2}):(\d{2})(?::(\d{2}))?/
// A minus offset is read only after an ISO 'T' time: elsewhere 11:06-11:08 is a range.
// The US zones are the ones the toolbox reads too.
const ZONE = /^(?: ?(?:UTC|GMT)(?:[+-]\d{1,2}(?::?\d{2})?)?| ?\+\d{2}:?\d{2}| ?[ECMP][SD]T)(?![a-z\d])/i
/** Zulu, a capital Z only: '11:06 z' and '09:00 Z-score' are text, not a zone. */
const ZULU = /^ ?Z(?![A-Za-z\d-])/
const ISO_ZONE = /^(?: ?(?:UTC|GMT)(?:[+-]\d{1,2}(?::?\d{2})?)?| ?Z|[+-]\d{2}:?\d{2})(?![a-z\d])/i
/** What may follow a time phrase: the end, a comma, a space, or a colon and space. */
const PHRASE_END = /^(?:$|,|[ \t]|:(?:[ \t]|$))/
/** The separator after a phrase: a comma, a colon, a spaced dash, then spaces. */
const PHRASE_SEP = /^(?:,|:|[ \t]+[–-](?=[ \t]|$))?[ \t]*/
// ponytail: "looks like a time" is a clock start, a numeric slash date or an
// ISO-ish date; anything else unread is plain prose.
const TIME_LIKE = /^(?:\d{1,2}:\d|\d{1,4}\/\d|\d{4}-\d)/

interface Head {
  lead: Span | null
  time: EventTime | null
  timeSpan: Span | null
  secondsSpan: Span | null
  unread: string | null
  /** Where the text after the phrase and its separator starts. */
  rest: number
}

interface Clock {
  len: number
  minutes: number
  seconds: number | null
  ms: number | null
  secondsAt: Span | null
  zone: string | null
  end: EventTime['end']
}

/**
 * The time a bullet starts with, after optional lead words. Only the start
 * counts: a time in the middle of a sentence is something the event mentions,
 * not when it happened.
 */
/** The date the bullets above stated, carried to time-only bullets under it. */
interface Carry {
  date: DayDate | null
  text: string | null
}

function readHead(text: string, carried: Carry): Head {
  const lead = LEAD.exec(text)?.[0] ?? ''
  const s = text.slice(lead.length)
  const refused = (u: string | null): Head => ({
    lead: null,
    time: null,
    timeSpan: null,
    secondsSpan: null,
    unread: u,
    rest: 0
  })
  let date: DayDate | null = null
  let dateText: string | null = null
  let clock: Clock | null = null
  let clockAt = 0
  let q = 0
  let unreadToken: string | null = null
  const d = readDate(s)
  if (d) {
    // A named date that does not exist (31 Feb) is refused whole, not rolled over.
    if (d.numeric) dateText = s.slice(0, d.len)
    else if (!d.date) return refused(s.slice(0, d.len))
    date = d.date
    q = d.len
    const sep = (d.iso ? ISO_DATE_TIME_SEP : DATE_TIME_SEP).exec(s.slice(q))?.[0]
    if (sep !== undefined) {
      const c = readClock(s.slice(q + sep.length), sep === 'T')
      if (c && c !== 'invalid' && PHRASE_END.test(s.slice(q + sep.length + c.len))) {
        clock = c
        clockAt = q + sep.length
        q = clockAt + c.len
      } else unreadToken = timeLike(s.slice(q + sep.length))
    }
    if (!clock && !PHRASE_END.test(s.slice(q))) return refused(s.slice(0, d.len))
  } else {
    const c = readClock(s, false)
    if (!c || c === 'invalid' || !PHRASE_END.test(s.slice(c.len))) return refused(timeLike(s))
    clock = c
    q = c.len
  }
  const at = lead.length
  const offset = (span: Span | null): Span | null =>
    span && { from: at + clockAt + span.from, to: at + clockAt + span.to }
  return {
    lead: lead ? { from: 0, to: lead.trimEnd().length } : null,
    time: {
      raw: s.slice(0, q),
      date: dateText !== null ? null : (date ?? carried.date),
      dateText: date !== null ? null : (dateText ?? carried.text),
      dateStated: date !== null || dateText !== null,
      minutes: clock?.minutes ?? null,
      seconds: clock?.seconds ?? null,
      ms: clock?.ms ?? null,
      approx: APPROX_LEAD.test(lead),
      zone: clock?.zone ?? null,
      end: clock?.end ?? null
    },
    timeSpan: { from: at, to: at + q },
    secondsSpan: offset(clock?.secondsAt ?? null),
    unread: unreadToken,
    rest: at + q + (PHRASE_SEP.exec(s.slice(q))?.[0].length ?? 0)
  }
}

/** The leading token when it looks like a time, else null. */
function timeLike(s: string): string | null {
  const token = /^[^\s,]+/.exec(s)?.[0] ?? ''
  return TIME_LIKE.test(token) ? token : null
}

/**
 * A date at the start: null when there is none, `date` null when it does not
 * exist. A date written as numbers with the year last (10/9/26) is `numeric`:
 * which number is the day is not in the text, so it is kept as written.
 */
function readDate(s: string): { date: DayDate | null; len: number; iso: boolean; numeric?: true } | null {
  let m = NUMERIC_DATE.exec(s)
  if (m) return { date: null, len: m[0].length, iso: false, numeric: true }
  m = YMD_SLASH.exec(s)
  if (m) return { date: dayDate(+m[1], +m[2], +m[3]), len: m[0].length, iso: false }
  m = DMY.exec(s)
  if (m) return { date: dayDate(+m[3], monthOf(m[2]), +m[1]), len: m[0].length, iso: false }
  m = MDY.exec(s)
  if (m) return { date: dayDate(+m[3], monthOf(m[1]), +m[2]), len: m[0].length, iso: false }
  m = ISO_DATE.exec(s)
  if (m) return { date: dayDate(+m[1], +m[2], +m[3]), len: m[0].length, iso: true }
  return null
}

function monthOf(name: string): number {
  const key = name.slice(0, 3).toLowerCase()
  return MONTHS.findIndex((n) => n.slice(0, 3).toLowerCase() === key) + 1
}

function dayDate(y: number, m: number, d: number): DayDate | null {
  const t = new Date(Date.UTC(y, m - 1, d))
  return m >= 1 && m <= 12 && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? { y, m, d } : null
}

/** Minutes from midnight, or null when the clock does not exist (25:10, 13:04 PM). */
function toMinutes(h: number, m: number, meridiem: string | undefined): number | null {
  if (m > 59) return null
  if (meridiem) {
    if (h < 1 || h > 12) return null
    return ((h % 12) + (/^p/i.test(meridiem) ? 12 : 0)) * 60 + m
  }
  return h > 23 ? null : h * 60 + m
}

/**
 * A clock with its optional seconds, fraction, AM/PM, range end and zone.
 * Null when the text does not start with a clock; 'invalid' when it does but
 * the clock does not exist.
 */
function readClock(s: string, isoT: boolean): Clock | 'invalid' | null {
  const a = CLOCK.exec(s)
  if (!a) return null
  let i = a[0].length
  const aMer = MERIDIEM.exec(s.slice(i))
  if (aMer) i += aMer[0].length
  let minutes = toMinutes(+a[1], +a[2], aMer?.[1])
  const seconds = a[3] === undefined ? null : +a[3]
  let end: Clock['end'] = null
  const r = isoT ? null : RANGE_END.exec(s.slice(i))
  if (r) {
    i += r[0].length
    const bMer = MERIDIEM.exec(s.slice(i))
    if (bMer) i += bMer[0].length
    const endMinutes = toMinutes(+r[1], +r[2], bMer?.[1] ?? aMer?.[1])
    const endSeconds = r[3] === undefined ? null : +r[3]
    if (endMinutes === null || (endSeconds ?? 0) > 59) return 'invalid'
    // "1:50–2:10 PM" puts the start in the afternoon too, unless that would
    // start it after its own end ("11:50–12:10 PM" starts in the morning).
    if (!aMer && bMer) {
      minutes = toMinutes(+a[1], +a[2], bMer[1])
      if (minutes !== null && minutes > endMinutes) minutes = toMinutes(+a[1], +a[2], /^p/i.test(bMer[1]) ? 'am' : 'pm')
    }
    end = { minutes: endMinutes, seconds: endSeconds }
  }
  if (minutes === null || (seconds ?? 0) > 59) return 'invalid'
  const z = isoT ? ISO_ZONE.exec(s.slice(i)) : (ZONE.exec(s.slice(i)) ?? ZULU.exec(s.slice(i)))
  if (z) i += z[0].length
  const secondsFrom = a[1].length + 3
  return {
    len: i,
    minutes,
    seconds,
    ms: a[4] === undefined ? null : Number(a[4].padEnd(3, '0').slice(0, 3)),
    secondsAt: seconds === null ? null : { from: secondsFrom, to: a[0].length },
    zone: z ? z[0].trim() : null,
    end
  }
}

/** The clock part of a time as written, without its date: '11:04' of '3 May 2025, 11:04'. */
export function clockText(t: EventTime): string {
  const d = t.dateStated ? readDate(t.raw) : null
  return d ? t.raw.slice(d.len).replace(ISO_DATE_TIME_SEP, '') : t.raw
}

/** The clock as written, with '~' when the analyst said it was approximate. */
function timeLabel(t: EventTime): string {
  return (t.approx ? '~' : '') + clockText(t)
}

export function formatDay(d: DayDate): string {
  return `${d.d} ${MONTHS[d.m - 1]} ${d.y}`
}

// ─── Indicators ──────────────────────────────────────────────────────────────

const DOT = String.raw`(?:\.|[[(](?:\.|dot)[\])])`
const AT = String.raw`(?:@|[[(]at[\])]|\[@\])`
const COLON = String.raw`(?::|\[:\])`
const SCHEME_SEP = String.raw`(?::\/\/|\[:\/\/\]|\[:\]\/\/)`
const WORD = /[\p{L}\p{N}_-]/u

/** A pattern for a refanged value as it may be written: real, or with any defang refangIoc undoes. */
function writtenAs(value: string): RegExp {
  let src = ''
  for (let i = 0; i < value.length;) {
    if (i === 0 && /^http/i.test(value)) {
      src += 'h(?:tt|xx)p'
      i += 4
    } else if (value.startsWith('://', i)) {
      src += SCHEME_SEP
      i += 3
    } else {
      const c = value[i++]
      src += c === '.' ? DOT : c === '@' ? AT : c === ':' ? COLON : c.replace(/[\\^$.*+?()[\]{}|/]/g, String.raw`\$&`)
    }
  }
  return new RegExp(src, 'gi')
}

/**
 * File extensions that are also top-level domains: login-microsoft.zip may be
 * a live site, so it is defanged. ponytail: the ones Details reads as files,
 * by hand; check against a TLD list if one comes into the code.
 */
const TLD_EXTENSION = /\.(?:zip|sh|py|one)\W*$/i
/** A plain dotted name: nowhere in it for an address, a path, a URL or a key=value to hide. */
const PLAIN_NAME = /^[\p{L}\p{N}_$~-]+(?:\.[\p{L}\p{N}_$~-]+)+$/u
/** A dotted quad: an IPv4 address, whatever name it opens. */
const DOTTED_QUAD = /\d{1,3}(?:\.\d{1,3}){3}/
/** A token without the brackets, quotes and prose punctuation around it. */
const unwrapped = (token: string): string => token.replace(/^[([{"'`*]+|[)\]}"'`*,.;:!?]+$/g, '')

/**
 * A token kept as written because it reaches no one outside: an internal
 * host (DESKTOP1.domain.local) or a program or document named by itself
 * (cmd.exe, invoice.pdf). Over-defanging is safe and under-defanging is not,
 * so only such a name is kept, never one with more in it.
 */
function keepsItsDots(token: string): boolean {
  if (!token.includes('.') || DOTTED_QUAD.test(token)) return false
  const kind = detectDetailField(token)
  const name = unwrapped(token)
  // The name alone: readValue reads past a mailto: the token keeps.
  if (kind === 'Hostname') return /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(name)
  return kind === 'File path' && PLAIN_NAME.test(name) && !TLD_EXTENSION.test(name)
}

/**
 * defangText for the timeline's text, a file or an internal host named by
 * itself left as written. defangText reads the value after 'Label: ' as a
 * host when it has a host's shape, and labelled lines are how steps and
 * chains are written: cmd.exe would be cmd[.]exe. The text is defanged as
 * written, so nothing changes how a line is read, and then a kept token goes
 * back as it was; when the tokens do not line up, nothing is kept. Every
 * count, edit, copy and drawing of a timeline defangs with this, so they agree.
 */
export function defangTimelineText(text: string): string {
  const out = defangText(text)
  if (out === text) return out
  const was = text.split(/(\s+)/)
  const now = out.split(/(\s+)/)
  if (was.length !== now.length || was.some((part, i) => i % 2 === 1 && part !== now[i])) return out
  return now.map((part, i) => (i % 2 === 0 && part !== was[i] && keepsItsDots(was[i]) ? was[i] : part)).join('')
}

/**
 * Every indicator on a line from column `from`, defanged or real, as columns
 * of the line. extractIocsFromText decides what is an indicator; this only
 * finds where each one is written. The domain inside a URL or an address is
 * part of it, not a second indicator. `live` is whether defangTimelineText
 * over the whole line would change it, so it agrees with what Defang will do:
 * a bare domain in prose, which defangText leaves as written, is not live.
 */
export function indicatorSpans(line: string, from = 0): TimelineIoc[] {
  return readIndicators(line, from).iocs
}

/**
 * indicatorSpans, and how many changes defangTimelineText makes on the line
 * outside every span: a file:// or ms-msdt: link, or anything else the
 * extractor does not list. Together they are what Defang timeline changes on
 * the line.
 */
function readIndicators(line: string, from = 0): { iocs: TimelineIoc[]; unlisted: number } {
  const text = line.slice(from)
  const found: { span: Span; type: IocType }[] = []
  for (const { value } of extractIocsFromText(text, [])) {
    const type = detectIocType(value)
    for (const m of text.matchAll(writtenAs(value))) {
      const end = m.index + m[0].length
      if (WORD.test(text[m.index - 1] ?? '') || WORD.test(text[end] ?? '')) continue
      found.push({ span: { from: from + m.index, to: from + end }, type })
    }
  }
  found.sort((a, b) => a.span.from - b.span.from || b.span.to - a.span.to)
  const iocs: TimelineIoc[] = []
  for (const f of found) if (f.span.from >= (iocs.at(-1)?.span.to ?? 0)) iocs.push({ ...f, live: false })
  const out = defangTimelineText(line)
  if (out === line) return { iocs, unlisted: 0 }
  const alone = (i: TimelineIoc) => {
    const written = line.slice(i.span.from, i.span.to)
    return defangText(written) !== written
  }
  // defangText rewrites token by token and never adds whitespace, so token n
  // of its output is token n of the line, defanged.
  const tokens = [...line.matchAll(/\S+/g)]
  const defanged = out.match(/\S+/g) ?? []
  if (defanged.length !== tokens.length) {
    for (const i of iocs) i.live = alone(i)
    return { iocs, unlisted: 0 }
  }
  let unlisted = 0
  tokens.forEach((t, n) => {
    const d = defanged[n]
    if (d === t[0]) return
    // A changed token is walked piece by piece, the text between indicators
    // and each indicator: defangText leaves a piece as written or, for a live
    // indicator, writes it as it defangs it alone. Judged per indicator, so
    // the domain in '1.2.3.4,evil.com' is not live because the address is.
    const end = t.index + t[0].length
    const inToken = iocs.filter((i) => i.span.from >= t.index && i.span.from < end)
    let at = t.index
    let pos = 0
    for (const [k, i] of inToken.entries()) {
      const gap = line.slice(at, i.span.from)
      const written = line.slice(i.span.from, i.span.to)
      const shown = defangText(written)
      const p = pos + gap.length
      if (!d.startsWith(gap, pos) || !(d.startsWith(written, p) || d.startsWith(shown, p))) {
        // ponytail: the walk lost its place, so the rest of the token's
        // indicators are judged alone; a changed gap counts once.
        if (!d.startsWith(gap, pos)) unlisted++
        for (const j of inToken.slice(k)) j.live = alone(j)
        return
      }
      i.live = !d.startsWith(written, p)
      pos = p + (i.live ? shown : written).length
      at = i.span.to
    }
    if (d.slice(pos) !== line.slice(at, end)) unlisted++
  })
  return { iocs, unlisted }
}

// ─── Gaps and summary ────────────────────────────────────────────────────────

const LONG_GAP_S = 15 * 60

const dayNumber = (d: DayDate): number => Date.UTC(d.y, d.m - 1, d.d) / 86_400_000

/** Seconds on a common scale; whole minutes unless `exact`. Dateless times share one day. */
function secondsOf(t: EventTime, exact: boolean): number {
  return (t.date ? dayNumber(t.date) * 86_400 : 0) + (t.minutes ?? 0) * 60 + (exact ? (t.seconds ?? 0) : 0)
}

function duration(s: number, exact: boolean): string {
  const parts: [number, string][] = [
    [Math.floor(s / 86_400), 'd'],
    [Math.floor(s / 3600) % 24, 'h'],
    [Math.floor(s / 60) % 60, 'min'],
    [exact ? s % 60 : 0, 's']
  ]
  return (
    parts
      .filter(([n]) => n)
      .map(([n, unit]) => `${n} ${unit}`)
      .join(' ') || (exact ? '0 s' : '0 min')
  )
}

/**
 * Clocks written in one zone: the same zone on every time, or none on any.
 * Zones are never converted, so 11:04 UTC and 13:10 +02:00 have no order here,
 * and neither do UTC and Z, or a zone and none.
 */
export function oneZone(times: EventTime[]): boolean {
  return times.every((t) => t.zone?.toUpperCase() === times[0].zone?.toUpperCase())
}

/**
 * Times can be ordered only when they are in one zone and all know their day,
 * or none does and all sit under the same date as written (10/9/26 is one day,
 * whichever way it reads).
 */
export function comparable(times: EventTime[]): boolean {
  if (!oneZone(times)) return false
  if (times.every((t) => t.date !== null)) return true
  return times.every((t) => t.date === null && t.dateText === times[0].dateText)
}

/**
 * The derived gap between two consecutive events. Precision is the coarser
 * of the two times; a time-only event earlier than the one above is out of
 * order, never taken to have crossed midnight.
 */
function gapBetween(a: EventTime | null, b: EventTime | null): TimelineGap | null {
  if (!a || !b || a.minutes === null || b.minutes === null || !comparable([a, b])) return null
  const exact = a.seconds !== null && b.seconds !== null
  const diff = secondsOf(b, exact) - secondsOf(a, exact)
  const dayChange = a.date && b.date && dayNumber(a.date) !== dayNumber(b.date) ? b.date : null
  const approx = a.approx || b.approx
  const when = (t: EventTime) => (dayChange && t.date ? `${formatDay(t.date)}, ` : '') + timeLabel(t)
  if (diff < 0) {
    return {
      label: 'earlier than the event above',
      long: false,
      outOfOrder: true,
      approx,
      dayChange,
      tooltip: `${when(b)} is earlier than ${when(a)} in the event above`
    }
  }
  const long = diff >= LONG_GAP_S
  const span = duration(diff, exact)
  const label = diff === 0 ? (exact ? 'same second' : 'same minute') : long ? `${span} later` : `+${span}`
  const coarse = !exact && (a.seconds !== null || b.seconds !== null) ? ', to the minute: one time has no seconds' : ''
  return {
    label: (approx ? '≈ ' : '') + label,
    long,
    outOfOrder: false,
    approx,
    dayChange,
    tooltip: `Derived from ${when(a)} → ${when(b)}${coarse}${approx ? ', approximate' : ''}`
  }
}

/** First and last are the earliest and latest times when they can be ordered, else the first and last written. */
function summarise(events: TimelineEvent[], otherLive: number): TimelineSummary {
  const timed = events.flatMap((e) => (!e.time || e.time.minutes === null ? [] : [e.time]))
  let first = timed[0]
  let last = timed.at(-1)
  let span: string | null = null
  if (timed.length > 1 && comparable(timed)) {
    first = timed.reduce((x, y) => (secondsOf(y, true) < secondsOf(x, true) ? y : x))
    last = timed.reduce((x, y) => (secondsOf(y, true) > secondsOf(x, true) ? y : x))
    const exact = first.seconds !== null && last.seconds !== null
    span = duration(secondsOf(last, exact) - secondsOf(first, exact), exact)
  }
  const stated = events.find((e) => e.time?.dateStated)?.time
  return {
    count: events.length,
    date: stated?.date ?? null,
    dateText: stated?.dateText ?? null,
    first: first ? timeLabel(first) : null,
    last: last ? timeLabel(last) : null,
    span,
    untimed: events.length - timed.length,
    live: events.reduce((n, e) => n + e.iocs.filter((i) => i.live).length, otherLive)
  }
}

// ─── Copy for ticket ─────────────────────────────────────────────────────────

/**
 * The timeline as plain text for a ticket, laid out for its style. Not
 * defanged here: copyText reads the block from the note lines as Defang
 * timeline leaves them.
 */
export function copyForTicket(block: TimelineBlock): string {
  if (block.style === 'steps') return copySteps(block)
  return block.style === 'chain' ? copyChain(block) : copyEvents(block)
}

/** 'Label: value', 'Label:' or the value alone. */
const pair = (at: Labelled): string =>
  at.labelText === null ? at.valueText : `${at.labelText}: ${at.valueText}`.trimEnd()

/** Steps: '1. Label: value (21:34)' with the time as written when there is one, details under it, then the facts. */
function copySteps(block: TimelineBlock): string {
  const out = [`Steps (${block.steps.length})`]
  for (const s of block.steps) {
    const t = s.event.time
    out.push(`${s.n}. ${pair(s)}${t ? ` (${t.approx ? '~' : ''}${t.raw})` : ''}`.trimEnd())
    for (const d of s.event.details) out.push(' '.repeat(`${s.n}. `.length) + d.text)
  }
  if (block.facts.length) out.push('')
  for (const f of block.facts) {
    out.push(pair(f))
    // The lines a fact runs on to sit under its value.
    for (const m of f.more) out.push(' '.repeat(f.labelText === null ? 0 : f.labelText.length + 2) + m.text)
  }
  return out.join('\n')
}

/** A chain: 'value (label)', two spaces a level and '→ ' before a child, its notes under it. */
function copyChain(block: TimelineBlock): string {
  const { links } = block
  const out = [`Process chain (${links.length} link${links.length === 1 ? '' : 's'})`]
  for (const l of links) {
    const lead = l.depth ? `${'  '.repeat(l.depth)}→ ` : ''
    out.push(lead + [l.valueText, l.labelText !== null && `(${l.labelText})`].filter(Boolean).join(' '))
    for (const n of l.notes) out.push(' '.repeat(lead.length + 2) + n.text)
  }
  return out.join('\n')
}

/**
 * Events: a time column as written, then the bullet without its lead word and
 * time phrase; details indent under it and Source: lines join the event line.
 * A date line goes above each event whose date, stated or carried, differs
 * from the one above it; a time with no date comes before any.
 */
function copyEvents(block: TimelineBlock): string {
  const { events } = block
  const labels = events.map((e) => (!e.time || e.time.minutes === null ? '--:--' : timeLabel(e.time)))
  const width = Math.max(8, ...labels.map((l) => l.length)) + 3
  const count = `${events.length} event${events.length === 1 ? '' : 's'}`
  const dayOf = (t: EventTime | null) => (t?.date ? formatDay(t.date) : (t?.dateText ?? null))
  // An untimed event says nothing about the day; the first one that has a time does.
  let day = dayOf(events.find((e) => e.time)?.time ?? null)
  const out = [`Timeline${day ? `, ${day}` : ''} (${count})`]
  events.forEach((e, n) => {
    const date = dayOf(e.time)
    if (date && date !== day) out.push(date)
    if (date) day = date
    const kind = e.kindSpan ? e.text.slice(e.kindSpan.from - e.textFrom, e.kindSpan.to - e.textFrom) : ''
    const sources = e.details.filter((d) => d.source).map((d) => d.text)
    const untimed = labels[n] === '--:--' ? ' (time not recorded)' : ''
    out.push((labels[n].padEnd(width) + [kind, e.body, ...sources].filter(Boolean).join(' ')).trimEnd() + untimed)
    for (const d of e.details) if (!d.source) out.push(' '.repeat(width) + d.text)
  })
  return out.join('\n')
}
