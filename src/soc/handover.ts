import type { App } from 'obsidian'
import { TFile, normalizePath } from 'obsidian'
import type { PMSettings, Project, Task } from '../types'
import { flattenTasks } from '../store/TaskTreeOps'
import { ensureFolder } from '../store/vaultFs'
import { isTerminalStatus } from '../utils'
import { formatIocLine } from './ioc'
import { formatSlaRemaining, slaAnchor, slaAtRisk, slaState } from './sla'

/**
 * Deterministic shift-handover markdown, built entirely from frontmatter
 * (zero body loads). Sections: open incidents by severity, everything that
 * changed in the last N hours (from the activity log), targets at risk,
 * waiting items. Overwritten on every run — a generated artifact, the header
 * says so.
 */
/** Statuses that mean "parked on someone else", for the Waiting section.
 *  'blocked' shipped as a default before 2.26 and still exists in older vaults. */
const WAITING_STATUS_IDS = new Set(['user-response', 'blocked'])

export function buildHandover(projects: Project[], settings: PMSettings, nowIso: string): string {
  const now = Date.parse(nowIso)
  const windowMs = settings.handoverWindowHours * 3_600_000
  const sevRank = new Map(settings.severities.map((s, i) => [s.id, i]))
  const sevLabel = (id: string) => settings.severities.find((s) => s.id === id)?.label ?? (id || 'No severity')

  interface Row {
    project: Project
    task: Task
  }
  const all: Row[] = []
  for (const project of projects) {
    for (const { task } of flattenTasks(project.tasks)) {
      if (task.archived) continue
      all.push({ project, task })
    }
  }

  const statusesOf = (p: Project) => (p.config?.statuses?.length ? p.config.statuses : settings.statuses)
  const isOpen = ({ project, task }: Row) => !isTerminalStatus(task.status, statusesOf(project))
  const label = (t: Task) => (t.key ? `${t.key} ${t.title}` : t.title)
  const byKeyAsc = (a: Row, b: Row) => label(a.task).localeCompare(label(b.task))

  const lines: string[] = [
    '# Shift handover',
    '',
    `Generated ${nowIso} · window ${settings.handoverWindowHours}h · this note is overwritten on every run.`,
    ''
  ]

  // ── Open incidents by severity ─────────────────────────────────────────────
  // Plain boards record no severity, so they are left out of THIS section only.
  // The later sections walk every board: "Changed in the last Nh" and "Waiting"
  // are board-neutral, and user-response is exactly the status a goals board
  // uses. Skipping whole boards there would print "None." where the truth is
  // "not looked at".
  const plainBoards = projects.filter((p) => p.config?.boardType === 'plain')
  const isCaseBoard = (r: Row) => r.project.config?.boardType !== 'plain'
  const openIncidents = all
    .filter(isCaseBoard)
    .filter(isOpen)
    .filter((r) => r.task.issueType === 'incident')
    .sort((a, b) => {
      const ra = sevRank.get(a.task.severity) ?? 99
      const rb = sevRank.get(b.task.severity) ?? 99
      return ra !== rb ? ra - rb : byKeyAsc(a, b)
    })
  lines.push('## Open incidents')
  lines.push('')
  // The exclusion is stated inside the section it applies to, so "None." here
  // can never be read as "nothing open anywhere".
  if (plainBoards.length) {
    const names = plainBoards.map((p) => p.title).join(', ')
    lines.push(`Not counted here: ${names} — plain board${plainBoards.length === 1 ? '' : 's'}, no severity recorded.`)
    lines.push('')
  }
  if (!openIncidents.length) {
    lines.push('None.')
  } else {
    let currentSev: string | null = null
    for (const r of openIncidents) {
      if (r.task.severity !== currentSev) {
        currentSev = r.task.severity
        lines.push(`### ${sevLabel(currentSev)}`)
      }
      const state = slaState(r.task, settings.slaPolicies, now)
      const slaText = state
        ? state.breached
          ? `target breached ${formatSlaRemaining(state.remainingMs)}`
          : `${state.phase} target in ${formatSlaRemaining(state.remainingMs)}`
        : 'no target'
      // SD-03: this note is what the next shift is handed, read away from the
      // case — a countdown with no anchor named is the one that misleads.
      const anchorNote = state && slaAnchor(r.task).from === 'created' ? ' (from case creation)' : ''
      // Latest by timestamp, not array position — hand-merged logs may be unordered.
      const last = r.task.activity.reduce<Task['activity'][number] | null>(
        (best, a) => (!best || a.at > best.at ? a : best),
        null
      )
      const lastText = last ? ` · last: ${last.field} → ${last.to} at ${last.at}` : ''
      lines.push(`- ${label(r.task)} — ${r.task.status} · ${slaText}${anchorNote}${lastText}`)
      // ponytail: 8 defanged indicators per incident keeps the note scannable; bump the cap if shifts want more.
      for (const ioc of r.task.iocs.slice(0, 8)) lines.push(`  - ${formatIocLine(ioc, settings.ownedAssets)}`)
      if (r.task.iocs.length > 8) lines.push(`  - +${r.task.iocs.length - 8} more`)
    }
  }
  lines.push('')

  // ── Changed in the window ──────────────────────────────────────────────────
  lines.push(`## Changed in the last ${settings.handoverWindowHours}h`)
  lines.push('')
  const changed = all
    .map((r) => ({
      ...r,
      recent: r.task.activity.filter((a) => {
        const at = Date.parse(a.at)
        return !Number.isNaN(at) && now - at <= windowMs && at <= now
      })
    }))
    .filter((r) => r.recent.length)
    .sort(byKeyAsc)
  if (!changed.length) {
    lines.push('Nothing recorded.')
  } else {
    for (const r of changed) {
      lines.push(`- ${label(r.task)}:`)
      for (const a of r.recent) lines.push(`  - ${a.field}: ${a.from || '(unset)'} → ${a.to} (${a.at})`)
    }
  }
  lines.push('')

  // ── Targets at risk ────────────────────────────────────────────────────────
  lines.push('## Response/resolution targets at risk')
  lines.push('')
  const atRisk = openIncidents.filter((r) => {
    const state = slaState(r.task, settings.slaPolicies, now)
    const policy = settings.slaPolicies[r.task.severity]
    return state && policy && slaAtRisk(state, policy)
  })
  if (!atRisk.length) {
    lines.push('None.')
  } else {
    for (const r of atRisk) {
      const state = slaState(r.task, settings.slaPolicies, now)
      if (!state) continue
      const text = state.breached
        ? `breached ${formatSlaRemaining(state.remainingMs)}`
        : `${formatSlaRemaining(state.remainingMs)} left (${state.phase})`
      lines.push(`- ${label(r.task)} — ${text}`)
    }
  }
  lines.push('')

  // ── Waiting ────────────────────────────────────────────────────────────────
  // ponytail: status ids only — no heuristics over labels. 'blocked' is no
  // longer a shipped default but is still matched: a vault created before 2.26
  // keeps it, and this section was written for it.
  lines.push('## Waiting')
  lines.push('')
  const waiting = all.filter((r) => WAITING_STATUS_IDS.has(r.task.status)).sort(byKeyAsc)
  if (!waiting.length) {
    lines.push('None.')
  } else {
    for (const r of waiting) {
      const assignees = r.task.assignees.length ? ` · ${r.task.assignees.join(', ')}` : ''
      // The configured label, not the raw id — same rule as sevLabel above and
      // caseReport.ts; this note is read away from the case (UX-14).
      const cfg = statusesOf(r.project).find((s) => s.id === r.task.status)
      lines.push(`- ${label(r.task)}${assignees} · ${cfg?.label ?? r.task.status}`)
    }
  }
  lines.push('')

  return lines.join('\n')
}

/**
 * Write the composed handover to `settings.handoverPath`, creating the folder
 * and the note on first run and overwriting it after that — the same contract
 * the note's own header states. Lifted out of main.ts unchanged so the palette
 * command and the preview modal write the identical file. Returns the path
 * actually written.
 */
export async function writeHandoverNote(app: App, md: string, path: string): Promise<string> {
  const target = normalizePath(path || 'SOC/Handover.md')
  const folder = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : ''
  if (folder) await ensureFolder(app, folder)
  const existing = app.vault.getAbstractFileByPath(target)
  if (existing instanceof TFile) {
    await app.vault.modify(existing, md)
  } else {
    await app.vault.create(target, md)
  }
  return target
}
