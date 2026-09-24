import type { SlaPolicy, Task } from '../types'

export interface SlaState {
  /** Which clock is running (or was breached last): time-to-first-response or time-to-resolution. */
  phase: 'response' | 'resolution'
  /** Epoch ms deadline for the current phase. */
  deadline: number
  /** Ms until the deadline; negative = overshoot. */
  remainingMs: number
  breached: boolean
  /** True once the incident is fully resolved (resolvedAt set) — the clock is stopped. */
  done: boolean
}

/** Remaining fraction under this threshold renders the chip amber. */
export const SLA_WARN_FRACTION = 0.25

/**
 * Where the SLA clock starts, and which stamp that is. Detection is the moment
 * the SOC's obligation begins: before it there is nothing to respond to, and
 * after it the queue latency is the SOC's own — anchoring at analyst pickup
 * instead would make every case pass by construction. task.occurredAt is NOT a
 * candidate: an event that happened last month does not make today's response
 * late. With no detection stamp the clock falls back to case creation, and
 * `from` is how callers disclose that instead of implying a detection nobody
 * wrote down (SD-03).
 */
export function slaAnchor(task: Task): { iso: string; from: 'detected' | 'created' } {
  return task.detectedAt ? { iso: task.detectedAt, from: 'detected' } : { iso: task.createdAt, from: 'created' }
}

/**
 * Pure SLA clock. Anchor = slaAnchor(task): the detection stamp, else case
 * creation. task.occurredAt is deliberately absent from this function — see
 * slaAnchor. The response phase ends at respondedAt, the resolution phase at
 * resolvedAt. Returns null when no clock
 * applies (not an incident, no severity, or no policy for the severity).
 *
 * ponytail: always-running clock — no pause tracking. Every status transition
 * is in the activity log, so paused time is derivable retroactively; add a
 * pause-aware variant over `activity` if blocked-time ever needs excluding.
 */
export function slaState(task: Task, policies: Record<string, SlaPolicy>, now: number): SlaState | null {
  if (task.issueType !== 'incident' || !task.severity) return null
  const policy = policies[task.severity]
  if (!policy) return null
  const anchorIso = slaAnchor(task).iso
  const anchor = Date.parse(anchorIso)
  if (Number.isNaN(anchor)) return null

  if (task.resolvedAt) {
    const resolved = Date.parse(task.resolvedAt)
    const deadline = anchor + policy.resolutionMins * 60_000
    return {
      phase: 'resolution',
      deadline,
      remainingMs: deadline - resolved,
      breached: resolved > deadline,
      done: true
    }
  }

  if (!task.respondedAt) {
    const deadline = anchor + policy.responseMins * 60_000
    return {
      phase: 'response',
      deadline,
      remainingMs: deadline - now,
      breached: now > deadline,
      done: false
    }
  }

  const deadline = anchor + policy.resolutionMins * 60_000
  return {
    phase: 'resolution',
    deadline,
    remainingMs: deadline - now,
    breached: now > deadline,
    done: false
  }
}

/** True when the clock is running and under SLA_WARN_FRACTION of its span remains (or breached). */
export function slaAtRisk(state: SlaState, policy: SlaPolicy): boolean {
  if (state.done) return false
  if (state.breached) return true
  const spanMs = (state.phase === 'response' ? policy.responseMins : policy.resolutionMins) * 60_000
  return state.remainingMs < spanMs * SLA_WARN_FRACTION
}

/** "2h 05m" / "37m" / "+1h 12m" (overshoot). Deterministic, minute resolution. */
export function formatSlaRemaining(remainingMs: number): string {
  const overshoot = remainingMs < 0
  const totalMins = Math.floor(Math.abs(remainingMs) / 60_000)
  const h = Math.floor(totalMins / 60)
  const m = totalMins % 60
  // Past a day, hours stop being readable. A lab case sat on the board showing
  // "+476h 46m", which is nineteen and a half days, and nobody reads it as
  // that. Days first, one unit of detail behind them; minutes only matter
  // while there is still an hour in which to act.
  const body = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
  return overshoot ? `+${body}` : body
}
