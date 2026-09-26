import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zip } from '../../test/zip'
import { analysePhishing, formatPhishReport, linksSection } from '../soc/phish'
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

async function openView(
  phishBrands: string[] = []
): Promise<{ view: PhishAnalysisView; root: FakeEl; titleEl: FakeEl }> {
  const leaf = { app: {}, updateHeader: (): void => {} }
  const plugin = {
    settings: { ownedAssets: [], phishBrands, projectsFolder: 'Boards' },
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

/** The panel's sections as heading → the texts under it. */
function sections(root: FakeEl): Map<string, string[]> {
  const panel = root.querySelector('.pm-headers-panel') as FakeEl
  const out = new Map<string, string[]>()
  let heading = ''
  for (const el of panel.children) {
    if (el.tagName === 'h4') heading = el.textContent
    else out.set(heading, el.texts())
  }
  return out
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

describe('PhishAnalysisView: sender text is drawn escaped', () => {
  // U+202E in the From domain (as an encoded word), the Subject, a Received
  // host and an undecodable part's name; a soft hyphen in a link host.
  const RLO_MAIL = `Received: from mx‮liame.evil.test (mx.evil.test [192.0.2.1]) by b‮evil.test with ESMTP; Mon, 21 Sep 2026 09:15:00 +0000
Return-Path: <bounce@evil.test>
From: PayPal <x@=?utf-8?b?4oCubW9jLmxhcHlhcA==?=>
To: analyst@corp.test
Subject: =?utf-8?b?4oCuSGVsbG8=?=
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="B"

--B
Content-Type: text/html

<a href="https://micro­soft-login.test/verify">sign in</a>
--B
Content-Type: application/octet-stream; name="=?utf-8?Q?Invoice=E2=80=AEfdp.exe?="
Content-Transfer-Encoding: base64

!!!!
--B--
`
  const CF = /\p{Cf}/u

  it('the Message tab escapes identities, hops and observations', async () => {
    const { view, root } = await openView()
    view.analyse(RLO_MAIL, 'rlo.eml (1 bytes)')
    await showing(view, '‮Hello')
    const drawn = (root.querySelector('.pm-headers-panel') as FakeEl).texts()
    expect(drawn.filter((t) => CF.test(t))).toEqual([])
    expect(drawn.some((t) => t.includes('<U+202E>moc.lapyap'))).toBe(true)
    expect(drawn.some((t) => t.startsWith('from mx<U+202E>liame'))).toBe(true)
  })

  it('the Indicators tab escapes its rows and its notes', async () => {
    const { view, root } = await openView()
    view.analyse(RLO_MAIL, 'rlo.eml (1 bytes)')
    await showing(view, '‮Hello')
    button(root, 'Indicators').fire('click')
    const drawn = (root.querySelector('.pm-headers-panel') as FakeEl).texts()
    expect(drawn.filter((t) => CF.test(t))).toEqual([])
    expect(drawn.some((t) => t.includes('Invoice<U+202E>fdp.exe'))).toBe(true)
  })

  it('a case titled from the subject carries it escaped', async () => {
    const { view, root } = await openView()
    view.analyse(RLO_MAIL, 'rlo.eml (1 bytes)')
    await showing(view, '‮Hello')
    button(root, 'Create case').fire('click')
    await vi.waitFor(() => expect(openProjectPicker).toHaveBeenCalled())
    vi.mocked(openProjectPicker).mock.calls[0][2]({ id: 'board' } as never)
    await vi.waitFor(() => expect(insertTask).toHaveBeenCalled())
    expect(insertTask.mock.calls[0][1].title).toBe('<U+202E>Hello')
  })
})

describe('PhishAnalysisView: Indicators tab headings', () => {
  it('puts parser notes under "Parser notes", not under "Not in this paste"', async () => {
    const { view, root } = await openView()
    const text = `From: a@example.test
Subject: Notes
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="B"

--B
Content-Type: text/plain

hello
--B
Content-Type: application/octet-stream; name="payload.bin"
Content-Transfer-Encoding: base64

!!!!
--B--
`
    view.analyse(text, 'n.eml (1 bytes)')
    await showing(view, 'Notes')
    button(root, 'Indicators').fire('click')
    const s = sections(root)
    const undecodable = (t: string): boolean => t.includes('payload.bin') && t.includes('could not be decoded')
    expect(s.get('Parser notes')?.some(undecodable)).toBe(true)
    expect(s.get('Not in this paste')?.some(undecodable) ?? false).toBe(false)
    // The header notes keep their own heading: this mail has no Return-Path.
    expect(s.get('Not in this paste')?.length).toBeGreaterThan(0)
  })
})

describe('PhishAnalysisView: a hop that arrived EARLIER', () => {
  it('keeps the timestamp alone in the unbreakable span and the sentence in one that wraps', async () => {
    const { view, root } = await openView()
    const text = `Received: from b.test by c.test with ESMTP; Mon, 21 Sep 2026 09:10:00 +0000
Received: from a.test by b.test with ESMTP; Mon, 21 Sep 2026 09:15:00 +0000
From: a@example.test
Subject: Skew

body
`
    view.analyse(text, 's.eml (1 bytes)')
    await showing(view, 'Skew')
    const warn = root.querySelector('.pm-headers-result.pm-headers-warn') as FakeEl
    expect(warn.textContent).toBe('2026-09-21T09:10:00.000Z')
    expect(root.querySelector('.pm-hop-delay')?.textContent).toBe(
      '(300s EARLIER than the hop before it — clock skew or a forged hop)'
    )
  })
})

describe('PhishAnalysisView: the tab strip from the keyboard', () => {
  it('says which pane is showing, and keeps focus on the chosen tab after the strip is rebuilt', async () => {
    const { view, root } = await openView()
    view.analyse(mail('Tabs', 'body'), 't.eml (1 bytes)')
    await showing(view, 'Tabs')
    button(root, 'Attachments').fire('click')
    const tabs = root.all().filter((el) => el.classes.has('pm-headers-tab'))
    const on = tabs.filter((el) => el.getAttribute('aria-pressed') === 'true')
    expect(on.map((el) => el.textContent)).toEqual(['Attachments (0)'])
    expect(tabs.filter((el) => el.getAttribute('aria-pressed') === 'false')).toHaveLength(tabs.length - 1)
    expect(focus.active).toBe(on[0])
  })
})

describe('PhishAnalysisView: the title inside the pane', () => {
  it('follows the subject, and goes back after Reset', async () => {
    const { view, root, titleEl } = await openView()
    view.analyse(mail('Invoice 4471 overdue', 'body'), 'i.eml (1 bytes)')
    await showing(view, 'Invoice 4471 overdue')
    expect(titleEl.textContent).toBe('Phish: Invoice 4471 overdue')
    button(root, 'Reset').fire('click')
    await vi.waitFor(() => expect(titleEl.textContent).toBe('Phishing analysis'))
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

/** The panel's h4 headings, each with the texts drawn inside it, in order. */
function headings(root: FakeEl): string[] {
  const panel = root.querySelector('.pm-headers-panel') as FakeEl
  return panel.children.filter((el) => el.tagName === 'h4').map((el) => el.texts().join(''))
}

const drawn = (root: FakeEl): string[] => (root.querySelector('.pm-headers-panel') as FakeEl).texts()

describe('PhishAnalysisView: the Links tab says what the report says', () => {
  it('uses the report’s heading, empty text and pointer to Attachments', async () => {
    // "Links: None found." sat above an attachment whose lure was a PDF /URI.
    const { view, root } = await openView()
    const text = `From: a@example.test
Subject: No links
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="B"

--B
Content-Type: text/plain

see attached
--B
Content-Type: application/octet-stream; name="scan.bin"
Content-Transfer-Encoding: base64

${btoa('bytes')}
--B--
`
    view.analyse(text, 'l.eml (1 bytes)')
    await showing(view, 'No links')
    button(root, 'Links').fire('click')
    const words = linksSection(report(view) as NonNullable<ReturnType<typeof report>>)
    expect(words.notes).toContain(
      'Anything found inside an attachment is listed with that attachment, under Attachments.'
    )
    expect(sections(root).get(words.heading)).toEqual([words.none, ...words.notes])
  })

  it('names the derived domain for what it is, with the note that says how it was derived', async () => {
    const { view, root } = await openView()
    view.analyse(mail('Derived', 'Sign in at https://login.paypa1.co.uk/verify today'), 'd.eml (1 bytes)')
    await showing(view, 'Derived')
    button(root, 'Links').fire('click')
    const words = linksSection(report(view) as NonNullable<ReturnType<typeof report>>)
    const rows = sections(root).get(words.heading) ?? []
    expect(rows).toContain('derived domain paypa1[.]co[.]uk')
    expect(rows.some((t) => t.startsWith('domain '))).toBe(false)
    expect(rows).toContain(words.notes[0])
    expect(words.notes[0]).toMatch(/^Derived domain = /)
  })

  it('escapes a flag that quotes the host as written', async () => {
    // U+202E in a host the URL parser refuses: the brand fact quotes the raw host.
    const { view, root } = await openView(['paypal.test'])
    view.analyse(mail('Flag', 'Go to https://paypal.te‮st/x now'), 'f.eml (1 bytes)')
    await showing(view, 'Flag')
    button(root, 'Links').fire('click')
    expect(drawn(root).filter((t) => /\p{Cf}/u.test(t))).toEqual([])
    expect(drawn(root).some((t) => t.startsWith('the name "paypal" on paypal.te<U+202E>st'))).toBe(true)
  })
})

describe('PhishAnalysisView: an attached message keeps its own text, links and parts', () => {
  // The same shape as the report's fixture: a reporter's note, then the
  // phisher's mail attached, holding a link and a payload of its own. The
  // name carries U+202E, because the sender wrote it.
  const NESTED = `From: user@corp.test
Subject: FW: payment
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="OUT"

--OUT
Content-Type: text/plain

Reporting this.
--OUT
Content-Type: message/rfc822
Content-Disposition: attachment; filename="=?utf-8?Q?fwd=E2=80=AElme.eml?="

From: attacker@evil.example
Subject: Invoice
Content-Type: multipart/mixed; boundary="IN"

--IN
Content-Type: text/html

<p>Pay at https://pay.evil.example/login</p>
--IN
Content-Type: application/octet-stream; name="payload.exe"
Content-Disposition: attachment; filename="payload.exe"
Content-Transfer-Encoding: base64

${btoa('MZ payload')}
--IN--

--OUT--
`
  const NAME = 'fwd<U+202E>lme.eml'

  it('shows the attached message’s text on the Body tab, under its own name, apart from the reporter’s', async () => {
    const { view, root } = await openView()
    view.analyse(NESTED, 'n.eml (1 bytes)')
    await showing(view, 'FW: payment')
    button(root, 'Body').fire('click')
    const s = sections(root)
    expect(s.get('Plain text')?.join(' ')).toContain('Reporting this.')
    expect([...s.values()].flat().join(' ')).toContain('Pay at https://pay.evil.example/login')
    expect(s.get('Text extracted from the HTML — not rendered')?.join(' ') ?? '').not.toContain('Pay at')
    expect(headings(root)).toContain(`Text of the attached message ${NAME}`)
    expect(drawn(root).filter((t) => /\p{Cf}/u.test(t))).toEqual([])
  })

  it('says which message a link was in', async () => {
    const { view, root } = await openView()
    view.analyse(NESTED, 'n.eml (1 bytes)')
    await showing(view, 'FW: payment')
    button(root, 'Links').fire('click')
    const row = root.all().find((el) => el.classes.has('pm-headers-link')) as FakeEl
    expect(row.texts().slice(0, 2)).toEqual(['hxxps://pay[.]evil[.]example/login', `in the body of ${NAME}`])
  })

  it('says which message an attachment was inside', async () => {
    const { view, root } = await openView()
    view.analyse(NESTED, 'n.eml (1 bytes)')
    await showing(view, 'FW: payment')
    button(root, 'Attachments').fire('click')
    const cards = root.all().filter((el) => el.classes.has('pm-att-card'))
    const payload = cards.find((c) => c.texts()[0] === 'payload.exe') as FakeEl
    expect(payload.texts()[1]).toBe(`inside ${NAME}`)
    const outer = cards.find((c) => c.texts()[0] === NAME) as FakeEl
    expect(outer.texts().some((t) => t.startsWith('inside '))).toBe(false)
    expect(drawn(root).filter((t) => /\p{Cf}/u.test(t))).toEqual([])
  })

  it('does not say a rebuilt part’s hashes came from the bytes in the file', async () => {
    // A message/rfc822 part is 7bit: its bytes were rebuilt from its text.
    const { view, root } = await openView()
    view.analyse(NESTED, 'n.eml (1 bytes)')
    await showing(view, 'FW: payment')
    button(root, 'Attachments').fire('click')
    const outer = root.all().find((el) => el.classes.has('pm-att-card') && el.texts()[0] === NAME) as FakeEl
    expect(outer.texts()).toContain(
      "this part's bytes were rebuilt here from its text as read (line breaks as LF), so its size and hashes may not match the file as sent"
    )
    expect(outer.texts()).toContain('hashes computed here')
    expect(outer.texts().some((t) => t.includes('from the bytes in the file'))).toBe(false)
  })
})

describe('PhishAnalysisView: the attachment cards say what the report says', () => {
  const pdfMail = (subject: string, streamBytes: number[]): string => {
    const head = `%PDF-1.7\n1 0 obj\n<< /Type /XObject /Subtype /Image /Filter /DCTDecode /Length ${streamBytes.length} >>\nstream\n`
    const tail = '\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'
    const bytes = [...head, ...tail].map((c) => c.charCodeAt(0))
    bytes.splice(head.length, 0, ...streamBytes)
    return `From: a@example.test\nSubject: ${subject}\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="B"\n\n--B\nContent-Type: application/pdf\nContent-Disposition: attachment; filename="scan.pdf"\nContent-Transfer-Encoding: base64\n\n${btoa(String.fromCharCode(...bytes))}\n--B--\n`
  }

  it('calls a /DCTDecode stream whose bytes are a program a stream, not a picture', async () => {
    const { view, root } = await openView()
    const program = [0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00]
    view.analyse(pdfMail('Stream', program), 's.eml (1 bytes)')
    await showing(view, 'Stream')
    button(root, 'Attachments').fire('click')
    expect(drawn(root).some((t) => /^Stream at byte \d+ \(\/DCTDecode\) · 16 bytes$/.test(t))).toBe(true)
    expect(drawn(root).some((t) => t.startsWith('Picture at'))).toBe(false)
  })

  it('still calls a JPEG stream a picture', async () => {
    const { view, root } = await openView()
    const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]
    view.analyse(pdfMail('Jpeg', jpeg), 'j.eml (1 bytes)')
    await showing(view, 'Jpeg')
    button(root, 'Attachments').fire('click')
    expect(drawn(root).some((t) => /^Picture at byte \d+ \(\/DCTDecode\) · 13 bytes$/.test(t))).toBe(true)
  })

  it('heads the inline images as the report does', async () => {
    const { view, root } = await openView()
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]
    const text = `From: a@example.test\nSubject: Logo\nMIME-Version: 1.0\nContent-Type: multipart/related; boundary="B"\n\n--B\nContent-Type: text/plain\n\nhi\n--B\nContent-Type: image/png\nContent-Disposition: inline; filename="logo.png"\nContent-ID: <logo>\nContent-Transfer-Encoding: base64\n\n${btoa(String.fromCharCode(...png))}\n--B--\n`
    view.analyse(text, 'i.eml (1 bytes)')
    await showing(view, 'Logo')
    button(root, 'Attachments').fire('click')
    const line = formatPhishReport(report(view) as NonNullable<ReturnType<typeof report>>)
      .split('\n')
      .find((l) => l.startsWith('### Inline images'))
    expect(line).toBe('### Inline images — marked inline or given a Content-ID by their own headers')
    expect(headings(root)).toContain(line?.slice(4))
  })
})

describe('PhishAnalysisView: Copy indicators', () => {
  it('copies the rows as the tab draws them, with invisible characters named', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { view, root } = await openView()
    view.analyse(mail('Soft', 'Sign in at https://micro­soft-login.test/verify'), 'c.eml (1 bytes)')
    await showing(view, 'Soft')
    button(root, 'Copy indicators').fire('click')
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled())
    const copied = writeText.mock.calls[0][0]
    expect(copied).toContain('url: hxxps://micro<U+00AD>soft-login[.]test/verify')
    expect(/\p{Cf}/u.test(copied)).toBe(false)
    vi.unstubAllGlobals()
  })
})

describe('PhishAnalysisView: an authentication result with no asserting host', () => {
  it('says there was none, rather than "asserted by no asserting host stated"', async () => {
    // Microsoft 365 writes the result with no host in front of it.
    const { view, root } = await openView()
    view.analyse(
      mail('M365', 'body', 'Authentication-Results: spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=example.test\n'),
      'a.eml (1 bytes)'
    )
    await showing(view, 'M365')
    const by = root.all().filter((el) => el.classes.has('pm-headers-by'))
    expect(by.map((el) => el.textContent)).toEqual(['no asserting host stated'])
  })
})
