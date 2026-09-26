import type { App } from 'obsidian'
import { TFile } from 'obsidian'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeApp, type FakeVault } from '../../test/fakeVault'
import PMPlugin from '../main'
import { ProjectStore } from '../store'
import { DEFAULT_SETTINGS, makeTask, type PMSettings, type Project, type StatusConfig } from '../types'
import { confirmDialog } from '../ui/ModalFactory'
import { ProjectModal } from './ProjectModal'

const notices: string[] = []
/** The footer buttons of the modal under test, by label. */
const buttons: { label: string; click: () => unknown }[] = []

vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  class Modal {
    contentEl = fakeEl()
    modalEl = fakeEl()
    closed = false
    constructor(public app: unknown) {}
    open(): void {}
    close(): void {
      this.closed = true
    }
  }
  class ButtonComponent {
    entry = { label: '', click: (): unknown => undefined }
    constructor() {
      buttons.push(this.entry)
    }
    setButtonText(t: string): this {
      this.entry.label = t
      return this
    }
    setCta(): this {
      return this
    }
    onClick(fn: () => unknown): this {
      this.entry.click = fn
      return this
    }
  }
  class Notice {
    constructor(msg: string) {
      notices.push(msg)
    }
    hide(): void {}
  }
  const given: Record<string, unknown> = { ...real, Modal, ButtonComponent, Notice }
  // Anything else the import chain names only has to exist.
  function Stub(): void {}
  return new Proxy(given, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string]
      if (typeof prop !== 'string' || prop === 'then') return undefined
      return Stub
    },
    has: () => true
  })
})
vi.mock('../ui/ModalFactory', () => ({
  confirmDialog: vi.fn<() => Promise<boolean>>(async () => true),
  promptText: vi.fn<() => Promise<null>>(async () => null),
  openProjectModal: vi.fn<() => void>(),
  openTaskModal: vi.fn<() => void>(),
  openProjectPicker: vi.fn<() => void>(),
  openTaskPicker: vi.fn<() => void>(),
  openCasePicker: vi.fn<() => void>(),
  openImportModal: vi.fn<() => void>()
}))
vi.mock('../ui/primitives/Avatar', () => ({
  Avatar: class {
    setName(): this {
      return this
    }
  }
}))
vi.mock('../ui/primitives/IconButton', () => ({
  IconButton: class {
    setIcon(): this {
      return this
    }
    setTooltip(): this {
      return this
    }
    onClick(): this {
      return this
    }
  }
}))
vi.mock('../ui/composites/addButton', () => ({ renderAddButton: vi.fn<() => void>() }))
vi.mock('../ui/PaletteListEditor', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  renderStatusListEditor: vi.fn<() => void>()
}))

/** A DOM stand-in: keeps tag, class, value and text, remembers listeners and children. */
interface FakeEl {
  tag: string
  cls: string
  value: string
  text: string
  on: Record<string, () => unknown>
  kids: FakeEl[]
  [key: string]: unknown
}
function fakeEl(tag = 'div', info?: string | { cls?: string; value?: string; text?: string }): FakeEl {
  const opts = typeof info === 'string' ? { cls: info } : (info ?? {})
  const el: FakeEl = { tag, cls: opts.cls ?? '', value: opts.value ?? '', text: opts.text ?? '', on: {}, kids: [] }
  const child = (t: string, i?: string | { cls?: string; value?: string; text?: string }): FakeEl => {
    const kid = fakeEl(t, i)
    el.kids.push(kid)
    return kid
  }
  Object.assign(el, {
    empty: () => (el.kids.length = 0),
    addClass: () => {},
    removeClass: () => {},
    toggleClass: () => {},
    hasClass: () => false,
    focus: () => {},
    select: () => {},
    setCssStyles: () => {},
    setText: (t: string) => (el.text = t),
    querySelectorAll: () => [],
    addEventListener: (k: string, fn: () => unknown) => (el.on[k] = fn),
    createDiv: (i?: string | { cls?: string; text?: string }) => child('div', i),
    createSpan: (i?: { cls?: string; text?: string }) => child('span', i),
    createEl: child
  })
  return el
}
const all = (el: FakeEl): FakeEl[] => [el, ...el.kids.flatMap(all)]

interface Opened {
  modal: ProjectModal
  field: (tag: string, cls: string) => FakeEl
  type: (el: FakeEl, value: string) => void
  save: () => Promise<void>
}

/** Open the board dialog as openProjectModal does, on a fake vault with a real store and plugin. */
function open(plugin: PMPlugin, project: Project | null): Opened {
  const saved = vi.fn<(p: Project) => void>()
  buttons.length = 0
  const modal = new ProjectModal(plugin.app, plugin, project, saved)
  modal.onOpen()
  const root = (modal as unknown as { contentEl: FakeEl }).contentEl
  const field = (tag: string, cls: string): FakeEl => {
    const hit = all(root).find((e) => e.tag === tag && e.cls === cls)
    if (!hit) throw new Error(`no ${tag}.${cls}`)
    return hit
  }
  const type = (el: FakeEl, value: string): void => {
    el.value = value
    el.on.input?.()
    el.on.change?.()
  }
  const save = async (): Promise<void> => {
    const button = buttons.find((b) => b.label === 'Save' || b.label === '+ Create board')
    button?.click()
    await vi.waitFor(() => expect((modal as unknown as { closed: boolean }).closed || notices.length > 0).toBe(true))
  }
  return { modal, field, type, save }
}

function setup(settings: Partial<PMSettings> = {}): { plugin: PMPlugin; store: ProjectStore; vault: FakeVault } {
  const { app, vault } = makeFakeApp()
  const full = { ...(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as PMSettings), ...settings }
  Object.assign(app, { workspace: { getLeavesOfType: () => [] } })
  const store = new ProjectStore(app as unknown as App, () => full)
  const plugin = Object.create(PMPlugin.prototype) as PMPlugin
  Object.assign(plugin, { app, settings: full, store, ownMoves: 0, saveData: async () => {} })
  return { plugin, store, vault }
}

/** The board read back by a fresh store, as after a restart. */
async function reread(vault: FakeVault, path: string, settings: PMSettings): Promise<Project | null> {
  const fresh = new ProjectStore(
    { vault, fileManager: {}, metadataCache: { getFileCache: () => null } } as unknown as App,
    () => settings
  )
  const f = vault.getAbstractFileByPath(path)
  return f instanceof TFile ? fresh.loadProject(f) : null
}

beforeEach(() => {
  notices.length = 0
  vi.mocked(confirmDialog).mockClear()
  vi.stubGlobal('window', { setTimeout: () => 1 })
})

describe('Board settings on an existing board', () => {
  it('saves the description, and board fields survive a later save through the board', async () => {
    const { plugin, store, vault } = setup()
    const board = await store.createProject('Queue', '')
    board.description = 'old description'
    await store.saveProject(board)
    const task = makeTask({ title: 'Case' })
    await store.insertTask(board, task)

    const { field, type, save } = open(plugin, board)
    type(field('textarea', 'pm-input pm-project-desc'), 'new description')
    type(field('input', 'pm-input pm-keyprefix-input'), 'soc')
    await save()
    await store.updateTask(board, task.id, { status: 'in-progress' })

    const back = await reread(vault, 'Queue/Queue.md', plugin.settings)
    expect(back?.description).toBe('new description')
    expect(back?.keyPrefix).toBe('SOC')
  })

  it('renames the board it was opened on, leaving nothing at the old path', async () => {
    const { plugin, store, vault } = setup()
    const board = await store.createProject('Old', '')
    const task = makeTask({ title: 'Case' })
    await store.insertTask(board, task)
    const { field, type, save } = open(plugin, board)
    type(field('input', 'pm-input pm-input--lg'), 'New')
    await save()
    expect(board.filePath).toBe('New/New.md')
    await store.updateTask(board, task.id, { status: 'done' })
    expect(vault.getAbstractFileByPath('Old/Old.md')).toBeNull()
    expect(vault.getAbstractFileByPath('New/New.md')).toBeInstanceOf(TFile)
  })

  it('refuses a rename plus a move into a taken folder before either touches disk', async () => {
    const { plugin, store, vault } = setup()
    const board = await store.createProject('Alpha', 'Boards')
    await store.createProject('Beta', 'Other')
    const { field, type, save } = open(plugin, board)
    type(field('input', 'pm-input pm-input--lg'), 'Beta')
    type(field('input', 'pm-input'), 'Other')
    await save()
    expect(notices).toEqual(['Other/Beta already exists — board not renamed or moved.'])
    expect(vault.getAbstractFileByPath('Boards/Alpha/Alpha.md')).toBeInstanceOf(TFile)
    expect(vault.getAbstractFileByPath('Boards/Beta')).toBeNull()
    expect(board.title).toBe('Alpha')
  })

  it('changes the board type', async () => {
    const { plugin, store } = setup()
    const board = await store.createProject('Queue', '')
    const { field, type, save } = open(plugin, board)
    const select = field('select', 'pm-input')
    type(select, 'plain')
    await save()
    expect(board.config?.boardType).toBe('plain')
  })

  it('names the real path of an older-layout board', async () => {
    const { plugin, store, vault } = setup()
    await vault.create('Projects/Old.md', '---\npm-project: true\ntitle: Old\ntaskIds: []\n---\n\n# Old\n')
    const f = vault.getAbstractFileByPath('Projects/Old.md')
    if (!(f instanceof TFile)) throw new Error('fixture')
    const board = await store.loadProject(f)
    const { modal } = open(plugin, board)
    const text = all((modal as unknown as { contentEl: FakeEl }).contentEl).map((e) => e.text)
    expect(text).toContain('Lives at Projects/Old.md. Type another path to move it there.')
  })

  it('moves cases off a status removed from the board list, to one of the same kind, unstamped', async () => {
    const statuses: StatusConfig[] = [
      { id: 'todo', label: 'To do', color: '#888', icon: '', complete: false },
      { id: 'done', label: 'Done', color: '#0a0', icon: '', complete: true },
      { id: 'closed', label: 'Closed', color: '#555', icon: '', complete: true }
    ]
    const { plugin, store } = setup()
    const board = await store.createProject('Queue', '')
    board.config = { statuses }
    await store.saveProject(board)
    const task = makeTask({ title: 'Case', issueType: 'incident', status: 'done', completed: '2025-01-01' })
    await store.insertTask(board, task)
    const { modal, save } = open(plugin, board)
    const draft = (modal as unknown as { project: Project }).project
    draft.config = { statuses: statuses.filter((s) => s.id !== 'done') }
    await save()
    expect(vi.mocked(confirmDialog).mock.calls[0][1]).toMatch(/Saving moves them: 1 from "Done" to "Closed"/)
    expect(task.status).toBe('closed')
    expect(task.completed).toBe('2025-01-01')
    expect(task.respondedAt).toBe('')
  })
})

describe('Board settings for a new board', () => {
  it("refuses a folder inside another board's own folder, saying why", async () => {
    const { plugin, store, vault } = setup()
    await store.createProject('Outer', '')
    const { field, type, save } = open(plugin, null)
    type(field('input', 'pm-input pm-input--lg'), 'Inner')
    type(field('input', 'pm-input'), 'Outer')
    await save()
    expect(notices[0]).toMatch(/is inside the folder of the board "Outer".*Board not created\.$/)
    expect(vault.getAbstractFileByPath('Outer/Inner')).toBeNull()
  })
})
