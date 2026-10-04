import { type App, TFile } from 'obsidian'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeApp } from '../../test/fakeVault'
import type PMPlugin from '../main'
import { ProjectStore } from '../store/ProjectStore'
import { findTaskById } from '../store/TaskIndex'
import { guardVerdictOnClose } from '../soc/verdictGuard'
import { DEFAULT_SETTINGS, makeTask, type PMSettings, type Task } from '../types'
import { confirmDialog } from '../ui/ModalFactory'
import { BOARD_REFUSAL, TaskModal, TITLE_REFUSAL } from './TaskModal'

const { notices, menuItems } = vi.hoisted(() => ({
  notices: [] as string[],
  menuItems: [] as { title: string; run: () => void }[]
}))

// Modal and Menu as the modal uses them; everything else the import chain
// extends resolves to a bare stand-in (views have no DOM here).
vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  function Stub(): void {}
  const overrides: Record<string, unknown> = {
    Notice: class {
      constructor(message: string) {
        notices.push(message)
      }
      hide(): void {}
    },
    Modal: class {
      closed = false
      constructor(public app: unknown) {}
      close(): void {
        this.closed = true
        ;(this as unknown as { onClose(): void }).onClose()
      }
    },
    Menu: class {
      addItem(build: (item: object) => void): this {
        const entry = { title: '', run: () => {} }
        const item = {
          setTitle: (t: string) => {
            entry.title = t
            return item
          },
          setIcon: () => item,
          setWarning: () => item,
          onClick: (fn: () => void) => {
            entry.run = fn
            return item
          }
        }
        build(item)
        menuItems.push(entry)
        return this
      }
      addSeparator(): this {
        return this
      }
      showAtPosition(): void {}
    }
  }
  return new Proxy(real, {
    get: (target, prop) => {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop]
      if (prop in target) return target[prop as string]
      if (typeof prop !== 'string' || prop === 'then') return undefined
      return Stub
    },
    has: () => true
  })
})
vi.mock('../ui/ModalFactory', () => ({
  confirmDialog: vi.fn<() => Promise<boolean>>(),
  openIndicatorSearch: vi.fn<() => void>(),
  openTaskModal: vi.fn<() => void>()
}))
vi.mock('../soc/verdictGuard', () => ({ guardVerdictOnClose: vi.fn<() => Promise<object | null>>() }))

/** The modal's private surface these tests drive; it is never rendered here. */
interface Harness {
  task: Task
  closed: boolean
  contentEl: { empty(): void }
  render(): void
  persistTask(): Promise<void>
  openOverflowMenu(anchor: unknown, titleError: (m: string) => void): void
  closeThen(go: () => void): void
  close(): void
  onClose(): void
  syncProgress(): void
  writeAttachment(name: string, data: ArrayBuffer): Promise<{ path: string }>
}

async function setup(fields: Partial<Task> = {}, settings: PMSettings = DEFAULT_SETTINGS) {
  const { app, vault } = makeFakeApp()
  const store = new ProjectStore(app as unknown as App, () => settings)
  const project = await store.createProject('Board', 'Projects')
  const plugin = { store, settings, refreshProjectViews: () => {} } as unknown as PMPlugin
  const add = async (title: string, more: Partial<Task> = {}): Promise<Task> => {
    const t = makeTask({ title, ...more })
    await store.insertTask(project, t, null)
    return t
  }
  const open = (task: Task | null): Harness => {
    const m = new TaskModal(app as unknown as App, plugin, project, task, null, () => {}) as unknown as Harness
    m.contentEl = { empty: () => {} }
    return m
  }
  const live = (id: string): Task => {
    const t = findTaskById(project, id)
    if (!t) throw new Error(`no task ${id}`)
    return t
  }
  const task = await add('Case', fields)
  return { store, project, vault, add, open, live, task }
}

/** One macrotask: every promise the handler chained has settled by then (the fake vault never waits on I/O). */
const settle = () => new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))

/** Runs the overflow menu's item and waits out its async handler. */
async function choose(m: Harness, title: string, titleError: (message: string) => void = () => {}): Promise<void> {
  menuItems.length = 0
  m.openOverflowMenu({ getBoundingClientRect: () => ({ left: 0, bottom: 0 }) }, titleError)
  const item = menuItems.find((i) => i.title === title)
  if (!item) throw new Error(`no ${title} item`)
  item.run()
  await settle()
}

beforeEach(() => {
  notices.length = 0
  vi.mocked(confirmDialog).mockReset()
  vi.mocked(guardVerdictOnClose).mockReset().mockResolvedValue({})
})

describe('TaskModal saving', () => {
  it('a second save after the first one finished reaches the store', async () => {
    const { open, live, task } = await setup()
    const m = open(task)
    m.task.description = 'edit one'
    await m.persistTask()
    m.task.description = 'edit two'
    await m.persistTask()
    expect(live(task.id).description).toBe('edit two')
  })

  it('after a failed Archive, later edits still save, and a rename is not its own conflict', async () => {
    const { store, project, open, add, live } = await setup()
    const first = await add('Dup')
    await store.archiveTask(project, first.id)
    const second = await add('Dup')
    const m = open(second)
    m.task.description = 'edit one'
    vi.spyOn(console, 'error').mockImplementationOnce(() => {}) // safeAsync reports the failure
    await choose(m, 'Archive') // the archive note name is taken, so the move fails
    expect(live(second.id).archived).toBeFalsy()
    m.task.description = 'edit two'
    m.task.title = 'Renamed'
    await m.persistTask()
    expect(live(second.id).description).toBe('edit two')
    expect(store.findTaskFileConflict(project, m.task)).toBeNull()
  })

  it('Archive runs the verdict prompt when it closes an incident, and Cancel archives nothing', async () => {
    const { open, live, task } = await setup({ issueType: 'incident' })
    vi.mocked(guardVerdictOnClose).mockResolvedValueOnce(null)
    const m = open(task)
    m.task.status = 'done'
    await choose(m, 'Archive')
    expect(guardVerdictOnClose).toHaveBeenCalledOnce()
    expect(live(task.id).status).toBe('todo')
    expect(live(task.id).archived).toBeFalsy()
  })

  it('Archive with a cleared title says so and writes nothing', async () => {
    const { open, live, task, vault } = await setup()
    const errors: string[] = []
    const m = open(task)
    m.task.title = ''
    await choose(m, 'Archive', (e) => errors.push(e))
    expect(errors).toEqual(['A title is required.'])
    expect(live(task.id).title).toBe('Case')
    expect(live(task.id).archived).toBeFalsy()
    expect(vault.getAbstractFileByPath('Projects/Board/Tasks/Archive/.md')).toBeNull()
  })

  it('closing with a title another note has keeps the old title and saves the rest', async () => {
    const { open, add, live, task } = await setup()
    await add('Beta')
    const m = open(task)
    m.task.description = 'EVIDENCE: attacker IP seen'
    m.task.title = 'Beta'
    m.onClose()
    await vi.waitFor(() => expect(live(task.id).description).toBe('EVIDENCE: attacker IP seen'))
    expect(live(task.id).title).toBe('Case')
    expect(notices).toEqual(['Title kept — a note named "Beta" already exists.'])
  })

  it('a Done pick fills progress, and a verdict prompt cancelled on close puts it back with the status', async () => {
    const { open, live, task } = await setup({ issueType: 'incident', progress: 25 })
    vi.mocked(guardVerdictOnClose).mockResolvedValueOnce(null)
    const m = open(task)
    m.task.status = 'done' // what the Status control or the header lozenge does
    m.syncProgress()
    expect(m.task.progress).toBe(100)
    m.task.description = 'other edit'
    m.onClose()
    await vi.waitFor(() => expect(live(task.id).description).toBe('other edit'))
    expect(live(task.id).status).toBe('todo')
    expect(live(task.id).progress).toBe(25)
  })

  it('closing with a title no file name can hold keeps the old title and saves the rest', async () => {
    const { open, live, task } = await setup()
    const m = open(task)
    m.task.title = '...'
    m.task.description = 'EVIDENCE'
    m.onClose()
    await vi.waitFor(() => expect(live(task.id).description).toBe('EVIDENCE'))
    expect(live(task.id).title).toBe('Case')
  })

  it('a file copied in and then closed unsaved goes to the trash; one a save kept stays', async () => {
    const { open, vault, task } = await setup({}, { ...DEFAULT_SETTINGS, saveTaskOnClose: false })
    const m = open(task)
    const kept = await m.writeAttachment('kept.exe', new ArrayBuffer(1))
    await m.persistTask()
    const dropped = await m.writeAttachment('sample.exe', new ArrayBuffer(1))
    m.close()
    await vi.waitFor(() => expect(vault.getAbstractFileByPath(dropped.path)).toBeNull())
    expect(vault.getAbstractFileByPath(kept.path)).not.toBeNull()
  })

  it('a copied file the case note on disk already links is never trashed (a save that failed part-way)', async () => {
    const { open, vault, task, live } = await setup({}, { ...DEFAULT_SETTINGS, saveTaskOnClose: false })
    const m = open(task)
    const linked = await m.writeAttachment('sample.exe', new ArrayBuffer(1))
    const note = vault.getAbstractFileByPath(live(task.id).filePath ?? '')
    if (!(note instanceof TFile)) throw new Error('no case note')
    await vault.process(note, (text) => `${text}\n[[sample.exe]]\n`)
    expect(linked.path.endsWith('/sample.exe')).toBe(true)
    m.close()
    await settle()
    expect(vault.getAbstractFileByPath(linked.path)).not.toBeNull()
  })

  it('a save on close that fails trashes the files only its edits linked', async () => {
    const { open, vault, task, store } = await setup()
    const m = open(task)
    const copied = await m.writeAttachment('sample.exe', new ArrayBuffer(1))
    m.task.description = 'edit'
    vi.spyOn(store, 'updateTask').mockRejectedValueOnce(new Error('disk full'))
    m.close()
    await vi.waitFor(() => expect(vault.getAbstractFileByPath(copied.path)).toBeNull())
  })

  it('a closed modal is never rebuilt: a late attach would leave editors nothing destroys', async () => {
    const { open, task } = await setup()
    const m = open(task)
    m.close()
    const empty = vi.fn<() => void>()
    m.contentEl = { empty }
    m.render()
    expect(empty).not.toHaveBeenCalled()
  })
})

describe('TaskModal new-case draft', () => {
  it('X, Esc or a click outside asks before a typed draft is dropped', async () => {
    const { open, project } = await setup()
    const m = open(null)
    m.task.title = 'Suspicious login'
    vi.mocked(confirmDialog).mockResolvedValueOnce(false)
    m.close()
    await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce())
    expect(m.closed).toBe(false)

    vi.mocked(confirmDialog).mockResolvedValueOnce(true)
    m.close()
    await vi.waitFor(() => expect(m.closed).toBe(true))
    expect(project.tasks.map((t) => t.title)).toEqual(['Case'])
  })

  it('leaving for another case waits for the answer, and Keep goes nowhere', async () => {
    const { open } = await setup()
    const m = open(null)
    m.task.title = 'Suspicious login'
    const go = vi.fn<() => void>()
    vi.mocked(confirmDialog).mockResolvedValueOnce(false)
    m.closeThen(go)
    await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce())
    await settle()
    expect(go).not.toHaveBeenCalled()
    expect(m.closed).toBe(false)
  })
})

describe('store refusals the modal and intake show as they are', () => {
  /** The message a store call is refused with, '' when it goes through. */
  const refusal = async (call: Promise<void>): Promise<string> => {
    try {
      await call
      return ''
    } catch (err) {
      return (err as Error).message
    }
  }

  it('the message prefixes match what the store throws', async () => {
    const { store, project } = await setup()
    expect(await refusal(store.insertTask(project, makeTask({ title: '   ' })))).toMatch(
      new RegExp(`^${TITLE_REFUSAL}`)
    )
    project.detached = { recorded: 1, folder: 'Projects/Board/Tasks' }
    expect(await refusal(store.insertTask(project, makeTask({ title: 'New' })))).toMatch(
      new RegExp(`^${BOARD_REFUSAL}New"`)
    )
  })
})
