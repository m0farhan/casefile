/**
 * Pure inline-markdown scanner for the description editor's live preview.
 * No obsidian / codemirror imports — this module is vitest-covered; the
 * CodeMirror decoration plugin in DescriptionEditor.ts consumes it.
 *
 * Semantics match inlineFormat.ts: marker RUNS pair by equal length, so
 * `**x**` is bold (never italic), `***x***` is bold+italic (2+1 split),
 * and runs of 4+ stay raw. Inline code wins over emphasis inside it.
 */

export interface InlineMark {
  /** Full formatted range INCLUDING markers (offsets within the line). */
  from: number
  to: number
  cls: 'strong' | 'em' | 'code'
  /** Marker sub-ranges to hide when the selection is elsewhere. */
  markers: [number, number][]
}

interface Run {
  start: number
  len: number
}

function charRuns(line: string, ch: string): Run[] {
  const runs: Run[] = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ch) continue
    const start = i
    while (i + 1 < line.length && line[i + 1] === ch) i++
    runs.push({ start, len: i - start + 1 })
  }
  return runs
}

/** Code spans: a backtick run pairs with the next run of the same length. */
function codeSpans(line: string): InlineMark[] {
  const marks: InlineMark[] = []
  const runs = charRuns(line, '`')
  let i = 0
  while (i < runs.length) {
    const open = runs[i]
    let close = -1
    for (let j = i + 1; j < runs.length; j++) {
      if (runs[j].len === open.len) {
        close = j
        break
      }
    }
    if (close === -1) {
      i++
      continue
    }
    const c = runs[close]
    marks.push({
      from: open.start,
      to: c.start + c.len,
      cls: 'code',
      markers: [
        [open.start, open.start + open.len],
        [c.start, c.start + c.len]
      ]
    })
    i = close + 1
  }
  return marks
}

/**
 * Emphasis for one marker char. Equal-length run pairing with minimal
 * flanking rules: an opener must be followed by non-whitespace, a closer
 * preceded by non-whitespace (so `2 * 3 * 4` stays raw); `_` additionally
 * refuses intra-word matches (`snake_case_name` stays raw).
 * For `*`: run length 1 = em, 2 = strong, 3 = strong+em, 4+ raw.
 * For `_`: only length 1 (em) — `__x__` is not bold in this grammar.
 * ponytail: no nesting inside consumed content (`**a *b* c**` bolds the
 * whole, inner em stays literal) — recurse into content if it ever matters.
 */
function emphasis(line: string, ch: '*' | '_', inCode: (run: Run) => boolean): InlineMark[] {
  const marks: InlineMark[] = []
  const runs = charRuns(line, ch).filter((r) => !inCode(r))
  const wordy = (c: string | undefined) => c !== undefined && /[0-9A-Za-z]/.test(c)
  const canOpen = (r: Run) => {
    const next = line[r.start + r.len]
    if (next === undefined || /\s/.test(next)) return false
    return ch === '*' || !wordy(line[r.start - 1])
  }
  const canClose = (r: Run) => {
    const prev = line[r.start - 1]
    if (prev === undefined || /\s/.test(prev)) return false
    return ch === '*' || !wordy(line[r.start + r.len])
  }
  const maxLen = ch === '*' ? 3 : 1
  let i = 0
  while (i < runs.length) {
    const open = runs[i]
    if (open.len > maxLen || !canOpen(open)) {
      i++
      continue
    }
    let close = -1
    for (let j = i + 1; j < runs.length; j++) {
      if (runs[j].len === open.len && canClose(runs[j])) {
        close = j
        break
      }
    }
    if (close === -1) {
      i++
      continue
    }
    const c = runs[close]
    const from = open.start
    const to = c.start + c.len
    if (open.len === 3) {
      // ***x*** = ** + * : outer 2 chars are the bold markers, inner 1 the italic.
      marks.push({
        from,
        to,
        cls: 'strong',
        markers: [
          [from, from + 2],
          [c.start + 1, to]
        ]
      })
      marks.push({
        from,
        to,
        cls: 'em',
        markers: [
          [from + 2, from + 3],
          [c.start, c.start + 1]
        ]
      })
    } else {
      marks.push({
        from,
        to,
        cls: open.len === 2 ? 'strong' : 'em',
        markers: [
          [from, from + open.len],
          [c.start, to]
        ]
      })
    }
    i = close + 1
  }
  return marks
}

/** All inline marks for one line (caller skips lines fenceMap flags). */
export function computeInlineMarks(line: string): InlineMark[] {
  const code = codeSpans(line)
  const inCode = (r: Run) => code.some((c) => r.start >= c.from && r.start < c.to)
  const marks = [...code, ...emphasis(line, '*', inCode), ...emphasis(line, '_', inCode)]
  return marks.sort((a, b) => a.from - b.from || a.to - b.to)
}

/**
 * Line-level markdown classification for the editor's live preview: headings,
 * quotes, task checkboxes, bullet and ordered list items. Offsets are within
 * the line. The decoration layer hides/replaces markers only while the
 * selection is off the line (Obsidian Live Preview behavior); fenced lines
 * are the caller's job to skip via fenceMap.
 */
export type LineMark =
  | { kind: 'heading'; level: number; markerLen: number }
  | { kind: 'quote'; markerLen: number }
  | { kind: 'task'; indent: number; markerLen: number; stateOffset: number; checked: boolean }
  | { kind: 'bullet'; indent: number }
  | { kind: 'ordered'; indent: number; markerLen: number }

export function classifyLine(text: string): LineMark | null {
  const heading = text.match(/^(#{1,6}) /)
  if (heading) return { kind: 'heading', level: heading[1].length, markerLen: heading[1].length + 1 }

  const quote = text.match(/^(>\s?)/)
  if (quote) return { kind: 'quote', markerLen: quote[1].length }

  // Task before bullet: "- [x] " would otherwise match the bullet rule.
  const task = text.match(/^(\s*)([-*+]) \[( |x|X)\](?= |$)/)
  if (task) {
    const indent = task[1].length
    return {
      kind: 'task',
      indent,
      markerLen: 5, // "- [x]"
      stateOffset: indent + 3, // past "- ["
      checked: task[3] !== ' '
    }
  }

  const bullet = text.match(/^(\s*)([-*+]) /)
  if (bullet) return { kind: 'bullet', indent: bullet[1].length }

  const ordered = text.match(/^(\s*)(\d{1,9}[.)]) /)
  if (ordered) return { kind: 'ordered', indent: ordered[1].length, markerLen: ordered[2].length }

  return null
}

/**
 * Per-line "skip inline parsing" map for a whole document: true for fenced
 * code block delimiters and every line inside a fence.
 * ponytail: closing fence only matches by char, not run length — nested
 * longer fences are rare in task descriptions.
 */
export function fenceMap(docText: string): boolean[] {
  const map: boolean[] = []
  let fence: string | null = null
  for (const line of docText.split('\n')) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (m) {
      map.push(true)
      if (fence === null) fence = m[1][0]
      else if (m[1][0] === fence) fence = null
    } else {
      map.push(fence !== null)
    }
  }
  return map
}
