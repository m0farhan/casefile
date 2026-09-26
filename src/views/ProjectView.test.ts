import { TFile } from 'obsidian'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type PMPlugin from '../main'
import { resolveProjectConfig } from '../store/ProjectConfig'
import {
  DEFAULT_SETTINGS,
  makeDefaultFilter,
  makeProject,
  type PMSettings,
  type Project,
  type SavedView,
  type ViewMode
} from '../types'
import { openProjectModal, openTaskModal } from '../ui/ModalFactory'
import { ProjectView } from './ProjectView'

/** Every toolbar button built, by its label or tooltip. */
const buttons: { label: string; click: () => unknown }[] = []
/** Constructor arguments of each TableView the view built. */
const tables: unknown[][] = []
/** Props of each ProjectHeader the view built. */
const headers: Record<string, unknown>[] = []

vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  class ItemView {
    registerEvent(): void {}
    async setState(): Promise<void> {}
  }
  class Button {
    entry = { label: '', click: (): unknown => undefined }
    constructor() {
      buttons.push(this.entry)
    }
    setButtonText(t: string): this {
      this.entry.label = t
      return this
    }
    setTooltip(t: string): this {
      this.entry.label = t
      return this
    }
    setIcon(): this {
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
  const given: Record<string, unknown> = {
    ...real,
    ItemView,
    ButtonComponent: Button,
    ExtraButtonComponent: Button,
    setTooltip: () => {}
  }
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
vi.mock('../ui/ModalFactory', () => ({ openProjectModal: vi.fn<() => void>(), openTaskModal: vi.fn<() => void>() }))
vi.mock('../ui/primitives/ViewSwitcher', () => ({
  ViewSwitcher: class {
    destroy(): void {}
  }
}))
vi.mock('../ui/composites/ProjectHeader', () => ({
  ProjectHeader: class {
    constructor(_el: unknown, props: Record<string, unknown>) {
      headers.push(props)
    }
    refresh(): void {}
    notifyMutation(): void {}
    setActiveSavedViewId(): void {}
  }
}))
vi.mock('./table/TableView', () => ({
  TableView: class {
    private state: unknown
    constructor(...args: unknown[]) {
      tables.push(args)
      this.state = args[5] ?? { sortKey: 'status', sortDir: 'asc' }
    }
    render(): void {}
    destroy(): void {}
    getViewState(): unknown {
      return this.state
    }
    getScrollTop(): number {
      return 0
    }
    setPendingScrollTop(): void {}
  }
}))
/** A subview that does nothing; hoisted, so the vi.mock factories below can reach it. */
function subview(): unknown {
  return class {
    render(): void {}
    destroy(): void {}
  }
}
vi.mock('./KanbanView', () => ({ KanbanView: subview() }))
vi.mock('./BacklogView', () => ({ BacklogView: subview() }))
vi.mock('./reports/ReportsView', () => ({ ReportsView: subview() }))
vi.mock('./gantt/GanttView', () => ({ GanttView: subview() }))

/** A DOM stand-in: keeps text, attributes, children and listeners. */
interface FakeEl {
  cls: string
  textContent: string
  attrs: Record<string, string>
  on: Record<string, (e?: unknown) => unknown>
  kids: FakeEl[]
  [key: string]: unknown
}
function fakeEl(info?: string | { cls?: string; text?: string; attr?: Record<string, string> }): FakeEl {
  const opts = typeof info === 'string' ? { cls: info } : (info ?? {})
  const el: FakeEl = {
    cls: opts.cls ?? '',
    textContent: opts.text ?? '',
    attrs: { ...opts.attr },
    on: {},
    kids: []
  }
  const child = (i?: string | { cls?: string; text?: string }): FakeEl => {
    const kid = fakeEl(i)
    el.kids.push(kid)
    return kid
  }
  Object.assign(el, {
    empty: () => (el.kids.length = 0),
    addClass: () => {},
    removeClass: () => {},
    toggleClass: () => {},
    hasAttribute: (k: string) => k in el.attrs,
    setAttribute: (k: string, v: string) => (el.attrs[k] = v),
    addEventListener: (k: string, fn: (e?: unknown) => unknown) => (el.on[k] = fn),
    createDiv: child,
    createSpan: child,
    createEl: (_tag: string, i?: { cls?: string; text?: string }) => child(i)
  })
  return el
}
const all = (el: FakeEl): FakeEl[] => [el, ...el.kids.flatMap(all)]

/** The members a test reaches, private ones included; the class type itself hides them. */
type View = Pick<ProjectView, 'setState' | 'showBoardMenu'> & {
  plugin: PMPlugin
  project: Project | null
  filePath: string
  currentView: ViewMode
  filter: ReturnType<typeof makeDefaultFilter>
  bodyEl: FakeEl
  titleEl2: FakeEl
  toolbarEl: FakeEl
  ensureInitialized(): void
  loadProject(): Promise<void>
  persistFilter(): Promise<void>
  handleSavedViewSelect(id: string | null): void
  handleSavedViewSave(name: string): Promise<void>
  renderProjectToolbar(): void
  renderCurrentView(): void
}

interface Harness {
  view: View
  settings: PMSettings
  vaultOn: Record<string, (...a: unknown[]) => unknown>
  timers: (() => unknown)[]
  saveProject: ReturnType<typeof vi.fn>
  renameProjectFiles: ReturnType<typeof vi.fn>
}

function harness(projects: Project[]): Harness {
  const settings: PMSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as PMSettings
  const vaultOn: Record<string, (...a: unknown[]) => unknown> = {}
  const files = new Map(
    projects.map((p) => {
      const f = new TFile()
      f.path = p.filePath
      f.extension = 'md'
      return [p.filePath, f]
    })
  )
  const saveProject = vi.fn<(p: Project) => Promise<void>>(async () => {})
  const renameProjectFiles = vi.fn<() => Promise<boolean>>(async () => true)
  const plugin = {
    settings,
    saveSettings: vi.fn<() => Promise<void>>(async () => {}),
    applyCollapsedState: () => {},
    renameProjectFiles,
    store: {
      loadProject: async (f: TFile) => projects.find((p) => p.filePath === f.path) ?? null,
      configFor: (p: Project) => resolveProjectConfig(p, settings),
      consumeSelfWrite: () => false,
      saveProject
    }
  }
  const view = Object.create(ProjectView.prototype) as View
  Object.assign(view, {
    plugin,
    app: {
      vault: {
        on: (name: string, fn: (...a: unknown[]) => unknown) => (vaultOn[name] = fn),
        getAbstractFileByPath: (p: string) => files.get(p) ?? null
      }
    },
    leaf: {},
    containerEl: fakeEl(),
    contentEl: fakeEl(),
    project: null,
    filePath: '',
    currentView: 'table',
    filter: makeDefaultFilter(),
    activeSavedViewId: null,
    subview: null,
    savedTableViewState: null,
    header: null,
    keydownHandler: null,
    reloadDebounceTimer: null,
    initialized: false,
    defaultViewAppliedFor: null,
    lastRenderedView: null
  })
  const timers: (() => unknown)[] = []
  vi.stubGlobal('window', {
    setTimeout: (fn: () => unknown) => timers.push(fn),
    clearTimeout: () => {}
  })
  return { view, settings, vaultOn, timers, saveProject, renameProjectFiles }
}

const board = (title: string, patch: Partial<Project> = {}): Project =>
  Object.assign(makeProject(title, `${title}/${title}.md`), patch)

beforeEach(() => {
  buttons.length = 0
  tables.length = 0
  headers.length = 0
  vi.mocked(openTaskModal).mockClear()
})

describe('ProjectView filters and saved views', () => {
  it('keeps the swimlane grouping when the filter is saved', async () => {
    const p = board('Queue')
    const { view, settings } = harness([p])
    await view.setState({ filePath: p.filePath }, {})
    settings.projectFilters[p.filePath] = { filter: view.filter, activeSavedViewId: null, kanbanLane: 'severity' }
    await view.persistFilter()
    expect(settings.projectFilters[p.filePath].kanbanLane).toBe('severity')
  })

  it('never lets a dropdown edit reach a saved view through a shared array', async () => {
    const saved: SavedView = {
      id: 'v1',
      name: 'Todo only',
      filter: { ...makeDefaultFilter(), statuses: ['todo'] },
      sortKey: 'status',
      sortDir: 'asc'
    }
    const p = board('Queue', { savedViews: [saved] })
    const { view } = harness([p])
    await view.setState({ filePath: p.filePath }, {})
    view.handleSavedViewSelect('v1')
    view.filter.statuses.push('in-progress')
    expect(saved.filter.statuses).toEqual(['todo'])

    await view.handleSavedViewSave('Mine')
    view.filter.statuses.length = 0
    expect(p.savedViews[1].filter.statuses).toEqual(['todo', 'in-progress'])
  })

  it('opens a table saved view with its own sort, from the table or from another view', async () => {
    const saved: SavedView = {
      id: 'v1',
      name: 'Due first',
      filter: makeDefaultFilter(),
      sortKey: 'due',
      sortDir: 'desc',
      viewMode: 'table'
    }
    const p = board('Queue', { savedViews: [saved] })
    const { view } = harness([p])
    await view.setState({ filePath: p.filePath }, {})
    expect(view.currentView).toBe('table')
    view.handleSavedViewSelect('v1')
    expect(tables[tables.length - 1][5]).toEqual({ sortKey: 'due', sortDir: 'desc' })

    view.currentView = 'kanban'
    view.renderCurrentView()
    view.handleSavedViewSelect('v1')
    expect(tables[tables.length - 1][5]).toEqual({ sortKey: 'due', sortDir: 'desc' })
  })
})

describe('ProjectView paths', () => {
  it('keeps the chosen view mode when its board is renamed, and only then', async () => {
    const a = board('Old')
    const b = board('New')
    const c = board('Other')
    const { view } = harness([a, b, c])
    await view.setState({ filePath: a.filePath }, {})
    expect(view.currentView).toBe('table')
    view.currentView = 'kanban'
    await view.setState({ filePath: b.filePath, keepView: true }, {})
    expect(view.currentView).toBe('kanban')
    // Opening a different board in this leaf still gives that board's default.
    await view.setState({ filePath: c.filePath }, {})
    expect(view.currentView).toBe('table')
  })

  it('reloads when a case note is created or renamed outside, not for its own board note', async () => {
    const p = board('Queue')
    const { view, vaultOn, timers } = harness([p])
    await view.setState({ filePath: p.filePath }, {})
    const note = (path: string): TFile => Object.assign(new TFile(), { path, extension: 'md' })
    vaultOn.rename?.(note('Queue/Tasks/Case one renamed.md'), 'Queue/Tasks/Case one.md')
    expect(timers).toHaveLength(1)
    vaultOn.create?.(note('Queue/Tasks/Synced in.md'))
    expect(timers).toHaveLength(2)
    // The board's own note is followed by the plugin (rekeyProjectPath), not reloaded at its old path.
    vaultOn.rename?.(note('Elsewhere/Queue/Queue.md'), p.filePath)
    vaultOn.rename?.(note('Other/Tasks/x.md'), 'Other/Tasks/y.md')
    expect(timers).toHaveLength(2)
  })

  it('says a detached board lists cases it cannot find, instead of showing none', async () => {
    const p = board('Queue', { detached: { recorded: 3, folder: 'Queue/Tasks' } })
    const { view } = harness([p])
    await view.setState({ filePath: p.filePath }, {})
    const text = all(view.bodyEl).map((e) => e.textContent)
    expect(text).toContain('Cases not found')
    expect(text.join(' ')).toContain('This board lists 3 cases, but Queue/Tasks is not there.')
    expect(tables).toHaveLength(0)
  })

  it('offers no verdict filter on a plain board', async () => {
    const p = board('Goals', { config: { boardType: 'plain' } })
    const { view } = harness([p])
    await view.setState({ filePath: p.filePath }, {})
    expect(headers[headers.length - 1].verdicts).toBeUndefined()
  })
})

describe('ProjectView board settings', () => {
  it('redraws the header and drops filter values the saved board no longer offers', async () => {
    const p = board('Queue')
    const { view, settings } = harness([p])
    await view.setState({ filePath: p.filePath }, {})
    view.filter.verdicts.push('tp')
    view.filter.statuses.push('todo', 'gone')
    await view.persistFilter()
    const before = headers.length

    buttons.find((b) => b.label === 'Board settings')?.click()
    const { onSave } = vi.mocked(openProjectModal).mock.calls.at(-1)?.[1] ?? {}
    await onSave?.({ ...p, config: { ...p.config, boardType: 'plain' } })

    // A plain board offers no verdict control, so no verdict may keep filtering it.
    expect(headers.length).toBe(before + 1)
    expect(headers[headers.length - 1].verdicts).toBeUndefined()
    expect(view.filter.verdicts).toEqual([])
    expect(view.filter.statuses).toEqual(['todo'])
    expect(settings.projectFilters[p.filePath].filter).toMatchObject({ verdicts: [], statuses: ['todo'] })
  })

  it('drops a verdict filter saved before the board went plain, on load', async () => {
    const p = board('Goals', { config: { boardType: 'plain' } })
    const { view, settings } = harness([p])
    settings.projectFilters[p.filePath] = {
      filter: { ...makeDefaultFilter(), verdicts: ['tp'] },
      activeSavedViewId: null
    }
    await view.setState({ filePath: p.filePath }, {})
    expect(view.filter.verdicts).toEqual([])
    expect(settings.projectFilters[p.filePath].filter.verdicts).toEqual([])
  })
})

describe('ProjectView toolbar', () => {
  it('ignores an emptied or unchanged board title on blur', async () => {
    const p = board('Queue')
    const { view, saveProject, renameProjectFiles } = harness([p])
    await view.setState({ filePath: p.filePath }, {})
    view.titleEl2.textContent = '   '
    view.titleEl2.on.blur?.()
    expect(view.titleEl2.textContent).toBe('Queue')
    expect(p.title).toBe('Queue')
    view.titleEl2.on.blur?.()
    expect(p.title).toBe('Queue')
    expect(saveProject).not.toHaveBeenCalled()
    expect(renameProjectFiles).not.toHaveBeenCalled()
  })

  it('keeps the board menu key from reaching the table row shortcuts', async () => {
    const p = board('Queue')
    const { view } = harness([p])
    await view.setState({ filePath: p.filePath }, {})
    view.showBoardMenu = vi.fn<() => Promise<void>>(async () => {})
    const icon = all(view.toolbarEl).find((e) => e.attrs['aria-label'] === 'Switch board')
    const e = { key: 'Enter', preventDefault: vi.fn<() => void>(), stopPropagation: vi.fn<() => void>() }
    icon?.on.keydown?.(e)
    expect(e.stopPropagation).toHaveBeenCalledOnce()
  })

  it('opens a new milestone with no hidden start date', async () => {
    const p = board('Queue')
    const { view } = harness([p])
    await view.setState({ filePath: p.filePath }, {})
    view.currentView = 'gantt'
    view.renderProjectToolbar()
    buttons.find((b) => b.label === '+ milestone')?.click()
    expect(vi.mocked(openTaskModal).mock.calls[0][2]).toMatchObject({ defaults: { type: 'milestone', start: '' } })
  })
})
