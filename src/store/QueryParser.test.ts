import { describe, expect, it } from 'vitest'
import { Temporal } from '../dates'
import { DEFAULT_PRIORITIES, DEFAULT_SEVERITIES, DEFAULT_STATUSES, makeTask, type Task } from '../types'
import { evaluateQuery, FIELD_HELP, FIELD_MATCHERS, HELP_HIDDEN_FIELDS, parseQuery, type QueryCtx } from './QueryParser'

// Thursday; end of ISO week = 2026-08-02.
const TODAY = Temporal.PlainDate.from('2026-07-30')

function ctx(overrides: Partial<QueryCtx> = {}): QueryCtx {
  return {
    statuses: DEFAULT_STATUSES,
    priorities: DEFAULT_PRIORITIES,
    severities: DEFAULT_SEVERITIES,
    currentUser: '',
    today: TODAY,
    ...overrides
  }
}

function matches(query: string, overrides: Partial<Task>, c: QueryCtx = ctx()): boolean {
  return evaluateQuery(parseQuery(query), makeTask(overrides), c)
}

describe('parseQuery', () => {
  it('returns an empty query for empty and whitespace-only input', () => {
    expect(parseQuery('')).toEqual({ terms: [], freeText: '' })
    expect(parseQuery('   \n ')).toEqual({ terms: [], freeText: '' })
  })

  it('parses field terms and collects the rest as free text', () => {
    expect(parseQuery('status:done beacon triage')).toEqual({
      terms: [{ field: 'status', op: '=', value: 'done' }],
      freeText: 'beacon triage'
    })
  })

  it('parses negation and every comparison operator', () => {
    expect(parseQuery('status:!done').terms).toEqual([{ field: 'status', op: '!', value: 'done' }])
    expect(parseQuery('prio:>=high').terms).toEqual([{ field: 'prio', op: '>=', value: 'high' }])
    expect(parseQuery('prio:<=low').terms).toEqual([{ field: 'prio', op: '<=', value: 'low' }])
    expect(parseQuery('progress:>50').terms).toEqual([{ field: 'progress', op: '>', value: '50' }])
    expect(parseQuery('due:<2026-08-15').terms).toEqual([{ field: 'due', op: '<', value: '2026-08-15' }])
  })

  it('keeps a double-quoted value (with spaces) as one atom', () => {
    expect(parseQuery('assignee:"John Smith" beacon').terms).toEqual([
      { field: 'assignee', op: '=', value: 'john smith' }
    ])
    expect(parseQuery('assignee:"John Smith" beacon').freeText).toBe('beacon')
    expect(parseQuery('assignee:!"John Smith"').terms).toEqual([{ field: 'assignee', op: '!', value: 'john smith' }])
  })

  it('quotes protect operator characters', () => {
    expect(parseQuery('assignee:">weird"').terms).toEqual([{ field: 'assignee', op: '=', value: '>weird' }])
  })

  it('lowercases field names and values', () => {
    expect(parseQuery('STATUS:Done').terms).toEqual([{ field: 'status', op: '=', value: 'done' }])
  })

  it('treats an unknown field as free text (whole term)', () => {
    expect(parseQuery('flavor:sour status:done')).toEqual({
      terms: [{ field: 'status', op: '=', value: 'done' }],
      freeText: 'flavor:sour'
    })
  })

  it('never throws on garbage: lone colons, dangling ops, unclosed quotes', () => {
    expect(() => parseQuery(':')).not.toThrow()
    expect(() => parseQuery('::: a:b: !>=< "')).not.toThrow()
    expect(parseQuery(':').freeText).toBe(':')
    expect(parseQuery('status:').freeText).toBe('status:')
    expect(parseQuery('status:!').freeText).toBe('status:!')
    expect(parseQuery('assignee:"John').terms).toEqual([{ field: 'assignee', op: '=', value: 'john' }])
  })

  it('memoizes the last query string', () => {
    const a = parseQuery('status:done x')
    expect(parseQuery('status:done x')).toBe(a)
    expect(parseQuery('status:todo')).not.toBe(a)
  })
})

describe('field matchers', () => {
  it('key: exact and prefix match, case-insensitive', () => {
    expect(matches('key:soc-3', { key: 'SOC-3' })).toBe(true)
    expect(matches('key:SOC', { key: 'SOC-3' })).toBe(true)
    expect(matches('key:SOC-1', { key: 'SOC-12' })).toBe(false)
    expect(matches('key:IR', { key: 'SOC-3' })).toBe(false)
    expect(matches('key:!SOC', { key: 'SOC-3' })).toBe(false)
    expect(matches('key:SOC', { key: '' })).toBe(false)
  })

  it('status: equality and negation on the id', () => {
    expect(matches('status:done', { status: 'done' })).toBe(true)
    expect(matches('status:DONE', { status: 'done' })).toBe(true)
    expect(matches('status:done', { status: 'todo' })).toBe(false)
    expect(matches('status:!done', { status: 'todo' })).toBe(true)
    expect(matches('status:!done', { status: 'done' })).toBe(false)
  })

  it('status: an ordering op on an equality field matches nothing (and never throws)', () => {
    expect(matches('status:>done', { status: 'done' })).toBe(false)
  })

  it('type: matches issueType', () => {
    expect(matches('type:incident', { issueType: 'incident' })).toBe(true)
    expect(matches('type:!incident', { issueType: 'bug' })).toBe(true)
    expect(matches('type:incident', { issueType: 'bug' })).toBe(false)
  })

  it('priority: ordering by catalog index, 0 = highest rank', () => {
    // DEFAULT_PRIORITIES: critical, high, medium, low
    expect(matches('prio:>=high', { priority: 'critical' })).toBe(true)
    expect(matches('prio:>=high', { priority: 'high' })).toBe(true)
    expect(matches('prio:>=high', { priority: 'medium' })).toBe(false)
    expect(matches('prio:>high', { priority: 'critical' })).toBe(true)
    expect(matches('prio:>high', { priority: 'high' })).toBe(false)
    expect(matches('prio:<medium', { priority: 'low' })).toBe(true)
    expect(matches('prio:<medium', { priority: 'medium' })).toBe(false)
    expect(matches('prio:<=medium', { priority: 'medium' })).toBe(true)
    expect(matches('priority:high', { priority: 'high' })).toBe(true)
    expect(matches('priority:!high', { priority: 'low' })).toBe(true)
  })

  it('priority: unknown ids never match an ordering op', () => {
    expect(matches('prio:>=urgent', { priority: 'high' })).toBe(false)
    expect(matches('prio:>=high', { priority: 'mystery' })).toBe(false)
    expect(matches('prio:>=high', { priority: 'high' }, ctx({ priorities: [] }))).toBe(false)
  })

  it('severity: sev:>=sev2 means sev1 or sev2 (old id forms keep working)', () => {
    expect(matches('sev:>=sev2', { severity: 'sev1' })).toBe(true)
    expect(matches('sev:>=sev2', { severity: 'sev2' })).toBe(true)
    expect(matches('sev:>=sev2', { severity: 'sev3' })).toBe(false)
    expect(matches('sev:>=sev2', { severity: '' })).toBe(false)
    expect(matches('severity:sev1', { severity: 'sev1' })).toBe(true)
    expect(matches('sev:!sev1', { severity: 'sev2' })).toBe(true)
  })

  it('severity: labels resolve like ids, for equality, negation, and ranking', () => {
    // DEFAULT_SEVERITIES: sev1 Critical, sev2 High, sev3 Medium, sev4 Low
    expect(matches('sev:critical', { severity: 'sev1' })).toBe(true)
    expect(matches('sev:critical', { severity: 'sev2' })).toBe(false)
    expect(matches('sev:>=high', { severity: 'sev1' })).toBe(true)
    expect(matches('sev:>=high', { severity: 'sev2' })).toBe(true)
    expect(matches('sev:>=high', { severity: 'sev3' })).toBe(false)
    expect(matches('sev:!low', { severity: 'sev1' })).toBe(true)
    expect(matches('sev:!low', { severity: 'sev4' })).toBe(false)
    expect(matches('sev:!low', { severity: '' })).toBe(true)
  })

  it('severity: label matching is case-insensitive', () => {
    expect(matches('sev:CRITICAL', { severity: 'sev1' })).toBe(true)
    expect(matches('SEV:>=High', { severity: 'sev2' })).toBe(true)
    expect(matches('severity:Medium', { severity: 'sev3' })).toBe(true)
  })

  it('severity: a value neither id nor label never matches, on any op', () => {
    expect(matches('sev:catastrophic', { severity: 'sev1' })).toBe(false)
    expect(matches('sev:>=catastrophic', { severity: 'sev1' })).toBe(false)
    expect(matches('sev:!catastrophic', { severity: 'sev1' })).toBe(false)
  })

  it('priority: labels resolve like ids (help-hidden, but old saved queries keep working)', () => {
    // DEFAULT_PRIORITIES ids already equal their lowercased labels, so this
    // pins the label path via mixed case.
    expect(matches('prio:>=High', { priority: 'critical' })).toBe(true)
    expect(matches('priority:Critical', { priority: 'critical' })).toBe(true)
  })

  it('verdict: equality and negation', () => {
    expect(matches('verdict:pending', { verdict: 'pending' })).toBe(true)
    expect(matches('verdict:!pending', { verdict: 'false-positive' })).toBe(true)
    expect(matches('verdict:pending', { verdict: '' })).toBe(false)
  })

  it('assignee: me resolves to currentUser, falls back to the literal', () => {
    const withUser = ctx({ currentUser: 'Alice' })
    expect(matches('assignee:me', { assignees: ['Alice'] }, withUser)).toBe(true)
    expect(matches('assignee:me', { assignees: ['Bob'] }, withUser)).toBe(false)
    expect(matches('assignee:me', { assignees: ['me'] })).toBe(true)
    expect(matches('assignee:me', { assignees: ['Alice'] })).toBe(false)
  })

  it('assignee: none matches unassigned, negation inverts', () => {
    expect(matches('assignee:none', { assignees: [] })).toBe(true)
    expect(matches('assignee:none', { assignees: ['Alice'] })).toBe(false)
    expect(matches('assignee:!none', { assignees: ['Alice'] })).toBe(true)
    expect(matches('assignee:"john smith"', { assignees: ['John Smith'] })).toBe(true)
    expect(matches('assignee:!bob', { assignees: ['Alice'] })).toBe(true)
  })

  it('tag: any tag equals; negation = no tag equals', () => {
    expect(matches('tag:phishing', { tags: ['malware', 'phishing'] })).toBe(true)
    expect(matches('tag:phishing', { tags: ['malware'] })).toBe(false)
    expect(matches('tag:!phishing', { tags: ['malware'] })).toBe(true)
    expect(matches('tag:!phishing', { tags: [] })).toBe(true)
    expect(matches('tag:PHISHING', { tags: ['phishing'] })).toBe(true)
  })

  it('bucket: equality including the literal none', () => {
    expect(matches('bucket:this-week', { bucket: 'this-week' })).toBe(true)
    expect(matches('bucket:none', { bucket: 'none' })).toBe(true)
    expect(matches('bucket:!none', { bucket: 'next' })).toBe(true)
    expect(matches('bucket:next', { bucket: 'none' })).toBe(false)
  })

  it('progress: equality and ordering on the number', () => {
    expect(matches('progress:50', { progress: 50 })).toBe(true)
    expect(matches('progress:50', { progress: 49 })).toBe(false)
    expect(matches('progress:!50', { progress: 49 })).toBe(true)
    expect(matches('progress:>=50', { progress: 50 })).toBe(true)
    expect(matches('progress:>50', { progress: 50 })).toBe(false)
    expect(matches('progress:<50', { progress: 0 })).toBe(true)
    expect(matches('progress:<=50', { progress: 51 })).toBe(false)
    expect(matches('progress:banana', { progress: 50 })).toBe(false)
  })

  it('due: none / today / tomorrow keywords', () => {
    expect(matches('due:none', { due: '' })).toBe(true)
    expect(matches('due:none', { due: '2026-08-01' })).toBe(false)
    expect(matches('due:!none', { due: '2026-08-01' })).toBe(true)
    expect(matches('due:today', { due: '2026-07-30' })).toBe(true)
    expect(matches('due:today', { due: '2026-07-31' })).toBe(false)
    expect(matches('due:tomorrow', { due: '2026-07-31' })).toBe(true)
    expect(matches('due:tomorrow', { due: '2026-07-30' })).toBe(false)
  })

  it('due: overdue requires a past date and a non-terminal status', () => {
    expect(matches('due:overdue', { due: '2026-07-29', status: 'in-progress' })).toBe(true)
    expect(matches('due:overdue', { due: '2026-07-29', status: 'done' })).toBe(false)
    expect(matches('due:overdue', { due: '2026-07-30', status: 'in-progress' })).toBe(false)
    expect(matches('due:overdue', { due: '', status: 'in-progress' })).toBe(false)
  })

  it('due: this-week and this-month windows', () => {
    // Week of Thu 2026-07-30 ends Sun 2026-08-02.
    expect(matches('due:this-week', { due: '2026-07-30' })).toBe(true)
    expect(matches('due:this-week', { due: '2026-08-02' })).toBe(true)
    expect(matches('due:this-week', { due: '2026-08-03' })).toBe(false)
    expect(matches('due:this-week', { due: '2026-07-29' })).toBe(false)
    expect(matches('due:this-month', { due: '2026-07-31' })).toBe(true)
    expect(matches('due:this-month', { due: '2026-07-01' })).toBe(false)
    expect(matches('due:this-month', { due: '2026-08-01' })).toBe(false)
  })

  it('due: relative comparisons in d/w/m from ctx.today', () => {
    expect(matches('due:<7d', { due: '2026-08-05' })).toBe(true)
    expect(matches('due:<7d', { due: '2026-08-06' })).toBe(false)
    expect(matches('due:<=2w', { due: '2026-08-13' })).toBe(true)
    expect(matches('due:<=2w', { due: '2026-08-14' })).toBe(false)
    expect(matches('due:>3d', { due: '2026-08-05' })).toBe(true)
    expect(matches('due:>3d', { due: '2026-08-01' })).toBe(false)
    expect(matches('due:>=1m', { due: '2026-08-30' })).toBe(true)
    expect(matches('due:>=1m', { due: '2026-08-29' })).toBe(false)
  })

  it('due: ISO comparisons and exact date', () => {
    expect(matches('due:<2026-08-15', { due: '2026-08-14' })).toBe(true)
    expect(matches('due:<2026-08-15', { due: '2026-08-15' })).toBe(false)
    expect(matches('due:2026-08-15', { due: '2026-08-15' })).toBe(true)
    expect(matches('due:2026-08-15', { due: '2026-08-14' })).toBe(false)
    expect(matches('due:!2026-08-15', { due: '2026-08-14' })).toBe(true)
  })

  it('due: no due date or garbage value never matches a comparison', () => {
    expect(matches('due:<7d', { due: '' })).toBe(false)
    expect(matches('due:garbage', { due: '2026-08-01' })).toBe(false)
    expect(matches('due:<garbage', { due: '2026-08-01' })).toBe(false)
  })

  it('archived: matches the flag (visibility still gated by showArchived upstream)', () => {
    expect(matches('archived:true', { archived: true })).toBe(true)
    expect(matches('archived:true', {})).toBe(false)
    expect(matches('archived:false', {})).toBe(true)
    expect(matches('archived:false', { archived: true })).toBe(false)
    expect(matches('archived:maybe', { archived: true })).toBe(false)
  })

  it('ANDs all terms together', () => {
    const t: Partial<Task> = { issueType: 'incident', status: 'in-progress', severity: 'sev1' }
    expect(matches('type:incident status:!done sev:>=sev2', t)).toBe(true)
    expect(matches('type:incident status:!done sev:>=sev2', { ...t, status: 'done' })).toBe(false)
    expect(matches('type:incident status:!done sev:>=sev2', { ...t, severity: 'sev3' })).toBe(false)
    expect(matches('type:incident status:!done sev:>=sev2', { ...t, issueType: 'task' })).toBe(false)
  })
})

describe('sla: matcher', () => {
  // sev1: respond within 60m, resolve within 240m of the anchor (detectedAt).
  const POLICIES = { sev1: { responseMins: 60, resolutionMins: 240 } }
  const T0 = Date.parse('2026-07-30T10:00:00Z')
  const MIN = 60_000
  const base: Partial<Task> = { issueType: 'incident', severity: 'sev1', detectedAt: '2026-07-30T10:00:00Z' }
  const at = (mins: number): QueryCtx => ctx({ slaPolicies: POLICIES, now: T0 + mins * MIN })

  it('ok: clock running with most of the window left', () => {
    expect(matches('sla:ok', base, at(10))).toBe(true)
    expect(matches('sla:warn', base, at(10))).toBe(false)
    expect(matches('sla:breached', base, at(10))).toBe(false)
    expect(matches('sla:none', base, at(10))).toBe(false)
  })

  it('warn: under a quarter of the response window remains', () => {
    expect(matches('sla:warn', base, at(50))).toBe(true)
    expect(matches('sla:ok', base, at(50))).toBe(false)
  })

  it('breached: past the response deadline; negation inverts', () => {
    expect(matches('sla:breached', base, at(90))).toBe(true)
    expect(matches('sla:!breached', base, at(90))).toBe(false)
    expect(matches('sla:!breached', base, at(10))).toBe(true)
  })

  it('resolution phase: respondedAt moves the clock to the resolution deadline', () => {
    const responded = { ...base, respondedAt: '2026-07-30T10:30:00Z' }
    expect(matches('sla:ok', responded, at(90))).toBe(true)
    expect(matches('sla:breached', responded, at(250))).toBe(true)
  })

  it('resolved on time is ok; resolved late stays breached', () => {
    const early = { ...base, respondedAt: '2026-07-30T10:10:00Z', resolvedAt: '2026-07-30T12:00:00Z' }
    const late = { ...base, respondedAt: '2026-07-30T10:10:00Z', resolvedAt: '2026-07-30T15:00:00Z' }
    expect(matches('sla:ok', early, at(500))).toBe(true)
    expect(matches('sla:breached', late, at(500))).toBe(true)
    expect(matches('sla:warn', late, at(500))).toBe(false)
  })

  it('none: not an incident, severity without a policy, or no policies at all', () => {
    expect(matches('sla:none', { ...base, issueType: 'task' }, at(10))).toBe(true)
    expect(matches('sla:none', { ...base, severity: 'sev4' }, at(10))).toBe(true)
    // ctx without slaPolicies and nothing registered → every task is none.
    expect(matches('sla:none', base, ctx({ now: T0 + 10 * MIN }))).toBe(true)
    expect(matches('sla:!none', base, at(10))).toBe(true)
  })

  it('ordering ops and unknown values never match', () => {
    expect(matches('sla:>breached', base, at(90))).toBe(false)
    expect(matches('sla:later', base, at(90))).toBe(false)
  })
})

describe('ioc: matcher', () => {
  const iocs = [
    { type: 'domain' as const, value: 'evil.com' },
    { type: 'url' as const, value: 'hxxp://bad[.]site/payload' },
    { type: 'hash' as const, value: 'D41D8CD98F00B204E9800998ECF8427E' }
  ]

  it('a defanged query matches a real stored value', () => {
    expect(matches('ioc:evil[.]com', { iocs })).toBe(true)
    expect(matches('ioc:hxxp://evil[.]com', { iocs })).toBe(false)
  })

  it('a real query matches a defanged stored value', () => {
    expect(matches('ioc:http://bad.site', { iocs })).toBe(true)
  })

  it('substring match, case-insensitive on both sides', () => {
    expect(matches('ioc:d41d8cd9', { iocs })).toBe(true)
    expect(matches('ioc:bad.site', { iocs })).toBe(true)
    expect(matches('ioc:good.site', { iocs })).toBe(false)
  })

  it('negation and empty ioc list', () => {
    expect(matches('ioc:!evil.com', { iocs })).toBe(false)
    expect(matches('ioc:!evil.com', { iocs: [] })).toBe(true)
    expect(matches('ioc:evil.com', { iocs: [] })).toBe(false)
  })
})

describe('FIELD_HELP', () => {
  it('stays in sync with FIELD_MATCHERS (every help row is a real field, every matcher has a row or is deliberately hidden)', () => {
    for (const f of FIELD_HELP) {
      expect(FIELD_MATCHERS[f.field], `help row '${f.field}' has no matcher`).toBeTypeOf('function')
      expect(HELP_HIDDEN_FIELDS.has(f.field), `'${f.field}' is help-hidden but has a help row`).toBe(false)
      expect(f.example.startsWith(`${f.field}:`), `example for '${f.field}' must use its own field`).toBe(true)
    }
    // Aliases (severity/sev) share a matcher fn, so one help row covers both. Retired
    // fields (priority/prio) keep a working matcher but are deliberately absent from
    // the help popover — HELP_HIDDEN_FIELDS is the exception list.
    const helped = new Set(FIELD_HELP.map((f) => FIELD_MATCHERS[f.field]))
    for (const [field, fn] of Object.entries(FIELD_MATCHERS)) {
      if (HELP_HIDDEN_FIELDS.has(field)) continue
      expect(helped.has(fn), `matcher '${field}' has no help row`).toBe(true)
    }
    // The hidden list names real matchers, not typos.
    for (const field of HELP_HIDDEN_FIELDS) {
      expect(FIELD_MATCHERS[field], `help-hidden field '${field}' has no matcher`).toBeTypeOf('function')
    }
  })
})
