/**
 * Which script and markup names an HTML or SVG attachment's text contains,
 * and which embedded-object markers an RTF attachment's does.
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

/**
 * The RTF control words that carry an embedded object, in the order the line
 * lists them. An RTF lure — the Equation Editor exploit is the famous one —
 * puts its payload in `{\object … {\*\objdata <hex>}}` after enough padding to
 * push it past the preview's first 20,000 characters, so without a count the
 * object that is the whole point of the file is shown nowhere and the report
 * is silent about it.
 */
const RTF_WORDS = ['object', 'objdata', 'objupdate', 'objemb', 'objlink', 'objautlink']

/**
 * Same zero-width literal alternation as MARKER_RE, so the pass stays linear.
 * The `(?![a-z])` after a control word is the delimiter RTF itself requires:
 * `\objdataxyz` is a different word, one the RTF specification tells readers
 * to ignore, and counting it as `\objdata` would be a claim about text that
 * is not in the file. The flag ignores case only so DDEAUTO can be found in
 * any case; control words are then kept only when spelled exactly as RTF
 * writes them, in lower case.
 *
 * DDEAUTO is not a control word. A DDE lure puts it in field-instruction text,
 * `{\*\fldinst DDEAUTO …}`, where Word reads it in any letter case, so it is
 * counted as text.
 */
const RTF_RE = new RegExp(`(?=(${RTF_WORDS.map((w) => `\\\\${w}`).join('|')})(?![a-z])|(ddeauto))`, 'gi')

/**
 * The first `\objclass` and what follows it, read no further than 65
 * characters so a hostile value is never copied whole. Only a class-name
 * shape is shown — letters, digits, `.`, `_`, `-` — which cannot carry a URL
 * or a sentence of the sender's into the report.
 */
const OBJCLASS_RE = /\\objclass(?![a-zA-Z])[ \t\r\n]*([A-Za-z0-9._-]{0,65})/

/**
 * The RTF census line for this text, or null when none of the markers appears.
 *
 * Like markupCensus it counts literal text and parses nothing, and says so.
 * The `\objclass` value is stated as what the file reads and nothing more: the
 * class Word acts on sits inside `\objdata`, and a lure can name any class it
 * likes here or none at all, so the line never says what the object is.
 */
export function rtfCensus(text: string): string | null {
  const counts: number[] = [...RTF_WORDS, 'DDEAUTO'].map(() => 0)
  for (const m of text.matchAll(RTF_RE)) {
    // `\OBJDATA` or `\ObjData` finds no index, so only the lower-case word is counted.
    const i = m[1] === undefined ? RTF_WORDS.length : RTF_WORDS.indexOf(m[1].slice(1))
    if (i >= 0 && counts[i] < MAX_COUNT) counts[i]++
  }
  const found = [...RTF_WORDS.map((w) => `\\${w}`), 'DDEAUTO'].flatMap((name, i) =>
    counts[i] ? [`${name} ×${counts[i] >= MAX_COUNT ? `${MAX_COUNT}+` : counts[i]}`] : []
  )
  const cls = OBJCLASS_RE.exec(text)
  let named = ''
  if (cls) {
    // A value longer than 64 characters, or one running on into a `:` or a
    // `/`, is not a class name; showing its first part would state a value
    // the file does not hold.
    const after = text.charAt(cls.index + cls[0].length)
    const plain = cls[1].length > 0 && cls[1].length <= 64 && (after === '' || /[\s{}\\]/.test(after))
    named = plain
      ? `the first \\objclass reads ${cls[1]}`
      : 'the first \\objclass is not followed by a short plain class name, so its value is not shown here'
  }
  if (!found.length && !named) return null
  return (
    `RTF object and DDEAUTO markers found: ${[found.join(', '), named].filter(Boolean).join('; ')} — counted as ` +
    'text wherever they appear, not parsed: control words in lower case as RTF writes them, DDEAUTO in any ' +
    'letter case; other spellings and escaped, split or encoded forms are not counted'
  )
}
