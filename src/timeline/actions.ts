import type { Editor } from 'obsidian'
import {
  type EventKind,
  type TimelineBlock,
  type TimelineEvent,
  type TimelineStyle,
  comparable,
  copyForTicket,
  defangTimelineText,
  findTimelines,
  frontmatterEnd,
  markerFor,
  oneZone,
  timelineAt
} from './parse'

/**
 * What the timeline's menu items and commands do to the note, as pure line
 * edits: the note's lines and the caret's line in, one replacement out, or
 * null where the item does not apply (so the same call is the menu's and the
 * command's check). applyEdit writes one into the editor as one undo step.
 */

export interface TimelineEdit {
  fromLine: number
  /** Inclusive: lines fromLine..toLine are replaced. */
  toLine: number
  /** The replacement, lines joined with \n. */
  text: string
  /** Where the caret goes after; left out, it stays where it was. */
  cursor?: { line: number; ch: number }
}

// As parse.ts reads them.
const BULLET = /^([ \t]*)[-*+](?:[ \t]+|$)/
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/
const FENCE_OPEN = /^\s*(?:(?:[-*+]|\d{1,3}[.)])[ \t]+)?(`{3,}|~{3,})/
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/
/** Lines that end a list rather than join it as events: a code fence, a divider ('---', '* * *'), a numbered item. */
const NOT_AN_EVENT = /^\s*(?:`{3,}|~{3,}|\d{1,9}[.)](?:[ \t]|$))|^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/

/** A blockquote or callout line. */
const QUOTE = /^\s*>/
/** A pipe table's delimiter row: '| --- | :-: |', '---|---'. */
const isTableRule = (s: string): boolean => s.includes('|') && s.includes('-') && /^[\s|:-]+$/.test(s)

const isBlank = (s: string | undefined): boolean => !s?.trim()
const indentOf = (s: string): number => s.length - s.trimStart().length

function here(lines: string[], line: number): { block: TimelineBlock; event: TimelineEvent | null } | null {
  return timelineAt(findTimelines(lines), line)
}

/** What add, move and delete act on: an event, or a chain's link with everything under it. */
interface Item {
  line: number
  lastLine: number
  indent: string
}

/** A steps list's closing Details or Facts bullet, which holds the facts and stays last; undefined in any other list. */
export const closingOf = (block: TimelineBlock): TimelineEvent | undefined =>
  block.facts.length ? block.events.at(-1) : undefined

/**
 * The item the caret is on, and the items it moves among: the event and the
 * events; in steps, the steps, while the closing Details bullet (a fact is
 * its) moves among none; in a chain, the link the line is on (a note is its
 * link's) and the links under the same parent, so a root moves among the
 * roots. Null on the marker or outside a timeline.
 */
function itemAt(
  lines: string[],
  line: number,
  at = here(lines, line)
): { block: TimelineBlock; item: Item; siblings: Item[] } | null {
  if (!at?.event) return null
  const { block } = at
  const closing = closingOf(block)
  if (closing) return { block, item: at.event, siblings: at.event === closing ? [] : block.steps.map((s) => s.event) }
  if (block.style !== 'chain') return { block, item: at.event, siblings: block.events }
  let link = block.links[0]
  for (const l of block.links) if (l.line <= line) link = l
  return { block, item: link, siblings: block.links.filter((l) => l.parent === link.parent) }
}

function replace(from: number, to: number, out: string[], cursor?: TimelineEdit['cursor']): TimelineEdit {
  return { fromLine: from, toLine: to, text: out.join('\n'), cursor }
}

/** Lines from..to taken out whole: the replaced range takes in a neighbour that stays, so its newline goes too. */
function removeLines(lines: string[], from: number, to: number, cursor?: TimelineEdit['cursor']): TimelineEdit {
  if (from > 0) return replace(from - 1, to, [lines[from - 1]], cursor)
  if (to + 1 < lines.length) return replace(from, to + 1, [lines[to + 1]], cursor)
  return replace(from, to, [''], cursor)
}

/** Which lines are fenced code, fences included. A fence in a list item ends with the item. */
function codeLines(lines: string[]): boolean[] {
  let fence: { mark: string; indent: number } | null = null
  return lines.map((l) => {
    if (fence && (isBlank(l) || indentOf(l) >= fence.indent)) {
      const close = FENCE_CLOSE.exec(l)?.[1]
      if (close && close[0] === fence.mark[0] && close.length >= fence.mark.length) fence = null
      return true
    }
    const open = FENCE_OPEN.exec(l)?.[1]
    fence = open ? { mark: open, indent: indentOf(l) } : null
    return open !== undefined
  })
}

/**
 * The first bullet of the list `line` is in, walking up as parse.ts walks
 * down; -1 when it is in none. Blank lines in an event's code block are code,
 * so two of them do not end the list.
 */
function listStart(lines: string[], line: number): number {
  const code = codeLines(lines)
  let start = -1
  for (let i = line; i >= 0; i--) {
    const l = lines[i]
    if (BULLET.test(l)) start = i
    else if (isBlank(l)) {
      if (!code[i] && (i === line || (isBlank(lines[i - 1]) && !code[i - 1]))) break
    } else if (indentOf(l) === 0) break
  }
  return start
}

/**
 * The lines a selection covers, for Make timeline. One that ends at column 0
 * (a triple-click, Shift+Down) stops at the line above: nothing of the line it
 * ends on is selected.
 */
export function selectedLines(editor: Editor): [number, number] {
  const from = editor.getCursor('from')
  const to = editor.getCursor('to')
  return [from.line, to.ch === 0 && to.line > from.line ? to.line - 1 : to.line]
}

/**
 * Make timeline: the marker line for the style directly above the list the caret is in.
 * Over a selection of two or more lines, its plain lines become events first:
 * '- ' goes in front of each at the selection's least indent, a deeper one
 * stays the detail of the line above, and blank lines and leading headings are
 * left alone. Null when there is no list, the lines are in a timeline already
 * or in the frontmatter, or they would not all become one timeline (a heading
 * or two blank lines inside the selection; a code fence, a divider or a
 * numbered item where '- ' would go).
 */
export function makeTimeline(
  lines: string[],
  fromLine: number,
  toLine: number,
  style: TimelineStyle = 'events'
): TimelineEdit | null {
  let first = fromLine
  let last = toLine
  while (first < last && (isBlank(lines[first]) || HEADING.test(lines[first]))) first++
  while (last > first && isBlank(lines[last])) last--
  if (first <= frontmatterEnd(lines)) return null
  const blocks = findTimelines(lines)
  for (let i = first; i <= last; i++) if (timelineAt(blocks, i)) return null
  const out = lines.slice()
  if (last > first) {
    const base = Math.min(...lines.slice(first, last + 1).flatMap((l) => (isBlank(l) ? [] : [indentOf(l)])))
    for (let i = first; i <= last; i++) {
      const l = lines[i]
      if (isBlank(l) || HEADING.test(l)) continue
      // ponytail: an item's text starts 2 columns in ('- '); left of that, a
      // fence, a divider or a number ends the list. Deeper, it is an event's.
      if (indentOf(l) < base + 2 && NOT_AN_EVENT.test(l)) return null
      if (indentOf(l) === base && !BULLET.test(l)) out[i] = `${l.slice(0, base)}- ${l.slice(base)}`
    }
  }
  const start = listStart(out, first)
  if (start < 0 || timelineAt(blocks, start)) return null
  const marker = (BULLET.exec(out[start])?.[1] ?? '') + markerFor(style)
  // The parser has the last word: every line asked for must be in the new timeline.
  const marked = [...out.slice(0, start), marker, ...out.slice(start)]
  const block = findTimelines(marked).find((b) => b.markerLine === start)
  for (let i = first; i <= last; i++) {
    if (!isBlank(lines[i]) && !(block && timelineAt([block], i + 1)?.event)) return null
  }
  return replace(start, last, [marker, ...out.slice(start, last + 1)])
}

/** Whether `line` is a row of a pipe table: one of a run of lines with a pipe that holds a delimiter row. */
function inTable(lines: string[], line: number): boolean {
  const piped = (i: number) => lines[i]?.includes('|') ?? false
  if (!piped(line)) return false
  let from = line
  let to = line
  while (piped(from - 1)) from--
  while (piped(to + 1)) to++
  return lines.slice(from, to + 1).some(isTableRule)
}

/**
 * Whether a %% comment or a $$ math block is still open after `line`: an odd
 * count of its marks from the frontmatter down, code left out. ponytail: a
 * mark in inline code counts too; skip code spans if that turns up.
 */
function inOpenBlock(lines: string[], line: number, code: boolean[]): boolean {
  const from = frontmatterEnd(lines) + 1
  const text = lines.slice(from, line + 1).filter((_, i) => !code[from + i])
  return ['%%', '$$'].some((mark) => text.join('\n').split(mark).length % 2 === 0)
}

/**
 * Insert timeline: a new one at the caret, nothing selected. A blank line
 * becomes the marker and one empty item; on a paragraph or a heading it goes
 * below that line. A blank line goes above it after a paragraph, where the
 * empty item would be read as more of the paragraph, and below it before
 * text, two where one would let it take in what follows (a list). Null in a
 * timeline, the frontmatter, a code block, a quote or callout, a table, a
 * %% comment or a $$ math block (each would be split), or where the parser
 * would not read one empty event.
 */
export function insertTimeline(lines: string[], line: number, style: TimelineStyle): TimelineEdit | null {
  const code = codeLines(lines)
  if (line <= frontmatterEnd(lines) || code[line] || QUOTE.test(lines[line]) || inTable(lines, line)) return null
  if (inOpenBlock(lines, line, code)) return null
  if (findTimelines(lines).some((b) => line >= b.markerLine && line <= b.lastLine)) return null
  const blank = isBlank(lines[line])
  const above = blank ? lines[line - 1] : lines[line]
  const gap = above !== undefined && !isBlank(above) && !HEADING.test(above)
  const head = [...(blank ? [] : [lines[line]]), ...(gap ? [''] : []), markerFor(style), '- ']
  const itemLine = line + head.length - 1
  if (line + 1 < lines.length && !isBlank(lines[line + 1])) head.push('')
  // The parser has the last word: the new timeline is the one empty event and nothing after it.
  for (const out of [head, [...head, '']]) {
    const note = [...lines.slice(0, line), ...out, ...lines.slice(line + 1)]
    const block = findTimelines(note).find((b) => b.markerLine === itemLine - 1)
    if (block?.events.length === 1 && block.lastLine === itemLine) {
      return replace(line, line, out, { line: itemLine, ch: 2 })
    }
  }
  return null
}

/** Style ›: the marker rewritten for the style, its indent kept; null when the timeline has that style. */
export function setStyle(lines: string[], line: number, style: TimelineStyle): TimelineEdit | null {
  const block = here(lines, line)?.block
  if (!block || block.style === style) return null
  const marker = lines[block.markerLine]
  return replace(block.markerLine, block.markerLine, [marker.slice(0, indentOf(marker)) + markerFor(style)])
}

/** The bullet character an item is written with; '-' for a numbered one. */
function bulletOf(lines: string[], item: Item): string {
  const c = lines[item.line][item.indent.length]
  return '-*+'.includes(c) ? c : '-'
}

/** An empty item written `bullet` after line `after`, caret in it. */
function insertItem(lines: string[], after: number, bullet: string): TimelineEdit {
  return replace(after, after, [lines[after], bullet], { line: after + 1, ch: bullet.length })
}

/** An empty item after line `after`, bulleted and indented like `like`. */
const insertEvent = (lines: string[], after: number, like: Item | undefined): TimelineEdit =>
  insertItem(lines, after, like ? `${like.indent}${bulletOf(lines, like)} ` : '- ')

/**
 * Add event below: after the caret's event and its details; on the marker,
 * the new first event; on a steps list's closing Details bullet or its facts,
 * the new last step. In a chain, a sibling of the caret's link after
 * everything under it.
 */
export function addEventBelow(lines: string[], line: number): TimelineEdit | null {
  const at = here(lines, line)
  if (!at) return null
  const item = itemAt(lines, line, at)?.item
  if (item && item === closingOf(at.block)) return addEventAtEnd(lines, line)
  return item ? insertEvent(lines, item.lastLine, item) : insertEvent(lines, at.block.markerLine, at.block.events[0])
}

/**
 * Add child: an empty link one indent deeper under the caret's link, after
 * everything already under it. The indent unit and bullet are the block's own
 * (the first child's, its indent past its parent's), else a tab and the
 * link's bullet. Null on the marker or outside a chain.
 */
export function addChild(lines: string[], line: number): TimelineEdit | null {
  const at = itemAt(lines, line)
  if (at?.block.style !== 'chain') return null
  const { links } = at.block
  const ref = links.find((l) => l.parent !== null)
  const parent = ref?.parent == null ? '' : links[ref.parent].indent
  const unit = ref?.indent.startsWith(parent) ? ref.indent.slice(parent.length) : ''
  return insertItem(lines, at.item.lastLine, `${at.item.indent}${unit || '\t'}${bulletOf(lines, ref ?? at.item)} `)
}

/**
 * "+ Add event": after the last event's last detail line; in steps, after the
 * last step, so the closing Details bullet stays last (on the marker when it
 * is the only one). `line` is the marker or any line of the timeline.
 */
export function addEventAtEnd(lines: string[], line: number): TimelineEdit | null {
  const block = here(lines, line)?.block
  if (!block) return null
  const last = closingOf(block) ? block.steps.at(-1)?.event : block.events.at(-1)
  return insertEvent(lines, last?.lastLine ?? block.markerLine, last ?? block.events[0])
}

/**
 * Swap the caret's event, details and all, with its neighbour; blank lines
 * between them stay put. In a chain, the link with everything under it, among
 * the links under the same parent.
 */
export function moveEvent(lines: string[], line: number, dir: 'up' | 'down'): TimelineEdit | null {
  const at = itemAt(lines, line)
  if (!at) return null
  const { item: e, siblings } = at
  const n = siblings.indexOf(e)
  const other = siblings[dir === 'up' ? n - 1 : n + 1]
  if (!other) return null
  const [a, b] = dir === 'up' ? [other, e] : [e, other]
  const out = [
    ...lines.slice(b.line, b.lastLine + 1),
    ...lines.slice(a.lastLine + 1, b.line),
    ...lines.slice(a.line, a.lastLine + 1)
  ]
  // The caret goes with its event; on a blank line below it, to its last line.
  const l = Math.min(line, e.lastLine)
  const shift = e === a ? b.lastLine - a.lastLine : a.line - b.line
  return replace(a.line, b.lastLine, out, { line: l + shift, ch: lines[l].length })
}

const KIND_WORD: Record<Exclude<EventKind, 'observed'>, string> = {
  detection: 'Detection',
  response: 'Response',
  execution: 'Execution',
  web: 'Web',
  file: 'File',
  email: 'Email',
  user: 'User',
  host: 'Host'
}

/**
 * The kind picker: the kind word and ': ' written right after the time phrase
 * and its separator (at the start when untimed), or the one there replaced;
 * Auto takes it out and leaves the kind to the text. A word that already
 * means the kind (Download for file, Alert for detection) is the analyst's
 * and stays: null. Observed has no word: null, and neither has a bullet that
 * opens a code fence: a word in front would turn the code into text.
 */
export function setEventKind(lines: string[], line: number, kind: EventKind | 'auto'): TimelineEdit | null {
  const e = here(lines, line)?.event
  if (!e || kind === 'observed' || FENCE_OPEN.test(lines[e.line])) return null
  if (kind === 'auto' ? !e.kindExplicit : e.kindExplicit && e.kind === kind) return null
  const text = lines[e.line]
  // body is the line's tail after the time phrase, its separator and any kind word.
  const end = text.length - e.body.length
  const from = e.kindSpan?.from ?? end
  let word = kind === 'auto' ? '' : `${KIND_WORD[kind]}: `
  // 'At 11:05', 'At 11:06,', a bare '-' and '[x]' end with no space to write after.
  if (word && !/\s/.test(text[from - 1])) word = ` ${word}`
  return replace(e.line, e.line, [text.slice(0, from) + word + text.slice(end)])
}

/** Seconds on one scale, to the minute unless `exact`; a dateless time is on day 0. */
function secondsOf(e: TimelineEvent, exact: boolean): number {
  const t = e.time
  const day = t?.date ? Date.UTC(t.date.y, t.date.m - 1, t.date.d) / 1000 : 0
  return day + (t?.minutes ?? 0) * 60 + (exact ? (t?.seconds ?? 0) : 0)
}

/**
 * Events in time order as far as their times say, keeping note order where
 * they do not: by minute first, then the events that have seconds sorted among
 * the places they hold, so an 11:05 keeps its place among 11:05:xx events
 * rather than being taken as 11:05:00. Fractions of a second are not compared.
 */
function byTime(events: TimelineEvent[]): TimelineEvent[] {
  const sorted = events.slice().sort((a, b) => secondsOf(a, false) - secondsOf(b, false))
  const slots = sorted.flatMap((e, i) => (e.time?.seconds == null ? [] : [i]))
  const bySecond = slots.map((i) => sorted[i]).sort((a, b) => secondsOf(a, true) - secondsOf(b, true))
  slots.forEach((i, n) => (sorted[i] = bySecond[n]))
  return sorted
}

/**
 * Sort events by time: null (item hidden) when the timeline is in order, is
 * drawn in another style than events, or the line is not in one; a reason
 * (item disabled) when an event has no time, the times are in different
 * zones, the day order is unknown, or sorting would put a time-only event
 * under another day's date; else the edit. Details go with their event and
 * blank lines between events stay where they are.
 */
export function sortEventsByTime(lines: string[], line: number): { edit: TimelineEdit } | { reason: string } | null {
  const at = here(lines, line)
  if (at?.block.style !== 'events') return null
  const { block } = at
  const timed = block.events.filter((e) => e.time?.minutes != null)
  const times = timed.flatMap((e) => (e.time ? [e.time] : []))
  const ordered = comparable(times)
  const order = ordered ? byTime(timed) : timed
  if (!block.gaps.some((g) => g?.outOfOrder) && order.every((e, i) => e === timed[i])) return null
  const untimed = block.events.length - timed.length
  if (untimed) return { reason: untimed === 1 ? '1 event has no time' : `${untimed} events have no time` }
  if (!oneZone(times)) return { reason: 'The times are written in different zones, so their order is unknown' }
  if (!ordered) return { reason: 'Not every event has a date, so the day order is unknown' }
  const { events } = block
  const out: string[] = []
  let cursor: TimelineEdit['cursor']
  order.forEach((e, i) => {
    if (e === at.event) {
      const l = Math.min(line, e.lastLine)
      cursor = { line: block.firstLine + out.length + l - e.line, ch: lines[l].length }
    }
    out.push(...lines.slice(e.line, e.lastLine + 1))
    if (i + 1 < events.length) out.push(...lines.slice(events[i].lastLine + 1, events[i + 1].line))
  })
  // A time-only event takes its date from the event above it, so moving it can
  // change its day, or the date as written (10/9/26) it sits under.
  const after = findTimelines([...lines.slice(0, block.firstLine), ...out, ...lines.slice(block.lastLine + 1)])
  const moved = after.find((b) => b.markerLine === block.markerLine)?.events ?? []
  const same = (a: TimelineEvent, b: TimelineEvent) =>
    secondsOf(a, true) === secondsOf(b, true) && a.time?.dateText === b.time?.dateText
  if (moved.length !== order.length || moved.some((e, i) => !same(e, order[i]))) {
    return { reason: 'Sorting would move an event onto another day: write its date on it first' }
  }
  return { edit: replace(block.firstLine, block.lastLine, out, cursor) }
}

/**
 * Delete event: the event and its details, whole lines (in a chain, the link
 * and everything under it); the caret goes to the line above. Between two
 * blank lines (a loose list) one of them goes too: two would end the timeline
 * there.
 */
export function deleteEvent(lines: string[], line: number): TimelineEdit | null {
  const e = itemAt(lines, line)?.item
  if (!e) return null
  const loose = isBlank(lines[e.line - 1]) && e.lastLine + 1 < lines.length && isBlank(lines[e.lastLine + 1])
  return removeLines(lines, e.line, e.lastLine + (loose ? 1 : 0), { line: e.line - 1, ch: lines[e.line - 1].length })
}

/**
 * Defang timeline: defangTimelineText over every event and detail line,
 * never the marker or anything outside the list. `changed` is false when there was
 * nothing to defang, for the caller's notice.
 */
export function defangTimeline(lines: string[], line: number): { edit: TimelineEdit; changed: boolean } | null {
  const block = here(lines, line)?.block
  if (!block) return null
  const { markerLine, firstLine, lastLine } = block
  if (!block.events.length) return { edit: replace(markerLine, markerLine, [lines[markerLine]]), changed: false }
  const before = lines.slice(firstLine, lastLine + 1)
  const out = before.map((l) => defangTimelineText(l))
  return { edit: replace(firstLine, lastLine, out), changed: out.some((l, i) => l !== before[i]) }
}

/** Back to plain list: only the marker line goes, whatever the style. */
export function backToPlainList(lines: string[], line: number): TimelineEdit | null {
  const block = here(lines, line)?.block
  return block ? removeLines(lines, block.markerLine, block.markerLine) : null
}

/**
 * Copy timeline for ticket: the text, defanged as Defang timeline defangs the
 * note, line by line, before it is laid out for the ticket: a bare domain that
 * is the whole of its note line is defanged there, and would be left as prose
 * once moved onto the event line. Copy it as it is; whether anything was
 * defanged is defangTimeline's `changed`.
 */
export function copyText(lines: string[], line: number): string | null {
  const edit = defangTimeline(lines, line)?.edit
  if (!edit) return null
  // Defanging keeps every line where it was, so `line` is still in the timeline.
  const out = lines.slice()
  out.splice(edit.fromLine, edit.toLine - edit.fromLine + 1, ...edit.text.split('\n'))
  const block = here(out, line)?.block
  return block ? copyForTicket(block) : null
}

/**
 * Write an edit into the editor as one undo step, then place the caret. Only
 * the part that differs is replaced, so the caret, a selection or a fold in
 * the text around it stays where it was.
 */
export function applyEdit(editor: Editor, edit: TimelineEdit): void {
  const start = { line: edit.fromLine, ch: 0 }
  const old = editor.getRange(start, { line: edit.toLine, ch: editor.getLine(edit.toLine).length })
  const next = edit.text
  let p = 0
  while (p < old.length && p < next.length && old[p] === next[p]) p++
  let s = 0
  while (s < old.length - p && s < next.length - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s++
  if (p + s < old.length || p + s < next.length) {
    const base = editor.posToOffset(start)
    editor.transaction({
      changes: [
        {
          from: editor.offsetToPos(base + p),
          to: editor.offsetToPos(base + old.length - s),
          text: next.slice(p, next.length - s)
        }
      ]
    })
  }
  if (edit.cursor) editor.setCursor(edit.cursor)
}
