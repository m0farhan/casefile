import type { App, Command } from 'obsidian'
import { TFile } from 'obsidian'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeApp, type FakeVault } from '../test/fakeVault'
import PMPlugin from './main'
import { ProjectStore } from './store'
import { DEFAULT_SETTINGS, makeProject, makeTask, type PMSettings, type Project } from './types'
import { confirmDialog, openImportModal, openProjectPicker, promptText } from './ui/ModalFactory'
import { ProjectView } from './views/ProjectView'

const notices: string[] = []

vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  class Notice {
    constructor(msg: string) {
      notices.push(msg)
    }
    hide(): void {}
  }
  const given: Record<string, unknown> = { ...real, Notice }
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
vi.mock('./ui/ModalFactory', () => ({
  confirmDialog: vi.fn<() => Promise<boolean>>(async () => true),
  promptText: vi.fn<() => Promise<string | null>>(),
  openProjectPicker: vi.fn<(p: unknown, list: Project[], choose: (p: Project) => void) => void>(),
  openImportModal: vi.fn<() => void>(),
  openProjectModal: vi.fn<() => void>(),
  openTaskModal: vi.fn<() => void>(),
  openTaskPicker: vi.fn<() => void>(),
  openCasePicker: vi.fn<() => void>()
}))

/** The plugin members a test reaches, private ones included; the class type itself hides them. */
type Plugin = Pick<
  PMPlugin,
  | 'settings'
  | 'store'
  | 'undoStack'
  | 'redoStack'
  | 'pushUndo'
  | 'undoLastAction'
  | 'redoLastAction'
  | 'onload'
  | 'moveProjectToFolder'
> & {
  stripBoardBacklinks(): Promise<void>
  adoptIssueKeysFlow(): Promise<void>
  importNotes(): Promise<void>
  migrateToProjectFolders(): Promise<void>
}

/** A plugin over a fake vault and a real store, without onload. */
function makePlugin(settings: Partial<PMSettings> = {}): {
  plugin: Plugin
  vault: FakeVault
  app: ReturnType<typeof makeFakeApp>['app'] & Record<string, unknown>
} {
  const { app, vault } = makeFakeApp()
  const full = { ...(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as PMSettings), ...settings }
  const plugin = Object.create(PMPlugin.prototype) as Plugin
  Object.assign(app, { workspace: { getLeavesOfType: () => [], getActiveViewOfType: () => null } })
  Object.assign(plugin, {
    app,
    settings: full,
    store: new ProjectStore(app as unknown as App, () => full),
    undoStack: [],
    redoStack: [],
    ownMoves: 0,
    saveData: async () => {},
    router: { openProjectByPath: async () => {} }
  })
  return { plugin, vault, app: app as ReturnType<typeof makeFakeApp>['app'] & Record<string, unknown> }
}

beforeEach(() => {
  notices.length = 0
  vi.mocked(confirmDialog).mockClear()
  vi.mocked(promptText).mockReset()
  vi.mocked(openImportModal).mockClear()
  vi.mocked(openProjectPicker).mockImplementation((_p, list, choose) => choose(list[0]))
})

describe('Undo last gantt date change', () => {
  it('names what it reverted, keeps a failed entry, and says when there is nothing', async () => {
    const { plugin } = makePlugin()
    await plugin.undoLastAction()
    expect(notices).toEqual(['Nothing to undo.'])

    const undo = vi.fn<() => Promise<void>>(async () => {})
    plugin.pushUndo({ undo, redo: async () => {}, label: 'dates of "Case A" on Queue' })
    await plugin.undoLastAction()
    expect(undo).toHaveBeenCalledOnce()
    expect(notices.at(-1)).toBe('Reverted dates of "Case A" on Queue.')
    expect(plugin.redoStack).toHaveLength(1)

    const failing = { undo: async () => Promise.reject(new Error('gone')), redo: async () => {} }
    plugin.pushUndo(failing)
    await plugin.undoLastAction()
    expect(notices.at(-1)).toBe('Could not undo: the case may have changed or been removed.')
    expect(plugin.undoStack.at(-1)).toBe(failing)
  })
})

describe('onload commands and listeners', () => {
  async function load(): Promise<{
    plugin: Plugin
    commands: Map<string, Command>
    renames: ((file: unknown, oldPath: string) => unknown)[]
    app: Record<string, unknown>
  }> {
    const { plugin, app } = makePlugin()
    const commands = new Map<string, Command>()
    const renames: ((file: unknown, oldPath: string) => unknown)[] = []
    const vaultOn = app.vault.on.bind(app.vault)
    Object.assign(app.vault, {
      on: (name: string, fn: (file: unknown, oldPath: string) => unknown) => {
        if (name === 'rename') renames.push(fn)
        return vaultOn(name as 'rename', fn as never)
      }
    })
    Object.assign(app.workspace as object, { onLayoutReady: () => {}, on: () => ({}) })
    Object.assign(plugin, {
      loadSettings: async () => {},
      registerView: () => {},
      addRibbonIcon: () => {},
      addCommand: (c: Command) => commands.set(c.id, c),
      registerEvent: () => {},
      addSettingTab: () => {},
      registerInterval: () => {}
    })
    vi.stubGlobal('__STYLEGUIDE__', false)
    vi.stubGlobal('activeDocument', { body: { classList: { toggle: () => {} } } })
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1 })
    await plugin.onload()
    return { plugin, commands, renames, app }
  }

  it('offers undo and redo by what they undo, and only when there is something', async () => {
    const { plugin, commands } = await load()
    const undo = commands.get('undo-last-action')
    const redo = commands.get('redo-last-action')
    expect(undo?.name).toBe('Undo last gantt date change')
    expect(redo?.name).toBe('Redo last gantt date change')
    expect(undo?.checkCallback?.(true)).toBe(false)
    plugin.pushUndo({ undo: async () => {}, redo: async () => {} })
    expect(undo?.checkCallback?.(true)).toBe(true)
    expect(redo?.checkCallback?.(true)).toBe(false)
  })

  it('reports a failed case report instead of dropping it', async () => {
    const { plugin, commands, app } = await load()
    const file = Object.assign(new TFile(), { path: 'Queue/Tasks/A.md' })
    Object.assign(app.workspace as object, { getActiveFile: () => file })
    plugin.store.loadAllProjects = () => Promise.reject(new Error('disk'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    commands.get('generate-case-report')?.callback?.()
    await vi.waitFor(() => expect(notices).toContain('Something went wrong. Check the console for details.'))
    errors.mockRestore()
  })

  it('follows a board note renamed outside: settings re-keyed, the open view pointed at it', async () => {
    const { plugin, renames, app } = await load()
    const view = Object.create(ProjectView.prototype) as ProjectView
    view.filePath = 'Queue/Queue.md'
    const setViewState = vi.fn<() => Promise<void>>(async () => {})
    Object.assign(app.workspace as object, { getLeavesOfType: () => [{ view, setViewState }] })
    plugin.settings.projectFilters['Queue/Queue.md'] = {
      filter: { ...DEFAULT_SETTINGS.projectFilters, statuses: ['todo'] } as never,
      activeSavedViewId: null
    }
    const moved = Object.assign(new TFile(), { path: 'IR/Queue/Queue.md', extension: 'md' })
    for (const fn of renames) await fn(moved, 'Queue/Queue.md')
    await vi.waitFor(() => expect(setViewState).toHaveBeenCalledOnce())
    expect(setViewState).toHaveBeenCalledWith({
      type: 'casefile-project',
      state: { filePath: 'IR/Queue/Queue.md', keepView: true }
    })
    expect(Object.keys(plugin.settings.projectFilters)).toEqual(['IR/Queue/Queue.md'])
  })
})

describe('Remove board backlinks', () => {
  it('finds every note carrying the generated line, and leaves a hand-written one', async () => {
    const { plugin, vault, app } = makePlugin()
    const generated = '---\npm-task: true\n---\n\nBody.\n\nProject: [[Queue|Queue]]\n'
    const hand = '---\npm-task: true\n---\n\nProject: [[Acme onboarding]]\nBody.\n'
    await vault.create('T/a.md', generated)
    await vault.create('T/b.md', generated)
    await vault.create('T/c.md', hand)
    Object.assign(app.metadataCache, { getFileCache: () => ({ frontmatter: { 'pm-task': true } }) })
    await plugin.stripBoardBacklinks()
    expect(vi.mocked(confirmDialog).mock.calls[0][1]).toMatch(/from 2 task note/)
    for (const p of ['T/a.md', 'T/b.md']) {
      const f = vault.getAbstractFileByPath(p)
      if (!(f instanceof TFile)) throw new Error(p)
      expect(await vault.cachedRead(f)).not.toContain('Project: [[')
    }
    const c = vault.getAbstractFileByPath('T/c.md')
    if (!(c instanceof TFile)) throw new Error('c')
    expect(await vault.cachedRead(c)).toBe(hand)
  })
})

describe('Adopt issue keys', () => {
  it('asks for the prefix before writing, pre-filled with the majority it found', async () => {
    const { plugin } = makePlugin()
    const board = await plugin.store.createProject('Intel', '')
    const tasks = ['APT-29 spearphish', 'APT-28 creds', 'SOC-4 Fix things'].map((title) => makeTask({ title }))
    for (const t of tasks) await plugin.store.insertTask(board, t)
    vi.mocked(promptText).mockResolvedValue('soc')
    await plugin.adoptIssueKeysFlow()
    await vi.waitFor(() => expect(board.keyPrefix).toBe('SOC'))
    expect(vi.mocked(promptText).mock.calls[0][3]).toEqual({ value: 'APT' })
    expect(vi.mocked(confirmDialog).mock.calls[0][1]).toMatch(/^Adopt issue keys with the prefix SOC\./)
    // The analyst's prefix, not the vote: APT titles keep their text.
    expect(tasks.map((t) => t.title)).toEqual(['APT-29 spearphish', 'APT-28 creds', 'Fix things'])
    expect(tasks.map((t) => t.key)).toEqual(['SOC-5', 'SOC-6', 'SOC-4'])
    expect(tasks[0].filePath).toBe('Intel/Tasks/APT-29 spearphish.md')
  })
})

describe('Import notes as tasks', () => {
  it('imports into the board in focus, not the first one open', async () => {
    const { plugin, app } = makePlugin()
    const views = ['A/A.md', 'B/B.md'].map((path) => {
      const v = Object.create(ProjectView.prototype) as ProjectView
      v.project = makeProject(path.slice(0, 1), path)
      return v
    })
    Object.assign(app.workspace as object, {
      getLeavesOfType: () => views.map((view) => ({ view })),
      getActiveViewOfType: () => views[1]
    })
    await plugin.importNotes()
    expect(vi.mocked(openImportModal).mock.calls[0][1]).toBe(views[1].project)
  })
})

describe('Move each board into its own folder', () => {
  it('moves only boards without their own folder, in place, and keeps the default folder', async () => {
    const { plugin, vault } = makePlugin({ projectsFolder: 'SOC' })
    await plugin.store.createProject('Queue', 'SOC')
    await vault.create('SOC/Old.md', '---\npm-project: true\ntitle: Old\ntaskIds: []\n---\n\n# Old\n')
    await plugin.migrateToProjectFolders()
    expect(vault.getAbstractFileByPath('SOC/Queue/Queue.md')).toBeInstanceOf(TFile)
    expect(vault.getAbstractFileByPath('SOC/Old/Old.md')).toBeInstanceOf(TFile)
    expect(vault.getAbstractFileByPath('Queue/Queue.md')).toBeNull()
    expect(plugin.settings.projectsFolder).toBe('SOC')
    expect(notices.at(-1)).toMatch(/^Moved 1 board\(s\)/)
  })
})

describe('Move board to folder', () => {
  it("refuses a folder inside another board's own folder, saying why and creating nothing", async () => {
    const { plugin, vault } = makePlugin()
    await plugin.store.createProject('Outer', '')
    const inner = await plugin.store.createProject('Inner', '')
    expect(await plugin.moveProjectToFolder(inner, 'Outer/Sub')).toBe(false)
    expect(notices.at(-1)).toMatch(/is inside the folder of the board "Outer".*Board not moved\.$/)
    expect(vault.getAbstractFileByPath('Outer/Sub')).toBeNull()
    expect(vault.getAbstractFileByPath('Inner/Inner.md')).toBeInstanceOf(TFile)
  })
})
