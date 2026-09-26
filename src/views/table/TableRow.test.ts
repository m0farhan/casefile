import { beforeEach, describe, expect, it, vi } from 'vitest'
import type PMPlugin from '../../main'
import { TaskFileNameConflictError } from '../../store/ProjectStore'
import { DEFAULT_ALERT_CATEGORIES, makeTask, type Task } from '../../types'
import { SelectCell, type SelectCellProps } from '../../ui/composites/cells/SelectCell'
import { TitleCell, type TitleCellProps } from '../../ui/composites/cells/TitleCell'
import type { TableContext, TableState } from './TableRenderer'
import { renderTaskRow } from './TableRow'

const h = vi.hoisted(() => ({
  notices: [] as string[]
}))

// The stub carries no view or modal classes; the row's import chain only
// needs them to exist. Notice is captured so what the row says can be read.
vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  function Stub(): void {}
  class Notice {
    constructor(message: unknown) {
      h.notices.push(String(message))
    }
    hide(): void {}
  }
  return new Proxy(
    { ...real, Notice },
    {
      get: (target: Record<string, unknown>, prop) => {
        if (prop in target) return target[prop as string]
        if (typeof prop !== 'string' || prop === 'then') return undefined
        return Stub
      },
      has: () => true
    }
  )
})
// The row's cells are DOM builders; each is replaced by a capture of its props.
// A constructor returning an object hands that object to `new`.
const withEl = vi.hoisted(
  () =>
    function (): { el: object } {
      return { el: {} }
    }
)
vi.mock('../../ui/composites/TaskRow', () => ({ TaskRow: vi.fn<() => { el: object }>(withEl) }))
vi.mock('../../ui/composites/cells/SelectCell', () => ({ SelectCell: vi.fn<() => void>() }))
vi.mock('../../ui/composites/cells/TitleCell', () => ({ TitleCell: vi.fn<() => { el: object }>(withEl) }))
vi.mock('../../ui/composites/cells/ExpandCell', () => ({ ExpandCell: vi.fn<() => void>() }))
vi.mock('../../ui/composites/cells/StatusCell', () => ({ StatusCell: vi.fn<() => void>() }))
vi.mock('../../ui/composites/cells/SeverityCell', () => ({ SeverityCell: vi.fn<() => { el: object }>(withEl) }))
vi.mock('../../ui/composites/cells/AssigneesCell', () => ({ AssigneesCell: vi.fn<() => void>() }))
vi.mock('../../ui/composites/cells/DueDateCell', () => ({ DueDateCell: vi.fn<() => void>() }))
vi.mock('../../ui/composites/cells/ProgressCell', () => ({ ProgressCell: vi.fn<() => void>() }))
vi.mock('../../ui/composites/cells/TimeCell', () => ({ TimeCell: vi.fn<() => void>() }))
vi.mock('../../ui/composites/cells/CustomFieldCell', () => ({ CustomFieldCell: vi.fn<() => void>() }))
vi.mock('../../ui/composites/cells/ActionsCell', () => ({ ActionsCell: vi.fn<() => void>() }))
vi.mock('../../soc/slaTicker', () => ({ renderSlaChip: vi.fn<() => void>() }))
vi.mock('../../ui/composites/issueMeta', () => ({
  renderIssueTypeIcon: vi.fn<() => object>(() => ({ kind: 'glyph' }))
}))
vi.mock('./TableRenderer', () => ({
  updateSelectCheckboxes: vi.fn<() => void>(),
  getVisibleTaskIds: (state: TableState) => state.visibleRows.map((f) => f.task.id)
}))

function row(task: Task, visible: Task[], conflict: TaskFileNameConflictError | null = null, boardType = 'case') {
  const store = {
    findTaskFileConflict: vi.fn<() => TaskFileNameConflictError | null>(() => conflict),
    updateTask: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve())
  }
  const state = {
    selectedTaskIds: new Set<string>(),
    lastCheckedTaskId: null as string | null,
    visibleRows: visible.map((t) => ({ task: t }))
  }
  const ctx = {
    project: { customFields: [] },
    plugin: {
      store,
      settings: { showTagColors: false, slaPolicies: {}, alertCategories: DEFAULT_ALERT_CATEGORIES }
    } as unknown as PMPlugin,
    statuses: [],
    boardType,
    state,
    onRefresh: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    onSelectionChange: vi.fn<() => void>()
  } as unknown as TableContext
  renderTaskRow({} as HTMLElement, task, 0, ctx)
  const select = vi.mocked(SelectCell).mock.lastCall?.[1] as SelectCellProps
  const title = vi.mocked(TitleCell).mock.lastCall?.[1] as TitleCellProps
  return { store, state, ctx, select, title }
}

const click = (checked: boolean, shiftKey: boolean): MouseEvent =>
  ({ target: { checked }, shiftKey }) as unknown as MouseEvent

beforeEach(() => {
  h.notices.length = 0
})

describe('row checkbox', () => {
  it('shift-click with an anchor no longer listed selects this row, as the ticked box shows', () => {
    const t = makeTask({ title: 'T' })
    const r = row(t, [t])
    r.state.lastCheckedTaskId = 'gone'
    r.select.onClick(click(true, true))
    expect([...r.state.selectedTaskIds]).toEqual([t.id])
  })

  it('shift-unticking with a stale anchor leaves this row unselected, so a bulk delete skips it', () => {
    const t = makeTask({ title: 'T' })
    const r = row(t, [t])
    r.state.selectedTaskIds.add(t.id)
    r.state.lastCheckedTaskId = 'gone'
    r.select.onClick(click(false, true))
    expect(r.state.selectedTaskIds.size).toBe(0)
  })

  it('shift-click with a listed anchor still selects the range', () => {
    const [a, b, c] = ['A', 'B', 'C'].map((title) => makeTask({ title }))
    const r = row(c, [a, b, c])
    r.state.lastCheckedTaskId = a.id
    r.select.onClick(click(true, true))
    expect([...r.state.selectedTaskIds].sort()).toEqual([a.id, b.id, c.id].sort())
  })
})

describe('inline title edit', () => {
  it('an emptied title is not saved; the refresh puts the old one back', async () => {
    const r = row(makeTask({ title: 'Keep me' }), [])
    await r.title.onTitleSave('')
    expect(r.store.updateTask).not.toHaveBeenCalled()
    expect(r.ctx.onRefresh).toHaveBeenCalledOnce()
  })

  it('a title whose note name is taken is not saved, and says why', async () => {
    const taken = new TaskFileNameConflictError('Projects/Queue/Tasks/Other.md')
    const r = row(makeTask({ title: 'Mine' }), [], taken)
    await r.title.onTitleSave('Other')
    expect(r.store.updateTask).not.toHaveBeenCalled()
    expect(h.notices).toEqual(['Title not saved: a note named "Other" already exists.'])
    expect(r.ctx.onRefresh).toHaveBeenCalledOnce()
  })

  it('a free title is saved', async () => {
    const t = makeTask({ title: 'Mine' })
    const r = row(t, [])
    await r.title.onTitleSave('Renamed')
    expect(r.store.updateTask).toHaveBeenCalledWith(r.ctx.project, t.id, { title: 'Renamed' })
  })
})

describe('issue-type glyph', () => {
  it("hands the title cell the case's tags and title, the same input the board card gives it", () => {
    const t = makeTask({ title: '77 - SOC138 - Detected Suspicious Xls File', issueType: 'incident' })
    row(t, [t])
    const props = vi.mocked(TitleCell).mock.lastCall?.[1] as TitleCellProps
    expect(props.alert).toEqual({ tags: [], title: t.title, categories: DEFAULT_ALERT_CATEGORIES })
  })

  it('on a plain board hands no title, so no kind is derived where no Alert kind control exists', () => {
    const t = makeTask({
      title: '77 - SOC138 - Detected Suspicious Xls File',
      issueType: 'incident',
      tags: ['phishing']
    })
    row(t, [t], null, 'plain')
    const props = vi.mocked(TitleCell).mock.lastCall?.[1] as TitleCellProps
    expect(props.alert).toEqual({ tags: ['phishing'], title: '', categories: DEFAULT_ALERT_CATEGORIES })
  })
})
