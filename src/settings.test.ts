import type { App } from 'obsidian'
import { TFile } from 'obsidian'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeApp, type FakeVault } from '../test/fakeVault'
import type PMPlugin from './main'
import { PMSettingTab } from './settings'
import { ProjectStore } from './store'
import { parseFrontmatter } from './store/YamlParser'
import { DEFAULT_SETTINGS, makeTask, type PMSettings, type StatusConfig } from './types'
import { confirmDialog } from './ui/ModalFactory'

const notices: string[] = []
/** Every Setting the tab builds, with the one component it added. */
const built: { name: string; comp: Record<string, unknown> }[] = []

vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  /** A settings component: every setter chains; setValue/getValue/onChange keep what they are given. */
  const component = (): Record<string, unknown> => {
    const state: Record<string, unknown> = { value: '', inputEl: fakeEl() }
    const proxy: Record<string, unknown> = new Proxy(state, {
      get: (t, p: string) => {
        if (p in t) return t[p]
        if (p === 'setValue') {
          return (v: unknown) => {
            t.value = v
            return proxy
          }
        }
        if (p === 'getValue') return () => t.value
        if (p === 'onChange') {
          return (fn: unknown) => {
            t.changed = fn
            return proxy
          }
        }
        return () => proxy
      }
    })
    return proxy
  }
  class Setting {
    entry = { name: '', comp: {} as Record<string, unknown> }
    constructor() {
      built.push(this.entry)
    }
    setName(n: string): this {
      this.entry.name = n
      return this
    }
    setDesc(): this {
      return this
    }
    setHeading(): this {
      return this
    }
    private add = (build: (c: Record<string, unknown>) => unknown): this => {
      this.entry.comp = component()
      build(this.entry.comp)
      return this
    }
    addText = this.add
    addTextArea = this.add
    addToggle = this.add
    addDropdown = this.add
    addSlider = this.add
    addButton = this.add
  }
  class PluginSettingTab {
    containerEl = fakeEl()
    constructor(public app: unknown) {}
  }
  class Notice {
    constructor(msg: string) {
      notices.push(msg)
    }
    hide(): void {}
  }
  class AbstractInputSuggest {
    onSelect(): void {}
  }
  return { ...real, Setting, PluginSettingTab, Notice, AbstractInputSuggest, getIconIds: () => [] }
})
vi.mock('./ui/ModalFactory', () => ({ confirmDialog: vi.fn<() => Promise<boolean>>() }))

interface FakeButton {
  tip: string
  click: () => unknown
}
const buttons: FakeButton[] = []
vi.mock('./ui/primitives/IconButton', () => ({
  IconButton: class {
    b: FakeButton = { tip: '', click: () => undefined }
    el = { setCssStyles: () => {} }
    constructor() {
      buttons.push(this.b)
    }
    setIcon(): this {
      return this
    }
    setTooltip(tip: string): this {
      this.b.tip = tip
      return this
    }
    onClick(fn: () => unknown): this {
      this.b.click = fn
      return this
    }
  }
}))

/** A DOM stand-in: keeps value and text, remembers listeners, hands out children of the same kind. */
type Listener = (e?: unknown) => void
type FakeEl = HTMLElement & { on: Record<string, Listener>; text: string; value: string; kids: FakeEl[] }
function fakeEl(info?: { value?: string; cls?: string }): FakeEl {
  const el = {
    on: {} as Record<string, Listener>,
    kids: [] as FakeEl[],
    text: '',
    value: info?.value ?? '',
    className: info?.cls ?? '',
    empty: () => {},
    addClass: () => {},
    removeClass: () => {},
    setText: (t: string) => (el.text = t),
    setCssStyles: () => {},
    addEventListener: (k: string, fn: Listener) => (el.on[k] = fn)
  }
  const child = (_tag: unknown, i?: string | { value?: string; cls?: string; text?: string }): FakeEl => {
    const kid = fakeEl(typeof i === 'string' ? { cls: i } : i)
    kid.text = typeof i === 'object' ? (i.text ?? '') : ''
    el.kids.push(kid)
    return kid
  }
  Object.assign(el, {
    createDiv: (i?: string) => child('div', i),
    createSpan: (i?: { cls?: string; text?: string }) => child('span', i),
    createEl: child
  })
  return el as unknown as FakeEl
}

const STATUSES: StatusConfig[] = [
  { id: 'todo', label: 'To do', color: '#888', icon: '', complete: false },
  { id: 'done', label: 'Done', color: '#0a0', icon: '', complete: true },
  { id: 'closed', label: 'Closed', color: '#555', icon: '', complete: true }
]

function makeTab(settings: PMSettings): { tab: PMSettingTab; store: ProjectStore; vault: FakeVault } {
  const { app, vault } = makeFakeApp()
  const store = new ProjectStore(app as unknown as App, () => settings)
  const plugin = {
    app,
    settings,
    store,
    saveSettings: vi.fn<() => Promise<void>>(async () => {}),
    getSecret: () => ''
  } as unknown as PMPlugin
  return { tab: new PMSettingTab(app as unknown as App, plugin), store, vault }
}

type Private = {
  renderStatusList(el: HTMLElement): void
  renderSlaRows(): void
  slaContainer: HTMLElement | null
}

beforeEach(() => {
  notices.length = 0
  built.length = 0
  buttons.length = 0
  vi.mocked(confirmDialog).mockReset()
})

describe('deleting a status', () => {
  it('asks first, then moves its cases to a status of the same kind without restamping them', async () => {
    const settings: PMSettings = { ...DEFAULT_SETTINGS, statuses: STATUSES.map((s) => ({ ...s })) }
    const { tab, store, vault } = makeTab(settings)
    const board = await store.createProject('Queue', '')
    const closedCase = makeTask({
      title: 'Phish',
      issueType: 'incident',
      status: 'done',
      completed: '2025-01-01',
      respondedAt: ''
    })
    await store.insertTask(board, closedCase)
    vi.mocked(confirmDialog).mockResolvedValue(true)

    ;(tab as unknown as Private).renderStatusList(fakeEl())
    buttons.filter((b) => b.tip === 'Remove')[1].click()

    const read = async (): Promise<Record<string, unknown>> => {
      const file = vault.getAbstractFileByPath(closedCase.filePath ?? '')
      if (!(file instanceof TFile)) throw new Error('case note missing')
      return parseFrontmatter(await vault.cachedRead(file)).frontmatter ?? {}
    }
    await vi.waitFor(async () => expect((await read()).status).toBe('closed'))
    expect(vi.mocked(confirmDialog).mock.calls[0][1]).toBe(
      '1 case uses "Done". Deleting it moves that case to "Closed", and the change is written to each case\'s activity log.'
    )
    const fm = await read()
    // A remap is not a closing: the real completion date stays and no response is invented.
    expect(fm.completed).toBe('2025-01-01')
    expect(fm.respondedAt ?? '').toBe('')
    expect(settings.statuses.map((s) => s.id)).toEqual(['todo', 'closed'])
  })

  it('refuses to delete the only status of its kind, and changes nothing', async () => {
    const settings: PMSettings = { ...DEFAULT_SETTINGS, statuses: STATUSES.slice(0, 2).map((s) => ({ ...s })) }
    const { tab } = makeTab(settings)
    ;(tab as unknown as Private).renderStatusList(fakeEl())
    buttons.filter((b) => b.tip === 'Remove')[1].click()
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toMatch(/only closing status/)
    expect(settings.statuses.map((s) => s.id)).toEqual(['todo', 'done'])
    expect(confirmDialog).not.toHaveBeenCalled()
  })
})

describe('response targets', () => {
  function rows(settings: PMSettings): { response: FakeEl; resolution: FakeEl; hint: FakeEl }[] {
    const { tab } = makeTab(settings)
    const container = fakeEl()
    const priv = tab as unknown as Private
    priv.slaContainer = container
    priv.renderSlaRows()
    return container.kids.map((row) => {
      const inputs = row.kids.filter((k) => k.className === 'pm-settings-sla-input')
      const hint = row.kids[row.kids.length - 1]
      return { response: inputs[0], resolution: inputs[1], hint }
    })
  }

  it('does not save a row with one side left blank, or a target of 0', () => {
    const settings: PMSettings = {
      ...DEFAULT_SETTINGS,
      severities: [{ id: 'sev1', label: 'Critical', color: '#f00', icon: '' }],
      slaPolicies: { sev1: { responseMins: 60, resolutionMins: 240 } }
    }
    const [row] = rows(settings)
    row.response.value = ''
    row.resolution.value = '240'
    row.response.on.change()
    // Today: saved as { responseMins: 0 }, so every sev1 incident is breached at creation.
    expect(settings.slaPolicies.sev1).toEqual({ responseMins: 60, resolutionMins: 240 })
    expect(row.hint.text).toMatch(/^Not saved/)

    row.response.value = '0'
    row.response.on.change()
    expect(settings.slaPolicies.sev1).toEqual({ responseMins: 60, resolutionMins: 240 })

    row.response.value = '30'
    row.response.on.change()
    expect(settings.slaPolicies.sev1).toEqual({ responseMins: 30, resolutionMins: 240 })
    expect(row.hint.text).toBe('')

    row.response.value = ''
    row.resolution.value = ''
    row.resolution.on.change()
    expect(settings.slaPolicies.sev1).toBeUndefined()
  })
})

describe('auto-archive days', () => {
  it('saves only a committed whole number, and puts the saved value back otherwise', () => {
    const settings: PMSettings = { ...DEFAULT_SETTINGS, statuses: STATUSES.map((s) => ({ ...s })) }
    const { tab } = makeTab(settings)
    tab.display()
    const field = built.find((b) => b.name === 'Archive closed cases after (days)')?.comp
    if (!field) throw new Error('no auto-archive setting')
    const input = field.inputEl as FakeEl
    // Obsidian calls a text component's onChange on every keystroke, then the
    // input fires 'change' once the analyst leaves it.
    for (const typed of ['4', '40', '400']) {
      field.value = typed
      ;(field.changed as ((v: string) => unknown) | undefined)?.(typed)
    }
    input.on.change?.()
    expect(settings.autoArchiveDays).toBe(0)
    expect(field.value).toBe('0')
    expect(notices).toEqual(['Archive window must be whole days, 0–365. Kept 0.'])

    field.value = '30'
    input.on.change?.()
    expect(settings.autoArchiveDays).toBe(30)
  })
})
