import type { App, WorkspaceLeaf } from 'obsidian'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent } from '../../test/fakeDom'
import { makeFakeApp } from '../../test/fakeVault'
import { diffTaskPatch, renderActivitySection, TaskDetailView } from './TaskDetailView'
import { DEFAULT_SETTINGS, makeTask } from '../types'
import type { Project, Task } from '../types'
import type PMPlugin from '../main'
import { ProjectStore } from '../store/ProjectStore'
import { findTaskById } from '../store/TaskIndex'
import { guardVerdictOnClose } from '../soc/verdictGuard'
import { applySubtaskChecked } from '../modals/SubtasksPanel'

// The aliased obsidian stub carries no view/modal base classes; this module's
// import chain (ModalFactory, TaskModal, …) only needs them to exist for
// `extends`, so bare stand-ins suffice.
vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  // Constructible AND callable stand-in (plain function, not class syntax).
  function Stub(): void {}
  // Proxy so ANY base class the chain extends (ItemView, Modal, SuggestModal,
  // AbstractInputSuggest, …) resolves to a bare stand-in instead of undefined.
  return new Proxy(real, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string]
      // 'then' must stay absent or the awaited factory result looks thenable.
      if (typeof prop !== 'string' || prop === 'then') return undefined
      return Stub
    },
    has: () => true
  })
})

vi.mock('../soc/verdictGuard', () => ({ guardVerdictOnClose: vi.fn<() => Promise<object>>(() => Promise.resolve({})) }))

const clone = (t: Task): Task => JSON.parse(JSON.stringify(t)) as Task

describe('diffTaskPatch', () => {
  it('sends only the fields the panel changed', () => {
    const snapshot = makeTask({ status: 'todo', description: 'before' })
    const working = clone(snapshot)
    working.description = 'after'
    const patch = diffTaskPatch(snapshot, working)
    expect(patch).toEqual({ description: 'after' })
  })

  it('never carries an untouched field, so a stale clone cannot revert edits made elsewhere', () => {
    // The board moved the live task to 'done' AFTER the panel cloned it: the
    // panel's working copy is stale at 'todo'. The old whole-clone patch sent
    // status:'todo' and reverted the board's edit; the diff must not.
    const snapshot = makeTask({ status: 'todo' })
    const working = clone(snapshot)
    working.description = 'typed in the panel'
    const patch = diffTaskPatch(snapshot, working)
    expect('status' in patch).toBe(false)
    expect('subtasks' in patch).toBe(false)
    expect('activity' in patch).toBe(false)
  })

  it('detects nested changes: subtasks and time logs', () => {
    const snapshot = makeTask({})
    const working = clone(snapshot)
    working.subtasks.push(makeTask({ title: 'child', type: 'subtask' }))
    working.timeLogs = [{ date: '2026-09-14', hours: 1, note: '' }]
    const patch = diffTaskPatch(snapshot, working)
    expect(Object.keys(patch).sort()).toEqual(['subtasks', 'timeLogs'])
  })

  it('a field cleared to undefined still lands in the patch', () => {
    const snapshot = makeTask({ timeEstimate: 4 })
    const working = clone(snapshot)
    working.timeEstimate = undefined
    const patch = diffTaskPatch(snapshot, working)
    expect('timeEstimate' in patch).toBe(true)
    expect(patch.timeEstimate).toBeUndefined()
  })

  it('identical clones diff to an empty patch (autosave becomes a no-op)', () => {
    const snapshot = makeTask({})
    expect(diffTaskPatch(snapshot, clone(snapshot))).toEqual({})
  })
})

describe('renderActivitySection', () => {
  const task = makeTask({
    activity: [{ at: '2026-09-26T10:00:00.000Z', field: 'iocs', from: '', to: 'http://evil.example/login' }]
  })
  const mount = (collapsed = true) => {
    const root = FakeEl.root()
    const state = { collapsed }
    renderActivitySection(root as unknown as HTMLElement, task, state)
    return { root, state, header: root.find('.pm-activity-header'), list: root.find('.pm-activity-list') }
  }

  it('prints an indicator defanged, as it shows everywhere else', () => {
    const text = mount().list.textContent
    expect(text).toContain('hxxp://evil[.]example/login')
    expect(text).not.toContain('http://evil.example')
  })

  it('the header is the one button: Enter or Space opens and closes the log', () => {
    const { header, list, state } = mount()
    const toggle = header.find('.pm-collapse-toggle')
    expect(header.getAttribute('role')).toBe('button')
    expect(header.getAttribute('tabindex')).toBe('0')
    expect(header.getAttribute('aria-expanded')).toBe('false')
    // One tab stop: the triangle inside is only a picture of the state.
    expect(toggle.hasAttribute('tabindex')).toBe(false)
    expect(toggle.getAttribute('aria-hidden')).toBe('true')

    const enter = fakeEvent('keydown', { key: 'Enter' })
    header.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
    expect(enter.propagationStopped).toBe(true)
    expect(state.collapsed).toBe(false)
    expect(list.hidden).toBe(false)
    expect(header.getAttribute('aria-expanded')).toBe('true')

    header.dispatchEvent(fakeEvent('keydown', { key: ' ' }))
    expect(list.hidden).toBe(true)
    expect(header.getAttribute('aria-expanded')).toBe('false')
  })

  it('a triangle click toggles once, and Shift+Enter is left to the modal save', () => {
    const { header, list } = mount()
    header.find('.pm-collapse-toggle').click()
    expect(list.hidden).toBe(false)
    const shiftEnter = fakeEvent('keydown', { key: 'Enter', shiftKey: true })
    header.dispatchEvent(shiftEnter)
    expect(shiftEnter.propagationStopped).toBe(false)
    expect(list.hidden).toBe(false)
  })
})

/** The panel's private surface these tests drive; render() is stubbed, as views have no DOM here. */
interface Panel {
  app: App
  projectPath: string
  taskId: string
  task: Task
  removedSubtaskIds: string[]
  render(): void
  loadTask(): Promise<void>
  scheduleSave(): void
  flushPendingSave(): Promise<void>
  persist(): Promise<void>
  onStatusChanged(task: Task): Promise<void>
}

async function setup(fields: Partial<Task> = {}, subtaskTitles: string[] = []) {
  const { app } = makeFakeApp()
  const store = new ProjectStore(app as unknown as App, () => DEFAULT_SETTINGS)
  const project = await store.createProject('Board', 'Projects')
  const task = makeTask({ title: 'Case', ...fields })
  await store.insertTask(project, task, null)
  for (const title of subtaskTitles) await store.insertTask(project, makeTask({ title, type: 'subtask' }), task.id)
  const plugin = { store, settings: DEFAULT_SETTINGS, refreshProjectViews: () => {} } as unknown as PMPlugin
  const panel = new TaskDetailView({} as WorkspaceLeaf, plugin) as unknown as Panel
  panel.app = app as unknown as App
  panel.render = () => {}
  panel.projectPath = project.filePath
  panel.taskId = task.id
  await panel.loadTask()
  const live = (id = task.id): Task => {
    const t = findTaskById(project, id)
    if (!t) throw new Error(`no task ${id}`)
    return t
  }
  const reload = async (): Promise<Project> => {
    const fresh = await new ProjectStore(app as unknown as App, () => DEFAULT_SETTINGS).loadAllProjects('Projects')
    return fresh[0]
  }
  /** The case as its note holds it, journal included. */
  const onDisk = async (): Promise<Task> => {
    const fresh = new ProjectStore(app as unknown as App, () => DEFAULT_SETTINGS)
    const t = (await fresh.loadAllProjects('Projects'))[0].tasks[0]
    await fresh.loadTaskBody(t)
    return t
  }
  return { store, project, panel, live, reload, onDisk }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('TaskDetailView saving', () => {
  it('an autosave while the verdict prompt is open does not write the close', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const { panel, live } = await setup({ issueType: 'incident', status: 'todo' })
    let answer: (v: object | null) => void = () => {}
    vi.mocked(guardVerdictOnClose).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))

    panel.task.description = 'typed just before closing'
    panel.scheduleSave()
    panel.task.status = 'done'
    const prompt = panel.onStatusChanged(panel.task)
    await vi.advanceTimersByTimeAsync(900)
    // The pending description saved; the close is still a question.
    expect(live().description).toBe('typed just before closing')
    expect(live().status).toBe('todo')
    expect(live().resolvedAt).toBe('')

    answer(null) // Cancel
    await prompt
    await panel.flushPendingSave()
    expect(live().status).toBe('todo')
    expect(live().activity.filter((a) => a.field === 'status')).toEqual([])
  })

  it('a flush saves an edit that scheduled nothing', async () => {
    const { panel, live } = await setup()
    panel.task.assignees.push('alice')
    await panel.flushPendingSave()
    expect(live().assignees).toEqual(['alice'])
  })

  it('the live task never shares the panel arrays: a second tick and an indicator removal both land', async () => {
    const { panel, live, reload } = await setup({}, ['A', 'B'])
    const [a, b] = panel.task.subtasks
    applySubtaskChecked(a, true, DEFAULT_SETTINGS.statuses)
    await panel.persist()
    applySubtaskChecked(b, true, DEFAULT_SETTINGS.statuses)
    await panel.persist()
    const onDisk = (await reload()).tasks[0].subtasks
    expect(onDisk.map((s) => s.status)).toEqual(['done', 'done'])

    panel.task.iocs.push({ type: 'ip', value: '203.0.113.9' })
    await panel.persist()
    panel.task.iocs.splice(0, 1)
    await panel.persist()
    expect(
      live()
        .activity.filter((e) => e.field === 'iocs')
        .map((e) => [e.from, e.to])
    ).toEqual([
      ['', '203.0.113.9'],
      ['203.0.113.9', '']
    ])
  })

  it('a subtask added in the panel keeps the key and note the store gave it', async () => {
    const { panel, live } = await setup()
    panel.task.subtasks.push(makeTask({ title: 'Added here', type: 'subtask' }))
    await panel.persist()
    const added = panel.task.subtasks[0]
    expect(added.filePath).toBe(live(added.id).filePath)
    expect(added.filePath).toMatch(/Added here\.md$/)
    applySubtaskChecked(added, true, DEFAULT_SETTINGS.statuses)
    await panel.persist()
    expect(live(added.id).status).toBe('done')
    expect(live(added.id).filePath).toBe(added.filePath)
  })

  it('a comment deleted while the previous autosave writes still reaches disk', async () => {
    const comments = ['first', 'second', 'third'].map((text) => ({ at: '2026-09-27 10:00', text }))
    const { panel, onDisk } = await setup({ comments })
    const del = (text: string) => (panel.task.comments = panel.task.comments?.filter((c) => c.text !== text))
    del('first')
    const writing = panel.persist()
    del('second') // the next delete is confirmed while that save writes
    await writing
    await panel.flushPendingSave()
    expect((await onDisk()).comments?.map((c) => c.text)).toEqual(['third'])
  })

  it('a subtask removed while the previous autosave writes is removed on disk too', async () => {
    const { panel, reload } = await setup({}, ['Sub A', 'Sub B'])
    const remove = (title: string) => {
      const sub = panel.task.subtasks.find((t) => t.title === title)
      panel.task.subtasks = panel.task.subtasks.filter((t) => t !== sub)
      if (sub) panel.removedSubtaskIds.push(sub.id)
    }
    remove('Sub A')
    const writing = panel.persist()
    remove('Sub B')
    await writing
    await panel.flushPendingSave()
    expect((await reload()).tasks[0].subtasks).toEqual([])
  })

  it('a board change to one subtask survives a panel edit of another', async () => {
    const { store, project, panel, live } = await setup({}, ['S1', 'S2'])
    const [s1, s2] = panel.task.subtasks
    await store.updateTask(project, s1.id, { status: 'done' })
    s2.title = 'S2 renamed'
    await panel.persist()
    expect(live(s1.id).status).toBe('done')
    expect(live(s1.id).activity.some((e) => e.field === 'status')).toBe(true)
    expect(live(s2.id).title).toBe('S2 renamed')
  })
})
