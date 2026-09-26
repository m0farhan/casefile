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

  // Task before bullet: "- [x] " would otherwise match the bullet rule. Any
  // state character makes a checkbox, as it does in the rendered preview
  // (checkboxToggle's CHECKBOX_LINE); only x/X reads as done.
  const task = text.match(/^(\s*)([-*+]) \[(.)\]( |$)/)
  if (task) {
    const indent = task[1].length
    return {
      kind: 'task',
      indent,
      // "- [x]" plus the space after it, so the text starts where the
      // rendered item's text does.
      markerLen: 5 + task[4].length,
      stateOffset: indent + 3, // past "- ["
      checked: task[3] === 'x' || task[3] === 'X'
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

/** Columns of leading whitespace, a tab reaching the next multiple of four. */
function leadColumns(text: string): number {
  let col = 0
  for (const ch of text) {
    if (ch === ' ') col++
    else if (ch === '\t') col += 4 - (col % 4)
    else break
  }
  return col
}

/**
 * Nesting depth of every list-item line, -1 for any other line, so the editor
 * can indent a nested item exactly as far as the rendered list does. An item
 * nests under the nearest open item whose content column it reaches, which
 * is CommonMark's rule. A blank line keeps the list open; any other line left
 * of the open item's content closes it, unless it directly continues that
 * item's text.
 * ponytail: the four-column indented-code limit, extra spaces after a marker
 * and lists inside quotes are not modelled; those items indent a little
 * differently in the editor than in the preview.
 */
export function listDepths(docText: string, fenced = fenceMap(docText)): number[] {
  const open: number[] = [] // content column of each open item, outermost first
  let prevBlank = true
  return docText.split('\n').map((text, i) => {
    const blank = text.trim() === ''
    const col = leadColumns(text)
    const lm = fenced[i] ? null : classifyLine(text)
    let depth = -1
    if (lm && (lm.kind === 'bullet' || lm.kind === 'task' || lm.kind === 'ordered')) {
      while (open.length > 0 && col < open[open.length - 1]) open.pop()
      depth = open.length
      open.push(col + (lm.kind === 'ordered' ? lm.markerLen + 1 : 2))
    } else if (!blank && open.length > 0 && col < open[open.length - 1] && (prevBlank || lm || fenced[i])) {
      open.length = 0
    }
    prevBlank = blank
    return depth
  })
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
// "---" or "===" under a paragraph line turns it into a heading.
const SETEXT_UNDERLINE = /^ {0,3}(?:-+|=+)[ \t]*$/

/**
 * Blank source lines the rendered preview has to stand in for, so its blocks
 * sit exactly where the editor's lines do. `gaps` holds, for each top-level
 * block the renderer will emit, the blank lines just above its first line;
 * `trail` the blank lines after the last. Rendering turns those lines into
 * margins it cannot size, and it cannot tell "Steps:\n1. …" (no gap) from a
 * list after a blank line. The block boundaries follow CommonMark where
 * descriptions go: headings, fences and rules stand alone; a list, quote or
 * fence ends a paragraph; a list takes blank lines, nested and indented lines
 * and, directly after text, unindented text; a quote takes unindented text.
 * ponytail: HTML blocks, math, %% comments, footnotes and link definitions
 * are not modelled; they change the block count, and the caller then keeps
 * its defaults rather than trust a misaligned list.
 */
export function blockGaps(docText: string): { gaps: number[]; trail: number } {
  const gaps: number[] = []
  let blank = 0
  let prev: 'para' | 'list' | 'quote' | 'other' | null = null
  let fence: string | null = null
  let itemCol = 0 // content column of the open list's current top-level item
  let marker = '' // that list's bullet character or number delimiter
  for (const text of docText.split('\n')) {
    if (fence !== null) {
      // Nothing starts inside a fence; blank lines there are code.
      if (text.match(FENCE_OPEN)?.[1][0] === fence) fence = null
      continue
    }
    if (text.trim() === '') {
      blank++
      continue
    }
    const col = leadColumns(text)
    const lm = classifyLine(text)
    const fenceOpen = text.match(FENCE_OPEN)
    const item = lm?.kind === 'bullet' || lm?.kind === 'task' || lm?.kind === 'ordered' ? lm : null
    const itemMarker = item ? text[item.indent + (item.kind === 'ordered' ? item.markerLen - 1 : 0)] : ''
    const kind =
      item && !THEMATIC_BREAK.test(text)
        ? 'list'
        : lm?.kind === 'quote'
          ? 'quote'
          : lm || fenceOpen || THEMATIC_BREAK.test(text)
            ? 'other'
            : 'para'
    let continues = false
    if (prev === 'list') {
      continues = col >= itemCol || (kind === 'list' && itemMarker === marker) || (blank === 0 && kind === 'para')
    } else if (prev === 'para') {
      continues =
        blank === 0 &&
        (kind === 'para' ||
          SETEXT_UNDERLINE.test(text) ||
          // Only an ordered list starting at 1 may interrupt a paragraph.
          (item?.kind === 'ordered' && !/^\s*1[.)]/.test(text)))
    } else if (prev === 'quote') {
      continues = blank === 0 && (kind === 'quote' || kind === 'para')
    }
    if (!continues) {
      gaps.push(blank)
      prev = kind
      marker = itemMarker
    }
    if (item && (!continues || col < itemCol)) {
      itemCol = col + (item.kind === 'ordered' ? item.markerLen + 1 : 2)
    }
    if (fenceOpen) fence = fenceOpen[1][0]
    blank = 0
  }
  return { gaps, trail: blank }
}
