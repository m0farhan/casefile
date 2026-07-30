import { parsePlainDate, Temporal } from '../dates'
import type { PriorityConfig, SeverityConfig, StatusConfig, Task } from '../types'
import { isTerminalStatus } from '../utils'

/**
 * JQL-lite query parser for the header search box.
 *
 * Grammar (all terms AND-ed, garbage never throws):
 *   query := term (whitespace term)*
 *   term  := field ':' value | bareword         (unknown field → whole term is free text)
 *   value := '!' atom | ('>='|'<='|'>'|'<') atom | atom
 *   atom  := '"' chars '"' | run of non-space chars
 *
 * Pure module — no Obsidian imports. Free-text words are NOT evaluated here;
 * they fall through to TaskFilter's existing substring matcher.
 */

export type Op = '=' | '!' | '>' | '>=' | '<' | '<='

export interface StructuredTerm {
  field: string
  op: Op
  /** Lowercased at parse time — all matching is case-insensitive against ids. */
  value: string
}

export interface CompiledQuery {
  terms: StructuredTerm[]
  freeText: string
}

export interface QueryCtx {
  statuses: StatusConfig[]
  /** Ordered catalog; index 0 = highest rank (drives `prio:>=high`). */
  priorities: PriorityConfig[]
  /** Ordered catalog; index 0 = most severe (drives `sev:>=sev2`). */
  severities: SeverityConfig[]
  /** Resolves `assignee:me`. Empty → 'me' stays a literal name. */
  currentUser: string
  today: Temporal.PlainDate
}

export type FieldMatcher = (task: Task, op: Op, value: string, ctx: QueryCtx) => boolean

// ─── Matcher helpers ─────────────────────────────────────────────────────────

/** Equality/negation on a single id-ish field. Ordering ops never match. */
function eqNeg(op: Op, actual: string, value: string): boolean {
  if (op === '=') return actual.toLowerCase() === value
  if (op === '!') return actual.toLowerCase() !== value
  return false
}

/** Positive predicate + op: '=' keeps it, '!' inverts it, ordering ops never match. */
function withNeg(op: Op, hit: boolean): boolean {
  if (op === '=') return hit
  if (op === '!') return !hit
  return false
}

/** Eq/neg plus ordering by catalog index, where index 0 = highest rank (so '>=' means idx <= idx(value)). */
function rankMatch(catalog: { id: string }[], actual: string, op: Op, value: string): boolean {
  if (op === '=' || op === '!') return eqNeg(op, actual, value)
  const ids = catalog.map((c) => c.id.toLowerCase())
  const ti = ids.indexOf(actual.toLowerCase())
  const vi = ids.indexOf(value)
  if (ti < 0 || vi < 0) return false
  if (op === '>') return ti < vi
  if (op === '>=') return ti <= vi
  if (op === '<') return ti > vi
  return ti >= vi
}

function compareDates(op: Op, due: Temporal.PlainDate, target: Temporal.PlainDate): boolean {
  const c = Temporal.PlainDate.compare(due, target)
  if (op === '<') return c < 0
  if (op === '<=') return c <= 0
  if (op === '>') return c > 0
  if (op === '>=') return c >= 0
  return withNeg(op, c === 0)
}

/** 'overdue' | 'today' | 'tomorrow' | 'this-week' | 'this-month' | 'none'; null when not a keyword. */
function dueKeyword(task: Task, value: string, ctx: QueryCtx): boolean | null {
  if (value === 'none') return !task.due
  const due = parsePlainDate(task.due)
  switch (value) {
    case 'overdue':
      return !!due && Temporal.PlainDate.compare(due, ctx.today) < 0 && !isTerminalStatus(task.status, ctx.statuses)
    case 'today':
      return !!due && Temporal.PlainDate.compare(due, ctx.today) === 0
    case 'tomorrow':
      return !!due && Temporal.PlainDate.compare(due, ctx.today.add({ days: 1 })) === 0
    case 'this-week': {
      // Same window as matchDueDateFilter: from today through the end of the ISO week.
      if (!due) return false
      const end = ctx.today.add({ days: 7 - (ctx.today.dayOfWeek % 7) })
      return Temporal.PlainDate.compare(due, ctx.today) >= 0 && Temporal.PlainDate.compare(due, end) <= 0
    }
    case 'this-month':
      return (
        !!due &&
        due.year === ctx.today.year &&
        due.month === ctx.today.month &&
        Temporal.PlainDate.compare(due, ctx.today) >= 0
      )
    default:
      return null
  }
}

/** Relative value like '7d' / '2w' / '1m' → today + n units; else parse as an ISO date. */
function dueTarget(value: string, todayDate: Temporal.PlainDate): Temporal.PlainDate | null {
  const m = /^(\d+)([dwm])$/.exec(value)
  if (!m) return parsePlainDate(value)
  const n = Number(m[1])
  if (m[2] === 'd') return todayDate.add({ days: n })
  if (m[2] === 'w') return todayDate.add({ weeks: n })
  return todayDate.add({ months: n })
}

// ─── Field registry ──────────────────────────────────────────────────────────

/**
 * Extensible field registry: later features add entries here and both parsing
 * (field recognition) and evaluation pick them up without parser changes.
 * Aliases are just extra entries pointing at the same matcher.
 */
export const FIELD_MATCHERS: Record<string, FieldMatcher> = {
  // Exact key, or key-prefix: key:ARGUS matches ARGUS-3 but key:ARGUS-1 never matches ARGUS-12.
  key: (task, op, value) => {
    const k = task.key.toLowerCase()
    return withNeg(op, k !== '' && (k === value || k.startsWith(value + '-')))
  },
  status: (task, op, value) => eqNeg(op, task.status, value),
  type: (task, op, value) => eqNeg(op, task.issueType, value),
  priority: (task, op, value, ctx) => rankMatch(ctx.priorities, task.priority, op, value),
  severity: (task, op, value, ctx) => rankMatch(ctx.severities, task.severity, op, value),
  verdict: (task, op, value) => eqNeg(op, task.verdict, value),
  assignee: (task, op, value, ctx) => {
    const v = value === 'me' && ctx.currentUser ? ctx.currentUser.toLowerCase() : value
    const hit = v === 'none' ? task.assignees.length === 0 : task.assignees.some((a) => a.toLowerCase() === v)
    return withNeg(op, hit)
  },
  tag: (task, op, value) =>
    withNeg(
      op,
      task.tags.some((t) => t.toLowerCase() === value)
    ),
  bucket: (task, op, value) => eqNeg(op, task.bucket, value),
  progress: (task, op, value) => {
    const n = Number(value)
    if (value === '' || !Number.isFinite(n)) return false
    if (op === '=') return task.progress === n
    if (op === '!') return task.progress !== n
    if (op === '>') return task.progress > n
    if (op === '>=') return task.progress >= n
    if (op === '<') return task.progress < n
    return task.progress <= n
  },
  due: (task, op, value, ctx) => {
    if (op === '=' || op === '!') {
      const kw = dueKeyword(task, value, ctx)
      if (kw !== null) return withNeg(op, kw)
    }
    const due = parsePlainDate(task.due)
    const target = dueTarget(value, ctx.today)
    if (!due || !target) return false
    return compareDates(op, due, target)
  },
  // Note: matchesFilter's early `task.archived && !filter.showArchived` gate still
  // applies before this runs — archived:true only surfaces tasks when showArchived is on.
  archived: (task, op, value) => {
    if (value !== 'true' && value !== 'false') return false
    return withNeg(op, !!task.archived === (value === 'true'))
  }
}
FIELD_MATCHERS.prio = FIELD_MATCHERS.priority
FIELD_MATCHERS.sev = FIELD_MATCHERS.severity

// ─── Parsing ─────────────────────────────────────────────────────────────────

const CMP_OPS: Op[] = ['>=', '<=', '>', '<', '!']

function stripQuotes(s: string): string {
  if (s.startsWith('"')) s = s.slice(1)
  if (s.endsWith('"')) s = s.slice(0, -1)
  return s
}

/** Split on whitespace, keeping double-quoted runs (e.g. assignee:"John Smith") together. */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let inQuote = false
  for (const ch of text) {
    if (ch === '"') {
      inQuote = !inQuote
      cur += ch
    } else if (!inQuote && /\s/.test(ch)) {
      if (cur) tokens.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur) tokens.push(cur)
  return tokens
}

function parseValue(raw: string): { op: Op; value: string } {
  let op: Op = '='
  for (const o of CMP_OPS) {
    if (raw.startsWith(o)) {
      op = o
      raw = raw.slice(o.length)
      break
    }
  }
  return { op, value: stripQuotes(raw) }
}

function compile(text: string): CompiledQuery {
  const terms: StructuredTerm[] = []
  const free: string[] = []
  for (const token of tokenize(text.trim())) {
    const m = /^([A-Za-z]+):(.+)$/s.exec(token)
    const field = m ? m[1].toLowerCase() : ''
    if (m && FIELD_MATCHERS[field]) {
      const { op, value } = parseValue(m[2])
      if (value) {
        terms.push({ field, op, value: value.toLowerCase() })
        continue
      }
    }
    // Unknown field, empty value (mid-typing), or plain word → free text.
    const word = stripQuotes(token)
    if (word) free.push(word)
  }
  return { terms, freeText: free.join(' ') }
}

// ponytail: single-entry memo — matchesFilter parses the same string once per task per render.
let cached: { text: string; query: CompiledQuery } | null = null

export function parseQuery(text: string): CompiledQuery {
  if (cached?.text === text) return cached.query
  const query = compile(text)
  cached = { text, query }
  return query
}

/** AND over the structured terms only — free text is evaluated by TaskFilter's substring matcher. */
export function evaluateQuery(compiled: CompiledQuery, task: Task, ctx: QueryCtx): boolean {
  return compiled.terms.every((t) => FIELD_MATCHERS[t.field]?.(task, t.op, t.value, ctx) ?? false)
}
