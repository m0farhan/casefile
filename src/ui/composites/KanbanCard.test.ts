import { describe, expect, it, vi } from 'vitest'
import { FakeEl } from '../../../test/fakeDom'
import { makeTask, type BoardType } from '../../types'
import { renderIssueTypeIcon } from './issueMeta'
import { KanbanCard, recurrenceLabel } from './KanbanCard'

vi.mock('obsidian', () => ({ setIcon: () => {}, setTooltip: () => {} }))
vi.mock('./issueMeta', () => ({ renderIssueTypeIcon: vi.fn<() => void>(), renderKeyChip: vi.fn<() => void>() }))

describe('recurrenceLabel', () => {
  it('uses the plain adverb for every-1 intervals', () => {
    expect(recurrenceLabel({ interval: 'weekly', every: 1 })).toBe('Repeats weekly')
    expect(recurrenceLabel({ interval: 'daily', every: 1 })).toBe('Repeats daily')
  })

  it('spells out multi-unit intervals', () => {
    expect(recurrenceLabel({ interval: 'weekly', every: 2 })).toBe('Repeats every 2 weeks')
    expect(recurrenceLabel({ interval: 'monthly', every: 3 })).toBe('Repeats every 3 months')
  })
})

describe('KanbanCard issue glyph', () => {
  const draw = (boardType: BoardType): string | undefined => {
    const task = makeTask({ title: 'Detected Suspicious Xls File', issueType: 'incident', tags: ['phishing'] })
    // FakeEl has no dataset or hasChildNodes; the card uses both.
    const root = FakeEl.root()
    const createDiv = root.createDiv.bind(root)
    root.createDiv = (info) => Object.assign(createDiv(info), { dataset: {} })
    Object.assign(FakeEl.prototype, {
      hasChildNodes(this: FakeEl) {
        return this.children.length > 0
      }
    })
    new KanbanCard(root as unknown as HTMLElement, {
      task,
      boardType,
      loggedHours: 0,
      overdue: false,
      showTagColors: false,
      onClick: () => {},
      onContextMenu: () => {},
      onDragStart: () => {},
      onDragEnd: () => {}
    })
    const alert = vi.mocked(renderIssueTypeIcon).mock.lastCall?.[2]?.alert
    expect(alert?.tags).toEqual(['phishing'])
    return alert?.title
  }

  it('derives a kind from the title on a case board only', () => {
    expect(draw('case')).toBe('Detected Suspicious Xls File')
    // A plain board has no Alert kind control for the derived tooltip to point at.
    expect(draw('plain')).toBe('')
  })
})
