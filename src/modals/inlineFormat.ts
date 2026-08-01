/** Result of toggling an inline marker: the new text plus the selection to restore. */
export interface InlineToggle {
  value: string
  selStart: number
  selEnd: number
}

/**
 * Toggle an inline markdown marker (`**`, `*`, `` ` ``) around [start, end) of value.
 * Wrapped (inside or immediately outside the selection) → unwrap; otherwise wrap.
 * Empty selection wraps nothing and parks the caret between the markers.
 */
export function toggleInlineMarker(value: string, start: number, end: number, marker: string): InlineToggle {
  const m = marker.length
  const sel = value.slice(start, end)

  // Selection includes the markers themselves: **bold** selected whole.
  if (sel.length >= 2 * m && sel.startsWith(marker) && sel.endsWith(marker) && !isEscapedRun(sel, marker)) {
    const inner = sel.slice(m, sel.length - m)
    return {
      value: value.slice(0, start) + inner + value.slice(end),
      selStart: start,
      selEnd: end - 2 * m
    }
  }

  // Markers sit just outside the selection: bold selected inside **bold**.
  if (markerOpenAround(value, start, end, marker)) {
    return {
      value: value.slice(0, start - m) + sel + value.slice(end + m),
      selStart: start - m,
      selEnd: end - m
    }
  }

  const wrapped = value.slice(0, start) + marker + sel + marker + value.slice(end)
  return { value: wrapped, selStart: start + m, selEnd: end + m }
}

/** `***` selected for a `*` toggle is bold+italic, not an escaped run — but `**` alone for `*` is. */
function isEscapedRun(sel: string, marker: string): boolean {
  return sel.length < 2 * marker.length + 1 && sel.split('').every((c) => c === marker[0])
}

/**
 * Is this marker actually open just outside [start, end)? An exact-slice check
 * alone would read the two halves of a `**` bold run as an open `*` italic and
 * unwrap instead of stacking, so single-char markers also require odd-length
 * marker runs on both sides (`*it*` and `***it***` unwrap; `**it**` stacks).
 */
function markerOpenAround(value: string, start: number, end: number, marker: string): boolean {
  const m = marker.length
  if (value.slice(start - m, start) !== marker || value.slice(end, end + m) !== marker) return false
  if (m > 1) return true
  const ch = marker[0]
  let left = 0
  for (let i = start - 1; i >= 0 && value[i] === ch; i--) left++
  let right = 0
  for (let i = end; i < value.length && value[i] === ch; i++) right++
  return left % 2 === 1 && right % 2 === 1
}
