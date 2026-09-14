import { normalizePath, type App } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, SeverityConfig, SlaPolicy, StatusConfig, Task, VerdictConfig } from '../types'
import { BUCKETS } from '../types'
import { flattenTasks } from '../store/TaskTreeOps'
import { defangIoc } from './ioc'
import { formatSlaRemaining, slaState } from './sla'

export interface CaseReportContext {
  project: Project
  statuses: StatusConfig[]
  severities: SeverityConfig[]
  verdicts: VerdictConfig[]
  slaPolicies: Record<string, SlaPolicy>
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

  const lines: string[] = [`# ${task.key ? `${task.key} ${task.title}` : task.title}`, '', summary, '']

  // ── Incident timeline ──────────────────────────────────────────────────────
  lines.push('## Incident timeline', '')
  const phases: [string, string][] = [
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
  const policy = ctx.slaPolicies[task.severity]
  const state = slaState(task, ctx.slaPolicies, ctx.now)
  if (!state || !policy) {
    lines.push('No target set.')
  } else {
    const anchor = Date.parse(task.detectedAt || task.createdAt)
    const responded = task.respondedAt ? Date.parse(task.respondedAt) : NaN
    if (!Number.isNaN(responded)) {
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
      lines.push(`| ${ioc.type} | ${cell(defangIoc(ioc.value, ioc.type))} | ${cell(ioc.note ?? '')} |`)
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
      lines.push(`- ${LINK_TYPE_LABELS[link.type] ?? link.type}: ${label}`)
    }
    lines.push('')
  }

  // ── Investigation journal ──────────────────────────────────────────────────
  lines.push('## Investigation journal', '')
  const comments = task.comments ?? []
  if (!comments.length) {
    lines.push('No journal entries.')
  } else {
    for (const c of comments) {
      lines.push(c.at ? `- ${c.at} — ${c.text}` : `- ${c.text}`)
    }
  }
  lines.push('')

  // ── Description (the analyst's own text, verbatim) ─────────────────────────
  lines.push('## Description', '', task.description.trim() || 'None recorded.', '')

  lines.push('---', '', `Generated from case data on ${new Date(ctx.now).toISOString().slice(0, 10)}.`)
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

/**
 * Shared load-then-compose step: description and journal live in the note
 * body, so hydrate it first, then compose from the project's live config.
 * Both the write-a-note and copy-to-clipboard paths go through here so their
 * output can never drift apart.
 */
export async function loadAndComposeCaseReport(plugin: PMPlugin, project: Project, task: Task): Promise<string> {
  await plugin.store.loadTaskBody(task)
  const cfg = plugin.store.configFor(project)
  return composeCaseReport(task, {
    project,
    statuses: cfg.statuses,
    severities: cfg.severities,
    verdicts: cfg.verdicts,
    slaPolicies: plugin.settings.slaPolicies,
    now: Date.now()
  })
}

/** Same report, straight to the clipboard — for pasting into an answer box. */
export async function copyCaseReport(plugin: PMPlugin, project: Project, task: Task): Promise<void> {
  await navigator.clipboard.writeText(await loadAndComposeCaseReport(plugin, project, task))
  plugin.showNotice('Case report copied')
}

/** Menu/command entry point: hydrate the body, compose, write, open, notify. */
export async function generateCaseReport(plugin: PMPlugin, project: Project, task: Task): Promise<void> {
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
