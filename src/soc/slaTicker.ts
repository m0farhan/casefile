import type { SeverityConfig, SlaPolicy, Task } from '../types'
import { formatSlaRemaining, slaAnchor, slaAtRisk, slaState } from './sla'
import { Chip } from '../ui/primitives/Chip'

export interface SlaChipView {
  text: string
  warn: boolean
  breach: boolean
  /** True while the clock is running — the chip stays in the tick registry. */
  live: boolean
  /** Which stamp the countdown runs from — the chip's tooltip. An identical
   * "Respond 45m" means "since detection" on one case and "since you picked it
   * up" on another; the board is the most-read surface and cannot say so in
   * its two words. */
  from: 'detected' | 'created'
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
    return {
      text: `Breached ${formatSlaRemaining(state.remainingMs)}`,
      warn: false,
      breach: true,
      live: false,
      from: slaAnchor(task).from
    }
  }
  const verb = state.phase === 'response' ? 'Respond' : 'Resolve'
  return {
    text: `${verb} ${formatSlaRemaining(state.remainingMs)}`,
    warn: !state.breached && slaAtRisk(state, policies[task.severity]),
    breach: state.breached,
    live: true,
    from: slaAnchor(task).from
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
  // One chip primitive, like severity and due beside it (VD-03/VD-04). The
  // countdown used to be the only hand-rolled span on the card: monospace,
  // its own radius and its own padding, so the loudest thing on the board was
  // also the one that matched nothing. It keeps tabular numerals instead —
  // the width still cannot jitter as the clock ticks.
  const chip = new Chip(el).setSize('sm')
  chip.el.addClass('pm-sla')
  paint(chip.el, view)
  if (view.live) registry.set(chip.el, { task, policies })
  return chip.el
}

function paint(chip: HTMLElement, view: SlaChipView): void {
  // A chip newly turning breached pulses exactly twice (motion.css), then holds steady red.
  if (view.breach && !chip.hasClass('pm-sla--breach')) {
    chip.addClass('gs-pulse-2')
    window.setTimeout(() => chip.removeClass('gs-pulse-2'), 2000)
  }
  const label = chip.querySelector<HTMLElement>('.pm-chip-label') ?? chip
  label.setText(view.text)
  // setAttr('title', …) is the repo's plain-element tooltip idiom (TableRenderer.ts:335)
  // — no obsidian import, no stub change, no layout or CSS change.
  chip.setAttr(
    'title',
    view.from === 'detected'
      ? 'Clock runs from the detection time'
      : 'Clock runs from case creation — detection time not recorded'
  )
  chip.toggleClass('pm-sla--warn', view.warn)
  chip.toggleClass('pm-sla--breach', view.breach)
  // Filled only while the clock is asking for something. A healthy countdown
  // is a quiet grey reading; the tint is what makes at-risk and breached the
  // one thing on the card that catches the eye.
  chip.toggleClass('pm-chip--solid', view.warn || view.breach)
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
 * Severity badge (config label in the config color). No-op without a config.
 * Shared by the kanban card and the table row.
 *
 * 'text' drops the tint and keeps the colored word. The board card uses it
 * because the card already carries its severity as a spine down its left
 * edge: the same fact twice, and the louder of the two was a filled box
 * sitting beside the filled countdown, which is the one thing on a card that
 * should be able to shout. The word stays because a color alone is not a
 * label.
 */
export function renderSeverityBadge(
  el: HTMLElement,
  cfg: SeverityConfig | undefined,
  variant: 'solid' | 'text' = 'solid'
): void {
  if (!cfg) return
  // One label primitive for severity everywhere (VD-03): the table cell
  // already used Chip; cards/modal/panel had a parallel hand-rolled span.
  const chip = new Chip(el).setLabel(cfg.label).setColor(cfg.color).setSize('sm')
  if (variant === 'solid') chip.setVariant('solid')
}
