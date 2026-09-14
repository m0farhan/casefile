import type { Ioc, SeverityConfig } from '../types'
import { extractIocsFromText } from './ioc'
import { TASK_SLUG_MAX_LENGTH } from '../store/YamlSerializer'

export interface ParsedAlert {
  title: string
  severityId: string
  detectedAt: string
  description: string
  iocs: Ioc[]
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

  // Detected: first present time-ish line wins; stored in the same format the
  // lifecycle "Now" buttons write (Date.toISOString). Unparseable → ''.
  let detectedAt = ''
  for (const key of ['event time', 'time', 'date']) {
    const raw = fields.get(key)
    if (!raw) continue
    const ms = Date.parse(raw)
    if (!Number.isNaN(ms)) detectedAt = new Date(ms).toISOString()
    break
  }

  return {
    title,
    severityId: severity?.id ?? '',
    detectedAt,
    description: text,
    iocs: extractIocsFromText(text, [])
  }
}
