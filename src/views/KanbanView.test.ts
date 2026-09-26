import type { App } from 'obsidian'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeApp } from '../../test/fakeVault'
import type PMPlugin from '../main'
import { quarantineMarkup } from '../soc/alertIntake'
import { guardVerdictOnClose } from '../soc/verdictGuard'
import { ProjectStore } from '../store/ProjectStore'
import { findTaskById } from '../store/TaskIndex'
import {
  DEFAULT_SETTINGS,
  DEFAULT_STATUSES,
  makeDefaultFilter,
  makeTask,
  type PMSettings,
  type Project,
  type Task
} from '../types'
import { KanbanColumn, type KanbanColumnProps } from '../ui/composites/KanbanColumn'
import { KanbanView, laneCreatePatch } from './KanbanView'
import type { KanbanLaneGroup } from './kanbanLanes'
import type { SubView } from './SubView'

const h = vi.hoisted(() => ({ notices: [] as string[], undos: [] as (() => Promise<void>)[] }))

// vi.mock hoists above the imports. KanbanView's import chain pulls the whole
// console in; the pure helper under test needs none of it, so the view-layer
// siblings (and the stub-less Menu export) become bare stand-ins. Notice and
// the undo toast are captured so a drop's messages and its undo can be read.
vi.mock('obsidian', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Menu: vi.fn<() => void>(),
  Notice: class {
    constructor(message: unknown) {
      h.notices.push(String(message))
    }
    hide(): void {}
  }
}))
vi.mock('../ui/ModalFactory', () => ({ openTaskModal: vi.fn<() => void>() }))
vi.mock('../ui/TaskContextMenu', () => ({ buildTaskContextMenu: vi.fn<() => void>() }))
vi.mock('../ui/composites/KanbanColumn', () => ({ KanbanColumn: vi.fn<() => void>() }))
vi.mock('../ui/composites/KanbanCard', () => ({ setKanbanSocConfig: vi.fn<() => void>() }))
vi.mock('../soc/verdictGuard', () => ({ guardVerdictOnClose: vi.fn<() => Promise<Partial<Task> | null>>() }))
vi.mock('../ui/undoNotice', () => ({
  showUndoNotice: (_message: string, undo: () => Promise<void>) => h.undos.push(undo)
}))
vi.mock('../ui/motion', () => ({
  captureRects: vi.fn<() => void>(),
  markEnter: vi.fn<() => void>(),
  motionOK: (): boolean => false,
  playFlip: vi.fn<() => void>()
}))

// The board's inline create routes its makeTask overrides through this patch:
// before the fix no lane field was set, so a card created inside the 'High'
// severity lane (or a bucket lane) materialized in a different lane.
describe('laneCreatePatch', () => {
  it('sets the severity of a card created in a severity lane', () => {
    expect(laneCreatePatch('severity', 'sev1')).toEqual({ severity: 'sev1' })
  })

  it('leaves severity unset in the no-severity lane', () => {
    expect(laneCreatePatch('severity', '')).toEqual({})
  })

  it('sets the bucket of a card created in a bucket lane', () => {
    expect(laneCreatePatch('bucket', 'this-week')).toEqual({ bucket: 'this-week' })
  })

  it('keeps the default bucket in the no-bucket lane', () => {
    expect(laneCreatePatch('bucket', 'none')).toEqual({ bucket: 'none' })
  })

  it('assigns the lane assignee in an assignee lane', () => {
    expect(laneCreatePatch('assignee', '[[People/Jane Doe]]')).toEqual({ assignees: ['[[People/Jane Doe]]'] })
  })

  it('leaves assignees empty in the unassigned lane', () => {
    expect(laneCreatePatch('assignee', '')).toEqual({})
  })

  it('refuses the create affordance in a real epic lane (no faked parentage)', () => {
    expect(laneCreatePatch('epic', 'task-123')).toBeNull()
  })

  it('allows create in the no-epic lane', () => {
    expect(laneCreatePatch('epic', '')).toEqual({})
  })

  it('adds nothing when the board has no lanes', () => {
    expect(laneCreatePatch('none', 'all')).toEqual({})
  })
})

// ─── The view against a real store ─────────────────────────────────────────
// Views have no DOM here. The container is a stand-in whose every method
// returns another stand-in; the columns are captured instead of drawn.

function fakeEl(onEmpty: () => void = () => {}): HTMLElement {
  const target = {
    empty: onEmpty,
    querySelectorAll: (): unknown[] => [],
    querySelector: (): null => null
  }
  return new Proxy(target, {
    get: (t, prop) => {
      if (prop in t) return t[prop as keyof typeof t]
      if (prop === 'then') return undefined
      return () => fakeEl()
    }
  }) as unknown as HTMLElement
}

interface Board {
  view: KanbanView
  store: ProjectStore
  project: Project
  settings: PMSettings
  empties: () => number
  columns: () => KanbanColumnProps[]
}

async function board(
  tasks: Partial<Task>[],
  opts: { lanes?: KanbanLaneGroup; settings?: Partial<PMSettings> } = {}
): Promise<Board> {
  const settings: PMSettings = { ...(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as PMSettings), ...opts.settings }
  const { app } = makeFakeApp()
  const store = new ProjectStore(app as unknown as App, () => settings)
  const project = await store.createProject('Queue', 'Projects')
  for (const t of tasks) await store.insertTask(project, makeTask(t))
  const filter = makeDefaultFilter()
  if (opts.lanes) {
    settings.projectFilters[project.filePath] = { filter, activeSavedViewId: null, kanbanLane: opts.lanes }
  }
  const plugin = {
    store,
    settings,
    isKanbanColumnCollapsed: () => false,
    toggleKanbanColumnCollapsed: () => Promise.resolve(),
    saveSettings: () => Promise.resolve()
  } as unknown as PMPlugin
  let empties = 0
  const view = new KanbanView(
    fakeEl(() => empties++),
    project,
    plugin,
    () => Promise.resolve(),
    filter
  )
  return {
    view,
    store,
    project,
    settings,
    empties: () => empties,
    columns: () => vi.mocked(KanbanColumn).mock.calls.map((call) => call[1])
  }
}

const byTitle = (b: Board, title: string): Task => {
  const t = b.project.tasks.find((x) => x.title === title)
  if (!t) throw new Error(`no task ${title}`)
  return t
}

/** Drag `task` onto the `status` column of the lane holding `laneTitle` (or the only lane). */
async function drop(b: Board, task: Task, status: string, laneOf?: string): Promise<void> {
  const cols = b
    .columns()
    .filter((c) => c.status.id === status && (!laneOf || c.cards.some((card) => card.task.title === laneOf)))
  const col = cols[0]
  if (!col) throw new Error(`no ${status} column`)
  const neighbor = col.cards[0]?.task.id
  col.onCardDragStart(task)
  await col.onDrop(task.id, status, neighbor ? { targetId: neighbor, position: 'before' } : null)
}

beforeEach(() => {
  vi.mocked(KanbanColumn).mockClear()
  vi.mocked(guardVerdictOnClose).mockResolvedValue({})
  h.notices.length = 0
  h.undos.length = 0
})

describe('KanbanView drop undo', () => {
  it('undoing a drop into Done restores the stamps the close set, so the SLA clock runs again', async () => {
    const b = await board([{ title: 'Beacon', issueType: 'incident', severity: 'sev1' }])
    b.view.render()
    await drop(b, byTitle(b, 'Beacon'), 'done')
    const closed = byTitle(b, 'Beacon')
    expect(closed.status).toBe('done')
    expect(closed.resolvedAt).not.toBe('')

    await h.undos[0]()
    const reopened = findTaskById(b.project, closed.id)
    expect(reopened?.status).toBe('todo')
    expect(reopened?.resolvedAt).toBe('')
    expect(reopened?.respondedAt).toBe('')
    expect(reopened?.completed).toBe('')
  })

  it('undoing a drop also takes back the verdict the close guard recorded', async () => {
    vi.mocked(guardVerdictOnClose).mockResolvedValue({ verdict: 'true-positive' })
    const b = await board([{ title: 'Beacon', issueType: 'incident' }])
    b.view.render()
    await drop(b, byTitle(b, 'Beacon'), 'done')
    expect(byTitle(b, 'Beacon').verdict).toBe('true-positive')

    await h.undos[0]()
    expect(byTitle(b, 'Beacon').verdict).toBe('')
  })

  it('undoing a drop out of Done puts back the original completion date and resolution time', async () => {
    const b = await board([
      {
        title: 'Old',
        issueType: 'incident',
        status: 'done',
        completed: '2026-01-01',
        respondedAt: '2026-01-01T09:00:00.000Z',
        resolvedAt: '2026-01-01T10:00:00.000Z'
      }
    ])
    b.view.render()
    await drop(b, byTitle(b, 'Old'), 'todo')
    await h.undos[0]()
    const back = byTitle(b, 'Old')
    expect(back.status).toBe('done')
    expect(back.completed).toBe('2026-01-01')
    expect(back.resolvedAt).toBe('2026-01-01T10:00:00.000Z')
  })
})

describe('KanbanView swimlanes', () => {
  it('a drop into another lane keeps the status change, writes no lane field and skips the reorder', async () => {
    const b = await board(
      [
        { title: 'A', severity: 'sev1' },
        { title: 'C', severity: 'sev2', status: 'in-progress' }
      ],
      { lanes: 'severity' }
    )
    const reorder = vi.spyOn(b.store, 'reorderTask')
    b.view.render()
    await drop(b, byTitle(b, 'A'), 'in-progress', 'C')
    const a = byTitle(b, 'A')
    expect(a.status).toBe('in-progress')
    expect(a.severity).toBe('sev1')
    expect(reorder).not.toHaveBeenCalled()
    expect(h.notices).toContain("Lanes follow the task's severity — edit the task to move it")
  })

  it('a drop inside its own lane still reorders and says nothing about lanes', async () => {
    const b = await board(
      [
        { title: 'A', severity: 'sev1' },
        { title: 'B', severity: 'sev1', status: 'in-progress' }
      ],
      { lanes: 'severity' }
    )
    const reorder = vi.spyOn(b.store, 'reorderTask')
    b.view.render()
    await drop(b, byTitle(b, 'A'), 'in-progress', 'B')
    expect(reorder).toHaveBeenCalledOnce()
    expect(h.notices.some((n) => n.startsWith('Lanes follow'))).toBe(false)
  })

  it('checks the WIP limit against the whole status, not one lane', async () => {
    const statuses = DEFAULT_STATUSES.map((s) => (s.id === 'in-progress' ? { ...s, wipLimit: 3 } : s))
    const b = await board(
      [
        { title: 'A', severity: 'sev1', status: 'in-progress' },
        { title: 'B', severity: 'sev1', status: 'in-progress' },
        { title: 'C', severity: 'sev2', status: 'in-progress' },
        { title: 'D', severity: 'sev2', status: 'in-progress' },
        { title: 'Gone', severity: 'sev2', status: 'in-progress', archived: true }
      ],
      { lanes: 'severity', settings: { statuses } }
    )
    b.view.render()
    const inProgress = b.columns().filter((c) => c.status.id === 'in-progress')
    expect(inProgress.map((c) => c.cards.length)).toEqual([2, 2])
    expect(inProgress.map((c) => c.wipCount)).toEqual([4, 4])
  })
})

describe('KanbanView previews and lifecycle', () => {
  it('previews a hostile 120 KB description quickly, and a quarantined paste by the text after its fence', async () => {
    const quarantined = quarantineMarkup(`<img src=x>${'A'.repeat(5000)}`) + '\n\nTriage: escalated to IR'
    const b = await board(
      [
        { title: 'Brackets', description: '['.repeat(120_000) },
        { title: 'Links', description: '[]('.repeat(40_000) },
        { title: 'Paste', description: quarantined }
      ],
      { settings: { kanbanShowDescriptionPreview: true } }
    )
    const started = performance.now()
    b.view.render()
    expect(performance.now() - started).toBeLessThan(1000)
    const preview = (title: string) =>
      b
        .columns()
        .flatMap((c) => c.cards)
        .find((c) => c.task.title === title)?.descriptionPreview
    expect(preview('Brackets')).toBe('['.repeat(240))
    expect(preview('Paste')).toBe('Triage: escalated to IR')
  })

  it('a destroyed board does not repaint when a description load finishes late', async () => {
    const b = await board([{ title: 'Late' }], { settings: { kanbanShowDescriptionPreview: true } })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const load = vi.spyOn(b.store, 'loadTaskBody').mockImplementation(async (task: Task) => {
      await gate
      task.description = 'loaded body'
    })
    b.view.render()
    expect(b.empties()).toBe(1)
    ;(b.view as SubView).destroy?.()
    release()
    // The board's own wait on these loads was registered first, so its
    // continuation (the repaint) has run by the time this one does.
    await Promise.all(load.mock.results.map((r) => r.value as Promise<void>))
    await Promise.resolve()
    expect(b.empties()).toBe(1)
  })
})
