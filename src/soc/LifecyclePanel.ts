import type { Task } from '../types'
import { formatSlaRemaining } from './sla'

const FIELDS = [
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
 * Compact incident-timeline section: the four lifecycle timestamps as
 * datetime-local inputs (empty = unset) with a "Now" stamp each, plus derived
 * response/resolution durations when both ends are set. Incidents only —
 * early-returns for every other issue type.
 */
export function renderLifecyclePanel(container: HTMLElement, task: Task, opts: { onChange: () => void }): void {
  if (task.issueType !== 'incident') return
  const section = container.createDiv('pm-modal-section pm-lifecycle')
  section.createEl('h4', { text: 'Incident timeline', cls: 'pm-modal-section-title' })
  const rows = section.createDiv('pm-lc-rows')
  const summary = section.createDiv('pm-lc-summary')

  const renderSummary = () => {
    summary.empty()
    const detected = Date.parse(task.detectedAt)
    const line = (label: string, endIso: string) => {
      const end = Date.parse(endIso)
      if (Number.isNaN(detected) || Number.isNaN(end) || end < detected) return
      summary.createSpan({ cls: 'pm-lc-summary-item', text: `${label}: ${formatSlaRemaining(end - detected)}` })
    }
    line('Response time', task.respondedAt)
    line('Resolution time', task.resolvedAt)
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
    input.addEventListener('change', () => commit(localInputToIso(input.value)))
    const nowBtn = row.createEl('button', { cls: 'pm-soc-btn', text: 'Now' })
    nowBtn.addEventListener('click', () => commit(new Date().toISOString()))
  }
  renderSummary()
}
