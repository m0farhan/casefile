import type { App } from 'obsidian'
import { TFile } from 'obsidian'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeApp, type FakeVault } from '../test/fakeVault'
import type PMPlugin from './main'
import { PMSettingTab } from './settings'
import { ProjectStore } from './store'
import { parseFrontmatter } from './store/YamlParser'
import { DEFAULT_ALERT_CATEGORIES, DEFAULT_SETTINGS, makeTask, type PMSettings, type StatusConfig } from './types'
import { setAlertKindDerivation, shownAlertKind } from './ui/composites/issueMeta'
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
        if (p === 'onClick') {
          return (fn: unknown) => {
            t.clicked = fn
            return proxy
          }
        }
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
  class FuzzySuggestModal {
    setPlaceholder(): void {}
  }
  return { ...real, Setting, PluginSettingTab, Notice, AbstractInputSuggest, FuzzySuggestModal, getIconIds: () => [] }
})
// The real probe needs Obsidian's global createSpan; a Lucide id is lowercase words.
vi.mock('./utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isIconName: (icon: string) => /^[a-z0-9-]+$/.test(icon)
}))
vi.mock('./ui/ModalFactory', () => ({ confirmDialog: vi.fn<() => Promise<boolean>>() }))

interface FakeButton {
  tip: string
  text: string
  click: () => unknown
}
const buttons: FakeButton[] = []
vi.mock('./ui/primitives/IconButton', () => ({
  IconButton: class {
    b: FakeButton = { tip: '', text: '', click: () => undefined }
    el = { setCssStyles: () => {}, setText: (t: string) => (this.b.text = t) }
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
    refreshProjectViews: vi.fn<() => void>(),
    getSecret: () => ''
  } as unknown as PMPlugin
  return { tab: new PMSettingTab(app as unknown as App, plugin), store, vault }
}

type Private = {
  renderStatusList(el: HTMLElement): void
  renderMembersList(el: HTMLElement): void
  renderAlertKindList(el: HTMLElement): void
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

describe('team members', () => {
  it('moves a member up or down and saves, and does nothing past either end', () => {
    const settings: PMSettings = { ...DEFAULT_SETTINGS, globalTeamMembers: ['Ann', 'Bo', 'Cy'] }
    const { tab } = makeTab(settings)
    const move = (tip: string, row: number): void => {
      buttons.length = 0
      ;(tab as unknown as Private).renderMembersList(fakeEl())
      buttons.filter((b) => b.tip === tip)[row].click()
    }

    move('Move up', 2)
    expect(settings.globalTeamMembers).toEqual(['Ann', 'Cy', 'Bo'])
    move('Move down', 0)
    expect(settings.globalTeamMembers).toEqual(['Cy', 'Ann', 'Bo'])
    move('Move up', 0)
    move('Move down', 2)
    expect(settings.globalTeamMembers).toEqual(['Cy', 'Ann', 'Bo'])
    expect((tab as unknown as { plugin: Record<string, unknown> }).plugin.saveSettings).toHaveBeenCalledTimes(2)
  })
})

describe('alert kinds', () => {
  const kinds = () => DEFAULT_ALERT_CATEGORIES.map((c) => ({ ...c, match: [...c.match] }))
  const setting = (name: string): Record<string, unknown> => {
    const found = built.find((b) => b.name === name)?.comp
    if (!found) throw new Error(`no ${name} setting`)
    return found
  }

  afterEach(() => setAlertKindDerivation(true))

  it("adds only the missing built-in kinds, and keeps the analyst's edits", () => {
    const own = kinds().filter((c) => c.id !== 'suspicious-connection')
    own[0].icon = 'mail-warning'
    const settings: PMSettings = { ...DEFAULT_SETTINGS, alertCategories: own }
    const { tab } = makeTab(settings)
    tab.display()
    const add = setting('Add missing built-in kinds').clicked as () => void
    add()
    expect(settings.alertCategories.map((c) => c.id)).toEqual(DEFAULT_ALERT_CATEGORIES.map((c) => c.id))
    expect(settings.alertCategories[0].icon).toBe('mail-warning')
    expect(notices).toEqual(['Added at the end of the list: Suspicious connection.'])
    add()
    expect(settings.alertCategories).toHaveLength(DEFAULT_ALERT_CATEGORIES.length)
    expect(notices[1]).toBe('Every built-in kind is already in the list.')
  })

  it('the derive toggle reaches every issue icon and redraws the boards', async () => {
    const settings: PMSettings = { ...DEFAULT_SETTINGS, alertCategories: kinds() }
    const { tab } = makeTab(settings)
    tab.display()
    const title = { tags: [], title: 'SOC138 - Detected Suspicious Xls File', categories: settings.alertCategories }
    expect(shownAlertKind(title)?.derivedFrom).toBe('xls')
    await (setting('Derive the alert kind from the title').changed as (v: boolean) => Promise<void>)(false)
    expect(settings.deriveAlertKind).toBe(false)
    expect(shownAlertKind(title)).toBeUndefined()
    expect((tab as unknown as { plugin: Record<string, unknown> }).plugin.refreshProjectViews).toHaveBeenCalled()
  })

  it('refuses a tag id another kind uses, or one with a space, and keeps the old one', () => {
    const settings: PMSettings = { ...DEFAULT_SETTINGS, alertCategories: kinds() }
    const { tab } = makeTab(settings)
    const list = fakeEl()
    ;(tab as unknown as Private).renderAlertKindList(list)
    const idInput = list.kids[1].kids[0].kids.filter((k) => k.className === 'pm-settings-status-label')[1]
    expect(idInput.value).toBe('malware')
    idInput.value = 'Phishing'
    idInput.on.change()
    expect(settings.alertCategories[1].id).toBe('malware')
    expect(idInput.value).toBe('malware')
    expect(notices).toEqual(['Not saved: the kind "Phishing" already answers to "Phishing".'])
    // A match word counts too: a 'macro' tag would read as Suspicious file.
    idInput.value = 'macro'
    idInput.on.change()
    expect(settings.alertCategories[1].id).toBe('malware')
    idInput.value = 'bad tag'
    idInput.on.change()
    expect(settings.alertCategories[1].id).toBe('malware')
    idInput.value = '#malicious-code'
    idInput.on.change()
    expect(settings.alertCategories[1].id).toBe('malicious-code')
  })

  it('refuses a label another kind answers to, and keeps the old one', () => {
    const settings: PMSettings = { ...DEFAULT_SETTINGS, alertCategories: kinds() }
    const { tab } = makeTab(settings)
    const list = fakeEl()
    ;(tab as unknown as Private).renderAlertKindList(list)
    const label = list.kids[0].kids[0].kids.filter((k) => k.className === 'pm-settings-status-label')[0]
    label.value = 'Malware'
    label.on.change()
    expect(settings.alertCategories[0].label).toBe('Phishing')
    expect(label.value).toBe('Phishing')
    expect(notices).toEqual(['Not saved: the kind "Malware" already answers to "Malware".'])
    label.value = 'Phish'
    label.on.change()
    expect(settings.alertCategories[0].label).toBe('Phish')
  })

  it('leaves out a match word another kind answers to, and saves the rest', () => {
    const settings: PMSettings = { ...DEFAULT_SETTINGS, alertCategories: kinds() }
    const { tab } = makeTab(settings)
    const list = fakeEl()
    ;(tab as unknown as Private).renderAlertKindList(list)
    const match = list.kids[0].kids[1].kids[1]
    match.value = 'lure, malware, macro'
    match.on.change()
    expect(settings.alertCategories[0].match).toEqual(['lure'])
    expect(match.value).toBe('lure')
    expect(notices).toEqual([
      'Not saved: the kind "Malware" already answers to "malware"; ' +
        'the kind "Suspicious file" already answers to "macro".'
    ])
  })

  it('does not add back a built-in a renamed kind still answers to', () => {
    const own = kinds()
    own[0].id = 'phish'
    const settings: PMSettings = { ...DEFAULT_SETTINGS, alertCategories: own }
    const { tab } = makeTab(settings)
    tab.display()
    ;(setting('Add missing built-in kinds').clicked as () => void)()
    expect(settings.alertCategories.map((c) => c.id)).toEqual(own.map((c) => c.id))
    expect(notices).toEqual(['Nothing added. Skipped Phishing: the kind "Phishing" already answers to "phishing".'])
  })

  it('an emoji icon shows as text on its own settings card, as it does on the board', () => {
    const own = kinds()
    own[0].icon = '🎣'
    const settings: PMSettings = { ...DEFAULT_SETTINGS, alertCategories: own }
    const { tab } = makeTab(settings)
    ;(tab as unknown as Private).renderAlertKindList(fakeEl())
    expect(buttons[0].text).toBe('🎣')
    expect(buttons[4].text).toBe('')
  })

  it('reads match words as a comma-separated list', () => {
    const settings: PMSettings = { ...DEFAULT_SETTINGS, alertCategories: kinds() }
    const { tab } = makeTab(settings)
    const list = fakeEl()
    ;(tab as unknown as Private).renderAlertKindList(list)
    const match = list.kids[0].kids[1].kids[1]
    match.value = ' lure ,, Spoofed Sender,'
    match.on.change()
    expect(settings.alertCategories[0].match).toEqual(['lure', 'Spoofed Sender'])
  })

  it('deletes a kind only once confirmed, and edits no case', async () => {
    const settings: PMSettings = { ...DEFAULT_SETTINGS, alertCategories: kinds() }
    const { tab, store } = makeTab(settings)
    const board = await store.createProject('Queue', '')
    await store.insertTask(board, makeTask({ title: 'Mail', issueType: 'incident', tags: ['phishing'] }))
    const updateTasks = vi.spyOn(store, 'updateTasks')
    const updateTask = vi.spyOn(store, 'updateTask')
    ;(tab as unknown as Private).renderAlertKindList(fakeEl())
    const remove = () => buttons.filter((b) => b.tip === 'Remove')[0].click()

    vi.mocked(confirmDialog).mockResolvedValue(false)
    remove()
    await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce())
    expect(settings.alertCategories[0].id).toBe('phishing')

    vi.mocked(confirmDialog).mockResolvedValue(true)
    remove()
    await vi.waitFor(() => expect(settings.alertCategories[0].id).toBe('malware'))
    expect(vi.mocked(confirmDialog).mock.calls[1][1]).toMatch(/^Delete the "Phishing" kind\? No case is edited/)
    expect(updateTasks).not.toHaveBeenCalled()
    expect(updateTask).not.toHaveBeenCalled()
  })
})

describe('board display settings and the asset boundary', () => {
  const setting = (name: string): Record<string, unknown> => {
    const found = built.find((b) => b.name === name)?.comp
    if (!found) throw new Error(`no ${name} setting`)
    return found
  }

  it('the tag colors, subtasks and week label settings redraw open boards', async () => {
    const { tab } = makeTab({ ...DEFAULT_SETTINGS })
    tab.display()
    const refresh = (tab as unknown as { plugin: { refreshProjectViews: () => void } }).plugin.refreshProjectViews
    await (setting('Show tag colors').changed as (v: boolean) => Promise<void>)(false)
    await (setting('Show subtasks on board').changed as (v: boolean) => Promise<void>)(true)
    await (setting('Gantt week label').changed as (v: string) => Promise<void>)('both')
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('keeps # comment lines in the owned domains and brands, as typed', async () => {
    const settings: PMSettings = { ...DEFAULT_SETTINGS }
    const { tab } = makeTab(settings)
    tab.display()
    await (setting('Owned domains and ranges').changed as (v: string) => Promise<void>)(
      '# HQ datacentre (ticket NET-114)\n10.20.0.0/16\n\ncorp.example'
    )
    expect(settings.ownedAssets).toEqual(['# HQ datacentre (ticket NET-114)', '10.20.0.0/16', 'corp.example'])
    await (setting('Brands to watch for').changed as (v: string) => Promise<void>)('# finance\npaypal')
    expect(settings.phishBrands).toEqual(['# finance', 'paypal'])
  })
})
