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
    // Split at the first colon by hand. The regex this replaced,
    // /^\s*([^:]+?)\s*:\s*(.+?)\s*$/, backtracked cubically on a long run of
    // whitespace with no colon: 3,000 spaces froze the modal for 4 s, on
    // every keystroke. Do not bring it back.
    const colon = line.indexOf(':')
    if (colon < 0) continue
    // A list marker is not part of the key: an alert copied out of a ticket
    // often arrives as `- Rule : …`. (`*` bullets already go with the emphasis.)
    const key = stripEmphasis(line.slice(0, colon))
      .replace(/^[-+•]\s+/, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
    const value = stripEmphasis(line.slice(colon + 1))
    // A key with nothing after its colon names nothing, so it is skipped —
    // `Rule : ` (trailing space) used to record an empty Rule and give the
    // case an empty title, while `Rule :` recorded nothing.
    if (!key || !value) continue
    if (!map.has(key)) map.set(key, value)
  }
  return map
}

/**
 * Drop markdown emphasis and code ticks from a field's key and value. Real
 * alerts are pasted from a console or a ticket already formatted — the common
 * shapes are `**Rule :** \`SOC138 - …\``, `**Rule** : X` and plain `Rule : X` —
 * and without this the key came out as `**rule`, so the Rule line, the severity
 * and the event time were all missed and the title fell back to whatever the
 * first line happened to be. Underscores are deliberately NOT stripped: `_` is
 * italics in markdown but also lives inside real values (hostnames, filenames),
 * and the value is what gets stored.
 */
function stripEmphasis(text: string): string {
  return text.replace(/[*`]/g, '').trim()
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
  // A cut between the two halves of an emoji leaves a lone surrogate, which
  // the filesystem stores as U+FFFD, so the note could never be found again.
  const title = (fields.get('rule') ?? firstLine)
    .slice(0, TASK_SLUG_MAX_LENGTH)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trim()

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
    description: quarantineMarkup(text),
    iocs: extractIocsFromText(text, [])
  }
}

/** A `<` that begins something a renderer would treat as markup. */
const LOOKS_LIKE_MARKUP = /<[a-z!/]/i

/**
 * A pasted alert becomes the case description verbatim, and the description
 * becomes the body of a markdown note. When the alert quotes a phishing
 * message — which is exactly what a reported-phish alert does — that body is
 * attacker-written markup sitting in a file the analyst will open.
 *
 * Opened inside the plugin, `scrubRemoteEmbeds` guards the render. Opened as
 * an ordinary note, nothing guards it at all: an `<img>`, a `background=` or a
 * `style="background-image:url(…)"` fetches on sight, and that request tells
 * the sender the mail reached an analyst, when, and from which address.
 *
 * So a paste carrying markup is fenced at the point it is written. Fencing is
 * not sanitising: every byte is kept, verbatim, and a code block renders none
 * of it anywhere — plugin, reading view, exported file or another vault.
 * Alerts without markup are left as prose, because the field blocks analysts
 * paste use markdown emphasis that is worth rendering.
 */
export function quarantineMarkup(text: string): string {
  if (!LOOKS_LIKE_MARKUP.test(text)) return text
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text}\n${fence}`
}
