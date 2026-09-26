import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zip } from '../../test/zip'
import { analysePhishing } from '../soc/phish'
import { PhishAnalysisView } from './PhishAnalysisView'
import { openProjectPicker } from '../ui/ModalFactory'

// -- Minimal fake DOM -------------------------------------------------------
// The suite runs in plain node (no jsdom in this repo), so this models only
// the element surface the analyser touches: Obsidian's create helpers, class
// toggles, attributes, listeners (with `once`), focus and a class-only
// querySelector.

type Info = { cls?: string; text?: string; attr?: Record<string, string> } | string

const focus: { active: unknown } = { active: null }

class FakeEl {
  classes = new Set<string>()
  attrs = new Map<string, string>()
  children: FakeEl[] = []
  listeners: { type: string; fn: () => void; once: boolean }[] = []
  textContent = ''
  value = ''
  disabled = false

  constructor(public tagName: string) {}

  createEl(tag: string, info: Info = {}): FakeEl {
    const el = new FakeEl(tag)
    const o = typeof info === 'string' ? { cls: info } : info
    for (const c of (o.cls ?? '').split(' ')) if (c) el.classes.add(c)
    if (o.text !== undefined) el.textContent = o.text
    for (const [k, v] of Object.entries(o.attr ?? {})) el.attrs.set(k, v)
    this.children.push(el)
    return el
  }

  createDiv(info?: Info): FakeEl {
    return this.createEl('div', info)
  }

  createSpan(info?: Info): FakeEl {
    return this.createEl('span', info)
  }

  empty(): void {
    this.children = []
  }

  addClass(...cs: string[]): void {
    for (const c of cs) this.classes.add(c)
  }

  toggleClass(c: string, on: boolean): void {
    if (on) this.classes.add(c)
    else this.classes.delete(c)
  }

  setText(text: string): void {
    this.textContent = text
  }

  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null
  }

  addEventListener(type: string, fn: () => void, opts?: { once?: boolean }): void {
    this.listeners.push({ type, fn, once: opts?.once === true })
  }

  fire(type: string): void {
    for (const l of this.listeners.slice()) {
      if (l.type !== type) continue
      if (l.once) this.listeners.splice(this.listeners.indexOf(l), 1)
      l.fn()
    }
  }

  focus(): void {
    focus.active = this
  }

  /** Every element under this one, this one first. */
  all(): FakeEl[] {
    return [this, ...this.children.flatMap((c) => c.all())]
  }

  /** Only compound class selectors (".a.b"), which is all the view asks for. */
  querySelector(sel: string): FakeEl | null {
    const want = sel.split('.').filter(Boolean)
    return (
      this.all()
        .slice(1)
        .find((el) => want.every((c) => el.classes.has(c))) ?? null
    )
  }

  /** The text drawn under this element, one entry per element that carries any. */
  texts(): string[] {
    return this.all()
      .map((el) => el.textContent)
      .filter(Boolean)
  }
}

// -- Obsidian and the modules around the view ---------------------------------

vi.mock('obsidian', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ItemView: class {
    app: unknown
    contentEl = new FakeEl('div')
    titleEl = new FakeEl('div')
    constructor(public leaf: { app: unknown }) {
      this.app = leaf.app
    }
  },
  ButtonComponent: class {
    buttonEl: FakeEl
    constructor(parent: FakeEl) {
      this.buttonEl = parent.createEl('button')
    }
    setButtonText(text: string): this {
      this.buttonEl.textContent = text
      return this
    }
    setDisabled(disabled: boolean): this {
      this.buttonEl.disabled = disabled
      return this
    }
    setCta(): this {
      return this
    }
    setClass(cls: string): this {
      this.buttonEl.addClass(cls)
      return this
    }
    onClick(fn: () => void): this {
      this.buttonEl.addEventListener('click', fn)
      return this
    }
  },
  SuggestModal: class {
    open(): void {}
  },
  setTooltip: (): void => {}
}))
vi.mock('../ui/ModalFactory', () => ({
  openProjectPicker: vi.fn<(plugin: unknown, projects: unknown[], pick: (project: unknown) => void) => void>(),
  openTaskModal: vi.fn<() => void>()
}))
vi.mock('../store/ProjectStore', () => ({ TaskFileNameConflictError: class extends Error {} }))

// The debounce runs when the test says so, not on a clock.
const timer = { pending: null as (() => void) | null }
vi.stubGlobal('window', {
  setTimeout: (fn: () => void): number => {
    timer.pending = fn
    return 1
  },
  clearTimeout: (): void => {
    timer.pending = null
  }
})

// -- Helpers -------------------------------------------------------------------

const insertTask =
  vi.fn<(project: unknown, task: { title: string; description: string; iocs: { value: string }[] }) => Promise<void>>()

async function openView(): Promise<{ view: PhishAnalysisView; root: FakeEl; titleEl: FakeEl }> {
  const leaf = { app: {}, updateHeader: (): void => {} }
  const plugin = {
    settings: { ownedAssets: [], phishBrands: [], projectsFolder: 'Boards' },
    store: {
      loadAllProjects: async (): Promise<unknown[]> => [{ id: 'board' }],
      configFor: () => ({ statuses: [], priorities: [] }),
      insertTask
    }
  }
  const view = new PhishAnalysisView(leaf as never, plugin as never)
  const inner = view as unknown as { contentEl: FakeEl; titleEl: FakeEl }
  // Obsidian's ItemView.load() sets the pane's title once, before onOpen.
  inner.titleEl.setText(view.getDisplayText())
  await view.onOpen()
  return { view, root: inner.contentEl, titleEl: inner.titleEl }
}

const report = (view: PhishAnalysisView): Awaited<ReturnType<typeof analysePhishing>> | null =>
  (view as unknown as { report: Awaited<ReturnType<typeof analysePhishing>> | null }).report

const button = (root: FakeEl, text: string): FakeEl => {
  const found = root.all().find((el) => el.tagName === 'button' && el.textContent.startsWith(text))
  if (!found) throw new Error(`no button "${text}"`)
  return found
}

const input = (root: FakeEl): FakeEl => root.all().find((el) => el.tagName === 'textarea') as FakeEl

/** Waits for the analysis of the message with this subject to be on screen. */
async function showing(view: PhishAnalysisView, subject: string): Promise<void> {
  await vi.waitFor(() =>
    expect(report(view)?.headers.identities.find((i) => i.label === 'Subject')?.value).toBe(subject)
  )
}

const mail = (subject: string, body: string, extra = ''): string =>
  `From: Sender <sender@example.test>
To: analyst@corp.test
Subject: ${subject}
${extra}MIME-Version: 1.0
Content-Type: text/plain

${body}
`

beforeEach(() => {
  timer.pending = null
  focus.active = null
  insertTask.mockReset()
  vi.mocked(openProjectPicker).mockReset()
})
afterEach(() => vi.clearAllMocks())

// -- Tests ---------------------------------------------------------------------

describe('PhishAnalysisView: a loaded message is analysed whole and kept out of the paste box', () => {
  it('leaves the box empty, names the source, and analyses the full text', async () => {
    const { view, root } = await openView()
    const text = mail('Loaded one', `Visit https://evil.test/a now.\n${'x'.repeat(50_000)}`)
    view.analyse(text, 'big.eml (51,000 bytes)')
    expect(input(root).value).toBe('')
    expect(root.querySelector('.pm-phish-loaded')?.textContent).toBe(
      'Loaded big.eml (51,000 bytes). Analysed in full; not shown here.'
    )
    await showing(view, 'Loaded one')
    expect((view as unknown as { raw: string }).raw).toBe(text)
    expect(report(view)?.text).toBe((await analysePhishing(text, [], [])).text)
  })

  it('typing drops the loaded message: the box is the message again', async () => {
    const { view, root } = await openView()
    view.analyse(mail('Loaded one', 'body'), 'a.eml (10 bytes)')
    await showing(view, 'Loaded one')
    const box = input(root)
    box.value = mail('Typed two', 'other body')
    box.fire('input')
    expect(root.querySelector('.pm-phish-loaded')?.textContent).toBe('')
    timer.pending?.()
    await showing(view, 'Typed two')
  })

  it('Reset drops the loaded message and its line', async () => {
    const { view, root } = await openView()
    view.analyse(mail('Loaded one', 'body'), 'a.eml (10 bytes)')
    await showing(view, 'Loaded one')
    button(root, 'Reset').fire('click')
    await vi.waitFor(() => expect(report(view)).toBeNull())
    expect(root.querySelector('.pm-phish-loaded')?.textContent).toBe('')
    expect((view as unknown as { loaded: string | null }).loaded).toBeNull()
  })
})

describe('PhishAnalysisView: the old report cannot be acted on once the message changes', () => {
  it('disables Copy and Create case from the first keystroke, through the debounce', async () => {
    const { view, root } = await openView()
    view.analyse(mail('First', 'https://one.test/x'), 'a.eml (1 bytes)')
    await showing(view, 'First')
    expect(button(root, 'Create case').disabled).toBe(false)
    const box = input(root)
    box.value = mail('Second', 'https://two.test/y')
    box.fire('input')
    // Nothing has run yet: the debounce is still pending.
    expect(timer.pending).not.toBeNull()
    for (const name of ['Copy report', 'Copy indicators', 'Create case']) expect(button(root, name).disabled).toBe(true)
    timer.pending?.()
    await showing(view, 'Second')
    expect(button(root, 'Create case').disabled).toBe(false)
  })

  it('disables them while a loaded message is analysed', async () => {
    const { view, root } = await openView()
    view.analyse(mail('First', 'https://one.test/x'), 'a.eml (1 bytes)')
    await showing(view, 'First')
    view.analyse(mail('Second', 'https://two.test/y'), 'b.eml (1 bytes)')
    // Synchronously after the call: the analysis has not landed.
    expect(report(view)?.headers.identities.find((i) => i.label === 'Subject')?.value).toBe('First')
    for (const name of ['Copy report', 'Copy indicators', 'Create case']) expect(button(root, name).disabled).toBe(true)
    await showing(view, 'Second')
  })

  it('a case is made from one message even when the next lands while the board picker is open', async () => {
    const { view, root } = await openView()
    view.analyse(mail('Invoice AAA', 'Pay at https://alpha-evil.test/a'), 'a.eml (1 bytes)')
    await showing(view, 'Invoice AAA')
    button(root, 'Create case').fire('click')
    await vi.waitFor(() => expect(openProjectPicker).toHaveBeenCalled())
    const pick = vi.mocked(openProjectPicker).mock.calls[0][2]

    view.analyse(mail('Payroll BBB', 'Pay at https://bravo-evil.test/b'), 'b.eml (1 bytes)')
    await showing(view, 'Payroll BBB')
    pick({ id: 'board' } as never)
    await vi.waitFor(() => expect(insertTask).toHaveBeenCalledTimes(1))
    const task = insertTask.mock.calls[0][1]
    expect(task.title).toBe('Invoice AAA')
    expect(task.description).toContain('Invoice AAA')
    expect(task.description).not.toContain('BBB')
    expect(task.iocs.map((i) => i.value).join(' ')).not.toContain('bravo')
  })

  it('a Reset while the picker is open still files the message the case was asked for, and throws nothing', async () => {
    const { view, root } = await openView()
    view.analyse(mail('Invoice AAA', 'Pay at https://alpha-evil.test/a'), 'a.eml (1 bytes)')
    await showing(view, 'Invoice AAA')
    button(root, 'Create case').fire('click')
    await vi.waitFor(() => expect(openProjectPicker).toHaveBeenCalled())
    const pick = vi.mocked(openProjectPicker).mock.calls[0][2]
    button(root, 'Reset').fire('click')
    await vi.waitFor(() => expect(report(view)).toBeNull())
    pick({ id: 'board' } as never)
    await vi.waitFor(() => expect(insertTask).toHaveBeenCalledTimes(1))
    expect(insertTask.mock.calls[0][1].title).toBe('Invoice AAA')
  })
})

describe('PhishAnalysisView: long lists are drawn when opened', () => {
  it('draws cards past the cap only when their disclosure opens, and then all of them', async () => {
    const { view, root } = await openView()
    const parts = Array.from(
      { length: 53 },
      (_, i) => `--B\nContent-Type: text/plain; name="f${i}.txt"\nContent-Disposition: attachment\n\nfile ${i}\n`
    ).join('')
    view.analyse(
      `From: a@example.test\nSubject: Many\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="B"\n\n${parts}--B--\n`,
      'm.eml (1 bytes)'
    )
    await showing(view, 'Many')
    button(root, 'Attachments').fire('click')
    const cards = (): number => root.all().filter((el) => el.classes.has('pm-att-card')).length
    expect(cards()).toBe(50)
    const more = root.all().find((el) => el.tagName === 'details') as FakeEl
    expect(more.children.map((el) => el.textContent)).toEqual(['3 more'])
    more.fire('toggle')
    expect(cards()).toBe(53)
    // Once: closing and opening again does not draw them twice.
    more.fire('toggle')
    expect(cards()).toBe(53)
  })

  it('builds a ZIP directory listing only when it is opened', async () => {
    const { view, root } = await openView()
    const bytes = zip([
      { name: 'a.txt', data: new TextEncoder().encode('one') },
      { name: 'b.txt', data: new TextEncoder().encode('two') }
    ])
    const b64 = btoa(String.fromCharCode(...bytes))
    view.analyse(
      `From: a@example.test\nSubject: Zip\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="B"\n\n--B\nContent-Type: application/zip; name="files.zip"\nContent-Transfer-Encoding: base64\n\n${b64}\n--B--\n`,
      'z.eml (1 bytes)'
    )
    await showing(view, 'Zip')
    button(root, 'Attachments').fire('click')
    const listing = root.all().find((el) => el.tagName === 'details') as FakeEl
    expect(listing.children.map((el) => el.tagName)).toEqual(['summary'])
    listing.fire('toggle')
    const pre = listing.children.find((el) => el.tagName === 'pre')
    expect(pre?.textContent).toContain('a.txt')
    expect(pre?.textContent).toContain('b.txt')
  })
})
