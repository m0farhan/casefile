import { describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent } from '../../../test/fakeDom'
import { makeTask, type BoardType, type Task } from '../../types'
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

describe('KanbanCard in a complete column', () => {
  const draw = (done: boolean): FakeEl => {
    const root = FakeEl.root()
    const createDiv = root.createDiv.bind(root)
    root.createDiv = (info) => Object.assign(createDiv(info), { dataset: {} })
    Object.assign(FakeEl.prototype, {
      hasChildNodes(this: FakeEl) {
        return this.children.length > 0
      }
    })
    new KanbanCard(root as unknown as HTMLElement, {
      task: makeTask({ title: 'Closed out' }),
      done,
      loggedHours: 0,
      overdue: false,
      showTagColors: false,
      onClick: () => {},
      onContextMenu: () => {},
      onDragStart: () => {},
      onDragEnd: () => {}
    })
    return root
  }

  it('marks the card done with a check, even on a board without issue keys', () => {
    const done = draw(true)
    expect(done.find('.pm-kanban-card').hasClass('pm-kanban-card--done')).toBe(true)
    expect(done.findAll('.pm-kanban-card-done-mark')).toHaveLength(1)
    expect(draw(false).findAll('.pm-kanban-card-done-mark')).toHaveLength(0)
  })
})

describe('KanbanCard progress scrubber', () => {
  const draw = (
    over: Partial<Task>,
    onProgressChange = vi.fn<(v: number) => void>(),
    onClick = vi.fn<() => void>()
  ) => {
    const root = FakeEl.root()
    const createDiv = root.createDiv.bind(root)
    root.createDiv = (info) => Object.assign(createDiv(info), { dataset: {} })
    Object.assign(FakeEl.prototype, {
      hasChildNodes(this: FakeEl) {
        return this.children.length > 0
      }
    })
    new KanbanCard(root as unknown as HTMLElement, {
      task: makeTask({ title: 'Beacon', ...over }),
      loggedHours: 0,
      overdue: false,
      showTagColors: false,
      onClick,
      onProgressChange,
      onContextMenu: () => {},
      onDragStart: () => {},
      onDragEnd: () => {}
    })
    return root
  }

  // A tap on the chip row, which Chromium's touch adjustment handed to the
  // slider below it, saved a Done card at 0% and never opened it.
  it('opens the card on a touch tap that landed off the slider, leaving progress alone', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const onProgressChange = vi.fn<(v: number) => void>()
    const onClick = vi.fn<() => void>()
    const slider = draw({ progress: 100 }, onProgressChange, onClick).find('.pm-kanban-progress')
    // The fake slider's box is 0..0, so clientY -4 is a point above it.
    slider.dispatchEvent(fakeEvent('pointerdown', { pointerType: 'touch', clientY: -4 }))
    slider.value = '0'
    slider.dispatchEvent(fakeEvent('input'))
    slider.dispatchEvent(fakeEvent('pointerup'))
    slider.dispatchEvent(fakeEvent('change'))
    expect(slider.value).toBe('100')
    expect(onProgressChange).not.toHaveBeenCalled()
    expect(onClick).toHaveBeenCalledOnce()

    // A touch on the slider itself still sets it.
    slider.dispatchEvent(fakeEvent('pointerdown', { pointerType: 'touch', clientY: 0 }))
    slider.value = '50'
    slider.dispatchEvent(fakeEvent('change'))
    expect(onProgressChange).toHaveBeenCalledWith(50)

    // Below the slider is the card's own edge: still the slider's.
    slider.dispatchEvent(fakeEvent('pointerdown', { pointerType: 'touch', clientY: 3 }))
    slider.value = '75'
    slider.dispatchEvent(fakeEvent('change'))
    expect(onProgressChange).toHaveBeenLastCalledWith(75)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('forgets a retargeted tap once it is over, so a later adjust with no pointer still saves', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const onProgressChange = vi.fn<(v: number) => void>()
    const slider = draw({ progress: 25 }, onProgressChange).find('.pm-kanban-progress')
    slider.dispatchEvent(fakeEvent('pointerdown', { pointerType: 'touch', clientY: -4 }))
    slider.dispatchEvent(fakeEvent('pointerup'))
    vi.advanceTimersByTime(400)
    slider.value = '50' // assistive tech sets the value with no pointer
    slider.dispatchEvent(fakeEvent('change'))
    expect(onProgressChange).toHaveBeenCalledWith(50)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('draws a value between the 25% detents where it is, not at the nearest one', () => {
    // FakeEl declares no `step`; the card sets it as a plain property.
    const step = (el: FakeEl) => (el as unknown as { step: string }).step
    const slider = draw({ progress: 40 }).find('.pm-kanban-progress')
    expect([step(slider), slider.style['--pm-progress-pct']]).toEqual(['1', '40%'])
    expect(step(draw({ progress: 50 }).find('.pm-kanban-progress'))).toBe('25')
  })

  // A milestone has no progress; one dragged into Done showed a 0% scrubber.
  it('gives a milestone no progress bar at all', () => {
    const card = draw({ type: 'milestone', progress: 40 })
    expect(card.findAll('.pm-kanban-progress, .pm-kanban-card-progress')).toHaveLength(0)
  })
})
