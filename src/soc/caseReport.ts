import { normalizePath, type App } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, SeverityConfig, SlaPolicy, StatusConfig, Task, VerdictConfig } from '../types'
import { BUCKETS } from '../types'
import { flattenTasks } from '../store/TaskTreeOps'
import { quoteUntrusted } from './emailHeaders'
import { OWN_ASSET_SUFFIX, assetRule, defangIoc } from './ioc'
import { formatSlaRemaining, slaAnchor, slaPolicy, slaState } from './sla'

export interface CaseReportContext {
  project: Project
  statuses: StatusConfig[]
  severities: SeverityConfig[]
  verdicts: VerdictConfig[]
  slaPolicies: Record<string, SlaPolicy>
  /** The analyst's asset boundary — marks own-estate rows so a reader of the
   *  exported report can tell them from adversary infrastructure. */
  ownedAssets: string[]
  now: number
}

const LINK_TYPE_LABELS: Record<string, string> = {
  blocks: 'Blocks',
  'relates-to': 'Relates to',
  duplicates: 'Duplicates'
}

/* Timezone suffix rendered after a Zulu/offset timestamp — data const. */
const ZONE_UTC = ' UTC'

/** "2026-07-30T08:30:00.000Z" → "2026-07-30 08:30 UTC" — minute precision, zone kept honest. */
function readableTs(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(iso)
  if (!m) return iso
  const zone = m[3] === 'Z' ? ZONE_UTC : m[3] ? `${ZONE_UTC}${m[3]}` : ''
  return `${m[1]} ${m[2]}${zone}`
}

/** Markdown table cells must not break on a literal pipe in an indicator or note. */
function cell(s: string): string {
  return s.replace(/\|/g, '\\|')
}

/**
 * One line of sender text made inert for a note that opens itself. A case
 * title is often a phishing subject or an alert's rule line, verbatim, and
 * written raw an `<img src=…>` fetches, `![…](…)` and `![[…]]` embed, and a
 * code span can run a Dataview inline query. Escaped, each shows as the
 * characters it is and loads nothing. Single brackets are left alone:
 * `[EXTERNAL] Invoice` is a common subject, and escaping it would put
 * backslashes into every pasted handover. A backslash the text already puts
 * before punctuation is doubled first, so it cannot cancel the escape placed
 * in front of its own `<`.
 */
export function inertLine(s: string): string {
  return s
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\')
    .replace(/\[\[/g, '\\[\\[')
    .replace(/!\[/g, '!\\[')
    .replace(/[<`]/g, '\\$&')
}

/**
 * Why an incident whose severity has a target shows no clock. "No target
 * set." would be false here: the target exists, a stamp the clock needs does
 * not, or cannot be read.
 */
function noClockLine(task: Task): string {
  const { iso, from } = slaAnchor(task)
  if (!iso) return 'Target set — no clock: neither detection nor creation time is recorded.'
  if (Number.isNaN(Date.parse(iso))) {
    return `Target set — no clock: the ${from === 'detected' ? 'detection' : 'creation'} time is not a readable date.`
  }
  return 'Target set — not computable: the resolved time is not a readable date.'
}

/**
 * Deterministic case-writeup markdown composed ONLY from the case's recorded
 * fields (built for LetsDefend-style exercise writeups). Every section is
 * honest: empty fields say "not recorded"/"none recorded", indicators render
 * defanged, and the footer claims nothing beyond the data. Same composition
 * idiom as buildHandover.
 */
export function composeCaseReport(task: Task, ctx: CaseReportContext): string {
  const statusLabel = ctx.statuses.find((s) => s.id === task.status)?.label ?? task.status
  const severityLabel = task.severity
    ? (ctx.severities.find((s) => s.id === task.severity)?.label ?? task.severity)
    : 'none recorded'
  const verdictLabel = task.verdict
    ? (ctx.verdicts.find((v) => v.id === task.verdict)?.label ?? task.verdict)
    : 'none recorded'

  let summary = `Status ${statusLabel} · severity ${severityLabel} · verdict ${verdictLabel}`
  if (task.bucket !== 'none') {
    summary += ` · bucket ${BUCKETS.find((b) => b.id === task.bucket)?.label ?? task.bucket}`
  }
  if (task.flagged) summary += ' · flagged'

  const lines: string[] = [`# ${inertLine(task.key ? `${task.key} ${task.title}` : task.title)}`, '', summary, '']

  // ── Incident timeline ──────────────────────────────────────────────────────
  lines.push('## Incident timeline', '')
  const phases: [string, string][] = [
    ['Occurred', task.occurredAt],
    ['Detected', task.detectedAt],
    ['Responded', task.respondedAt],
    ['Contained', task.containedAt],
    ['Resolved', task.resolvedAt]
  ]
  for (const [name, ts] of phases) {
    lines.push(`- ${name}: ${ts ? readableTs(ts) : 'not recorded'}`)
  }
  lines.push('')

  // ── Response targets ───────────────────────────────────────────────────────
  lines.push('## Response targets', '')
  const policy = slaPolicy(task, ctx.slaPolicies)
  const state = slaState(task, ctx.slaPolicies, ctx.now)
  if (!policy) {
    lines.push('No target set.')
  } else if (!state) {
    lines.push(noClockLine(task))
  } else {
    const { iso: anchorIso, from } = slaAnchor(task)
    const anchor = Date.parse(anchorIso)
    // The report leaves the vault, and it is the one surface holding
    // slaPolicies — so it is entitled to say plainly which clock ran.
    lines.push(
      from === 'detected'
        ? '- Clock anchored at: detected'
        : '- Clock anchored at: case created — detection time not recorded'
    )
    const responded = task.respondedAt ? Date.parse(task.respondedAt) : NaN
    if (task.respondedAt && Number.isNaN(responded)) {
      lines.push('- Response: not computable — the responded time is not a readable date')
    } else if (!Number.isNaN(responded)) {
      const margin = anchor + policy.responseMins * 60_000 - responded
      lines.push(
        `- Response: ${
          margin >= 0
            ? `met (${formatSlaRemaining(margin)} inside target)`
            : `breached (${formatSlaRemaining(margin)} past target)`
        }`
      )
    } else if (state.phase === 'response' && !state.done) {
      lines.push(
        `- Response: ${
          state.breached
            ? `breached (${formatSlaRemaining(state.remainingMs)} past target)`
            : `still running (${formatSlaRemaining(state.remainingMs)} left)`
        }`
      )
    } else {
      // Resolved without a response timestamp — the response phase is honestly unknown.
      lines.push('- Response: response time not recorded')
    }
    if (state.phase === 'resolution' && state.done) {
      lines.push(
        `- Resolution: ${
          state.breached
            ? `breached (${formatSlaRemaining(state.remainingMs)} past target)`
            : `met (${formatSlaRemaining(state.remainingMs)} inside target)`
        }`
      )
    } else {
      const remainingMs = anchor + policy.resolutionMins * 60_000 - ctx.now
      lines.push(
        `- Resolution: ${
          remainingMs < 0
            ? `breached (${formatSlaRemaining(remainingMs)} past target)`
            : `still running (${formatSlaRemaining(remainingMs)} left)`
        }`
      )
    }
  }
  lines.push('')

  // ── Indicators ─────────────────────────────────────────────────────────────
  lines.push('## Indicators', '')
  if (!task.iocs.length) {
    lines.push('None recorded.')
  } else {
    lines.push('| Type | Value | Note |', '| --- | --- | --- |')
    for (const ioc of task.iocs) {
      const asset = assetRule(ioc.value, ctx.ownedAssets) ? OWN_ASSET_SUFFIX : ''
      // In a code span, or a defanged UNC path loses a backslash and `__x__`
      // turns bold: the reader would see an indicator that is not the recorded one.
      const value = cell(quoteUntrusted(defangIoc(ioc.value, ioc.type))) + asset
      lines.push(`| ${ioc.type} | ${value} | ${cell(inertLine(ioc.note ?? ''))} |`)
    }
  }
  lines.push('')

  // ── Linked cases (section omitted entirely when the case declares none) ────
  const links = task.links ?? []
  if (links.length) {
    lines.push('## Linked cases', '')
    const byId = new Map(flattenTasks(ctx.project.tasks).map((f) => [f.task.id, f.task]))
    for (const link of links) {
      const target = byId.get(link.taskId)
      const label = target ? (target.key ? `${target.key} ${target.title}` : target.title) : 'missing case'
      lines.push(`- ${LINK_TYPE_LABELS[link.type] ?? link.type}: ${inertLine(label)}`)
    }
    lines.push('')
  }

  // ── Investigation journal ──────────────────────────────────────────────────
  lines.push('## Investigation journal', '')
  const comments = task.comments ?? []
  if (!comments.length) {
    lines.push('No journal entries.')
  } else {
    // Journal stamps are wall-clock time with no zone, while the timeline
    // above is UTC. Converting them would guess a zone nobody recorded.
    if (comments.some((c) => c.at)) {
      lines.push(
        'Entry times are the local clock of the device each entry was written on; the time zone was not recorded.',
        ''
      )
    }
    for (const c of comments) {
      lines.push(c.at ? `- ${c.at} — ${c.text}` : `- ${c.text}`)
    }
  }
  lines.push('')

  // ── Description (the analyst's own text, verbatim) ─────────────────────────
  lines.push('## Description', '', task.description.trim() || 'None recorded.', '')

  lines.push('---', '', `Generated from case data on ${new Date(ctx.now).toISOString().slice(0, 10)} (UTC).`)
  return lines.join('\n')
}

/**
 * Write the report next to the case file as "<case basename> — report.md".
 * An existing report is never overwritten — " (2)", " (3)"… suffixes instead.
 * Returns the created path, or null when the task has no file yet.
 */
export async function writeCaseReportNote(app: App, task: Task, md: string): Promise<string | null> {
  if (!task.filePath) return null
  const dir = task.filePath.includes('/') ? task.filePath.slice(0, task.filePath.lastIndexOf('/') + 1) : ''
  const base = task.filePath.slice(dir.length).replace(/\.md$/, '')
  // ponytail: 99 reports for one case means something else is wrong.
  for (let n = 1; n <= 99; n++) {
    const name = n === 1 ? `${base} — report.md` : `${base} — report (${n}).md`
    const path = normalizePath(dir + name)
    if (app.vault.getAbstractFileByPath(path)) continue
    const file = await app.vault.create(path, md)
    return file.path
  }
  return null
}

const PLAIN_BOARD = (project: Project) => `${project.title} is a plain board — case reports are for case boards.`

/**
 * A case report is a SOC artifact: incident timeline, response targets,
 * indicators, verdict. On a plain board every one of those sections would
 * print "not recorded", which reads as a case with nothing found rather than
 * a board that never recorded any of it. Said before the body is read or the
 * file is checked, so the analyst gets this reason and not "Save the case
 * first" or a generic error.
 */
function refusesPlainBoard(plugin: PMPlugin, project: Project): boolean {
  if (plugin.store.configFor(project).boardType !== 'plain') return false
  plugin.showNotice(PLAIN_BOARD(project))
  return true
}

/**
 * Shared load-then-compose step: description and journal live in the note
 * body, so hydrate it first, then compose from the project's live config.
 * Both the write-a-note and copy-to-clipboard paths go through here so their
 * output can never drift apart.
 */
export async function loadAndComposeCaseReport(plugin: PMPlugin, project: Project, task: Task): Promise<string> {
  await plugin.store.loadTaskBody(task)
  const cfg = plugin.store.configFor(project)
  // Backstop for a caller that skips refusesPlainBoard.
  if (cfg.boardType === 'plain') throw new Error(PLAIN_BOARD(project))
  return composeCaseReport(task, {
    project,
    statuses: cfg.statuses,
    severities: cfg.severities,
    verdicts: cfg.verdicts,
    slaPolicies: plugin.settings.slaPolicies,
    ownedAssets: plugin.settings.ownedAssets,
    now: Date.now()
  })
}

/** Same report, straight to the clipboard — for pasting into an answer box. */
export async function copyCaseReport(plugin: PMPlugin, project: Project, task: Task): Promise<void> {
  if (refusesPlainBoard(plugin, project)) return
  await navigator.clipboard.writeText(await loadAndComposeCaseReport(plugin, project, task))
  plugin.showNotice('Case report copied')
}

/** Menu/command entry point: hydrate the body, compose, write, open, notify. */
export async function generateCaseReport(plugin: PMPlugin, project: Project, task: Task): Promise<void> {
  if (refusesPlainBoard(plugin, project)) return
  if (!task.filePath) {
    plugin.showNotice('Save the case first — it has no file yet.')
    return
  }
  const md = await loadAndComposeCaseReport(plugin, project, task)
  const path = await writeCaseReportNote(plugin.app, task, md)
  if (!path) {
    plugin.showNotice('Could not create the report note.')
    return
  }
  await plugin.app.workspace.openLinkText(path, '', true)
  plugin.showNotice(`Case report saved to ${path}`)
}
