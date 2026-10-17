import type { App, Plugin, WorkspaceLeaf } from 'obsidian'
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
import { today } from '../dates'

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
  persistTitle(input: { value: string }): Promise<void>
  syncExternal(): Promise<void>
  followFile(file: { path: string } | null): Promise<void>
  fitToFront(leaf: unknown): void
  onResize(): void
  leaf: { setViewState(state: unknown): Promise<void> }
  contentEl: { isConnected: boolean }
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
  panel.contentEl = { isConnected: true }
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
  /** The case changed by someone else: another store's save, as typing in the note or Sync would. */
  const editElsewhere = async (patch: Partial<Task>): Promise<void> => {
    store.registerCacheInvalidation({ registerEvent: () => {} } as unknown as Plugin)
    // The markers of this store's own earlier writes, as the panel's 'changed' handler takes them up.
    for (const path of [project.filePath, live().filePath ?? '']) store.consumeSelfWrite(path)
    const other = new ProjectStore(app as unknown as App, () => DEFAULT_SETTINGS)
    const [board] = await other.loadAllProjects('Projects')
    await other.loadTaskBody(board.tasks[0])
    await other.updateTask(board, board.tasks[0].id, patch)
  }
  return { store, project, panel, live, reload, onDisk, editElsewhere }
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

  it('a Done pick shows 100 and the completion date at once, so its save redraws nothing', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const { panel, live } = await setup({ status: 'todo', progress: 25 })
    const drawn: [number, string][] = []
    panel.render = () => drawn.push([panel.task.progress, panel.task.completed])
    panel.task.status = 'done'
    await panel.onStatusChanged(panel.task)
    expect(drawn).toEqual([[100, today().toString()]])
    // The save stamps nothing the pick did not already show: a redraw would
    // close an editor under the caret of whatever is typed next.
    await vi.advanceTimersByTimeAsync(900)
    expect(live()).toMatchObject({ progress: 100, completed: today().toString() })
    expect(drawn).toHaveLength(1)
    // Reopened before a save: the date goes again, as the store would clear it.
    panel.task.status = 'in-progress'
    await panel.onStatusChanged(panel.task)
    expect(drawn.at(-1)).toEqual([100, ''])
  })

  it('a slider dragged back after a Done pick is what saves', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const { panel, live } = await setup({ status: 'todo', progress: 25 })
    panel.task.status = 'done'
    await panel.onStatusChanged(panel.task)
    expect(panel.task.progress).toBe(100)
    panel.task.progress = 25
    await panel.flushPendingSave()
    expect(live().status).toBe('done')
    expect(live().progress).toBe(25)
  })

  it('a Done pick undone before its save goes out saves the old progress', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const { panel, live } = await setup({ status: 'todo', progress: 25 })
    panel.task.status = 'done'
    await panel.onStatusChanged(panel.task)
    panel.task.status = 'in-progress'
    await panel.onStatusChanged(panel.task)
    await vi.advanceTimersByTimeAsync(900)
    expect(live().status).toBe('in-progress')
    expect(live().progress).toBe(25)
  })

  it('a title no file name can hold is put back, so later edits still save', async () => {
    const { panel, live } = await setup()
    const input = { value: '...' }
    panel.task.title = '...'
    await panel.persistTitle(input)
    expect(input.value).toBe('Case')
    panel.task.description = 'evidence'
    await panel.flushPendingSave()
    expect(live().description).toBe('evidence')
  })
})

describe('TaskDetailView outside changes', () => {
  it('a change made in the note shows in the panel, and the next panel save keeps it', async () => {
    const { panel, editElsewhere, onDisk } = await setup({ issueType: 'incident' })
    const render = vi.fn<() => void>()
    panel.render = render
    await editElsewhere({ description: 'At 11:05:40, the user ran PowerShell', severity: 'sev1' })
    await panel.syncExternal()
    expect(panel.task.description).toBe('At 11:05:40, the user ran PowerShell')
    expect(panel.task.severity).toBe('sev1')
    expect(render).toHaveBeenCalledOnce()

    panel.task.details = [{ field: 'User', value: 'anita.garcia' }]
    await panel.flushPendingSave()
    const disk = await onDisk()
    expect(disk.description).toBe('At 11:05:40, the user ran PowerShell')
    expect(disk.details).toEqual([{ field: 'User', value: 'anita.garcia' }])
  })

  it('a field the panel has changed keeps the panel value; the others take the note', async () => {
    const { panel, editElsewhere, onDisk } = await setup()
    panel.task.description = 'typed in the panel'
    await editElsewhere({ description: 'typed in the note', tags: ['malware'] })
    await panel.syncExternal()
    expect(panel.task.description).toBe('typed in the panel')
    expect(panel.task.tags).toEqual(['malware'])
    await panel.flushPendingSave()
    const disk = await onDisk()
    expect(disk.description).toBe('typed in the panel')
    expect(disk.tags).toEqual(['malware'])
  })

  it("the panel's own save reads back as no change, so nothing redraws under the caret", async () => {
    vi.stubGlobal('window', globalThis)
    const { panel } = await setup({ issueType: 'incident' })
    panel.task.description = 'Scenario\n\n| User | anita.garcia |\n| --- | --- |\n'
    panel.task.details = [{ field: 'IP', value: '10.0.1.135' }]
    panel.task.iocs.push({ type: 'domain', value: 'promptcraft.online', note: 'payload' })
    panel.task.status = 'in-progress'
    await panel.onStatusChanged(panel.task)
    await panel.flushPendingSave()
    const render = vi.fn<() => void>()
    panel.render = render
    await panel.syncExternal()
    expect(render).not.toHaveBeenCalled()
  })

  it('a list both sides changed is merged and the merge saved', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const { panel, editElsewhere, onDisk } = await setup({ tags: ['triage'] })
    panel.task.tags.push('phish')
    await editElsewhere({ tags: ['triage', 'malware'] })
    await panel.syncExternal()
    expect(panel.task.tags).toEqual(['triage', 'phish', 'malware'])
    await vi.advanceTimersByTimeAsync(900)
    expect((await onDisk()).tags).toEqual(['triage', 'phish', 'malware'])
  })

  it('a row removed on the other side goes; one the panel removed stays gone', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const { panel, editElsewhere, onDisk } = await setup({ tags: ['a', 'b', 'c'] })
    panel.task.tags = ['a', 'c', 'mine']
    await editElsewhere({ tags: ['b', 'c'] })
    await panel.syncExternal()
    expect(panel.task.tags).toEqual(['c', 'mine'])
    await vi.advanceTimersByTimeAsync(900)
    expect((await onDisk()).tags).toEqual(['c', 'mine'])
  })

  it('waits while a panel save is pending, then takes the change in', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const { panel, editElsewhere } = await setup()
    panel.task.assignees.push('alice')
    panel.scheduleSave()
    await editElsewhere({ tags: ['phish'] })
    await panel.syncExternal()
    expect(panel.task.tags).toEqual([])
    await vi.advanceTimersByTimeAsync(1500)
    expect(panel.task.tags).toEqual(['phish'])
    expect(panel.task.assignees).toEqual(['alice'])
  })
})

describe('TaskDetailView follows the case note in front', () => {
  async function following() {
    const ctx = await setup()
    const second = makeTask({ title: 'Second case' })
    await ctx.store.insertTask(ctx.project, second, null)
    const shown: unknown[] = []
    ctx.panel.leaf = {
      setViewState: (state) => {
        shown.push(state)
        return Promise.resolve()
      }
    }
    // The cache as Obsidian has it: case notes carry the marker and their id.
    const notes = new Map<string, Record<string, unknown>>([
      [ctx.panel.task.filePath ?? '', { 'pm-task': true, id: ctx.panel.task.id }],
      [second.filePath ?? '', { 'pm-task': true, id: second.id }],
      ['Notes/plain.md', { tags: ['reading'] }],
      ['Copies/copy.md', { 'pm-task': true, id: second.id }]
    ])
    const app = ctx.panel.app as unknown as { metadataCache: { getFileCache: (f: { path: string }) => unknown } }
    app.metadataCache.getFileCache = (f) => ({ frontmatter: notes.get(f.path) })
    return { ...ctx, second, shown }
  }

  it('shows the case whose note comes to the front', async () => {
    const { panel, project, second, shown } = await following()
    await panel.followFile({ path: second.filePath ?? '' })
    expect(shown).toEqual([
      { type: 'casefile-task-detail', state: { projectPath: project.filePath, taskId: second.id }, active: false }
    ])
  })

  it('leaves the panel alone for its own case, another note, no note, or a copy carrying a case id', async () => {
    const { panel, shown } = await following()
    await panel.followFile({ path: panel.task.filePath ?? '' })
    await panel.followFile({ path: 'Notes/plain.md' })
    await panel.followFile(null)
    await panel.followFile({ path: 'Copies/copy.md' })
    expect(shown).toEqual([])
  })

  it('switching notes quickly follows the last one only', async () => {
    const { panel, second, shown } = await following()
    const first = panel.followFile({ path: second.filePath ?? '' })
    const last = panel.followFile({ path: 'Notes/plain.md' })
    const again = panel.followFile({ path: second.filePath ?? '' })
    await Promise.all([first, last, again])
    expect(shown).toHaveLength(1)
  })
})

describe('TaskDetailView shuts its sidebar when a board comes to the front', () => {
  type Tab = {
    getRoot: () => object
    parent: object
    view: {
      getViewType: () => string
      file: { path: string } | null
      containerEl: { isShown: () => boolean }
      leaf?: Tab
    }
  }
  async function docked(settings: Partial<typeof DEFAULT_SETTINGS> = {}) {
    const ctx = await setup()
    const rootSplit = {}
    const rightSplit = { collapsed: false, collapse: vi.fn<() => void>(), expand: vi.fn<() => void>() }
    rightSplit.collapse.mockImplementation(() => void (rightSplit.collapsed = true))
    rightSplit.expand.mockImplementation(() => void (rightSplit.collapsed = false))
    const group = {}
    const view = (type: string, path?: string) => ({
      getViewType: () => type,
      file: path ? { path } : null,
      containerEl: { isShown: () => false }
    })
    const tab = (v: Tab['view'], parent = group): Tab => {
      const t: Tab = { getRoot: () => rootSplit, parent, view: v }
      v.leaf = t
      return t
    }
    const casePath = ctx.panel.task.filePath ?? ''
    const note = tab(view('markdown', casePath))
    const plain = tab(view('markdown', 'Notes/plain.md'))
    const board = tab(view('casefile-project'))
    const boards = tab(view('casefile-dashboard'))
    const open = [note, plain, board, boards]
    // The tab in front of the main pane, as Obsidian's getMostRecentLeaf(rootSplit) gives it.
    let inFront: Tab = note
    const handlers = new Map<string, (leaf?: unknown) => void>()
    const panel = ctx.panel as Panel & Record<string, unknown>
    panel.plugin = { ...(panel.plugin as object), settings: { ...DEFAULT_SETTINGS, ...settings } }
    panel.leaf = { ...ctx.panel.leaf, getRoot: () => rightSplit } as Panel['leaf']
    panel.containerEl = { isShown: () => !rightSplit.collapsed }
    panel.registerEvent = () => {}
    panel.registerDomEvent = () => {}
    const app = panel.app as unknown as Record<string, Record<string, unknown>>
    app.workspace = {
      rootSplit,
      rightSplit,
      leftSplit: {},
      // The main pane's newest tab, or a tab group's newest shown one.
      getMostRecentLeaf: (root: unknown) =>
        root === rootSplit
          ? inFront
          : (open.find((l) => l.parent === root && l === inFront) ??
            open.find((l) => l.parent === root && l.view.containerEl.isShown()) ??
            null),
      getLeavesOfType: (type: string) => open.filter((l) => l.view.getViewType() === type),
      iterateRootLeaves: (fn: (l: Tab) => void) => open.forEach(fn),
      on: (name: string, fn: (leaf?: unknown) => void) => void handlers.set(name, fn)
    }
    app.vault.on = () => ({})
    app.metadataCache.on = () => ({})
    const notes = new Map<string, Record<string, unknown>>([
      [casePath, { 'pm-task': true, id: ctx.panel.task.id }],
      ['Notes/plain.md', { tags: ['reading'] }]
    ])
    app.metadataCache.getFileCache = (f: { path: string }) => ({ frontmatter: notes.get(f.path) })
    /** A tab brought to the front by a click on it: only that tab is shown in its group, unless stacked. */
    let stacked = false
    const stack = () => void (stacked = true)
    const show = (t: Tab) => {
      inFront = t
      for (const l of open) if (l.parent === t.parent) l.view.containerEl.isShown = () => stacked || l === t
      handlers.get('active-leaf-change')?.(t)
    }
    /** The layout changed with no leaf made active: a tab closed, a view loaded into the tab in front. */
    const relayout = (t: Tab, closed?: Tab) => {
      if (closed) {
        open.splice(open.indexOf(closed), 1)
        closed.view.containerEl.isShown = () => false // detached: out of the page
      }
      for (const l of open) if (l.parent === t.parent) l.view.containerEl.isShown = () => stacked || l === t
      handlers.get('layout-change')?.()
    }
    /** Obsidian's workspace 'resize', fired once a sidebar has opened or shut, whichever tab it shows. */
    const resized = () => handlers.get('resize')?.()
    // Open as note: the case note in front, the board behind it.
    note.view.containerEl.isShown = () => true
    await (panel as unknown as { onOpen(): Promise<void> }).onOpen()
    return {
      ...ctx,
      panel,
      rightSplit,
      casePath,
      note,
      plain,
      board,
      boards,
      open,
      view,
      tab,
      show,
      relayout,
      stack,
      resized,
      handlers
    }
  }

  it('the board or the boards list in front shuts the sidebar; the case note back in front opens it', async () => {
    const { rightSplit, note, board, boards, show } = await docked()
    show(board)
    expect(rightSplit.collapsed).toBe(true)
    show(note)
    expect(rightSplit.collapsed).toBe(false)
    show(boards)
    expect(rightSplit.collapsed).toBe(true)
  })

  it('opened from the board, or opened again by hand there, a click back into the board leaves it open', async () => {
    const ctx = await docked()
    ctx.show(ctx.board)
    ctx.rightSplit.expand() // by hand, or Open in sidebar from the card menu
    ctx.resized()
    ctx.show(ctx.board)
    expect(ctx.rightSplit.collapsed).toBe(false)
  })

  it('closing the case note tab, with the panel in use, shuts it for the board left in front', async () => {
    const { rightSplit, note, board, relayout } = await docked()
    relayout(board, note)
    expect(rightSplit.collapsed).toBe(true)
  })

  it('in a split main pane, the board left where the closed case note was is what counts', async () => {
    const { rightSplit, note, board, open, tab, view, relayout, ...ctx } = await docked()
    const other = tab(view('markdown', 'Notes/other.md'), {})
    other.view.containerEl.isShown = () => true
    open.push(other)
    ctx.show(note) // the case note in front on the left; the other pane was clicked in more recently
    const app = ctx.panel.app as unknown as {
      workspace: { rootSplit: object; getMostRecentLeaf: (root: unknown) => Tab | null }
    }
    const byGroup = app.workspace.getMostRecentLeaf
    app.workspace.getMostRecentLeaf = (root) => (root === app.workspace.rootSplit ? other : byGroup(root))
    relayout(board, note)
    expect(rightSplit.collapsed).toBe(true)
  })

  it('a board loaded into the tab in front shuts it, with no tab change', async () => {
    const { rightSplit, plain, view, show, relayout } = await docked()
    show(plain)
    plain.view = view('casefile-dashboard') // Open boards pane into this tab, or Open current file as a board
    plain.view.leaf = plain
    relayout(plain)
    expect(rightSplit.collapsed).toBe(true)
  })

  it('a case note opened in place in the tab in front opens it again', async () => {
    const { rightSplit, plain, board, casePath, show } = await docked()
    show(board)
    show(plain)
    expect(rightSplit.collapsed).toBe(true)
    plain.view.file = { path: casePath } // a link to the case clicked in the plain note: the same view loads it
    show(plain)
    expect(rightSplit.collapsed).toBe(false)
  })

  it('another note in front neither shuts nor opens it', async () => {
    const { rightSplit, plain, board, show } = await docked()
    show(plain)
    expect(rightSplit.collapse).not.toHaveBeenCalled()
    show(board)
    show(plain)
    expect(rightSplit.collapsed).toBe(true)
  })

  it('a sidebar shut by hand stays shut when the case note comes to the front', async () => {
    const { rightSplit, note, plain, show } = await docked()
    rightSplit.collapse()
    show(plain)
    show(note)
    expect(rightSplit.expand).not.toHaveBeenCalled()
  })

  it('opened again on the board, even onto another sidebar tab, then shut by hand: it stays shut for the case note', async () => {
    const { panel, rightSplit, note, board, show, resized } = await docked()
    show(board)
    panel.containerEl = { isShown: () => false } // Open case timeline: the sidebar opens on its tab
    rightSplit.expand()
    resized()
    rightSplit.collapse()
    show(note)
    expect(rightSplit.expand).toHaveBeenCalledTimes(1)
  })

  it('leaves it open while a case note shows in another pane beside the board', async () => {
    const { rightSplit, board, open, tab, view, casePath, show } = await docked()
    const beside = tab(view('markdown', casePath), {})
    beside.view.containerEl.isShown = () => true
    open.push(beside)
    show(board)
    expect(rightSplit.collapse).not.toHaveBeenCalled()
  })

  it('a case note stacked under the board in its own tab group does not keep it open', async () => {
    const { rightSplit, board, show, stack } = await docked()
    stack() // Stack tabs: every tab in the group stays displayed, the case note too
    show(board)
    expect(rightSplit.collapsed).toBe(true)
  })

  it('a case note moved into the sidebar beside the panel keeps it open', async () => {
    const { rightSplit, board, open, tab, view, casePath, show } = await docked()
    const inSidebar = tab(view('markdown', casePath), {})
    inSidebar.getRoot = () => rightSplit
    inSidebar.view.containerEl.isShown = () => true
    open.push(inSidebar)
    show(board)
    expect(rightSplit.collapse).not.toHaveBeenCalled()
  })

  it('docking the panel in the sidebar with a board already in front does not shut it on the drop', async () => {
    const { panel, rightSplit, board, show, relayout } = await docked()
    const app = panel.app as unknown as { workspace: { rootSplit: object } }
    const docked_ = panel.leaf
    panel.leaf = { ...docked_, getRoot: () => app.workspace.rootSplit } as Panel['leaf']
    show(board) // the panel sits in the main pane while the board comes to the front
    panel.leaf = docked_
    relayout(board)
    expect(rightSplit.collapse).not.toHaveBeenCalled()
  })

  it('opened in the main pane and docked later, it takes the board already in front as found', async () => {
    const { panel, rightSplit, note, board, relayout } = await docked()
    const app = panel.app as unknown as { workspace: { rootSplit: object; getMostRecentLeaf: () => unknown } }
    // One leaf, dragged from the main pane into the sidebar: only its root changes.
    let root: object = app.workspace.rootSplit
    const leaf = { ...panel.leaf, getRoot: () => root } as Panel['leaf']
    panel.leaf = leaf
    app.workspace.getMostRecentLeaf = () => (root === app.workspace.rootSplit ? leaf : board)
    await (panel as unknown as { onOpen(): Promise<void> }).onOpen() // restored with the panel in front
    relayout(board, note) // the board comes up while nothing is recorded for it
    root = rightSplit
    relayout(board) // dropped into the open sidebar
    expect(rightSplit.collapse).not.toHaveBeenCalled()
  })

  it('the panel itself in the main pane is never taken for what is in front', async () => {
    const { panel, rightSplit, board, show, relayout, resized } = await docked()
    show(board)
    rightSplit.expand()
    resized()
    const app = panel.app as unknown as { workspace: { rootSplit: object } }
    const inSidebar = panel.leaf
    panel.leaf = { ...inSidebar, getRoot: () => app.workspace.rootSplit } as Panel['leaf']
    panel.fitToFront(panel.leaf) // dragged into the main pane and clicked there
    panel.leaf = inSidebar
    relayout(board) // docked again, the board still in front
    expect(rightSplit.collapse).toHaveBeenCalledTimes(1)
  })

  it("in a stacked group, the case note in front is what counts, not the group's first tab", async () => {
    const { rightSplit, note, board, open, show, stack, handlers, panel } = await docked()
    open.splice(open.indexOf(board), 1)
    open.unshift(board) // the board is the group's first tab
    stack()
    show(board)
    expect(rightSplit.collapsed).toBe(true)
    show(note)
    expect(rightSplit.collapsed).toBe(false)
    handlers.get('layout-change')?.() // any layout change, or a click into the panel
    handlers.get('active-leaf-change')?.(panel.leaf)
    expect(rightSplit.collapse).toHaveBeenCalledTimes(1)
  })

  it('in a stacked group, closing the case note in front goes by the tab the group shows next', async () => {
    const { rightSplit, note, board, open, tab, view, casePath, show, stack, relayout } = await docked()
    stack()
    const second = tab(view('markdown', casePath)) // a second case note, opened after the board
    open.splice(open.indexOf(board), 1)
    open.unshift(board, second) // [board, second, note]: the board newest after the close
    show(board)
    show(second)
    expect(rightSplit.collapsed).toBe(false)
    const group = board.parent as { children?: unknown[]; currentTab?: number }
    group.children = [board, note]
    group.currentTab = 1 // Obsidian moves to the case note beside the closed tab
    relayout(note, second)
    expect(rightSplit.collapse).toHaveBeenCalledTimes(1)
  })

  it('a case note dragged into another pane is looked for there when it closes', async () => {
    const { rightSplit, note, plain, board, open, show, relayout, handlers } = await docked()
    const right = {}
    plain.parent = right
    show(plain)
    show(note)
    note.parent = right // dragged onto the right pane, in front there
    board.view.containerEl.isShown = () => true // the left pane shows the board again
    handlers.get('layout-change')?.()
    relayout(plain, note) // closed: the right pane shows the plain note, not a board
    expect([open.includes(note), rightSplit.collapse.mock.calls.length]).toEqual([false, 0])
  })

  it('leaves it alone when boards open cases in the side panel', async () => {
    const { rightSplit, board, show } = await docked({ openTaskIn: 'panel' })
    show(board)
    expect(rightSplit.collapse).not.toHaveBeenCalled()
  })

  it('leaves it alone when it shows another tab, or the panel sits in the main pane', async () => {
    const { panel, rightSplit, board, boards, show } = await docked()
    panel.containerEl = { isShown: () => false }
    show(board)
    panel.containerEl = { isShown: () => true }
    const app = panel.app as unknown as { workspace: { rootSplit: object } }
    panel.leaf = { ...panel.leaf, getRoot: () => app.workspace.rootSplit } as Panel['leaf']
    show(boards)
    expect(rightSplit.collapse).not.toHaveBeenCalled()
  })

  it('a sidebar tab or another window coming to the front changes nothing', async () => {
    const { panel, rightSplit, tab, view } = await docked()
    const inSidebar = tab(view('casefile-project'))
    inSidebar.getRoot = () => rightSplit
    const inPopout = tab(view('casefile-dashboard'))
    inPopout.getRoot = () => ({})
    panel.fitToFront(inSidebar)
    panel.fitToFront(inPopout)
    panel.fitToFront(null)
    expect(rightSplit.collapse).not.toHaveBeenCalled()
  })
})
