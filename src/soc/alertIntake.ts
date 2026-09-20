import type { Ioc, SeverityConfig } from '../types'
import { extractIocsFromText } from './ioc'
import { TASK_SLUG_MAX_LENGTH } from '../store/YamlSerializer'

export interface ParsedAlert {
  title: string
  severityId: string
  /** When the event happened, per the alert's own event-time key. '' = not named. */
  occurredAt: string
  /** When the detection fired, per an alert/detection-named key ONLY. '' = not named. */
  detectedAt: string
  description: string
  iocs: Ioc[]
}

/* Keys naming the EVENT's own time: when the thing happened, not when anyone
 * noticed it. These feed occurredAt and never reach the SLA clock (SD-03). */
const OCCURRED_KEYS = ['event time', 'time', 'date'] as const

/* Keys naming the DETECTION. A key must say alert or detect to reach the SLA
 * anchor. Nothing is inferred from a time VALUE, only from the label the
 * source wrote. */
const DETECTED_KEYS = [
  'alert time',
  'alert created',
  'alert date',
  'detection time',
  'detected',
  'detected at'
] as const

/* A value needs a 4-digit year AND a date/time separator or month name before
 * Date.parse sees it. V8's legacy fallback turns bare integers into years —
 * Date.parse('3') is 2001-03-01, Date.parse('257') is year 257 — so an EDR's
 * `Detected : 3` (a count) would otherwise fabricate a stamp and anchor the
 * SLA on it. Guards the event-time keys too: a fixture carries `EventID : 257`. */
const HAS_YEAR = /\d{4}/
const HAS_DATE_PART = /[-/:]|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i

/**
 * First present key wins; a value that is absent, not time-shaped, or
 * unparseable yields '' rather than falling through to the next key — the
 * header's own time line is the one that counts (the fieldLines first-wins
 * rule). Reads one list, never the other.
 */
function firstStamp(fields: Map<string, string>, keys: readonly string[]): string {
  for (const key of keys) {
    const raw = fields.get(key)
    if (!raw) continue
    if (!HAS_YEAR.test(raw) || !HAS_DATE_PART.test(raw)) return ''
    const ms = Date.parse(raw)
    return Number.isNaN(ms) ? '' : new Date(ms).toISOString()
  }
  return ''
}

/**
 * Split "Key : Value" lines (LetsDefend/monitoring shape; spaces around the
 * colon vary) into a lowercase-keyed map. First occurrence of a key wins —
 * the alert header comes first, anything repeated later is body noise.
 */
function fieldLines(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = /^\s*([^:]+?)\s*:\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase().replace(/\s+/g, ' ')
    if (!map.has(key)) map.set(key, m[2])
  }
  return map
}

/**
 * Parse a pasted monitoring alert into case fields. Honest by construction:
 * anything that cannot be extracted stays '' — never guessed. The paste
 * itself becomes the description verbatim, so nothing is ever lost.
 */
export function parseAlertPaste(text: string, cfg: { severities: SeverityConfig[] }): ParsedAlert {
  const fields = fieldLines(text)

  // Title: the Rule line if present, else the first non-empty line; capped to
  // the task filename limit (TASK_SLUG_MAX_LENGTH) so the note name matches.
  const firstLine =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  const title = (fields.get('rule') ?? firstLine).slice(0, TASK_SLUG_MAX_LENGTH).trim()

  const sevLabel = fields.get('severity')
  const severity = sevLabel ? cfg.severities.find((s) => s.label.toLowerCase() === sevLabel.toLowerCase()) : undefined

  // SD-03: the alert's Event Time is when the event HAPPENED, not when the SOC
  // detected it. Writing it to detectedAt made every queued alert born breached,
  // because the SLA anchors on detectedAt. Two disjoint key sets, two lookups,
  // and neither result is ever copied into the other: an alert that names one
  // time fills one field, and the empty one stays empty.
  const occurredAt = firstStamp(fields, OCCURRED_KEYS)
  const detectedAt = firstStamp(fields, DETECTED_KEYS)

  return {
    title,
    severityId: severity?.id ?? '',
    occurredAt,
    detectedAt,
    description: text,
    iocs: extractIocsFromText(text, [])
  }
}
