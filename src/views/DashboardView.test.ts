import { beforeEach, describe, expect, it, vi } from 'vitest'
import type PMPlugin from '../main'
import { DEFAULT_SETTINGS, makeProject, type PMSettings, type Project } from '../types'
import { confirmDialog } from '../ui/ModalFactory'
import { DashboardView } from './DashboardView'
import { renderProjectListContent, type ProjectListContext } from './ProjectListRenderer'

/** Items of the last menu opened, by title. */
const menuItems = new Map<string, () => unknown>()
/** Props of each board card drawn. */
const cards: { title: string; onContextMenu: (at: { x: number; y: number }) => void }[] = []

vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  class Menu {
    constructor() {
      menuItems.clear()
    }
    addItem(build: (item: Record<string, unknown>) => unknown): this {
      let title = ''
      const item: Record<string, unknown> = {
        setTitle: (t: string) => {
          title = t
          return item
        },
        setIcon: () => item,
        onClick: (fn: () => unknown) => {
          menuItems.set(title, fn)
          return item
        }
      }
      build(item)
      return this
    }
    showAtPosition(): void {}
    showAtMouseEvent(): void {}
  }
  class ItemView {
    registerEvent(): void {}
  }
  class ButtonComponent {
    setButtonText(): this {
      return this
    }
    setCta(): this {
      return this
    }
    onClick(): this {
      return this
    }
  }
  const given: Record<string, unknown> = { ...real, Menu, ItemView, ButtonComponent }
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
  openProjectModal: vi.fn<() => void>(),
  promptText: vi.fn<() => Promise<null>>(async () => null)
}))
vi.mock('../ui/composites/ProjectCard', () => ({
  ProjectCard: class {
    el = null
    constructor(_el: unknown, props: (typeof cards)[number]) {
      cards.push(props)
    }
  }
}))
vi.mock('../ui/primitives/EmptyState', () => ({
  EmptyState: class {
    el = null
  }
}))

/** A DOM stand-in that swallows everything. */
function fakeEl(): HTMLElement {
  const el: Record<string, unknown> = {}
  Object.assign(el, {
    empty: () => {},
    addClass: () => {},
    createDiv: () => fakeEl(),
    createEl: () => fakeEl()
  })
  return el as unknown as HTMLElement
}

function pluginWith(boards: Project[], settings: Partial<PMSettings> = {}) {
  const notices: string[] = []
  const deleteProject = vi.fn<(p: Project) => Promise<void>>(async () => {})
  const plugin = {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    showNotice: (msg: string) => notices.push(msg),
    app: { vault: { getAbstractFileByPath: () => null } },
    store: {
      loadAllProjects: vi.fn<() => Promise<Project[]>>(async () => boards),
      configFor: () => ({ statuses: DEFAULT_SETTINGS.statuses }),
      deleteProject
    }
  } as unknown as PMPlugin
  return { plugin, notices, deleteProject }
}

beforeEach(() => {
  cards.length = 0
  vi.mocked(confirmDialog).mockClear()
})

describe('Delete board', () => {
  it('refuses, naming them, when other boards are filed inside its folder', async () => {
    const outer = makeProject('Incident Response', 'Incident Response/Incident Response.md')
    const inner = makeProject('Goals', 'Incident Response/Goals/Goals.md')
    const { plugin, notices, deleteProject } = pluginWith([outer, inner])
    const ctx: ProjectListContext = {
      plugin,
      toolbarEl: fakeEl(),
      contentEl: fakeEl(),
      isStale: () => false,
      openProjectFile: async () => {}
    }
    await renderProjectListContent(ctx)
    cards.find((c) => c.title === 'Incident Response')?.onContextMenu({ x: 0, y: 0 })
    menuItems.get('Delete board')?.()
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toBe(
      'Not deleting "Incident Response": "Goals" is a board filed inside its folder. Move it out first.'
    )
    expect(confirmDialog).not.toHaveBeenCalled()
    expect(deleteProject).not.toHaveBeenCalled()
  })
})

describe('Boards pane', () => {
  it('redraws for a board filed outside the default folder, and for a new board once indexed', async () => {
    const goals = makeProject('Goals', 'Personal/Goals/Goals.md')
    const { plugin } = pluginWith([goals], { projectsFolder: 'Cases' })
    const on: Record<string, (...a: unknown[]) => unknown> = {}
    const timers: (() => unknown)[] = []
    vi.stubGlobal('window', { setTimeout: (fn: () => unknown) => timers.push(fn), clearTimeout: () => {} })
    const view = Object.create(DashboardView.prototype) as DashboardView
    Object.assign(view, {
      plugin,
      renderToken: 0,
      reloadDebounceTimer: null,
      watched: [],
      containerEl: Object.assign(fakeEl(), { addClass: () => {} }),
      contentEl: fakeEl(),
      app: {
        vault: { on: (name: string, fn: (...a: unknown[]) => unknown) => (on[name] = fn) },
        metadataCache: { on: (name: string, fn: (...a: unknown[]) => unknown) => (on[`meta:${name}`] = fn) }
      }
    })
    await view.onOpen()
    await vi.waitFor(() => expect(cards).toHaveLength(1))
    on.modify?.({ path: 'Personal/Goals/Tasks/one.md' })
    expect(timers).toHaveLength(1)
    on['meta:changed']?.({ path: 'Elsewhere/New/New.md' }, '', { frontmatter: { 'pm-project': true } })
    expect(timers).toHaveLength(2)
    on.modify?.({ path: 'Notes/unrelated.md' })
    expect(timers).toHaveLength(2)
  })
})
