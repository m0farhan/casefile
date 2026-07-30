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
 * Pure SLA clock. Anchor = detectedAt || createdAt. The response phase ends at
 * respondedAt, the resolution phase at resolvedAt. Returns null when no clock
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
  const anchorIso = task.detectedAt || task.createdAt
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
  const body = h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
  return overshoot ? `+${body}` : body
}
