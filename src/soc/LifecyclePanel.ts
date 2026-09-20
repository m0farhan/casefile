import type { SlaPolicy, Task } from '../types'
import { formatSlaRemaining, slaAnchor } from './sla'

const FIELDS = [
  { key: 'occurredAt', label: 'Occurred' },
  { key: 'detectedAt', label: 'Detected' },
  { key: 'respondedAt', label: 'Responded' },
  { key: 'containedAt', label: 'Contained' },
  { key: 'resolvedAt', label: 'Resolved' }
] as const

/** ISO datetime → <input type="datetime-local"> value in the viewer's zone. '' when unset/unparseable. */
export function isoToLocalInput(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local value (viewer-local wall time) → ISO datetime. '' when cleared/unparseable. */
export function localInputToIso(value: string): string {
  if (!value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

/**
 * Compact incident-timeline section: the five lifecycle timestamps as
 * datetime-local inputs (empty = unset) with a "Now" stamp each, plus derived
 * durations measured from the SAME anchor the SLA uses (slaAnchor), so the
 * panel and the chip beside it can never report different clocks. Incidents
 * only — early-returns for every other issue type.
 */
export function renderLifecyclePanel(
  container: HTMLElement,
  task: Task,
  opts: { onChange: () => void; slaPolicies: Record<string, SlaPolicy> }
): void {
  if (task.issueType !== 'incident') return
  const section = container.createDiv('pm-modal-section pm-lifecycle')
  section.createEl('h4', { text: 'Incident timeline', cls: 'pm-modal-section-title' })
  const rows = section.createDiv('pm-lc-rows')
  const summary = section.createDiv('pm-lc-summary')

  const renderSummary = () => {
    summary.empty()
    // slaAnchor, not task.detectedAt: intake leaves the detection stamp empty
    // (SD-03), and reading the raw field here blanked all three durations for
    // exactly the cases this change creates.
    const anchor = Date.parse(slaAnchor(task).iso)
    const line = (label: string, endIso: string) => {
      const end = Date.parse(endIso)
      if (Number.isNaN(anchor) || Number.isNaN(end) || end < anchor) return
      summary.createSpan({ cls: 'pm-lc-summary-item', text: `${label}: ${formatSlaRemaining(end - anchor)}` })
    }
    line('Response time', task.respondedAt)
    line('Containment time', task.containedAt)
    line('Resolution time', task.resolvedAt)
    // SD-03 disclosure: with no detection stamp the clock runs from creation,
    // and the durations above are measured from there too. Gated on a real
    // policy, not on severity — a severity whose policy was deleted in settings
    // has no clock at all, and the chip renders nothing for it.
    if (!task.detectedAt && opts.slaPolicies[task.severity]) {
      summary.createSpan({
        cls: 'pm-lc-summary-item',
        text: 'SLA runs from case creation — detection time not recorded'
      })
    }
  }

  for (const f of FIELDS) {
    const row = rows.createDiv('pm-lc-row')
    row.createSpan({ cls: 'pm-lc-label', text: f.label })
    const input = row.createEl('input', { type: 'datetime-local', cls: 'pm-prop-date pm-lc-input' })
    input.value = isoToLocalInput(task[f.key])
    const commit = (iso: string) => {
      task[f.key] = iso
      input.value = isoToLocalInput(iso)
      renderSummary()
      opts.onChange()
    }
    // ponytail: kept as a native datetime-local input — DateControl is
    // date-only (type="date", Today/Clear) and would drop the time component.
    input.addEventListener('change', () => {
      // '' here means a partial/invalid edit (datetime-local exposes incomplete
      // values as ''), not a deliberate clear — clearing goes through the Clear
      // button. Committing '' mid-edit silently wiped stamps.
      if (input.value) commit(localInputToIso(input.value))
    })
    input.addEventListener('blur', () => {
      // Partial/invalid value on leave: revert the display to the stored stamp.
      if (!input.value) input.value = isoToLocalInput(task[f.key])
    })
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      // First Escape cancels the edit (don't let the modal's Escape close it).
      e.stopPropagation()
      input.value = isoToLocalInput(task[f.key])
      input.blur()
    })
    const nowBtn = row.createEl('button', { cls: 'pm-soc-btn', text: 'Now' })
    nowBtn.addEventListener('click', () => commit(new Date().toISOString()))
    const clearBtn = row.createEl('button', { cls: 'pm-soc-btn', text: 'Clear' })
    clearBtn.addEventListener('click', () => commit(''))
  }
  renderSummary()
}
