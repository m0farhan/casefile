import { describe, expect, it, vi } from 'vitest'
import type { TFile } from 'obsidian'
import { makeFakeApp } from '../test/fakeVault'
import { migrateProjects } from './migration'
import type PMPlugin from './main'

const OLD_BOARD = '---\npm-project: true\ntitle: Old\ntasks:\n  - id: t1\n    title: Embedded\n---\n'

/** A plugin shell around the fake vault, its cache answering from `cache` by path. */
function pluginWith(cache: Record<string, { frontmatter?: Record<string, unknown> } | null>) {
  const { app, vault } = makeFakeApp()
  app.metadataCache.getFileCache = (f: TFile) => cache[f.path] ?? null
  const loadProject = vi.fn<(file: TFile) => Promise<null>>(async () => null)
  const plugin = {
    settings: { projectsFolder: '' },
    app,
    store: { loadProject, saveProject: vi.fn<() => Promise<void>>() }
  }
  return { plugin: plugin as unknown as PMPlugin, vault, loadProject }
}

describe('migrateProjects', () => {
  it('reads no root note the metadata cache already knows is not an old-format board', async () => {
    const cache: Record<string, { frontmatter?: Record<string, unknown> }> = {}
    const { plugin, vault, loadProject } = pluginWith(cache)
    for (let i = 0; i < 25; i++) {
      await vault.create(`Note ${i}.md`, 'plain')
      cache[`Note ${i}.md`] = {} // indexed, no frontmatter: not a board
      await vault.create(`Tagged ${i}.md`, '---\ntags: [x]\n---\n')
      cache[`Tagged ${i}.md`] = { frontmatter: { tags: ['x'] } }
    }
    await vault.create('New.md', '---\npm-project: true\ntaskIds: []\n---\n')
    cache['New.md'] = { frontmatter: { 'pm-project': true, taskIds: [] } }
    const reads = vi.spyOn(vault, 'cachedRead')
    const rawReads = vi.spyOn(vault, 'read')

    await migrateProjects(plugin)
    expect(reads.mock.calls.length + rawReads.mock.calls.length).toBe(0)
    expect(loadProject).not.toHaveBeenCalled()
  })

  it('still migrates an old-format board, cached or not yet indexed', async () => {
    const tasks = [{ id: 't1', title: 'Embedded' }]
    const { plugin, vault, loadProject } = pluginWith({ 'Cached.md': { frontmatter: { 'pm-project': true, tasks } } })
    await vault.create('Cached.md', OLD_BOARD)
    await vault.create('Unindexed.md', OLD_BOARD)

    await migrateProjects(plugin)
    expect(loadProject.mock.calls.map(([f]) => f.path).sort()).toEqual(['Cached.md', 'Unindexed.md'])
  })
})
