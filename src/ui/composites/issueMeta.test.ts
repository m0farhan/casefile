import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeEl } from '../../../test/fakeDom'
import { DEFAULT_ALERT_CATEGORIES, DEFAULT_ISSUE_TYPES } from '../../types'
import { renderIssueTypeIcon, setAlertKindDerivation } from './issueMeta'

// The glyph and tooltip are recorded on the element so a test can read them.
vi.mock('obsidian', () => ({
  setIcon: (el: FakeEl, id: string) => el.setAttr('data-icon', id),
  setTooltip: (el: FakeEl, tip: string) => el.setAttr('aria-label', tip)
}))
vi.mock('../../utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isIconName: () => true
}))

const INCIDENT = DEFAULT_ISSUE_TYPES.find((t) => t.id === 'incident')
const TASK = DEFAULT_ISSUE_TYPES.find((t) => t.id === 'task')
const HAND_MADE = '77 - SOC138 - Detected Suspicious Xls File'

function draw(type = INCIDENT, tags: string[] = [], title = HAND_MADE): FakeEl {
  const root = FakeEl.root()
  renderIssueTypeIcon(root as unknown as HTMLElement, type, {
    alert: { tags, title, categories: DEFAULT_ALERT_CATEGORIES }
  })
  return root.find('.pm-issuetype-icon')
}

afterEach(() => setAlertKindDerivation(true))

describe('renderIssueTypeIcon', () => {
  it('a hand-made incident with no kind tag shows the kind its title names, marked derived', () => {
    const icon = draw()
    expect(icon.getAttribute('data-icon')).toBe('file-warning')
    expect(icon.hasClass('pm-issuetype-icon--derived')).toBe(true)
    expect(icon.getAttribute('aria-label')).toBe(
      'Incident · Suspicious file, derived from the title word "xls" — not recorded on the case. ' +
        'Set the alert kind to record it.'
    )
  })

  it('a kind the tags record draws as normal', () => {
    const icon = draw(INCIDENT, ['phishing'])
    expect(icon.getAttribute('data-icon')).toBe('fish')
    expect(icon.hasClass('pm-issuetype-icon--derived')).toBe(false)
    expect(icon.getAttribute('aria-label')).toBe('Incident · Phishing')
  })

  it('with derivation off, an untagged incident keeps the incident glyph', () => {
    setAlertKindDerivation(false)
    const icon = draw()
    expect(icon.getAttribute('data-icon')).toBe(INCIDENT?.icon)
    expect(icon.hasClass('pm-issuetype-icon--derived')).toBe(false)
    expect(icon.getAttribute('aria-label')).toBe('Incident')
  })

  it('only an incident takes a kind glyph', () => {
    const icon = draw(TASK, ['macro'])
    expect(icon.getAttribute('data-icon')).toBe(TASK?.icon)
    expect(icon.getAttribute('aria-label')).toBe(TASK?.label)
  })
})
