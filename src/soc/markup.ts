/**
 * Which script and markup names an HTML or SVG attachment's text contains.
 *
 * An HTML smuggling file is a page that builds its payload in the browser: a
 * long base64 string, then `atob(`, `new Blob`, `createObjectURL` and a
 * `.download` or a `window.location` to hand the result over. None of that has
 * a magic number, and the preview only shows the first screen of the blob, so
 * without a count of these names the analyst is shown a wall of base64 and
 * nothing else.
 *
 * Like the PDF census, this is a count of literal text and not a parse. It
 * runs no script, builds no DOM and decides nothing: `eval(` inside a comment
 * is counted the same as `eval(` in a script block, and the line it returns
 * says so. What it cannot see — a name split across string pieces, escaped, or
 * encoded — it does not count, and the line says that too, so an absent name
 * reads as "not written out here" and never as "not present".
 */

/**
 * In the order the line lists them: the in-browser build chain first, then
 * credential forms and redirects, then decoders, then embedded frames.
 */
const MARKERS = [
  '<script',
  'atob(',
  'new Blob',
  'createObjectURL',
  'msSaveOrOpenBlob',
  '.download',
  '<form',
  'type="password"',
  'window.location',
  'location.href',
  'location.replace',
  'http-equiv="refresh"',
  'eval(',
  'unescape(',
  'fromCharCode',
  'document.write',
  '<iframe',
  '<embed',
  '<object',
  '<foreignObject'
]

const INDEX = new Map(MARKERS.map((name, i) => [name.toLowerCase(), i]))

/**
 * One alternation of the literal names, inside a lookahead so the match is
 * zero-width. That is what lets `window.location.href` count as both
 * `window.location` and `location.href`: a consuming match would swallow the
 * first and never see the second, and "counted wherever they appear" would
 * then be untrue. No two names can match at the same position, so the
 * alternation's order never hides one behind another.
 *
 * Literals only, so the pass is linear: the engine tries at most one short
 * word per position and never backtracks into what it already read.
 */
const MARKER_RE = new RegExp(`(?=(${MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))`, 'gi')

/**
 * ponytail: counts stop at 999 and show as "999+", which is still a true lower
 * bound. The pass itself is bounded by the text it is given — the caller hands
 * over capped windows, not the whole file — so the cap is for the reader: past
 * a few hundred the exact number adds nothing to the line.
 */
const MAX_COUNT = 999

/**
 * The census line for this text, or null when none of the names appears.
 *
 * Matching ignores letter case — HTML tag names do too — and the line says so,
 * because `<SCRIPT` shown as `<script ×1` would otherwise be a claim about text
 * that is not in the file. It also says other spellings go uncounted: a line
 * that lists `type="password"` must not read as if `type='password'` or an
 * unquoted `type=password` would have been listed too.
 */
export function markupCensus(text: string): string | null {
  const counts: number[] = MARKERS.map(() => 0)
  // matchAll steps past each zero-width match by itself, so this cannot stall on one position.
  for (const m of text.matchAll(MARKER_RE)) {
    const i = INDEX.get(m[1].toLowerCase())
    if (i !== undefined && counts[i] < MAX_COUNT) counts[i]++
  }
  const found = MARKERS.flatMap((name, i) =>
    counts[i] ? [`${name} ×${counts[i] >= MAX_COUNT ? `${MAX_COUNT}+` : counts[i]}`] : []
  )
  if (!found.length) return null
  return (
    `script and markup names found: ${found.join(', ')} — counted as text in any letter case wherever they ` +
    'appear, not parsed; other spellings and split or encoded forms are not counted'
  )
}
