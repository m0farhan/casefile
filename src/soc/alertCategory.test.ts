import { describe, expect, it } from 'vitest'
import { DEFAULT_ALERT_CATEGORIES } from '../types'
import {
  alertKindOf,
  categoryForTags,
  missingBuiltInKinds,
  normalizeAlertCategories,
  setKindTag,
  suggestCategory
} from './alertCategory'

const CATS = DEFAULT_ALERT_CATEGORIES

describe('categoryForTags', () => {
  it('matches a tag against the id, the label and a match term', () => {
    expect(categoryForTags(['phishing'], CATS)?.id).toBe('phishing')
    expect(categoryForTags(['Suspicious File'], CATS)?.id).toBe('suspicious-file')
    expect(categoryForTags(['macro'], CATS)?.id).toBe('suspicious-file')
    expect(categoryForTags(['  Credential Compromise  '], CATS)?.id).toBe('credentials')
  })

  it('returns undefined when no tag names a category', () => {
    expect(categoryForTags([], CATS)).toBeUndefined()
    expect(categoryForTags(['soc138', 'day-shift', 'demo'], CATS)).toBeUndefined()
  })

  it('requires the whole tag to equal a term, never a substring', () => {
    expect(categoryForTags(['phishing-training'], CATS)).toBeUndefined()
  })

  it('resolves ties by list order', () => {
    expect(categoryForTags(['malware', 'phishing'], CATS)?.id).toBe('phishing')
  })
})

describe('suggestCategory', () => {
  const t = (title: string) => suggestCategory(title, CATS)

  it('categorises real LetsDefend case titles', () => {
    expect(t('SOC282 - Phishing Alert - Deceptive Mail Detected')?.id).toBe('phishing')
    expect(t('SOC104 - Malware Detected')?.id).toBe('malware')
    expect(t('SOC109 - Emotet Malware Detected')?.id).toBe('malware')
    expect(t('SOC138 - Detected Suspicious Xls File')?.id).toBe('suspicious-file')
    expect(t('SOC166 - Javascript Code Detected in Requested URL')?.id).toBe('web-attack')
    expect(t('SOC168 - Whoami Command Detected in Request Body')?.id).toBe('web-attack')
    expect(t('SOC169 - Possible IDOR Attack Detected')?.id).toBe('web-attack')
    expect(t('SOC170 - Passwd Found in Requested URL - Possible LFI Attack')?.id).toBe('web-attack')
    expect(t('DEMO - Playbook walkthrough')).toBeUndefined()
  })

  it('reports the exact term that matched, so the suggestion can be checked', () => {
    expect(t('SOC138 - Detected Suspicious Xls File')).toEqual({
      id: 'suspicious-file',
      label: 'Suspicious file',
      matched: 'xls'
    })
  })

  it('matches whole words only', () => {
    expect(t('Becoming a better analyst')).toBeUndefined()
    expect(t('Xlsxxx report')).toBeUndefined()
  })

  it('suggests nothing rather than guessing', () => {
    expect(t('SOC199 - Something Nobody Named')).toBeUndefined()
    expect(t('Free coffee voucher')).toBeUndefined()
    expect(t('')).toBeUndefined()
    expect(suggestCategory('SOC282 - Phishing Alert', [])).toBeUndefined()
  })
})

describe('normalizeAlertCategories', () => {
  it('installs the defaults only when the key is absent', () => {
    expect(normalizeAlertCategories(undefined)).toEqual(CATS)
    // An empty list is a choice the analyst is allowed to make.
    expect(normalizeAlertCategories([])).toEqual([])
  })

  it('survives a hand-edited data.json without taking every card render down', () => {
    expect(normalizeAlertCategories([{ id: 'phishing' }])).toEqual([
      { id: 'phishing', label: 'phishing', color: '#8a94a0', icon: '', match: [] }
    ])
    expect(normalizeAlertCategories([null, 3, { label: 'no id' }, { id: '' }])).toEqual([])
    expect(normalizeAlertCategories([{ id: 'x', match: ['ok', 7, null] }])[0].match).toEqual(['ok'])
  })

  it('does not hand back the shared default objects', () => {
    const out = normalizeAlertCategories(undefined)
    out[0].match.push('mutated')
    expect(CATS[0].match).not.toContain('mutated')
  })
})

describe('alertKindOf', () => {
  const HAND_MADE = '77 - SOC138 - Detected Suspicious Xls File'

  it("derives a hand-made case's kind from its title, saying which word matched", () => {
    const kind = alertKindOf([], HAND_MADE, CATS, true)
    expect(kind?.category.id).toBe('suspicious-file')
    expect(kind?.derivedFrom).toBe('xls')
  })

  it('a recorded tag wins over the title, and is not marked derived', () => {
    const kind = alertKindOf(['phishing'], HAND_MADE, CATS, true)
    expect(kind?.category.id).toBe('phishing')
    expect(kind?.derivedFrom).toBeUndefined()
  })

  it('derives nothing with derivation off, or from a title that names no kind', () => {
    expect(alertKindOf([], HAND_MADE, CATS, false)).toBeUndefined()
    expect(alertKindOf(['xls'], HAND_MADE, CATS, false)?.category.id).toBe('suspicious-file')
    expect(alertKindOf([], 'DEMO - Playbook walkthrough', CATS, true)).toBeUndefined()
  })

  it('reads a suspicious connection without taking a term from another kind', () => {
    expect(alertKindOf([], 'SOC301 - Suspicious Connection to Rare Host', CATS, true)?.category.id).toBe(
      'suspicious-connection'
    )
    expect(alertKindOf([], 'Blocked Connection Attempt', CATS, true)?.category.id).toBe('suspicious-connection')
    // 'c2' belongs to Malware, earlier in the list, so this never depends on order.
    expect(alertKindOf([], 'C2 Connection Detected', CATS, true)?.category.id).toBe('malware')
    // No term names two built-in kinds.
    const terms = CATS.flatMap((c) => [...new Set([c.id, c.label, ...c.match].map((t) => t.toLowerCase()))])
    expect(new Set(terms).size).toBe(terms.length)
  })
})

describe('setKindTag', () => {
  it('records exactly one kind: every tag that names a kind goes, other tags stay', () => {
    expect(setKindTag(['soc138', 'macro', 'Phishing', 'day-shift'], CATS, 'malware')).toEqual([
      'soc138',
      'day-shift',
      'malware'
    ])
  })

  it('keeps a tag that already is the chosen kind where it is', () => {
    expect(setKindTag(['phishing', 'demo', 'malware'], CATS, 'phishing')).toEqual(['phishing', 'demo'])
  })

  it("'' clears the kind", () => {
    expect(setKindTag(['xls', 'demo'], CATS, '')).toEqual(['demo'])
    expect(setKindTag(['demo'], CATS, '')).toEqual(['demo'])
  })
})

describe('missingBuiltInKinds', () => {
  it('offers only the built-ins a saved list lacks, as copies, and leaves the list alone', () => {
    const saved = CATS.filter((c) => c.id !== 'suspicious-connection').map((c) => ({ ...c, label: 'edited' }))
    const before = JSON.stringify(saved)
    const missing = missingBuiltInKinds(saved)
    expect(missing.map((c) => c.id)).toEqual(['suspicious-connection'])
    expect(JSON.stringify(saved)).toBe(before)
    missing[0].match.push('mutated')
    expect(CATS.at(-1)?.match).not.toContain('mutated')
    expect(missingBuiltInKinds(CATS)).toEqual([])
  })
})
