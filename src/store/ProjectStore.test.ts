import type { App } from 'obsidian'
import { TFile, TFolder } from 'obsidian'
import { describe, expect, it, vi } from 'vitest'
import { makeFakeApp, type FakeVault } from '../../test/fakeVault'
import { DEFAULT_SETTINGS, makeTask, type PMSettings, type Project, type StatusConfig, type Task } from '../types'
import { ProjectStore } from './ProjectStore'
import { buildTaskIndex } from './TaskIndex'
import { findTask, flattenTasks } from './TaskTreeOps'

const expectDefined = <T>(value: T | null | undefined, message = 'expected value to be defined'): T => {
  if (value == null) throw new Error(message)
  return value
}

const STATUSES: StatusConfig[] = [
  { id: 'todo', label: 'Todo', color: '#888', icon: 'circle', complete: false },
  { id: 'in-progress', label: 'In progress', color: '#88f', icon: 'loader', complete: false },
  { id: 'done', label: 'Done', color: '#0a0', icon: 'check', complete: true }
]

const SETTINGS: PMSettings = { ...DEFAULT_SETTINGS, statuses: STATUSES }

function newStore(): { store: ProjectStore; vault: FakeVault; app: App } {
  const { app, vault } = makeFakeApp()
  const store = new ProjectStore(app as unknown as App, () => SETTINGS)
  return { store, vault, app: app as unknown as App }
}

async function addNamed(
  store: ProjectStore,
  project: Parameters<ProjectStore['insertTask']>[0],
  title: string,
  parentId: string | null = null
): Promise<Task> {
  const task = makeTask({ title })
  await store.insertTask(project, task, parentId)
  return task
}

describe('ProjectStore self-write tracking', () => {
  it('marks the project file as self-written after save', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Self', 'Projects')
    expect(store.consumeSelfWrite(project.filePath)).toBe(true) // creates mark too (cache invalidation peeks them)

    await store.updateTask(project, 'nope', {}) // no-op (id not found)
    // Project file is rewritten on every saveProject, which marks it.
    expect(store.consumeSelfWrite(project.filePath)).toBe(true)
    expect(vault.modifyCount.get(project.filePath)).toBe(1)
  })

  it('marks task file paths as self-written when modified', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('T', 'Projects')
    const task = await addNamed(store, project, 'Solo')
    vault.resetCounts()

    await store.updateTask(project, task.id, { status: 'in-progress' })

    expect(store.consumeSelfWrite(expectDefined(task.filePath))).toBe(true)
    expect(store.consumeSelfWrite(expectDefined(task.filePath))).toBe(false) // single-use
  })

  it('marks both old and new path on title rename (modify new, trash old)', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('R', 'Projects')
    const task = await addNamed(store, project, 'Before')
    const oldPath = expectDefined(task.filePath)
    vault.resetCounts()

    await store.updateTask(project, task.id, { title: 'Renamed' })

    // The new path is created (marked for cache invalidation) and the old
    // path is trashed (marked so the delete listener skips the reload).
    expect(store.consumeSelfWrite(expectDefined(task.filePath))).toBe(true)
    expect(store.consumeSelfWrite(oldPath)).toBe(true)
  })

  it('treats markers older than the window as stale', async () => {
    const { store } = newStore()

    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const project = await store.createProject('Stale', 'Projects')
      vi.setSystemTime(new Date('2026-01-01T00:00:05.001Z')) // > 5s after marker
      expect(store.consumeSelfWrite(project.filePath)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ProjectStore dirty-set save efficiency', () => {
  it('does not rewrite task files when nothing is dirty', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Clean', 'Projects')
    const a = await addNamed(store, project, 'Alpha')
    const b = await addNamed(store, project, 'Beta')
    vault.resetCounts()

    // No mutations, but force a save by updating a non-existent id.
    await store.updateTask(project, 'missing-id', {})

    expect(vault.modifyCount.get(expectDefined(a.filePath)) ?? 0).toBe(0)
    expect(vault.modifyCount.get(expectDefined(b.filePath)) ?? 0).toBe(0)
    expect(vault.modifyCount.get(project.filePath)).toBe(1)
  })

  it('rewrites only the updated task on a single-field update', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('One', 'Projects')
    const a = await addNamed(store, project, 'Alpha')
    const b = await addNamed(store, project, 'Beta')
    const c = await addNamed(store, project, 'Gamma')
    vault.resetCounts()

    await store.updateTask(project, b.id, { priority: 'high' })

    expect(vault.modifyCount.get(expectDefined(a.filePath)) ?? 0).toBe(0)
    expect(vault.modifyCount.get(expectDefined(b.filePath))).toBe(1)
    expect(vault.modifyCount.get(expectDefined(c.filePath)) ?? 0).toBe(0)
  })

  it('rewrites direct children when a parent title changes', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Family', 'Projects')
    const parent = await addNamed(store, project, 'Parent')
    const child1 = await addNamed(store, project, 'Child one', parent.id)
    const child2 = await addNamed(store, project, 'Child two', parent.id)
    vault.resetCounts()

    await store.updateTask(project, parent.id, { title: 'New parent' })

    // Parent file is renamed (create new + trash old), not modified.
    expect(vault.modifyCount.get(expectDefined(parent.filePath)) ?? 0).toBe(0)
    // Children stay at the same path but get rewritten because their Parent link broke.
    expect(vault.modifyCount.get(expectDefined(child1.filePath))).toBe(1)
    expect(vault.modifyCount.get(expectDefined(child2.filePath))).toBe(1)
  })

  it('rewrites both old and new parent on moveTask', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Move', 'Projects')
    const p1 = await addNamed(store, project, 'Parent one')
    const p2 = await addNamed(store, project, 'Parent two')
    const child = await addNamed(store, project, 'Child', p1.id)
    const oldChildPath = expectDefined(child.filePath)
    vault.resetCounts()

    await store.moveTask(project, child.id, p2.id)

    expect(vault.modifyCount.get(expectDefined(p1.filePath))).toBe(1)
    expect(vault.modifyCount.get(expectDefined(p2.filePath))).toBe(1)
    // The child's file relocates under the new parent's folder: create + trash, not modify.
    expect(vault.createCount.get(expectDefined(child.filePath))).toBe(1)
    expect(vault.trashCount.get(oldChildPath)).toBe(1)
  })

  it('rewrites the parent (not the deleted task) on deleteTask', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Delete', 'Projects')
    const parent = await addNamed(store, project, 'Keep')
    const child = await addNamed(store, project, 'Goner', parent.id)
    const childPath = expectDefined(child.filePath)
    vault.resetCounts()

    await store.deleteTask(project, child.id)

    expect(vault.trashCount.get(childPath)).toBe(1)
    expect(vault.modifyCount.get(expectDefined(parent.filePath))).toBe(1)
  })
})

describe('ProjectStore round-trip', () => {
  it('reloads tasks created via mutators with the same state', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Round', 'Projects')
    const a = await addNamed(store, project, 'Design')
    const b = await addNamed(store, project, 'Build')
    await store.updateTask(project, a.id, {
      priority: 'high',
      assignees: ['Alice'],
      tags: ['design']
    })
    await store.updateTask(project, b.id, { status: 'in-progress' })
    const childOfA = await addNamed(store, project, 'Sub of design', a.id)

    // Fresh store, same vault. Reload from disk.
    const store2 = new ProjectStore(app, () => SETTINGS)
    const file = vault.getAbstractFileByPath(project.filePath)
    if (!(file instanceof TFile)) throw new Error('project file missing')
    const reloaded = await store2.loadProject(file)
    if (!reloaded) throw new Error('failed to reload')

    expect(reloaded.title).toBe('Round')
    const flat = flattenTasks(reloaded.tasks)
    const ids = new Set(flat.map((f) => f.task.id))
    expect(ids.has(a.id)).toBe(true)
    expect(ids.has(b.id)).toBe(true)
    expect(ids.has(childOfA.id)).toBe(true)

    const reloadedA = expectDefined(flat.find((f) => f.task.id === a.id)).task
    expect(reloadedA.title).toBe('Design')
    expect(reloadedA.priority).toBe('high')
    expect(reloadedA.assignees).toEqual(['Alice'])
    expect(reloadedA.tags).toEqual(['design'])
    expect(reloadedA.subtasks.map((s) => s.id)).toEqual([childOfA.id])

    const reloadedB = expectDefined(flat.find((f) => f.task.id === b.id)).task
    expect(reloadedB.status).toBe('in-progress')
  })

  it('migrates an old-format (embedded tasks) project on load and save', async () => {
    const { store, vault } = newStore()
    // Manually write an old-format project file (tasks embedded in frontmatter).
    const oldFm = [
      '---',
      'pm-project: true',
      'id: legacy',
      'title: Legacy',
      'tasks:',
      '  - id: t1',
      '    title: First',
      '    status: todo',
      '  - id: t2',
      '    title: Second',
      '    status: done',
      '---',
      ''
    ].join('\n')
    await vault.create('Projects/Legacy.md', oldFm)

    const file = vault.getAbstractFileByPath('Projects/Legacy.md')
    if (!(file instanceof TFile)) throw new Error('legacy file missing')
    const project = await store.loadProject(file)
    if (!project) throw new Error('load failed')

    // markAllDirty should have flagged every embedded task; saving once writes them all.
    await store.saveProject(project)

    // Files exist on disk now.
    expect(vault.getAbstractFileByPath('Projects/Legacy_tasks/first.md')).not.toBeNull()
    expect(vault.getAbstractFileByPath('Projects/Legacy_tasks/second.md')).not.toBeNull()

    // Reload and verify the embedded tasks survived as per-file tasks.
    const reloaded = await store.loadProject(file)
    if (!reloaded) throw new Error('reload failed')
    const flat = flattenTasks(reloaded.tasks)
    expect(flat.map((f) => f.task.title).sort()).toEqual(['First', 'Second'])
  })
})

describe('ProjectStore completion date', () => {
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

  it('stamps completed when a task enters a complete status and clears it on exit', async () => {
    const { store } = newStore()
    const project = await store.createProject('Done dates', 'Projects')
    const task = await addNamed(store, project, 'Ship it')
    expect(task.completed).toBe('')

    await store.updateTask(project, task.id, { status: 'done' })
    expect(task.completed).toMatch(ISO_DATE)

    await store.updateTask(project, task.id, { status: 'in-progress' })
    expect(task.completed).toBe('')
  })

  it('does not restamp when status changes between two complete statuses or stays put', async () => {
    const { store } = newStore()
    const project = await store.createProject('Stable', 'Projects')
    const task = await addNamed(store, project, 'Edit me')
    await store.updateTask(project, task.id, { status: 'done' })
    const stamped = task.completed
    expect(stamped).toMatch(ISO_DATE)

    // A non-status edit leaves the date alone.
    await store.updateTask(project, task.id, { title: 'Edited' })
    expect(task.completed).toBe(stamped)
  })

  it('stamps from a full-task patch that already carries the unchanged completed field', async () => {
    // The task modal saves the whole task as the patch, so `completed` is present
    // and equal to the stored value. Auto-stamping must still fire on the status flip.
    const { store } = newStore()
    const project = await store.createProject('Modal', 'Projects')
    const task = await addNamed(store, project, 'Via modal')
    await store.updateTask(project, task.id, { ...task, status: 'done', completed: '' })
    expect(task.completed).toMatch(ISO_DATE)
  })

  it('respects an explicit completion date in the patch over auto-stamping', async () => {
    const { store } = newStore()
    const project = await store.createProject('Manual', 'Projects')
    const task = await addNamed(store, project, 'Backdated')
    await store.updateTask(project, task.id, { status: 'done', completed: '2025-01-15' })
    expect(task.completed).toBe('2025-01-15')
  })

  it('persists the completion date across a reload', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Persisted', 'Projects')
    const task = await addNamed(store, project, 'Archive me')
    await store.updateTask(project, task.id, { status: 'done' })

    const store2 = new ProjectStore(app, () => SETTINGS)
    const file = vault.getAbstractFileByPath(project.filePath)
    if (!(file instanceof TFile)) throw new Error('project file missing')
    const reloaded = await store2.loadProject(file)
    if (!reloaded) throw new Error('reload failed')
    const reloadedTask = expectDefined(flattenTasks(reloaded.tasks).find((f) => f.task.id === task.id)).task
    expect(reloadedTask.completed).toMatch(ISO_DATE)
  })

  it('stamps a task inserted directly in a complete status', async () => {
    const { store } = newStore()
    const project = await store.createProject('Insert done', 'Projects')
    const task = makeTask({ title: 'Born done', status: 'done' })
    await store.insertTask(project, task)
    expect(task.completed).toMatch(ISO_DATE)
  })

  it('does not bleed one task completion date onto another in a bulk update', async () => {
    const { store } = newStore()
    const project = await store.createProject('Bulk', 'Projects')
    const open = await addNamed(store, project, 'Still open')
    const finishing = await addNamed(store, project, 'Finishing')
    await store.updateTask(project, finishing.id, { status: 'done' })
    open.completed = ''

    // A shared patch object applied to a task that is already done must not carry
    // a stamped date onto the open task in the same call.
    await store.updateTasks(project, [finishing.id, open.id], { priority: 'high' })
    expect(open.completed).toBe('')
  })
})

describe('ProjectStore task attachments', () => {
  it('saves an attachment under the task own attachments folder', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Imgs', 'Projects')
    const task = await addNamed(store, project, 'Shot')

    const file = await store.saveTaskAttachment(project, task, 'pic.png', new ArrayBuffer(4))

    expect(file.path).toBe('Projects/Imgs/Tasks/shot/attachments/pic.png')
    expect(vault.getAbstractFileByPath('Projects/Imgs/Tasks/shot/attachments/pic.png')).not.toBeNull()
  })

  it('disambiguates a colliding attachment name', async () => {
    const { store } = newStore()
    const project = await store.createProject('Imgs', 'Projects')
    const task = await addNamed(store, project, 'Shot')

    const first = await store.saveTaskAttachment(project, task, 'pic.png', new ArrayBuffer(4))
    const second = await store.saveTaskAttachment(project, task, 'pic.png', new ArrayBuffer(4))

    expect(first.path).toBe('Projects/Imgs/Tasks/shot/attachments/pic.png')
    expect(second.path).toBe('Projects/Imgs/Tasks/shot/attachments/pic 1.png')
  })

  it('trashes the attachments folder when the task is deleted', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Imgs', 'Projects')
    const task = await addNamed(store, project, 'Shot')
    await store.saveTaskAttachment(project, task, 'pic.png', new ArrayBuffer(4))

    await store.deleteTask(project, task.id)

    expect(vault.getAbstractFileByPath('Projects/Imgs/Tasks/shot/attachments/pic.png')).toBeNull()
    expect(vault.getAbstractFileByPath('Projects/Imgs/Tasks/shot')).toBeNull()
  })

  it('moves the attachments folder when the task is renamed', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Imgs', 'Projects')
    const task = await addNamed(store, project, 'Shot')
    await store.saveTaskAttachment(project, task, 'pic.png', new ArrayBuffer(4))

    await store.updateTask(project, task.id, { title: 'Photo' })

    expect(vault.getAbstractFileByPath('Projects/Imgs/Tasks/shot/attachments/pic.png')).toBeNull()
    expect(vault.getAbstractFileByPath('Projects/Imgs/Tasks/photo/attachments/pic.png')).not.toBeNull()
  })

  it('moves the attachments folder when the task is archived and back when unarchived', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Imgs', 'Projects')
    const task = await addNamed(store, project, 'Shot')
    await store.saveTaskAttachment(project, task, 'pic.png', new ArrayBuffer(4))

    await store.archiveTask(project, task.id)
    expect(vault.getAbstractFileByPath('Projects/Imgs/Tasks/shot/attachments/pic.png')).toBeNull()
    expect(vault.getAbstractFileByPath('Projects/Imgs/Tasks/Archive/shot/attachments/pic.png')).not.toBeNull()

    await store.unarchiveTask(project, task.id)
    expect(vault.getAbstractFileByPath('Projects/Imgs/Tasks/Archive/shot/attachments/pic.png')).toBeNull()
    expect(vault.getAbstractFileByPath('Projects/Imgs/Tasks/shot/attachments/pic.png')).not.toBeNull()
  })
})

describe('ProjectStore nested subtask files', () => {
  const reload = async (app: App, vault: FakeVault, path: string): Promise<Project> => {
    const file = vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) throw new Error('missing project file')
    const loaded = await new ProjectStore(app, () => SETTINGS).loadProject(file)
    if (!loaded) throw new Error('reload failed')
    return loaded
  }

  it('saves a new subtask inside its parent task folder, recursively', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Nest', 'Projects')
    const parent = await addNamed(store, project, 'Parent')
    const child = await addNamed(store, project, 'Child', parent.id)
    const grand = await addNamed(store, project, 'Grand', child.id)

    expect(parent.filePath).toBe('Projects/Nest/Tasks/parent.md')
    expect(child.filePath).toBe('Projects/Nest/Tasks/parent/child.md')
    expect(grand.filePath).toBe('Projects/Nest/Tasks/parent/child/grand.md')
    expect(vault.getAbstractFileByPath('Projects/Nest/Tasks/parent/child/grand.md')).toBeInstanceOf(TFile)
  })

  it('a parent title rename carries nested subtask files and keeps them loadable', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Carry', 'Projects')
    const parent = await addNamed(store, project, 'Parent')
    const child = await addNamed(store, project, 'Child', parent.id)
    const grand = await addNamed(store, project, 'Grand', child.id)

    await store.updateTask(project, parent.id, { title: 'Renamed' })

    expect(parent.filePath).toBe('Projects/Carry/Tasks/renamed.md')
    expect(child.filePath).toBe('Projects/Carry/Tasks/renamed/child.md')
    expect(grand.filePath).toBe('Projects/Carry/Tasks/renamed/child/grand.md')
    expect(vault.getAbstractFileByPath('Projects/Carry/Tasks/renamed/child/grand.md')).toBeInstanceOf(TFile)
    expect(vault.getAbstractFileByPath('Projects/Carry/Tasks/parent')).toBeNull()

    const reloaded = await reload(app, vault, project.filePath)
    const rParent = expectDefined(flattenTasks(reloaded.tasks).find((f) => f.task.id === parent.id)).task
    expect(rParent.subtasks.map((s) => s.id)).toEqual([child.id])
    expect(rParent.subtasks[0].subtasks.map((s) => s.id)).toEqual([grand.id])
  })

  it('reparenting relocates the file with its own subtree, and promotion returns it to the case folder', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Repar', 'Projects')
    const p1 = await addNamed(store, project, 'Parent one')
    const p2 = await addNamed(store, project, 'Parent two')
    const child = await addNamed(store, project, 'Child', p1.id)
    const grand = await addNamed(store, project, 'Grand', child.id)

    await store.moveTask(project, child.id, p2.id)
    expect(child.filePath).toBe('Projects/Repar/Tasks/parent-two/child.md')
    expect(grand.filePath).toBe('Projects/Repar/Tasks/parent-two/child/grand.md')
    expect(vault.getAbstractFileByPath('Projects/Repar/Tasks/parent-two/child/grand.md')).toBeInstanceOf(TFile)
    expect(vault.getAbstractFileByPath('Projects/Repar/Tasks/parent-one/child.md')).toBeNull()

    await store.moveTask(project, child.id, null)
    expect(child.filePath).toBe('Projects/Repar/Tasks/child.md')
    expect(grand.filePath).toBe('Projects/Repar/Tasks/child/grand.md')
    expect(vault.getAbstractFileByPath('Projects/Repar/Tasks/child/grand.md')).toBeInstanceOf(TFile)
  })

  it('round-trips a nested layout and ignores stray non-task notes in task folders', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Round', 'Projects')
    const parent = await addNamed(store, project, 'Parent')
    const child = await addNamed(store, project, 'Child', parent.id)
    const grand = await addNamed(store, project, 'Grand', child.id)
    const sibling = await addNamed(store, project, 'Sibling')
    await vault.create('Projects/Round/Tasks/parent/scratch note.md', 'not a task')

    const reloaded = await reload(app, vault, project.filePath)
    const flat = flattenTasks(reloaded.tasks)
    expect(flat.map((f) => f.task.id).sort()).toEqual([parent.id, child.id, grand.id, sibling.id].sort())
    const rParent = expectDefined(flat.find((f) => f.task.id === parent.id)).task
    expect(rParent.subtasks.map((s) => s.id)).toEqual([child.id])
    expect(rParent.subtasks[0].subtasks.map((s) => s.id)).toEqual([grand.id])
    expect(flat.some((f) => f.task.title === 'scratch note')).toBe(false)
  })

  it('duplicating a parent nests the cloned subtree under the copy, keeping child titles', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('DupNest', 'Projects')
    const parent = await addNamed(store, project, 'Parent')
    await addNamed(store, project, 'Child', parent.id)

    const copy = expectDefined(await store.duplicateTask(project, parent.id, true))

    expect(copy.title).toBe('Parent (copy)')
    expect(copy.subtasks[0].title).toBe('Child')
    expect(copy.filePath).toBe('Projects/DupNest/Tasks/parent-(copy).md')
    expect(copy.subtasks[0].filePath).toBe('Projects/DupNest/Tasks/parent-(copy)/child.md')
    expect(vault.getAbstractFileByPath('Projects/DupNest/Tasks/parent-(copy)/child.md')).toBeInstanceOf(TFile)
  })

  it('nestSubtaskFiles migrates a flat vault into nested folders, idempotently', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Flat', 'Projects')
    // Hand-write a flat legacy layout: every task file directly in the case folder.
    const write = async (name: string, id: string, extra: string[]): Promise<void> => {
      await vault.create(
        `Projects/Flat/Tasks/${name}.md`,
        ['---', 'pm-task: true', `id: ${id}`, `title: ${name}`, 'status: todo', ...extra, '---', ''].join('\n')
      )
    }
    await write('parent', 'p1', ['subtaskIds:', '  - c1'])
    await write('child', 'c1', ['parentId: p1', 'subtaskIds:', '  - g1'])
    await write('grand', 'g1', ['parentId: c1'])

    const store2 = new ProjectStore(app, () => SETTINGS)
    const file = vault.getAbstractFileByPath(project.filePath)
    if (!(file instanceof TFile)) throw new Error('project file missing')
    const loaded = expectDefined(await store2.loadProject(file))
    // Flat vaults load unchanged without the migration.
    expect(flattenTasks(loaded.tasks).length).toBe(3)

    expect(await store2.nestSubtaskFiles(loaded)).toBe(2)

    expect(vault.getAbstractFileByPath('Projects/Flat/Tasks/parent.md')).toBeInstanceOf(TFile)
    expect(vault.getAbstractFileByPath('Projects/Flat/Tasks/parent/child.md')).toBeInstanceOf(TFile)
    expect(vault.getAbstractFileByPath('Projects/Flat/Tasks/parent/child/grand.md')).toBeInstanceOf(TFile)
    expect(vault.getAbstractFileByPath('Projects/Flat/Tasks/child.md')).toBeNull()
    expect(vault.getAbstractFileByPath('Projects/Flat/Tasks/grand.md')).toBeNull()

    // Second run: nothing left to move.
    expect(await store2.nestSubtaskFiles(loaded)).toBe(0)

    const reloaded = await reload(app, vault, project.filePath)
    const rParent = expectDefined(flattenTasks(reloaded.tasks).find((f) => f.task.id === 'p1')).task
    expect(rParent.subtasks.map((s) => s.id)).toEqual(['c1'])
    expect(rParent.subtasks[0].subtasks.map((s) => s.id)).toEqual(['g1'])
  })
})

describe('ProjectStore metadataCache fast path', () => {
  function stubTaskCache(app: App, path: string, fm: Record<string, unknown>): void {
    const cache = (app as unknown as { metadataCache: { getFileCache: (f: TFile) => unknown } }).metadataCache
    cache.getFileCache = (f: TFile) => (f.path === path ? { frontmatter: fm } : null)
  }

  it('skips the disk read when metadataCache has the task frontmatter', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Cache', 'Projects')
    const task = await addNamed(store, project, 'cached task')
    const taskPath = expectDefined(task.filePath)

    stubTaskCache(app, taskPath, { 'pm-task': true, id: task.id, title: 'cached task' })

    // Strip the file so a real read would throw — proving the cache path didn't read.
    const f = vault.getAbstractFileByPath(taskPath)
    if (!(f instanceof TFile)) throw new Error('task file missing')
    await vault.trashFile(f)
    vault.resetCounts()

    const stub = new TFile()
    stub.path = taskPath
    stub.basename = 'cached task'
    const result = await store.loadTaskFile(stub)
    expect(result.task?.id).toBe(task.id)
    expect(result.task?.description).toBe('')
  })

  it('loadTaskBody pulls the description from disk on demand', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Body', 'Projects')
    const task = await addNamed(store, project, 'task')
    await store.updateTask(project, task.id, { description: 'real description' })
    const taskPath = expectDefined(task.filePath)

    // Reload through a fresh store with cache hits — task arrives unhydrated.
    stubTaskCache(app, taskPath, {
      'pm-task': true,
      id: task.id,
      title: 'task',
      projectId: project.id
    })
    const store2 = new ProjectStore(app, () => SETTINGS)
    const projectFile = vault.getAbstractFileByPath(project.filePath)
    if (!(projectFile instanceof TFile)) throw new Error('project file missing')
    const reloaded = await store2.loadProject(projectFile)
    if (!reloaded) throw new Error('reload failed')
    const reloadedTask = reloaded.tasks[0]
    expect(reloadedTask.description).toBe('')

    await store2.loadTaskBody(reloadedTask)
    expect(reloadedTask.description).toBe('real description')
  })

  it('an fm-only save on a cache-loaded task preserves the on-disk description', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Preserve', 'Projects')
    const task = await addNamed(store, project, 'preserve me')
    await store.updateTask(project, task.id, { description: 'keep this' })
    const taskPath = expectDefined(task.filePath)

    stubTaskCache(app, taskPath, {
      'pm-task': true,
      id: task.id,
      title: 'preserve me',
      projectId: project.id
    })
    const store2 = new ProjectStore(app, () => SETTINGS)
    const projectFile = vault.getAbstractFileByPath(project.filePath)
    if (!(projectFile instanceof TFile)) throw new Error('project file missing')
    const reloaded = await store2.loadProject(projectFile)
    if (!reloaded) throw new Error('reload failed')
    const reloadedTask = reloaded.tasks[0]

    // priority is frontmatter-only — the body must not be touched.
    await store2.updateTask(reloaded, reloadedTask.id, { priority: 'high' })

    const file = vault.getAbstractFileByPath(taskPath)
    if (!(file instanceof TFile)) throw new Error('task file gone')
    const content = await vault.cachedRead(file)
    expect(content).toContain('keep this')
  })

  it('a description edit on a cache-loaded task writes the new body atomically', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Edit', 'Projects')
    const task = await addNamed(store, project, 'editable')
    await store.updateTask(project, task.id, { description: 'before' })
    const taskPath = expectDefined(task.filePath)

    stubTaskCache(app, taskPath, {
      'pm-task': true,
      id: task.id,
      title: 'editable',
      projectId: project.id
    })
    const store2 = new ProjectStore(app, () => SETTINGS)
    const projectFile = vault.getAbstractFileByPath(project.filePath)
    if (!(projectFile instanceof TFile)) throw new Error('project file missing')
    const reloaded = await store2.loadProject(projectFile)
    if (!reloaded) throw new Error('reload failed')
    const reloadedTask = reloaded.tasks[0]

    await store2.updateTask(reloaded, reloadedTask.id, { description: 'after' })

    const file = vault.getAbstractFileByPath(taskPath)
    if (!(file instanceof TFile)) throw new Error('task file gone')
    const content = await vault.cachedRead(file)
    expect(content).toContain('after')
    expect(content).not.toContain('before')
  })
})

describe('ProjectStore task index', () => {
  it('matches a freshly rebuilt index after a sequence of mutations', async () => {
    const { store } = newStore()
    const project = await store.createProject('Idx', 'Projects')
    const a = await addNamed(store, project, 'Alpha')
    const b = await addNamed(store, project, 'Beta')
    const c = await addNamed(store, project, 'Gamma', a.id)
    await store.updateTask(project, b.id, { title: 'Beta renamed' })
    await store.moveTask(project, c.id, b.id)
    const d = await addNamed(store, project, 'Delta')
    await store.duplicateTask(project, a.id, true)
    await store.deleteTask(project, d.id)

    const fresh = buildTaskIndex(project.tasks)
    expect(project.taskIndex.size).toBe(fresh.size)
    for (const [id, entry] of fresh) {
      expect(project.taskIndex.get(id)?.parentId).toBe(entry.parentId)
      expect(project.taskIndex.get(id)?.task).toBe(entry.task)
    }
  })

  it('duplicates a task with subtasks without colliding on filenames', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Dup', 'Projects')
    const parent = await addNamed(store, project, 'Parent')
    await addNamed(store, project, 'subtask', parent.id)

    const copy = await store.duplicateTask(project, parent.id, true)
    expect(copy).not.toBeNull()

    const paths = flattenTasks(project.tasks).map((f) => f.task.filePath)
    expect(new Set(paths).size).toBe(paths.length)
    for (const p of paths) {
      expect(p).toBeTruthy()
      expect(vault.getAbstractFileByPath(expectDefined(p))).toBeInstanceOf(TFile)
    }
  })

  it('disambiguates the copy title when the same task is duplicated twice', async () => {
    const { store } = newStore()
    const project = await store.createProject('Dup2', 'Projects')
    const task = await addNamed(store, project, 'Task')

    const first = await store.duplicateTask(project, task.id, false)
    const second = await store.duplicateTask(project, task.id, false)

    expect(first?.title).toBe('Task (copy)')
    expect(second?.title).toBe('Task (copy 2)')
  })

  it('counts up instead of stacking suffixes when a copy is duplicated', async () => {
    const { store } = newStore()
    const project = await store.createProject('Dup4', 'Projects')
    const task = await addNamed(store, project, 'Task')

    const first = expectDefined(await store.duplicateTask(project, task.id, false))
    const second = await store.duplicateTask(project, first.id, false)
    const third = await store.duplicateTask(project, second?.id ?? '', false)

    expect(first.title).toBe('Task (copy)')
    expect(second?.title).toBe('Task (copy 2)')
    expect(third?.title).toBe('Task (copy 3)')
  })

  it('survives a reload: rebuilt index after load matches the in-memory tree', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Reload', 'Projects')
    const a = await addNamed(store, project, 'Alpha')
    await addNamed(store, project, 'Child', a.id)
    await addNamed(store, project, 'Beta')

    const store2 = new ProjectStore(app, () => SETTINGS)
    const file = vault.getAbstractFileByPath(project.filePath)
    if (!(file instanceof TFile)) throw new Error('missing file')
    const reloaded = await store2.loadProject(file)
    if (!reloaded) throw new Error('reload failed')

    const fresh = buildTaskIndex(reloaded.tasks)
    expect(reloaded.taskIndex.size).toBe(fresh.size)
    for (const [id, entry] of fresh) {
      expect(reloaded.taskIndex.get(id)?.parentId).toBe(entry.parentId)
    }
  })
})

describe('ProjectStore editor subtask save', () => {
  const reload = async (app: App, vault: FakeVault, path: string): Promise<Project> => {
    const file = vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) throw new Error('missing file')
    return expectDefined(await new ProjectStore(app, () => SETTINGS).loadProject(file))
  }

  it('persists a subtask added through updateTask (the task editor save path)', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Editor', 'Projects')
    const parent = await addNamed(store, project, 'Parent')

    // The editor edits a deep clone and saves the whole task back.
    const edited = JSON.parse(JSON.stringify(parent)) as Task
    edited.subtasks.push(makeTask({ title: 'New sub', type: 'subtask' }))
    await store.updateTask(project, parent.id, edited)

    const sub = expectDefined(flattenTasks(project.tasks).find((f) => f.task.title === 'New sub')).task
    expect(sub.filePath).toBeTruthy()
    expect(vault.getAbstractFileByPath(expectDefined(sub.filePath))).toBeInstanceOf(TFile)

    const reloaded = await reload(app, vault, project.filePath)
    expect(
      flattenTasks(reloaded.tasks)
        .map((f) => f.task.title)
        .sort()
    ).toEqual(['New sub', 'Parent'])
  })

  it('renames one subtask and trashes another removed in the editor', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Editor', 'Projects')
    const parent = await addNamed(store, project, 'Parent')
    await addNamed(store, project, 'Alpha', parent.id)
    const beta = await addNamed(store, project, 'Beta', parent.id)
    const betaPath = expectDefined(beta.filePath)

    const live = expectDefined(flattenTasks(project.tasks).find((f) => f.task.id === parent.id)).task
    const edited = JSON.parse(JSON.stringify(live)) as Task
    edited.subtasks = edited.subtasks.filter((s) => s.title !== 'Beta')
    edited.subtasks[0].title = 'Alpha renamed'
    await store.updateTask(project, parent.id, edited)

    expect(vault.getAbstractFileByPath(betaPath)).toBeNull()
    const reloaded = await reload(app, vault, project.filePath)
    expect(
      flattenTasks(reloaded.tasks)
        .map((f) => f.task.title)
        .sort()
    ).toEqual(['Alpha renamed', 'Parent'])
  })

  it('persists a subtask bucket/severity edit made through the parent save (reconcile compare)', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Editor', 'Projects')
    const parent = await addNamed(store, project, 'Parent')
    await addNamed(store, project, 'Child', parent.id)

    // Only the new fields change — title/status/progress stay identical, so this
    // fails if reconcileSubtasks' dirty compare doesn't cover the new fields.
    const live = expectDefined(flattenTasks(project.tasks).find((f) => f.task.id === parent.id)).task
    const edited = JSON.parse(JSON.stringify(live)) as Task
    edited.subtasks[0].bucket = 'this-week'
    edited.subtasks[0].severity = 'sev2'
    await store.updateTask(project, parent.id, edited)

    const reloaded = await reload(app, vault, project.filePath)
    const child = expectDefined(flattenTasks(reloaded.tasks).find((f) => f.task.title === 'Child')).task
    expect(child.bucket).toBe('this-week')
    expect(child.severity).toBe('sev2')
  })
})

describe('ProjectStore duplicate long titles', () => {
  it('duplicates a long-titled task without hanging and keeps filenames unique', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Dup3', 'Projects')
    const longTitle = 'This is a very long task title that comfortably exceeds the sixty character filename slug cap'
    const parent = await addNamed(store, project, longTitle)
    await addNamed(store, project, 'subtask', parent.id)

    // Duplicate twice: the base is trimmed so the "(copy N)" suffix survives the
    // slug cap, so both copies get distinct titles and distinct files.
    expect(await store.duplicateTask(project, parent.id, true)).not.toBeNull()
    expect(await store.duplicateTask(project, parent.id, true)).not.toBeNull()

    const paths = flattenTasks(project.tasks).map((f) => f.task.filePath)
    expect(new Set(paths).size).toBe(paths.length)
    for (const p of paths) {
      expect(vault.getAbstractFileByPath(expectDefined(p))).toBeInstanceOf(TFile)
    }
  })
})

describe('ProjectStore concurrent-save race', () => {
  it('does not lose markDirty calls that fire during an in-flight save', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Race', 'Projects')
    const a = await addNamed(store, project, 'Alpha')
    const b = await addNamed(store, project, 'Beta')
    const aOldPath = expectDefined(a.filePath)
    const bOldPath = expectDefined(b.filePath)
    vault.resetCounts()

    // Kick off two updates back-to-back without awaiting the first.
    // The second saveProject chains behind the first in the saveQueue, so any
    // markDirty calls from the second mutator must survive the first save's
    // dirty-set drain.
    const first = store.updateTask(project, a.id, { title: 'A new' })
    const second = store.updateTask(project, b.id, { title: 'B new' })
    await Promise.all([first, second])

    expect(vault.getAbstractFileByPath('Projects/Race/Tasks/a-new.md')).not.toBeNull()
    expect(vault.getAbstractFileByPath('Projects/Race/Tasks/b-new.md')).not.toBeNull()
    expect(vault.getAbstractFileByPath(aOldPath)).toBeNull()
    expect(vault.getAbstractFileByPath(bOldPath)).toBeNull()
  })
})

describe('ProjectStore bulk mutators', () => {
  it('updateTasks with a function patch writes only the patched task files', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Bulk', 'Projects')
    const a = await addNamed(store, project, 'alpha')
    const b = await addNamed(store, project, 'beta')
    await store.updateTask(project, b.id, { assignees: ['sam'] })
    vault.resetCounts()

    await store.updateTasks(project, [a.id, b.id], (t) =>
      t.assignees.includes('sam') ? null : { assignees: [...t.assignees, 'sam'] }
    )

    expect(a.assignees).toEqual(['sam'])
    expect(vault.modifyCount.get(expectDefined(a.filePath))).toBe(1)
    expect(vault.modifyCount.get(expectDefined(b.filePath))).toBeUndefined()
    const file = vault.getAbstractFileByPath(expectDefined(a.filePath))
    if (!(file instanceof TFile)) throw new Error('task file missing')
    expect(await vault.cachedRead(file)).toContain('sam')
  })

  it('reorderTask persists sibling order through the parent file only', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Order', 'Projects')
    const parent = await addNamed(store, project, 'parent')
    const one = await addNamed(store, project, 'one', parent.id)
    const two = await addNamed(store, project, 'two', parent.id)
    vault.resetCounts()

    await store.reorderTask(project, two.id, one.id, 'before')

    expect(parent.subtasks.map((t) => t.id)).toEqual([two.id, one.id])
    expect(vault.modifyCount.get(expectDefined(parent.filePath))).toBe(1)
    expect(vault.modifyCount.get(expectDefined(one.filePath))).toBeUndefined()
    expect(vault.modifyCount.get(expectDefined(two.filePath))).toBeUndefined()
    const file = vault.getAbstractFileByPath(expectDefined(parent.filePath))
    if (!(file instanceof TFile)) throw new Error('parent file missing')
    const content = await vault.cachedRead(file)
    expect(content.indexOf(two.id)).toBeLessThan(content.indexOf(one.id))
  })

  it('writes tasks that have no file yet even when nothing marked them dirty', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Net', 'Projects')
    const rogue = makeTask({ title: 'rogue' })
    project.tasks.push(rogue)
    project.taskIndex.set(rogue.id, { task: rogue, parentId: null })

    await store.saveProject(project)

    expect(rogue.filePath).toBeDefined()
    expect(vault.getAbstractFileByPath(expectDefined(rogue.filePath))).not.toBeNull()
  })
})

describe('ProjectStore project cache', () => {
  it('returns the cached instance on repeated loads', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Cached', 'Projects')
    await addNamed(store, project, 'task')
    const file = vault.getAbstractFileByPath(project.filePath)
    if (!(file instanceof TFile)) throw new Error('project file missing')

    const first = await store.loadProject(file)
    const second = await store.loadProject(file)

    expect(first).toBe(project)
    expect(second).toBe(first)
  })

  it('saving a cloned project makes the clone the canonical cached copy', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Clone me', 'Projects')
    await addNamed(store, project, 'task')

    // Same shape as ProjectModal: JSON round-trip plus index rebuild.
    const clone = JSON.parse(JSON.stringify(project)) as typeof project
    clone.taskIndex = buildTaskIndex(clone.tasks)
    clone.description = 'edited in modal'
    await store.saveProject(clone)

    const file = vault.getAbstractFileByPath(project.filePath)
    if (!(file instanceof TFile)) throw new Error('project file missing')
    const reloaded = await store.loadProject(file)
    expect(reloaded).toBe(clone)
  })
})

describe('ProjectStore.importNoteAsTask', () => {
  async function importInto(handling: 'move' | 'copy') {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Import', 'Projects')
    const note = await vault.create('Notes/Idea.md', 'the note body')
    const result = await store.importNoteAsTask(project, note, {
      status: 'in-progress',
      priority: 'high',
      handling
    })
    return { store, vault, app, project, result }
  }

  it('copies a note into the tasks folder and keeps the original', async () => {
    const { vault, result } = await importInto('copy')
    expect(result).toBe('imported')
    expect(vault.getAbstractFileByPath('Notes/Idea.md')).toBeInstanceOf(TFile)

    const created = vault.getAbstractFileByPath('Projects/Import/Tasks/idea.md')
    if (!(created instanceof TFile)) throw new Error('imported task file missing')
    const content = await vault.read(created)
    expect(content).toContain('pm-task: true')
    expect(content).toContain('status: "in-progress"')
    expect(content).toContain('priority: "high"')
    expect(content).toContain('the note body')
  })

  it('moves a note into the tasks folder', async () => {
    const { vault, result } = await importInto('move')
    expect(result).toBe('imported')
    expect(vault.getAbstractFileByPath('Notes/Idea.md')).toBeNull()

    const moved = vault.getAbstractFileByPath('Projects/Import/Tasks/idea.md')
    if (!(moved instanceof TFile)) throw new Error('imported task file missing')
    const content = await vault.read(moved)
    expect(content).toContain('pm-task: true')
    expect(content).toContain('the note body')
  })

  it('imported tasks appear as top-level tasks on the next project load', async () => {
    const { vault, app, project } = await importInto('move')
    const store2 = new ProjectStore(app, () => SETTINGS)
    const file = vault.getAbstractFileByPath(project.filePath)
    if (!(file instanceof TFile)) throw new Error('project file missing')
    const reloaded = expectDefined(await store2.loadProject(file))
    expect(reloaded.tasks.map((t) => t.title)).toContain('Idea')
  })

  it('skips notes that are already tasks', async () => {
    const { store, vault, project } = await importInto('copy')
    const existing = vault.getAbstractFileByPath('Projects/Import/Tasks/idea.md')
    if (!(existing instanceof TFile)) throw new Error('imported task file missing')
    const before = await vault.read(existing)

    const result = await store.importNoteAsTask(project, existing, {
      status: 'todo',
      priority: 'low',
      handling: 'move'
    })
    expect(result).toBe('skipped')
    expect(await vault.read(existing)).toBe(before)
  })
})

describe('ProjectStore.importTaskForest', () => {
  it('writes a parent/child forest that reloads as a tree with dependencies', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Forest', 'Projects')
    const parentSource = await vault.create('Notes/Parent.md', 'parent body')
    const childSource = await vault.create('Notes/Child.md', 'child body')

    const child = makeTask({ title: 'Child', type: 'subtask' })
    const parent = makeTask({ title: 'Parent', subtasks: [child] })
    child.dependencies = [parent.id]
    const sources = new Map([
      [parent.id, parentSource],
      [child.id, childSource]
    ])

    const count = await store.importTaskForest(project, [parent], sources, 'move')
    expect(count).toBe(2)
    expect(vault.getAbstractFileByPath('Notes/Parent.md')).toBeNull()

    const store2 = new ProjectStore(app, () => SETTINGS)
    const file = vault.getAbstractFileByPath(project.filePath)
    if (!(file instanceof TFile)) throw new Error('project file missing')
    const reloaded = expectDefined(await store2.loadProject(file))
    const top = reloaded.tasks.find((t) => t.title === 'Parent')
    expect(expectDefined(top).subtasks.map((t) => t.title)).toEqual(['Child'])
    expect(expectDefined(top).subtasks[0].dependencies).toEqual([parent.id])
    expect(expectDefined(top).description).toBe('parent body')
  })

  it('places archived tasks in the Archive subfolder', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Arch', 'Projects')
    const source = await vault.create('Notes/Old.md', 'old body')
    const task = makeTask({ title: 'Old', archived: true })

    await store.importTaskForest(project, [task], new Map([[task.id, source]]), 'copy')
    expect(vault.getAbstractFileByPath('Projects/Arch/Tasks/Archive/old.md')).toBeInstanceOf(TFile)
    expect(vault.getAbstractFileByPath('Notes/Old.md')).toBeInstanceOf(TFile)
  })
})

describe('per-project config', () => {
  it('round-trips the config overrides through the project file', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Custom', 'Projects')
    project.config = {
      statuses: [
        { id: 'idea', label: 'Idea', color: '#888888', icon: '', complete: false },
        { id: 'shipped', label: 'Shipped', color: '#00aa00', icon: '', complete: true }
      ],
      priorities: [
        { id: 'urgent', label: 'Urgent', color: '#ff0000', icon: '' },
        { id: 'later', label: 'Later', color: '#888888', icon: '' }
      ],
      defaultView: 'kanban',
      autoSchedule: false
    }
    await store.saveProject(project)

    const store2 = new ProjectStore(app, () => SETTINGS)
    const file = vault.getAbstractFileByPath(project.filePath)
    if (!(file instanceof TFile)) throw new Error('project file missing')
    const reloaded = expectDefined(await store2.loadProject(file))
    expect(reloaded.config).toEqual(project.config)
  })

  it('omits the frontmatter key when the project overrides nothing', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Inherit', 'Projects')
    await store.saveProject(project)

    const store2 = new ProjectStore(app, () => SETTINGS)
    const file = vault.getAbstractFileByPath(project.filePath)
    if (!(file instanceof TFile)) throw new Error('project file missing')
    expect(await vault.read(file)).not.toContain('config:')
    const reloaded = expectDefined(await store2.loadProject(file))
    expect(reloaded.config).toBeUndefined()
  })

  it('stamps completion using the project-defined complete flag', async () => {
    const { store } = newStore()
    const project = await store.createProject('Flags', 'Projects')
    project.config = {
      statuses: [
        { id: 'idea', label: 'Idea', color: '#888888', icon: '', complete: false },
        { id: 'shipped', label: 'Shipped', color: '#00aa00', icon: '', complete: true }
      ]
    }
    const task = await addNamed(store, project, 'Ship it')
    await store.updateTask(project, task.id, { status: 'shipped' })
    expect(expectDefined(findTask(project.tasks, task.id)).completed).not.toBe('')
  })

  it('skips auto-scheduling when the project turns it off', async () => {
    const { store } = newStore()
    const project = await store.createProject('NoSched', 'Projects')
    const a = await addNamed(store, project, 'First')
    const b = await addNamed(store, project, 'Second')
    await store.updateTask(project, a.id, { start: '2026-07-06', due: '2026-07-10' })
    await store.updateTask(project, b.id, { start: '2026-07-01', due: '2026-07-02', dependencies: [a.id] })

    project.config = { autoSchedule: false }
    expect(await store.scheduleAfterChange(project, a.id)).toBe(0)

    project.config = undefined
    expect(await store.scheduleAfterChange(project, a.id)).toBeGreaterThan(0)
  })
})

describe('issue keys', () => {
  async function reloadProject(app: App, vault: FakeVault, path: string): Promise<Project> {
    const file = vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) throw new Error('missing file')
    return expectDefined(await new ProjectStore(app, () => SETTINGS).loadProject(file))
  }

  it('assigns PREFIX-N keys to dirty keyless tasks on save, persisting nextKeySeq', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Keyed', 'Projects')
    project.keyPrefix = 'SOC'

    const a = await addNamed(store, project, 'First')
    const b = await addNamed(store, project, 'Second')
    expect(a.key).toBe('SOC-1')
    expect(b.key).toBe('SOC-2')

    const reloaded = await reloadProject(app, vault, project.filePath)
    expect(reloaded.nextKeySeq).toBe(3)
    expect(
      flattenTasks(reloaded.tasks)
        .map((f) => f.task.key)
        .sort()
    ).toEqual(['SOC-1', 'SOC-2'])
  })

  it('keeps keys immutable: an already-keyed task is never re-keyed on later saves', async () => {
    const { store } = newStore()
    const project = await store.createProject('Immutable', 'Projects')
    project.keyPrefix = 'SOC'
    const a = await addNamed(store, project, 'Task')
    expect(a.key).toBe('SOC-1')
    await store.updateTask(project, a.id, { status: 'in-progress' })
    expect(a.key).toBe('SOC-1')
  })

  it('a duplicated task gets a fresh key, not the source key', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Dup', 'Projects')
    project.keyPrefix = 'SOC'
    const a = await addNamed(store, project, 'Original')
    await store.duplicateTask(project, a.id, false)

    const reloaded = await reloadProject(app, vault, project.filePath)
    const keys = flattenTasks(reloaded.tasks)
      .map((f) => f.task.key)
      .sort()
    expect(keys).toEqual(['SOC-1', 'SOC-2'])
  })

  it('adoptIssueKeys adopts embedded keys, strips titles, keys the rest by age, and is idempotent', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Argus', 'Projects')

    const epic1 = makeTask({ title: 'ARGUS-1: Data Collection', createdAt: '2026-07-01T00:00:00Z' })
    const epic2 = makeTask({ title: 'ARGUS-2: Correlation', createdAt: '2026-07-02T00:00:00Z' })
    const plain = makeTask({ title: 'Loose story', createdAt: '2026-07-03T00:00:00Z' })
    await store.insertTask(project, epic1, null)
    await store.insertTask(project, epic2, null)
    await store.insertTask(project, plain, null)
    const child = makeTask({ title: 'Child of one', type: 'subtask', createdAt: '2026-07-04T00:00:00Z' })
    await store.insertTask(project, child, epic1.id)

    const result = expectDefined(await store.adoptIssueKeys(project))
    expect(result.prefix).toBe('ARGUS')
    expect(result.adopted).toBe(2)
    expect(result.assigned).toBe(2) // plain + child
    expect(result.renamedBasenames.length).toBe(2)

    const reloaded = await reloadProject(app, vault, project.filePath)
    const byTitle = new Map(flattenTasks(reloaded.tasks).map((f) => [f.task.title, f.task]))
    expect(expectDefined(byTitle.get('Data Collection')).key).toBe('ARGUS-1')
    expect(expectDefined(byTitle.get('Correlation')).key).toBe('ARGUS-2')
    expect(expectDefined(byTitle.get('Loose story')).key).toBe('ARGUS-3')
    expect(expectDefined(byTitle.get('Child of one')).key).toBe('ARGUS-4')
    expect(reloaded.keyPrefix).toBe('ARGUS')
    expect(reloaded.nextKeySeq).toBe(5)

    // Second run: nothing left to do.
    const again = expectDefined(await store.adoptIssueKeys(project))
    expect(again.adopted).toBe(0)
    expect(again.assigned).toBe(0)
  })

  it('adoptIssueKeys returns null without a determinable prefix, then honors the fallback', async () => {
    const { store } = newStore()
    const project = await store.createProject('NoPrefix', 'Projects')
    await addNamed(store, project, 'Plain task')

    expect(await store.adoptIssueKeys(project)).toBeNull()
    const result = expectDefined(await store.adoptIssueKeys(project, 'soc'))
    expect(result.prefix).toBe('SOC')
    expect(result.assigned).toBe(1)
  })

  it('duplicate embedded numbers: first claims the seq, second falls through to fresh assignment', async () => {
    const { store } = newStore()
    const project = await store.createProject('DupSeq', 'Projects')
    const first = makeTask({ title: 'XX-1: Alpha', createdAt: '2026-07-01T00:00:00Z' })
    const second = makeTask({ title: 'XX-1: Beta', createdAt: '2026-07-02T00:00:00Z' })
    await store.insertTask(project, first, null)
    await store.insertTask(project, second, null)

    const result = expectDefined(await store.adoptIssueKeys(project))
    expect(result.adopted).toBe(1)
    expect(result.assigned).toBe(1)
    const keys = flattenTasks(project.tasks)
      .map((f) => f.task.key)
      .sort()
    expect(keys).toEqual(['XX-1', 'XX-2'])
    // The second keeps its (now misleading) title untouched — honest, reported, not silently rewritten.
    expect(
      flattenTasks(project.tasks)
        .map((f) => f.task.title)
        .sort()
    ).toEqual(['Alpha', 'XX-1: Beta'])
  })
})

describe('activity log + incident lifecycle stamps', () => {
  it('appends one entry per tracked field change through updateTask', async () => {
    const { store } = newStore()
    const project = await store.createProject('Audit', 'Projects')
    const t = await addNamed(store, project, 'Traced')

    await store.updateTask(project, t.id, { status: 'in-progress', priority: 'high' })

    expect(t.activity.map((a) => [a.field, a.from, a.to])).toEqual([
      ['status', 'todo', 'in-progress'],
      ['priority', 'medium', 'high']
    ])
    expect(t.activity[0].at).toBeTruthy()
  })

  it('logs nothing for unchanged fields or untracked fields', async () => {
    const { store } = newStore()
    const project = await store.createProject('Quiet', 'Projects')
    const t = await addNamed(store, project, 'Silent')

    await store.updateTask(project, t.id, { status: 'todo', progress: 50, title: 'Silent' })
    expect(t.activity).toEqual([])
  })

  it('whole-task patches (editor deep clones) diff against the live task, not double-log', async () => {
    const { store } = newStore()
    const project = await store.createProject('Clone', 'Projects')
    const t = await addNamed(store, project, 'Edited')
    await store.updateTask(project, t.id, { status: 'in-progress' })
    expect(t.activity.length).toBe(1)

    // Editor-style save: deep clone with one more change; clone carries the existing log.
    const edited = JSON.parse(JSON.stringify(t)) as Task
    edited.verdict = 'pending'
    await store.updateTask(project, t.id, edited)

    const live = expectDefined(findTask(project.tasks, t.id))
    expect(live.activity.map((a) => a.field)).toEqual(['status', 'verdict'])
  })

  it('bulk updateTasks logs per task without cross-task bleed', async () => {
    const { store } = newStore()
    const project = await store.createProject('Bulk', 'Projects')
    const a = await addNamed(store, project, 'A')
    const b = await addNamed(store, project, 'B')

    await store.updateTasks(project, [a.id, b.id], { status: 'done' })

    expect(a.activity.length).toBe(1)
    expect(b.activity.length).toBe(1)
    expect(a.activity[0]).not.toBe(b.activity[0])
  })

  it('auto-stamps respondedAt on first incident status change, never overwrites, manual wins', async () => {
    const { store } = newStore()
    const project = await store.createProject('IR', 'Projects')
    const inc = makeTask({ title: 'Incident', issueType: 'incident', severity: 'sev2' })
    await store.insertTask(project, inc, null)

    await store.updateTask(project, inc.id, { status: 'in-progress' })
    const stamped = inc.respondedAt
    expect(stamped).toBeTruthy()

    await store.updateTask(project, inc.id, { status: 'todo' })
    expect(inc.respondedAt).toBe(stamped) // never overwritten

    const manual = '2026-07-30T00:00:00.000Z'
    await store.updateTask(project, inc.id, { status: 'in-progress', respondedAt: manual })
    expect(inc.respondedAt).toBe(manual) // an explicit differing value is a manual edit — it wins
  })

  it('manual respondedAt in the same patch wins over the auto-stamp', async () => {
    const { store } = newStore()
    const project = await store.createProject('IRM', 'Projects')
    const inc = makeTask({ title: 'Incident', issueType: 'incident' })
    await store.insertTask(project, inc, null)

    const manual = '2026-07-30T00:00:00.000Z'
    await store.updateTask(project, inc.id, { status: 'in-progress', respondedAt: manual })
    expect(inc.respondedAt).toBe(manual)
  })

  it('auto-stamps resolvedAt when an incident enters a terminal status', async () => {
    const { store } = newStore()
    const project = await store.createProject('IRR', 'Projects')
    const inc = makeTask({ title: 'Incident', issueType: 'incident' })
    await store.insertTask(project, inc, null)

    await store.updateTask(project, inc.id, { status: 'done' })
    expect(inc.resolvedAt).toBeTruthy()
    expect(inc.respondedAt).toBeTruthy() // first status change too

    // Non-incidents never get stamps.
    const plain = await addNamed(store, project, 'Plain')
    await store.updateTask(project, plain.id, { status: 'done' })
    expect(plain.resolvedAt).toBe('')
  })

  it('logs bucket changes and ioc added/removed values', async () => {
    const { store } = newStore()
    const project = await store.createProject('IocLog', 'Projects')
    const t = await addNamed(store, project, 'Indicators')

    await store.updateTask(project, t.id, {
      bucket: 'this-week',
      iocs: [{ type: 'ip', value: '10.0.0.1' }]
    })
    // Whole-list replacement (editor-style): one add + one remove.
    await store.updateTask(project, t.id, {
      iocs: [{ type: 'domain', value: 'evil.example' }]
    })

    expect(t.activity.map((a) => [a.field, a.from, a.to])).toEqual([
      ['bucket', 'none', 'this-week'],
      ['iocs', '', '10.0.0.1'],
      ['iocs', '', 'evil.example'],
      ['iocs', '10.0.0.1', '']
    ])
  })

  it('ioc type/note edits and unchanged lists log nothing', async () => {
    const { store } = newStore()
    const project = await store.createProject('IocQuiet', 'Projects')
    const t = await addNamed(store, project, 'Stable')
    await store.updateTask(project, t.id, { iocs: [{ type: 'ip', value: '10.0.0.1' }] })
    expect(t.activity.length).toBe(1)

    // Same value, different type + new note: the indicator's identity is unchanged.
    await store.updateTask(project, t.id, { iocs: [{ type: 'domain', value: '10.0.0.1', note: 'seen' }] })
    // Identical list again (editor deep clone re-saving).
    await store.updateTask(project, t.id, { iocs: [{ type: 'domain', value: '10.0.0.1', note: 'seen' }] })
    expect(t.activity.length).toBe(1)
  })

  it('appendActivity writes a direct entry and persists it', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Direct', 'Projects')
    const t = await addNamed(store, project, 'Breach me')

    await store.appendActivity(project, t.id, {
      at: '2026-07-30T10:00:00.000Z',
      field: 'sla',
      from: 'response',
      to: 'breached'
    })

    const file = vault.getAbstractFileByPath(project.filePath)
    if (!(file instanceof TFile)) throw new Error('missing file')
    const reloaded = expectDefined(await new ProjectStore(app, () => SETTINGS).loadProject(file))
    const rt = expectDefined(findTask(reloaded.tasks, t.id))
    expect(rt.activity).toEqual([{ at: '2026-07-30T10:00:00.000Z', field: 'sla', from: 'response', to: 'breached' }])
  })
})

describe('v3 self-contained project folders', () => {
  it('createProject produces <base>/<Name>/<Name>.md with Tasks inside', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Argus', 'Projects')
    expect(project.filePath).toBe('Projects/Argus/Argus.md')
    const task = await addNamed(store, project, 'Recon')
    expect(task.filePath).toBe('Projects/Argus/Tasks/recon.md')
    expect(vault.getAbstractFileByPath('Projects/Argus/Argus.md')).toBeInstanceOf(TFile)
  })

  it('empty base = vault root: project "Cases" creates a top-level Cases/ folder', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Cases', '')
    expect(project.filePath).toBe('Cases/Cases.md')
    const task = await addNamed(store, project, 'First')
    expect(task.filePath).toBe('Cases/Tasks/first.md')
    expect(vault.getAbstractFileByPath('Cases/Cases.md')).toBeInstanceOf(TFile)

    const found = await store.loadAllProjects('')
    expect(found.map((p) => p.title)).toEqual(['Cases'])
  })

  it('refuses to create a project whose folder already exists', async () => {
    const { store, vault } = newStore()
    await vault.createFolder('Projects/Dup')
    expect(store.newProjectFilePath('Projects', 'Dup')).toBeNull()
    await expect(store.createProject('Dup', 'Projects')).rejects.toThrow('already exists')
  })

  it('loads all three layouts side by side', async () => {
    const { store, vault } = newStore()
    // Legacy: <root>/Old.md + <root>/Old_tasks/
    await vault.create(
      'Projects/Old.md',
      ['---', 'pm-project: true', 'id: old', 'title: Old', 'taskIds:', '  - t1', '---', ''].join('\n')
    )
    await vault.create(
      'Projects/Old_tasks/one.md',
      ['---', 'pm-task: true', 'id: t1', 'title: one', 'status: todo', '---', ''].join('\n')
    )
    // v2: <root>/Cases/Mid.md + <root>/Tasks/Mid/
    await vault.create(
      'Projects/Cases/Mid.md',
      ['---', 'pm-project: true', 'id: mid', 'title: Mid', 'taskIds:', '  - t2', '---', ''].join('\n')
    )
    await vault.create(
      'Projects/Tasks/Mid/two.md',
      ['---', 'pm-task: true', 'id: t2', 'title: two', 'status: todo', '---', ''].join('\n')
    )
    // v3: created fresh
    const fresh = await store.createProject('New', 'Projects')
    await addNamed(store, fresh, 'three')

    const projects = await store.loadAllProjects('Projects')
    expect(projects.map((p) => p.title)).toEqual(['Mid', 'New', 'Old'])
    const byTitle = new Map(projects.map((p) => [p.title, p]))
    expect(expectDefined(byTitle.get('Old')).tasks.map((t) => t.title)).toEqual(['one'])
    expect(expectDefined(byTitle.get('Mid')).tasks.map((t) => t.title)).toEqual(['two'])
    expect(expectDefined(byTitle.get('New')).tasks.map((t) => t.title)).toEqual(['three'])
  })

  it('renameProjectFolder carries the folder, tasks, archive and attachments, re-pointing memory', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Before', 'Projects')
    const parent = await addNamed(store, project, 'Parent')
    const child = await addNamed(store, project, 'Child', parent.id)
    const gone = await addNamed(store, project, 'Shelved')
    await store.archiveTask(project, gone.id)
    await store.saveTaskAttachment(project, parent, 'pic.png', new ArrayBuffer(4))

    const moved = await store.renameProjectFolder(project, 'After')
    expect(moved).toEqual({ from: 'Projects/Before/Before.md', to: 'Projects/After/After.md' })
    expect(project.filePath).toBe('Projects/After/After.md')
    expect(parent.filePath).toBe('Projects/After/Tasks/parent.md')
    expect(child.filePath).toBe('Projects/After/Tasks/parent/child.md')
    expect(gone.filePath).toBe('Projects/After/Tasks/Archive/shelved.md')
    expect(vault.getAbstractFileByPath('Projects/After/Tasks/parent/child.md')).toBeInstanceOf(TFile)
    expect(vault.getAbstractFileByPath('Projects/After/Tasks/parent/attachments/pic.png')).toBeInstanceOf(TFile)
    expect(vault.getAbstractFileByPath('Projects/Before')).toBeNull()

    // The canonical cached object keeps its identity under the new key.
    const file = vault.getAbstractFileByPath('Projects/After/After.md')
    if (!(file instanceof TFile)) throw new Error('renamed project file missing')
    expect(await store.loadProject(file)).toBe(project)

    // Mirror the caller: persist the new title, then reload cold.
    project.title = 'After'
    await store.saveProject(project)
    const reloaded = expectDefined(await new ProjectStore(app, () => SETTINGS).loadProject(file))
    expect(reloaded.title).toBe('After')
    expect(flattenTasks(reloaded.tasks).length).toBe(3)
  })

  it('deleteProject trashes the whole project folder', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Gone', 'Projects')
    const task = await addNamed(store, project, 'Task')
    await store.saveTaskAttachment(project, task, 'pic.png', new ArrayBuffer(4))

    await store.deleteProject(project)

    expect(vault.getAbstractFileByPath('Projects/Gone')).toBeNull()
    expect(vault.getAbstractFileByPath('Projects/Gone/Gone.md')).toBeNull()
  })

  it('renameProjectFolder refuses an occupied target and skips no-op renames', async () => {
    const { store } = newStore()
    const a = await store.createProject('Alpha', 'Projects')
    await store.createProject('Beta', 'Projects')
    expect(await store.renameProjectFolder(a, 'Beta')).toBe('occupied')
    expect(a.filePath).toBe('Projects/Alpha/Alpha.md')
    expect(await store.renameProjectFolder(a, 'Alpha')).toBeNull()
  })
})

describe('v3 migration: moveProjectToOwnFolder', () => {
  const V2_FIXTURE: [string, string[]][] = [
    ['Projects/Cases/Mig.md', ['pm-project: true', 'id: mig', 'title: Mig', 'taskIds:', '  - p1']],
    ['Projects/Tasks/Mig/parent.md', ['pm-task: true', 'id: p1', 'title: parent', 'subtaskIds:', '  - c1']],
    ['Projects/Tasks/Mig/parent/child.md', ['pm-task: true', 'id: c1', 'title: child', 'parentId: p1']],
    ['Projects/Tasks/Mig/Archive/old.md', ['pm-task: true', 'id: a1', 'title: old']]
  ]

  it('moves a v2 case into its own root folder, leaving unrelated notes untouched, idempotently', async () => {
    const { store, vault, app } = newStore()
    for (const [path, fm] of V2_FIXTURE) {
      await vault.create(path, ['---', ...fm, '---', ''].join('\n'))
    }
    await vault.create('Projects/keep-me.md', 'an unrelated note that must not move')

    const file = vault.getAbstractFileByPath('Projects/Cases/Mig.md')
    if (!(file instanceof TFile)) throw new Error('fixture project missing')
    const project = expectDefined(await store.loadProject(file))
    expect(flattenTasks(project.tasks).length).toBe(3)

    const moved = await store.moveProjectToOwnFolder(project, '')
    if (moved === 'occupied' || moved === null) throw new Error('expected a move')
    expect(moved.from).toBe('Projects/Cases/Mig.md')
    expect(moved.to).toBe('Mig/Mig.md')
    expect(moved.files).toBe(4) // project file + 2 live tasks + 1 archived

    expect(vault.getAbstractFileByPath('Mig/Mig.md')).toBeInstanceOf(TFile)
    expect(vault.getAbstractFileByPath('Mig/Tasks/parent.md')).toBeInstanceOf(TFile)
    expect(vault.getAbstractFileByPath('Mig/Tasks/parent/child.md')).toBeInstanceOf(TFile)
    expect(vault.getAbstractFileByPath('Mig/Tasks/Archive/old.md')).toBeInstanceOf(TFile)
    expect(project.filePath).toBe('Mig/Mig.md')

    // The old skeleton is empty; the unrelated note stays put.
    expect(vault.getAbstractFileByPath('Projects/keep-me.md')).toBeInstanceOf(TFile)
    const oldCases = vault.getAbstractFileByPath('Projects/Cases')
    const oldTasks = vault.getAbstractFileByPath('Projects/Tasks')
    expect(oldCases instanceof TFolder && oldCases.children.length).toBe(0)
    expect(oldTasks instanceof TFolder && oldTasks.children.length).toBe(0)

    // Idempotent: already at the target.
    expect(await store.moveProjectToOwnFolder(project, '')).toBeNull()

    const movedFile = vault.getAbstractFileByPath('Mig/Mig.md')
    if (!(movedFile instanceof TFile)) throw new Error('moved project file missing')
    const reloaded = expectDefined(await new ProjectStore(app, () => SETTINGS).loadProject(movedFile))
    const rParent = expectDefined(flattenTasks(reloaded.tasks).find((f) => f.task.id === 'p1')).task
    expect(rParent.subtasks.map((s) => s.id)).toEqual(['c1'])
    expect(expectDefined(flattenTasks(reloaded.tasks).find((f) => f.task.id === 'a1')).task.archived).toBe(true)
  })

  it('refuses when the target root folder is already taken', async () => {
    const { store, vault } = newStore()
    await vault.create(
      'Projects/Cases/Clash.md',
      ['---', 'pm-project: true', 'id: clash', 'title: Clash', 'taskIds: []', '---', ''].join('\n')
    )
    await vault.createFolder('Clash')
    const file = vault.getAbstractFileByPath('Projects/Cases/Clash.md')
    if (!(file instanceof TFile)) throw new Error('fixture project missing')
    const project = expectDefined(await store.loadProject(file))
    expect(await store.moveProjectToOwnFolder(project, '')).toBe('occupied')
    expect(project.filePath).toBe('Projects/Cases/Clash.md')
  })

  it('moves a v3-shaped project that still sits under the old projects folder', async () => {
    const { store, vault } = newStore()
    const project = await store.createProject('Nested', 'Projects')
    await addNamed(store, project, 'task')

    const moved = await store.moveProjectToOwnFolder(project, '')
    if (moved === 'occupied' || moved === null) throw new Error('expected a move')
    expect(moved.to).toBe('Nested/Nested.md')
    expect(project.filePath).toBe('Nested/Nested.md')
    expect(vault.getAbstractFileByPath('Nested/Tasks/task.md')).toBeInstanceOf(TFile)
    expect(vault.getAbstractFileByPath('Projects/Nested')).toBeNull()
  })
})

describe('comments persistence', () => {
  it('appending a comment via updateTask survives a full rewrite and reload', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Journal', 'Projects')
    const t = await addNamed(store, project, 'Investigated')

    await store.updateTask(project, t.id, {
      comments: [{ at: '2026-07-30 14:32', text: 'First finding' }]
    })

    const file = vault.getAbstractFileByPath(project.filePath)
    if (!(file instanceof TFile)) throw new Error('missing file')
    const reloaded = expectDefined(await new ProjectStore(app, () => SETTINGS).loadProject(file))
    const rt = expectDefined(findTask(reloaded.tasks, t.id))
    await new ProjectStore(app, () => SETTINGS).loadTaskBody(rt)
    expect(rt.comments).toEqual([{ at: '2026-07-30 14:32', text: 'First finding' }])
  })

  it('a frontmatter-only save of an UNHYDRATED task leaves on-disk comments intact', async () => {
    const { store, vault, app } = newStore()
    const project = await store.createProject('Keep', 'Projects')
    const t = await addNamed(store, project, 'Commented')
    await store.updateTask(project, t.id, { comments: [{ at: '2026-07-30 09:00', text: 'Keep me' }] })

    // Fresh store = fresh hydratedBodies; cache-loaded task body is unread.
    const file = vault.getAbstractFileByPath(project.filePath)
    if (!(file instanceof TFile)) throw new Error('missing file')
    const store2 = new ProjectStore(app, () => SETTINGS)
    const p2 = expectDefined(await store2.loadProject(file))
    const t2 = expectDefined(findTask(p2.tasks, t.id))

    // 'fm' save (status) then a 'full' save (title rename) — the dangerous path.
    await store2.updateTask(p2, t2.id, { status: 'in-progress' })
    await store2.updateTask(p2, t2.id, { title: 'Commented renamed' })

    const store3 = new ProjectStore(app, () => SETTINGS)
    const file3 = vault.getAbstractFileByPath(project.filePath)
    if (!(file3 instanceof TFile)) throw new Error('missing file')
    const p3 = expectDefined(await store3.loadProject(file3))
    const t3 = expectDefined(findTask(p3.tasks, t2.id))
    await store3.loadTaskBody(t3)
    expect(t3.comments).toEqual([{ at: '2026-07-30 09:00', text: 'Keep me' }])
  })
})
