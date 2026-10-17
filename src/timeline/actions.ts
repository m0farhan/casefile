import type { Editor } from 'obsidian'
import { defangText } from '../soc/toolbox'
import {
  TIMELINE_MARKER,
  type EventKind,
  type TimelineBlock,
  type TimelineEvent,
  comparable,
  copyForTicket,
  findTimelines,
  frontmatterEnd,
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

const isBlank = (s: string | undefined): boolean => !s?.trim()
const indentOf = (s: string): number => s.length - s.trimStart().length

function here(lines: string[], line: number): { block: TimelineBlock; event: TimelineEvent | null } | null {
  return timelineAt(findTimelines(lines), line)
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
 * Make timeline: the marker line directly above the list the caret is in.
 * Over a selection of two or more lines, its plain lines become events first:
 * '- ' goes in front of each at the selection's least indent, a deeper one
 * stays the detail of the line above, and blank lines and leading headings are
 * left alone. Null when there is no list, the lines are in a timeline already
 * or in the frontmatter, or they would not all become one timeline (a heading
 * or two blank lines inside the selection; a code fence, a divider or a
 * numbered item where '- ' would go).
 */
export function makeTimeline(lines: string[], fromLine: number, toLine: number): TimelineEdit | null {
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
  const marker = (BULLET.exec(out[start])?.[1] ?? '') + TIMELINE_MARKER
  // The parser has the last word: every line asked for must be in the new timeline.
  const marked = [...out.slice(0, start), marker, ...out.slice(start)]
  const block = findTimelines(marked).find((b) => b.markerLine === start)
  for (let i = first; i <= last; i++) {
    if (!isBlank(lines[i]) && !(block && timelineAt([block], i + 1)?.event)) return null
  }
  return replace(start, last, [marker, ...out.slice(start, last + 1)])
}

/** An empty event after line `after`, bulleted and indented like `like`, caret in it. */
function insertEvent(lines: string[], after: number, like: TimelineEvent | undefined): TimelineEdit {
  const bullet = like ? `${like.indent}${lines[like.line][like.indent.length]} ` : '- '
  return replace(after, after, [lines[after], bullet], { line: after + 1, ch: bullet.length })
}

/** Add event below: after the caret's event and its details; on the marker, the new first event. */
export function addEventBelow(lines: string[], line: number): TimelineEdit | null {
  const at = here(lines, line)
  if (!at) return null
  return at.event
    ? insertEvent(lines, at.event.lastLine, at.event)
    : insertEvent(lines, at.block.markerLine, at.block.events[0])
}

/** "+ Add event": after the last event's last detail line. `line` is the marker or any line of the timeline. */
export function addEventAtEnd(lines: string[], line: number): TimelineEdit | null {
  const block = here(lines, line)?.block
  return block ? insertEvent(lines, block.lastLine, block.events.at(-1)) : null
}

/** Swap the caret's event, details and all, with its neighbour; blank lines between them stay put. */
export function moveEvent(lines: string[], line: number, dir: 'up' | 'down'): TimelineEdit | null {
  const at = here(lines, line)
  const e = at?.event
  if (!at || !e) return null
  const { events } = at.block
  const n = events.indexOf(e)
  const other = events[dir === 'up' ? n - 1 : n + 1]
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
  email: 'Email'
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
 * Sort events by time: null (item hidden) when the timeline is in order or
 * the line is not in one; a reason (item disabled) when an event has no time,
 * the times are in different zones, the day order is unknown, or sorting would
 * put a time-only event under another day's date; else the edit. Details go
 * with their event and blank lines between events stay where they are.
 */
export function sortEventsByTime(lines: string[], line: number): { edit: TimelineEdit } | { reason: string } | null {
  const at = here(lines, line)
  if (!at) return null
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
 * Delete event: the event and its details, whole lines; the caret goes to the
 * line above. Between two blank lines (a loose list) one of them goes too:
 * two would end the timeline there.
 */
export function deleteEvent(lines: string[], line: number): TimelineEdit | null {
  const e = here(lines, line)?.event
  if (!e) return null
  const loose = isBlank(lines[e.line - 1]) && e.lastLine + 1 < lines.length && isBlank(lines[e.lastLine + 1])
  return removeLines(lines, e.line, e.lastLine + (loose ? 1 : 0), { line: e.line - 1, ch: lines[e.line - 1].length })
}

/**
 * Defang timeline: defangText over every event and detail line, never the
 * marker or anything outside the list. `changed` is false when there was
 * nothing to defang, for the caller's notice.
 */
export function defangTimeline(lines: string[], line: number): { edit: TimelineEdit; changed: boolean } | null {
  const block = here(lines, line)?.block
  if (!block) return null
  const { markerLine, firstLine, lastLine } = block
  if (!block.events.length) return { edit: replace(markerLine, markerLine, [lines[markerLine]]), changed: false }
  const before = lines.slice(firstLine, lastLine + 1)
  const out = before.map((l) => defangText(l))
  return { edit: replace(firstLine, lastLine, out), changed: out.some((l, i) => l !== before[i]) }
}

/** Back to plain list: only the marker line goes. */
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
