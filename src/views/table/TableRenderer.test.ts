import type { App } from 'obsidian'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeApp } from '../../../test/fakeVault'
import type PMPlugin from '../../main'
import { ProjectStore } from '../../store/ProjectStore'
import { DEFAULT_SETTINGS, makeDefaultFilter, makeTask, type Project, type Task } from '../../types'
import { confirmDialog, openTaskModal } from '../../ui/ModalFactory'
import { handleTableKeyDown, refreshTableBody, type TableContext } from './TableRenderer'

// The stub carries no view or modal classes; the import chain only needs them to exist.
vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  function Stub(): void {}
  return new Proxy(real, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string]
      if (typeof prop !== 'string' || prop === 'then') return undefined
      return Stub
    },
    has: () => true
  })
})
vi.mock('../../ui/ModalFactory', () => ({
  openTaskModal: vi.fn<() => void>(),
  confirmDialog: vi.fn<() => Promise<boolean>>(() => Promise.resolve(false))
}))
vi.mock('../../ui/composites/addButton', () => ({ renderAddButton: vi.fn<() => void>() }))
vi.mock('./TableRow', () => ({
  renderTaskRow: vi.fn<() => void>(),
  updateSelectedRow: vi.fn<() => void>(),
  updateSelectAllCheckbox: vi.fn<() => void>()
}))

// Views have no DOM here: just enough element types for the instanceof checks,
// and a table body whose every method returns another stand-in.
class FakeElement {
  constructor(private readonly selector = '') {}
  closest(sel: string): FakeElement | null {
    return this.selector && sel.split(',').some((s) => s.trim() === this.selector) ? this : null
  }
}
function fakeEl(): HTMLElement {
  return new Proxy(
    { querySelector: (): null => null },
    {
      get: (t, prop) => {
        if (prop in t) return t[prop as keyof typeof t]
        if (prop === 'then' || prop === 'lastElementChild') return undefined
        return () => fakeEl()
      }
    }
  ) as unknown as HTMLElement
}

beforeEach(() => {
  vi.stubGlobal('HTMLElement', FakeElement)
  vi.stubGlobal('HTMLInputElement', class extends FakeElement {})
  vi.stubGlobal('HTMLTextAreaElement', class extends FakeElement {})
  vi.mocked(openTaskModal).mockClear()
  vi.mocked(confirmDialog).mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function table(
  titles: string[]
): Promise<{ ctx: TableContext; store: ProjectStore; project: Project; tasks: Task[] }> {
  const { app } = makeFakeApp()
  const settings = { ...DEFAULT_SETTINGS }
  const store = new ProjectStore(app as unknown as App, () => settings)
  const project = await store.createProject('Queue', 'Projects')
  const tasks: Task[] = []
  for (const title of titles) {
    const t = makeTask({ title })
    await store.insertTask(project, t)
    tasks.push(t)
  }
  const ctx = {
    container: fakeEl(),
    project,
    plugin: { store, settings, app } as unknown as PMPlugin,
    statuses: store.configFor(project).statuses,
    boardType: 'case',
    state: {
      sortKey: 'title',
      sortDir: 'asc',
      filter: makeDefaultFilter(),
      selectedTaskId: null,
      selectedTaskIds: new Set<string>(),
      lastCheckedTaskId: null,
      tableBody: fakeEl(),
      wrapper: null,
      visibleRows: [],
      rowHeight: 36,
      heightCalibrated: false,
      windowStart: -1,
      windowEnd: -1,
      renderWindow: null
    },
    onRefresh: () => Promise.resolve(),
    onSelectionChange: vi.fn<() => void>(),
    onBulkDelete: vi.fn<() => void>()
  } as unknown as TableContext
  refreshTableBody(ctx)
  return { ctx, store, project, tasks }
}

describe('table selection', () => {
  it('a task deleted elsewhere leaves the selection, so the bar counts live tasks', async () => {
    const { ctx, store, project, tasks } = await table(['A', 'B'])
    for (const t of tasks) ctx.state.selectedTaskIds.add(t.id)
    await store.deleteTask(project, tasks[0].id)
    refreshTableBody(ctx)
    expect([...ctx.state.selectedTaskIds]).toEqual([tasks[1].id])
  })

  it('a task the filter hides stays selected', async () => {
    const { ctx, tasks } = await table(['A', 'B'])
    ctx.state.selectedTaskIds.add(tasks[1].id)
    ctx.state.filter = { ...ctx.state.filter, text: 'A' }
    refreshTableBody(ctx)
    expect([...ctx.state.selectedTaskIds]).toEqual([tasks[1].id])
  })
})

describe('table row shortcuts', () => {
  const key = (k: string) =>
    ({ key: k, preventDefault: vi.fn<() => void>() }) as unknown as KeyboardEvent & {
      preventDefault: ReturnType<typeof vi.fn<() => void>>
    }

  it('leave Enter and Backspace to a focused button', async () => {
    const { ctx, tasks } = await table(['A'])
    ctx.state.selectedTaskId = tasks[0].id
    vi.stubGlobal('activeDocument', { activeElement: new FakeElement('button') })
    for (const k of ['Enter', 'Backspace', 'Delete']) {
      const e = key(k)
      handleTableKeyDown(e, ctx)
      expect(e.preventDefault).not.toHaveBeenCalled()
    }
    expect(openTaskModal).not.toHaveBeenCalled()
    expect(confirmDialog).not.toHaveBeenCalled()
  })

  it('leave them to a focused role=button control too', async () => {
    const { ctx, tasks } = await table(['A'])
    ctx.state.selectedTaskId = tasks[0].id
    vi.stubGlobal('activeDocument', { activeElement: new FakeElement('[role="button"]') })
    handleTableKeyDown(key('Enter'), ctx)
    expect(openTaskModal).not.toHaveBeenCalled()
  })

  it('still open the highlighted row on Enter when no control has focus', async () => {
    const { ctx, tasks } = await table(['A'])
    ctx.state.selectedTaskId = tasks[0].id
    vi.stubGlobal('activeDocument', { activeElement: new FakeElement() })
    const e = key('Enter')
    handleTableKeyDown(e, ctx)
    expect(e.preventDefault).toHaveBeenCalledOnce()
    expect(openTaskModal).toHaveBeenCalledOnce()
  })
})
