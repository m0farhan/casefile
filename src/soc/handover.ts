import type { PMSettings, Project, Task } from '../types'
import { flattenTasks } from '../store/TaskTreeOps'
import { isTerminalStatus } from '../utils'
import { formatSlaRemaining, slaAtRisk, slaState } from './sla'

/**
 * Deterministic shift-handover markdown, built entirely from frontmatter
 * (zero body loads). Sections: open incidents by severity, everything that
 * changed in the last N hours (from the activity log), targets at risk,
 * blocked items. Overwritten on every run — a generated artifact, the header
 * says so.
 */
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
  const openIncidents = all
    .filter(isOpen)
    .filter((r) => r.task.issueType === 'incident')
    .sort((a, b) => {
      const ra = sevRank.get(a.task.severity) ?? 99
      const rb = sevRank.get(b.task.severity) ?? 99
      return ra !== rb ? ra - rb : byKeyAsc(a, b)
    })
  lines.push('## Open incidents')
  lines.push('')
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
      // Latest by timestamp, not array position — hand-merged logs may be unordered.
      const last = r.task.activity.reduce<Task['activity'][number] | null>(
        (best, a) => (!best || a.at > best.at ? a : best),
        null
      )
      const lastText = last ? ` · last: ${last.field} → ${last.to} at ${last.at}` : ''
      lines.push(`- ${label(r.task)} — ${r.task.status} · ${slaText}${lastText}`)
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

  // ── Blocked ────────────────────────────────────────────────────────────────
  // ponytail: status-id 'blocked' only — no heuristics over labels.
  lines.push('## Blocked')
  lines.push('')
  const blocked = all.filter((r) => r.task.status === 'blocked').sort(byKeyAsc)
  if (!blocked.length) {
    lines.push('None.')
  } else {
    for (const r of blocked) {
      const assignees = r.task.assignees.length ? ` · ${r.task.assignees.join(', ')}` : ''
      lines.push(`- ${label(r.task)}${assignees}`)
    }
  }
  lines.push('')

  return lines.join('\n')
}
