import { type AlertCategoryConfig, DEFAULT_ALERT_CATEGORIES } from '../types'

/** Every term that names this category, lowercased: its id, its label, its match list. */
export function categoryTerms(cat: AlertCategoryConfig): string[] {
  return [cat.id, cat.label, ...cat.match].map((t) => t.trim().toLowerCase()).filter(Boolean)
}

/**
 * The category a case IS, read from its own tags — a fact the analyst recorded,
 * never a guess about the title. A tag must EQUAL one of the category's terms,
 * so `phishing-training` is not Phishing. Nothing matches = undefined: the
 * caller keeps the issue-type icon and says the category is not recorded.
 * First category in list order wins, so the settings list is the documented
 * tie-break.
 */
export function categoryForTags(
  tags: readonly string[],
  categories: readonly AlertCategoryConfig[]
): AlertCategoryConfig | undefined {
  const have = new Set(tags.map((t) => t.trim().toLowerCase()))
  return categories.find((cat) => categoryTerms(cat).some((t) => have.has(t)))
}

export interface CategorySuggestion {
  id: string
  label: string
  /** The exact term that matched — shown to the analyst, never hidden. */
  matched: string
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[a-z0-9]/.test(c)

/**
 * Whole-word/phrase containment. indexOf, not RegExp: the terms are
 * analyst-typed and the haystack is pasted text, so nothing is ever compiled
 * from either. Boundaries stop "bec" firing on "Becoming".
 */
function wordMatch(hay: string, term: string): boolean {
  for (let from = 0; ; from++) {
    const i = hay.indexOf(term, from)
    if (i < 0) return false
    if (!isWordChar(hay[i - 1]) && !isWordChar(hay[i + term.length])) return true
    from = i
  }
}

/**
 * DERIVED, and never stored on its own: the intake modal shows this as an
 * editable suggestion carrying the word that matched, and only the analyst's
 * confirmation turns it into a tag.
 *
 * The ONE source is the case title — the alert's Rule line, the field the modal
 * puts in front of the analyst. The rest of the paste is deliberately not read:
 * `fieldLines` maps EVERY line with no header boundary, and real alerts put a
 * blank line between every field, so "stop at the first blank line" would
 * reduce the header to a single heading. There is no cheap way to tell a
 * source's own `Alert Type :` from one sitting inside a quoted phishing mail,
 * so a title the analyst can see beats a field they cannot.
 */
export function suggestCategory(
  title: string,
  categories: readonly AlertCategoryConfig[]
): CategorySuggestion | undefined {
  const hay = title.toLowerCase()
  if (!hay) return undefined
  for (const cat of categories) {
    const matched = categoryTerms(cat).find((t) => wordMatch(hay, t))
    if (matched) return { id: cat.id, label: cat.label, matched }
  }
  return undefined
}

/**
 * Trust boundary: data.json is hand-editable and travels with the vault. A row
 * missing `match`, or a number where a label belongs, would throw out of
 * categoryTerms inside EVERY card render — the ownedAssets lesson in main.ts.
 * An explicitly empty list is kept: "no alert categories" is a state the
 * analyst is allowed to choose, and a missing key is the only thing that
 * installs the defaults.
 */
export function normalizeAlertCategories(raw: unknown): AlertCategoryConfig[] {
  if (!Array.isArray(raw)) return DEFAULT_ALERT_CATEGORIES.map((c) => ({ ...c, match: [...c.match] }))
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => ({
      id: str(c.id),
      label: str(c.label, str(c.id)),
      color: str(c.color, '#8a94a0'),
      icon: str(c.icon),
      match: Array.isArray(c.match) ? c.match.filter((t): t is string => typeof t === 'string') : []
    }))
    .filter((c) => c.id !== '')
}
