import type { SeverityConfig, SlaPolicy, Task } from '../types'
import { formatSlaRemaining, slaAtRisk, slaState } from './sla'

export interface SlaChipView {
  text: string
  warn: boolean
  breach: boolean
  /** True while the clock is running — the chip stays in the tick registry. */
  live: boolean
}

/**
 * What an SLA chip should show right now. Pure — the renderer, the 30s tick
 * and the tests all share this one decision. Null = no chip (no clock, or
 * resolved on time: nothing left to watch).
 */
export function slaChipView(task: Task, policies: Record<string, SlaPolicy>, now: number): SlaChipView | null {
  const state = slaState(task, policies, now)
  if (!state) return null
  if (state.done) {
    if (!state.breached) return null
    // Resolved late: steady red record, clock stopped.
    return { text: `Breached ${formatSlaRemaining(state.remainingMs)}`, warn: false, breach: true, live: false }
  }
  const verb = state.phase === 'response' ? 'Respond' : 'Resolve'
  return {
    text: `${verb} ${formatSlaRemaining(state.remainingMs)}`,
    warn: !state.breached && slaAtRisk(state, policies[task.severity]),
    breach: state.breached,
    live: true
  }
}

interface ChipEntry {
  task: Task
  policies: Record<string, SlaPolicy>
}

/**
 * Live chips awaiting ticks, keyed by element. No explicit unregister: the
 * tick loop drops entries whose element left the DOM (views re-render by
 * rebuilding, so stale chips disconnect), bounding retention at one tick.
 */
const registry = new Map<HTMLElement, ChipEntry>()

/**
 * Render an SLA countdown chip into `el` and register it for the shared 30s
 * tick. Returns null (renders nothing) when no clock applies or the incident
 * resolved on time.
 */
export function renderSlaChip(el: HTMLElement, task: Task, policies: Record<string, SlaPolicy>): HTMLElement | null {
  const view = slaChipView(task, policies, Date.now())
  if (!view) return null
  const chip = el.createSpan({ cls: 'pm-sla' })
  paint(chip, view)
  if (view.live) registry.set(chip, { task, policies })
  return chip
}

function paint(chip: HTMLElement, view: SlaChipView): void {
  // A chip newly turning breached pulses exactly twice (motion.css), then holds steady red.
  if (view.breach && !chip.hasClass('pm-sla--breach')) {
    chip.addClass('gs-pulse-2')
    window.setTimeout(() => chip.removeClass('gs-pulse-2'), 2000)
  }
  chip.setText(view.text)
  chip.toggleClass('pm-sla--warn', view.warn)
  chip.toggleClass('pm-sla--breach', view.breach)
}

/**
 * Advance every registered chip. Called by the single 30s interval that
 * ProjectView owns. Updates textContent + classes only — never re-renders
 * views.
 */
export function tickAllSlaChips(): void {
  const now = Date.now()
  for (const [chip, { task, policies }] of registry) {
    if (!chip.isConnected) {
      registry.delete(chip)
      continue
    }
    const view = slaChipView(task, policies, now)
    if (!view) {
      registry.delete(chip)
      chip.remove()
      continue
    }
    paint(chip, view)
    if (!view.live) registry.delete(chip) // clock stopped: freeze as the steady breach record
  }
}

/**
 * Severity badge (config label, config color on a soft tint). No-op without
 * a config. Shared by the kanban card and the table row.
 */
export function renderSeverityBadge(el: HTMLElement, cfg: SeverityConfig | undefined): void {
  if (!cfg) return
  const badge = el.createSpan({ cls: 'pm-sev-badge', text: cfg.label })
  badge.setCssStyles({ color: cfg.color, background: `color-mix(in srgb, ${cfg.color} 15%, transparent)` })
}
