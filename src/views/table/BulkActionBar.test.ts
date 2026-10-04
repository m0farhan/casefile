import type { App } from 'obsidian'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeApp } from '../../../test/fakeVault'
import type PMPlugin from '../../main'
import { ProjectStore } from '../../store/ProjectStore'
import { findTaskById } from '../../store/TaskIndex'
import { DEFAULT_SETTINGS, makeTask, type PMSettings, type Project, type Task } from '../../types'
import { runBulkPatch } from './BulkActionBar'
import type { TableContext } from './TableRenderer'

const h = vi.hoisted(() => {
  const guard: { result: Record<string, unknown> | null; calls: unknown[][] } = { result: {}, calls: [] }
  return { notices: [] as string[], undos: [] as (() => Promise<void>)[], guard }
})

// The stub carries no component or modal classes; the bar's import chain only
// needs them to exist. Notice is captured so the count it states can be read.
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
vi.mock('../../ui/undoNotice', () => ({
  showUndoNotice: (_message: string, undo: () => Promise<void>) => h.undos.push(undo)
}))
vi.mock('../../soc/verdictGuard', () => ({
  guardVerdictOnClose: (...args: unknown[]) => {
    h.guard.calls.push(args)
    return Promise.resolve(h.guard.result)
  }
}))

const SETTINGS: PMSettings = { ...DEFAULT_SETTINGS }

async function setup(tasks: Partial<Task>[]): Promise<{ ctx: TableContext; project: Project; ids: string[] }> {
  const { app } = makeFakeApp()
  const store = new ProjectStore(app as unknown as App, () => SETTINGS)
  const project = await store.createProject('Queue', 'Projects')
  const ids: string[] = []
  for (const t of tasks) {
    const task = makeTask(t)
    await store.insertTask(project, task)
    ids.push(task.id)
  }
  const ctx = {
    project,
    plugin: { store, app, settings: SETTINGS } as unknown as PMPlugin,
    statuses: store.configFor(project).statuses,
    boardType: store.configFor(project).boardType,
    state: { selectedTaskIds: new Set(ids) },
    onRefresh: () => Promise.resolve()
  } as unknown as TableContext
  return { ctx, project, ids }
}

const live = (project: Project, id: string): Task => {
  const t = findTaskById(project, id)
  if (!t) throw new Error(`no task ${id}`)
  return t
}

beforeEach(() => {
  h.notices.length = 0
  h.undos.length = 0
  h.guard.result = {}
  h.guard.calls.length = 0
})

describe('runBulkPatch undo', () => {
  it('undoing a bulk close restores the response and resolution stamps, so the SLA clock runs again', async () => {
    const { ctx, project, ids } = await setup([{ title: 'Beacon', issueType: 'incident', severity: 'sev1' }])
    await runBulkPatch(ctx, { status: 'done' })
    const closed = live(project, ids[0])
    expect(closed.resolvedAt).not.toBe('')
    expect(closed.respondedAt).not.toBe('')

    await h.undos[0]()
    const reopened = live(project, ids[0])
    expect(reopened.status).toBe('todo')
    expect(reopened.resolvedAt).toBe('')
    expect(reopened.respondedAt).toBe('')
    expect(reopened.completed).toBe('')
  })

  it('undoing a bulk close puts back the progress the close filled to 100', async () => {
    const { ctx, project, ids } = await setup([{ title: 'Beacon', progress: 25 }])
    await runBulkPatch(ctx, { status: 'done' })
    expect(live(project, ids[0]).progress).toBe(100)

    await h.undos[0]()
    expect(live(project, ids[0]).progress).toBe(25)
  })

  it('undoing a bulk reopen puts back the original completion date, not today', async () => {
    const { ctx, project, ids } = await setup([{ title: 'Old', status: 'done', completed: '2026-01-01' }])
    await runBulkPatch(ctx, { status: 'todo' })
    expect(live(project, ids[0]).completed).toBe('')

    await h.undos[0]()
    expect(live(project, ids[0]).status).toBe('done')
    expect(live(project, ids[0]).completed).toBe('2026-01-01')
  })
})

describe('runBulkPatch verdicts', () => {
  it('records a verdict on the selected incidents only, and counts only those', async () => {
    const { ctx, project, ids } = await setup([
      { title: 'Case', issueType: 'incident' },
      { title: 'Chore', issueType: 'task' }
    ])
    await runBulkPatch(ctx, { verdict: 'true-positive' })
    expect(live(project, ids[0]).verdict).toBe('true-positive')
    expect(live(project, ids[1]).verdict).toBe('')

    await h.undos[0]()
    expect(live(project, ids[0]).verdict).toBe('')
  })

  it('says so when no incident is selected, and writes nothing', async () => {
    const { ctx, project, ids } = await setup([{ title: 'Chore', issueType: 'task' }])
    await runBulkPatch(ctx, { verdict: 'true-positive' })
    expect(live(project, ids[0]).verdict).toBe('')
    expect(h.undos).toHaveLength(0)
    expect(h.notices).toEqual(['No incidents selected: a verdict is recorded on incidents only'])
  })

  it('asks the verdict guard once, telling it how many incidents the answer covers', async () => {
    const { ctx, project, ids } = await setup([
      { title: 'A', issueType: 'incident' },
      { title: 'B', issueType: 'incident' },
      { title: 'C', issueType: 'incident', verdict: 'false-positive' }
    ])
    h.guard.result = { verdict: 'true-positive' }
    await runBulkPatch(ctx, { status: 'done' })
    expect(h.guard.calls).toHaveLength(1)
    expect(h.guard.calls[0][4]).toBe(2)
    expect(ids.map((id) => live(project, id).verdict)).toEqual(['true-positive', 'true-positive', 'false-positive'])
  })
})
