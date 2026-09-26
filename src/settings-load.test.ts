import { beforeEach, describe, expect, it, vi } from 'vitest'
import type PMPlugin from './main'
import type { PMSettings } from './types'

// The stub carries no Plugin or view classes; importing main.ts only needs them to exist.
vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  function Stub(): void {}
  return new Proxy(real, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string]
      if (typeof prop !== 'string' || prop === 'then') return undefined
      return Stub
    },
    has: () => true
  })
})

/**
 * One plugin launch: a fresh module graph (so DEFAULT_SETTINGS is the
 * shipped value, not one an earlier launch edited), loading `data` as
 * data.json. Returns the settings and whatever was saved back.
 */
async function launch(data: unknown): Promise<{ settings: PMSettings; saved: unknown }> {
  vi.resetModules()
  const { default: Plugin } = await import('./main')
  const plugin = Object.create(Plugin.prototype) as PMPlugin
  let saved: unknown = null
  Object.assign(plugin, {
    app: { loadLocalStorage: () => null, saveLocalStorage: () => {} },
    loadData: async () => JSON.parse(JSON.stringify(data)) as unknown,
    saveData: async (d: unknown) => {
      saved = JSON.parse(JSON.stringify(d)) as unknown
    }
  })
  await plugin.loadSettings()
  return { settings: plugin.settings, saved }
}

beforeEach(() => {
  vi.resetModules()
})

describe('loadSettings', () => {
  it('loads a data.json whose palettes hold a null (a cross-list drop wrote one)', async () => {
    const { settings } = await launch({
      statuses: [null],
      verdicts: [null, { id: 'true-positive', label: 'True positive', color: '#eb5757', icon: '' }, 7, 'x']
    })
    expect(settings.verdicts.map((v) => v.id)).toEqual(['true-positive'])
    // Nothing valid left: the shipped list, not an empty board.
    expect(settings.statuses.map((s) => s.id)).toContain('todo')
    expect(settings.statuses.every((s) => typeof s.complete === 'boolean')).toBe(true)
  })

  it('keeps cleared SLA targets and deleted templates across a relaunch', async () => {
    const first = await launch({ statusDefaultsUpgraded: true, slaPolicies: {}, incidentTemplates: [] })
    expect(first.settings.slaPolicies).toEqual({})
    expect(first.settings.incidentTemplates).toEqual([])
    const second = await launch({ ...first.settings })
    expect(second.settings.slaPolicies).toEqual({})
    expect(second.settings.incidentTemplates).toEqual([])
  })

  it('still gives the defaults to a data.json that never had those keys', async () => {
    const { settings } = await launch({})
    expect(Object.keys(settings.slaPolicies).length).toBeGreaterThan(0)
    expect(settings.incidentTemplates.length).toBeGreaterThan(0)
  })

  it('hands out copies, so editing one launch never edits the defaults', async () => {
    vi.resetModules()
    const { default: Plugin } = await import('./main')
    const { DEFAULT_SETTINGS } = await import('./types')
    const plugin = Object.create(Plugin.prototype) as PMPlugin
    Object.assign(plugin, {
      app: { loadLocalStorage: () => null, saveLocalStorage: () => {} },
      loadData: async () => null,
      saveData: async () => {}
    })
    await plugin.loadSettings()
    plugin.settings.statuses[0].label = 'Edited'
    plugin.settings.globalTeamMembers.push('someone')
    const first = Object.keys(plugin.settings.slaPolicies)[0]
    plugin.settings.slaPolicies[first].responseMins = 1
    expect(DEFAULT_SETTINGS.statuses[0].label).not.toBe('Edited')
    expect(DEFAULT_SETTINGS.globalTeamMembers).toEqual([])
    expect(DEFAULT_SETTINGS.slaPolicies[first].responseMins).not.toBe(1)
  })

  it('never hands a CSS url() colour from data.json to the page', async () => {
    const evil = 'url(https://evil.example/beacon.png)'
    const { settings } = await launch({
      statusDefaultsUpgraded: true,
      statuses: [
        { id: 'todo', label: 'To do', color: evil, icon: '', complete: false },
        { id: 'done', label: 'Done', color: 'red', icon: '', complete: true }
      ],
      severities: [{ id: 'sev1', label: 'Critical', color: '#ff0000', icon: '' }],
      alertCategories: [{ id: 'phish', label: 'Phishing', color: evil, icon: '', match: [] }]
    })
    expect(settings.statuses.map((s) => s.color)).toEqual(['#8a94a0', 'red'])
    expect(settings.severities[0].color).toBe('#ff0000')
    expect(settings.alertCategories[0].color).toBe('#8a94a0')
  })

  it('a saved "derive the alert kind" off reaches the icons, and a saved kinds list gains no new built-in', async () => {
    const own = { id: 'phish', label: 'Phishing', color: '#56ccf2', icon: 'fish', match: [] }
    const { settings, saved } = await launch({
      statusDefaultsUpgraded: true,
      deriveAlertKind: false,
      alertCategories: [own]
    })
    // The same module graph the launch used, so this is the flag every icon reads.
    const { shownAlertKind } = await import('./ui/composites/issueMeta')
    const kind = shownAlertKind({
      tags: [],
      title: 'SOC120 - Phishing Mail Detected',
      categories: settings.alertCategories
    })
    expect(kind).toBeUndefined()
    expect(settings.alertCategories).toEqual([own])
    expect(saved).toBeNull()
  })
})
