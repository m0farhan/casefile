import { describe, expect, it, vi } from 'vitest'
import type PMPlugin from '../main'
import { makeProject, makeTask } from '../types'
import { openCaseNote, openTaskDetailPanel } from './ModalFactory'

const platform = vi.hoisted(() => ({ isPhone: false }))

// The import chain (TaskModal, the views) only needs its base classes to exist
// for `extends`; Platform is the one value these tests set.
vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  function Stub(): void {}
  return new Proxy(real, {
    get: (target, prop) => {
      if (prop === 'Platform') return platform
      if (prop in target) return target[prop as string]
      if (typeof prop !== 'string' || prop === 'then') return undefined
      return Stub
    },
    has: () => true
  })
})

/** Lets the chained awaits inside openCaseNote and openTaskDetailPanel run out. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function workspace(opts: { panelOpen?: boolean; panelParent?: { name: string } } = {}) {
  const calls: string[] = []
  // The board the dialog was over is in front until openLinkText puts the new note there.
  const mainTabs = { name: 'main tabs' }
  const board = { name: 'board', parent: mainTabs }
  const note = { name: 'note', parent: mainTabs }
  let front: { name: string } = board
  const panel = {
    name: 'panel',
    parent: opts.panelParent ?? { name: 'right sidebar' },
    setViewState: vi.fn<(state: { active: boolean }) => Promise<void>>((state) => {
      calls.push(`panel.setViewState active=${state.active}`)
      return Promise.resolve()
    })
  }
  const ws = {
    getLeavesOfType: () => (opts.panelOpen ? [panel] : []),
    getRightLeaf: () => {
      calls.push('getRightLeaf')
      return panel
    },
    getMostRecentLeaf: () => front,
    openLinkText: vi.fn<(path: string) => Promise<void>>((path) => {
      calls.push(`openLinkText ${path}`)
      // Resolves once the new tab holds the note and is in front, as Obsidian's does.
      front = note
      return Promise.resolve()
    }),
    revealLeaf: vi.fn<(leaf: { name: string }) => Promise<void>>((leaf) => {
      calls.push(`revealLeaf ${leaf.name}`)
      return Promise.resolve()
    }),
    setActiveLeaf: vi.fn<(leaf: { name: string }, params: { focus: boolean }) => void>((leaf, params) => {
      calls.push(`setActiveLeaf ${leaf.name} focus=${params.focus}`)
    })
  }
  const plugin = { app: { workspace: ws } } as unknown as PMPlugin
  return { plugin, panel, calls }
}

const project = makeProject('SOC', 'SOC/SOC.md')
const task = makeTask({ title: 'ClickFix', filePath: 'SOC/Tasks/ClickFix.md' })

describe('openCaseNote', () => {
  it('opens the note, brings the panel up beside it on the case, and gives the focus back to the note', async () => {
    const { plugin, panel, calls } = workspace({ panelOpen: true })
    openCaseNote(plugin, project, task)
    await flush()
    expect(calls).toEqual([
      'openLinkText SOC/Tasks/ClickFix.md',
      'panel.setViewState active=false',
      'revealLeaf panel',
      'setActiveLeaf note focus=true'
    ])
    expect(panel.setViewState).toHaveBeenCalledWith({
      type: 'casefile-task-detail',
      active: false,
      state: { projectPath: 'SOC/SOC.md', taskId: task.id }
    })
  })

  it('makes the panel when none is open', async () => {
    const { plugin, calls } = workspace()
    openCaseNote(plugin, project, task)
    await flush()
    expect(calls).toContain('getRightLeaf')
    expect(calls).toContain('revealLeaf panel')
  })

  it('on a phone, points the panel at the case but does not pull the drawer over the note', async () => {
    platform.isPhone = true
    try {
      const { plugin, calls } = workspace({ panelOpen: true })
      openCaseNote(plugin, project, task)
      await flush()
      expect(calls).toEqual(['openLinkText SOC/Tasks/ClickFix.md', 'panel.setViewState active=false'])
    } finally {
      platform.isPhone = false
    }
  })

  it("a panel dragged into the note's own tab group stays behind the note", async () => {
    const tabs = { name: 'main tabs' }
    const { plugin, calls } = workspace({ panelOpen: true, panelParent: tabs })
    // The note opens as a new tab in that same group.
    const app = plugin.app as unknown as { workspace: { getMostRecentLeaf: () => unknown } }
    app.workspace.getMostRecentLeaf = () => ({ name: 'note', parent: tabs })
    openCaseNote(plugin, project, task)
    await flush()
    expect(calls).toEqual(['openLinkText SOC/Tasks/ClickFix.md', 'panel.setViewState active=false'])
  })

  it('does nothing for a case with no note yet', async () => {
    const { plugin, calls } = workspace({ panelOpen: true })
    openCaseNote(plugin, project, makeTask({ title: 'Unsaved' }))
    await flush()
    expect(calls).toEqual([])
  })
})

describe('openTaskDetailPanel', () => {
  it('by default the panel takes the focus, as before', async () => {
    const { plugin, calls } = workspace({ panelOpen: true })
    openTaskDetailPanel(plugin, project, task.id)
    await flush()
    expect(calls).toEqual(['panel.setViewState active=true', 'revealLeaf panel'])
  })

  it('on a phone, an explicit open (Open in sidebar, a board click) still brings the panel up', async () => {
    platform.isPhone = true
    try {
      const { plugin, calls } = workspace({ panelOpen: true })
      openTaskDetailPanel(plugin, project, task.id)
      await flush()
      expect(calls).toEqual(['panel.setViewState active=true', 'revealLeaf panel'])
    } finally {
      platform.isPhone = false
    }
  })

  it('without focus and with nothing in front to give it back to, the panel is still shown', async () => {
    const { plugin, calls } = workspace({ panelOpen: true })
    const app = plugin.app as unknown as { workspace: { getMostRecentLeaf: () => null } }
    app.workspace.getMostRecentLeaf = () => null
    openTaskDetailPanel(plugin, project, task.id, { focus: false })
    await flush()
    expect(calls).toEqual(['panel.setViewState active=false', 'revealLeaf panel'])
  })
})
