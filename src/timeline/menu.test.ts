import type { App, Command, Editor, EditorPosition, EditorTransaction, Menu, Plugin } from 'obsidian'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent, type FakeEvent } from '../../test/fakeDom'
import type { NoteTimelineCallbacks } from './livePreview'
import { addTimelineItems, openKindMenu, registerNoteTimeline, timelineLinkAt } from './menu'

const platform = vi.hoisted(() => ({ isAndroidApp: false, isIosApp: false }))

/** Obsidian's Menu and SuggestModal as far as the timeline uses them, recording what was built and opened. */
const fakes = vi.hoisted(() => {
  interface Item {
    title: string
    checked: boolean
    disabled: boolean
    click: (() => void) | null
    submenu: FakeMenu | null
  }
  class FakeMenu {
    static shown: FakeMenu[] = []
    items: Item[] = []
    addItem(build: (item: object) => void): this {
      const it: Item = { title: '', checked: false, disabled: false, click: null, submenu: null }
      const item = {
        setTitle: (t: string) => {
          it.title = t
          return item
        },
        setIcon: () => item,
        setWarning: () => item,
        setChecked: (c: boolean) => {
          it.checked = c
          return item
        },
        setDisabled: (d: boolean) => {
          it.disabled = d
          return item
        },
        onClick: (fn: () => void) => {
          it.click = fn
          return item
        },
        setSubmenu: () => {
          it.submenu = new FakeMenu()
          return it.submenu
        }
      }
      build(item)
      this.items.push(it)
      return this
    }
    showAtMouseEvent(): void {
      FakeMenu.shown.push(this)
    }
  }
  class FakeSuggestModal {
    static opened: unknown[] = []
    setPlaceholder(): void {}
    open(): void {
      FakeSuggestModal.opened.push(this)
    }
  }
  return { FakeMenu, FakeSuggestModal, timeline: { callbacks: null as NoteTimelineCallbacks | null } }
})
type FakeMenu = InstanceType<typeof fakes.FakeMenu>

// menu.ts pulls in the reading module; its Obsidian base classes only need to
// exist (TaskDetailView.test idiom). Platform is a plain object a test can
// switch to Android; Menu and SuggestModal are the fakes above.
vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  function Stub(): void {}
  const fake: Record<string, unknown> = {
    Platform: platform,
    Menu: fakes.FakeMenu,
    SuggestModal: fakes.FakeSuggestModal
  }
  return new Proxy(real, {
    get: (target, prop) => {
      if (typeof prop === 'string' && prop in fake) return fake[prop]
      if (prop in target) return target[prop as string]
      if (typeof prop !== 'string' || prop === 'then') return undefined
      return Stub
    },
    has: () => true
  })
})

// The Live Preview drawing is its own module's to test; here only the callbacks it is given.
vi.mock('./livePreview', () => ({
  noteTimelineExtension: (callbacks: NoteTimelineCallbacks) => {
    fakes.timeline.callbacks = callbacks
    return []
  }
}))

afterEach(() => {
  platform.isAndroidApp = false
  platform.isIosApp = false
  fakes.FakeMenu.shown = []
  fakes.FakeSuggestModal.opened = []
  vi.unstubAllGlobals()
})

/** An Obsidian editor over a note and a selection: enough for the menu, the commands and applyEdit. */
function editorOn(note: string[], from: EditorPosition, to: EditorPosition = from) {
  let doc = note.join('\n')
  let start = from
  let caret = to
  const offset = (p: EditorPosition) =>
    doc
      .split('\n')
      .slice(0, p.line)
      .reduce((n, l) => n + l.length + 1, p.ch)
  const editor = {
    getValue: () => doc,
    getCursor: (which?: string) => (which === 'from' ? start : caret),
    getLine: (n: number) => doc.split('\n')[n],
    getRange: (a: EditorPosition, b: EditorPosition) => doc.slice(offset(a), offset(b)),
    posToOffset: offset,
    offsetToPos: (o: number) => {
      const before = doc.slice(0, o).split('\n')
      return { line: before.length - 1, ch: before[before.length - 1].length }
    },
    transaction: (tx: EditorTransaction) => {
      for (const c of tx.changes ?? []) {
        doc = doc.slice(0, offset(c.from)) + c.text + doc.slice(offset(c.to ?? c.from))
      }
    },
    setCursor: (p: EditorPosition) => {
      start = p
      caret = p
    }
  }
  return { editor: editor as unknown as Editor, lines: () => doc.split('\n'), caret: () => caret }
}

/** The caret alone on `line`. */
const caretOn = (note: string[], line: number) => editorOn(note, { line, ch: 0 })

/**
 * A menu's items as text, in order: a submenu's after its item as
 * 'Item › Sub', a checked one ending ' ✓', a disabled one '(disabled)'.
 */
function outline(menu: FakeMenu, parent = ''): string[] {
  return menu.items.flatMap((it) => {
    const title = `${parent}${it.title}${it.checked ? ' ✓' : ''}${it.disabled ? ' (disabled)' : ''}`
    return it.submenu ? [`${title} ›`, ...outline(it.submenu, `${it.title} › `)] : [title]
  })
}

/** Clicks the item at a path of titles ('Make timeline', 'Steps'). */
function click(menu: FakeMenu, ...path: string[]): void {
  const [first, ...rest] = path
  const it = menu.items.find((i) => i.title === first)
  if (!it) throw new Error(`no ${first} in ${outline(menu).join(', ')}`)
  if (rest.length) {
    if (!it.submenu) throw new Error(`${first} has no submenu`)
    click(it.submenu, ...rest)
  } else if (it.click) it.click()
  else throw new Error(`${first} does nothing`)
}

/** The right-click menu at the caret. */
function menuOf(editor: Editor): FakeMenu {
  const menu = new fakes.FakeMenu()
  addTimelineItems(menu as unknown as Menu, editor, editor.getCursor().line, {} as App)
  return menu
}

/** The plugin's commands by id, with the Live Preview callbacks it handed over. */
function registered(): { commands: Map<string, Command>; callbacks: NoteTimelineCallbacks } {
  vi.stubGlobal('activeDocument', {})
  const commands = new Map<string, Command>()
  const plugin = {
    app: {
      workspace: { on: () => ({}), onLayoutReady: () => {}, iterateAllLeaves: () => {} },
      metadataCache: { on: () => ({}) }
    },
    registerEditorExtension: () => {},
    registerMarkdownPostProcessor: () => {},
    registerEvent: () => {},
    registerDomEvent: () => {},
    addCommand: (c: Command) => commands.set(c.id, c)
  }
  registerNoteTimeline(plugin as unknown as Plugin)
  if (!fakes.timeline.callbacks) throw new Error('no Live Preview callbacks')
  return { commands, callbacks: fakes.timeline.callbacks }
}

/** Runs a command's check (`checking`) or the command itself on an editor; whether it applied. */
function runCommand(id: string, editor: Editor, checking = false): boolean {
  const command = registered().commands.get(id)
  if (!command?.editorCheckCallback) throw new Error(`no ${id} command`)
  return command.editorCheckCallback(checking, editor, {} as never) === true
}

function line(...cls: string[]) {
  const root = FakeEl.root()
  const ln = root.createDiv({ cls })
  return { root, ln }
}

describe('timelineLinkAt', () => {
  it('finds a bare URL inside a timeline line', () => {
    const { ln } = line('cm-line', 'cf-ntl-line')
    const url = ln.createSpan({ cls: ['cm-url', 'cm-underline'], text: 'http://lawson-rowe-review.com/' })
    expect(timelineLinkAt(url as unknown as EventTarget)).toBe(url)
  })

  it('leaves links outside a timeline to Obsidian', () => {
    const { ln } = line('cm-line')
    const url = ln.createSpan({ cls: 'cm-url', text: 'https://example.com' })
    expect(timelineLinkAt(url as unknown as EventTarget)).toBeNull()
  })

  it('ignores plain text in a timeline, and targets that are not elements', () => {
    const { ln } = line('cm-line', 'cf-ntl-line')
    const word = ln.createSpan({ text: 'the user browsed' })
    expect(timelineLinkAt(word as unknown as EventTarget)).toBeNull()
    expect(timelineLinkAt(null)).toBeNull()
    expect(timelineLinkAt({} as EventTarget)).toBeNull()
  })
})

describe('timelineLinkAt: only links that leave the vault', () => {
  it('leaves a note link and a tag in a timeline to Obsidian', () => {
    const { ln } = line('cm-line', 'cf-ntl-line')
    const note = ln.createSpan({ cls: 'cm-hmd-internal-link' }).createSpan({ cls: 'cm-underline', text: 'Evidence' })
    expect(timelineLinkAt(note as unknown as EventTarget)).toBeNull()
    const tag = ln.createSpan({ cls: ['cm-hashtag', 'cm-hashtag-end'], text: 'phishing' })
    expect(timelineLinkAt(tag as unknown as EventTarget)).toBeNull()
    // Rendered HTML, as an embed inside a card draws it.
    const a = ln.createEl('a', { cls: 'internal-link', text: 'Alert 4521' })
    expect(timelineLinkAt(a as unknown as EventTarget)).toBeNull()
  })

  it("asks Obsidian whether a markdown link's text points at a note or a site", () => {
    const { ln } = line('cm-line', 'cf-ntl-line')
    const text = ln.createSpan({ cls: 'cm-link' }).createSpan({ cls: 'cm-underline', text: 'the report' })
    const at = text as unknown as EventTarget
    expect(timelineLinkAt(at, () => 'internal-link')).toBeNull()
    expect(timelineLinkAt(at, () => 'external-link')).toBe(text)
    // Unknown (Obsidian could not say): kept from opening.
    expect(timelineLinkAt(at, () => null)).toBe(text)
    expect(timelineLinkAt(at)).toBe(text)
  })

  it('keeps a rendered external link from opening, whatever the text around it is', () => {
    const { ln } = line('cm-line', 'cf-ntl-line')
    const a = ln.createEl('a', { cls: 'external-link', text: 'Payload page' })
    expect(timelineLinkAt(a as unknown as EventTarget, () => 'internal-link')).toBe(a)
  })
})

describe('registerNoteTimeline: the link guard', () => {
  type Listener = (evt: MouseEvent) => void
  const doc = () => ({ name: 'doc' }) as unknown as Document

  function setup(leafDocs: Document[] = []) {
    const main = doc()
    vi.stubGlobal('activeDocument', main)
    const guards: { doc: unknown; type: string; fn: Listener; capture: boolean }[] = []
    let windowOpen: ((win: { doc: Document }) => void) | null = null
    const plugin = {
      app: {
        workspace: {
          on: (name: string, fn: (win: { doc: Document }) => void) => {
            if (name === 'window-open') windowOpen = fn
            return {}
          },
          onLayoutReady: (fn: () => void) => fn(),
          iterateAllLeaves: (fn: (leaf: unknown) => void) => {
            for (const d of [main, ...leafDocs]) fn({ getContainer: () => ({ doc: d }) })
          }
        },
        metadataCache: { on: () => ({}) }
      },
      registerEditorExtension: vi.fn<() => void>(),
      registerMarkdownPostProcessor: vi.fn<() => void>(),
      registerEvent: vi.fn<() => void>(),
      addCommand: vi.fn<() => void>(),
      registerDomEvent: vi.fn<(d: unknown, type: string, fn: Listener, opts?: { capture: boolean }) => void>(
        (d, type, fn, opts) => {
          guards.push({ doc: d, type, fn, capture: opts?.capture ?? false })
        }
      )
    }
    registerNoteTimeline(plugin as unknown as Plugin)
    const openWindow = (d: Document) => windowOpen?.({ doc: d })
    const on = (d: unknown) =>
      guards
        .filter((g) => g.doc === d)
        .map((g) => `${g.type}${g.capture ? ' (capture)' : ''}`)
        .sort()
    const guard = (type: string, on: unknown = main) => {
      const g = guards.find((x) => x.doc === on && x.type === type)
      if (!g) throw new Error(`no ${type} guard`)
      return (evt: FakeEvent) => g.fn(evt as unknown as MouseEvent)
    }
    return { main, on, openWindow, guard }
  }

  const EVERY = ['auxclick (capture)', 'click (capture)', 'mousedown (capture)']

  it('guards every window: the main one, a popout open at load and one opened later', () => {
    const popout = doc()
    const { main, on, openWindow } = setup([popout])
    expect(on(main)).toEqual(EVERY)
    expect(on(popout)).toEqual(EVERY)
    const later = doc()
    openWindow(later)
    expect(on(later)).toEqual(EVERY)
  })

  it("stops the presses Obsidian's editor opens a link on: the middle button, and a tap on Android", () => {
    const { guard } = setup()
    const { ln } = line('cm-line', 'cf-ntl-line')
    const url = ln.createSpan({ cls: ['cm-url', 'cm-underline'], text: 'http://lawson-rowe-review.com/' })
    const press = (button: number) => {
      const e = fakeEvent('mousedown', { target: url, button })
      guard('mousedown')(e)
      return e
    }
    const middle = press(1)
    expect(middle.defaultPrevented).toBe(true)
    expect(middle.propagationStopped).toBe(true)
    // A plain press on desktop places the caret, as in any text.
    const left = press(0)
    expect(left.defaultPrevented).toBe(false)
    expect(left.propagationStopped).toBe(false)
    platform.isAndroidApp = true
    const tap = press(0)
    expect(tap.propagationStopped).toBe(true)
    // The tap still places the caret.
    expect(tap.defaultPrevented).toBe(false)
  })

  it('lets a middle-click on a note link through', () => {
    const { guard } = setup()
    const { ln } = line('cm-line', 'cf-ntl-line')
    const note = ln.createSpan({ cls: 'cm-hmd-internal-link' }).createSpan({ cls: 'cm-underline', text: 'Evidence' })
    const e = fakeEvent('mousedown', { target: note, button: 1 })
    guard('mousedown')(e)
    expect(e.defaultPrevented).toBe(false)
    expect(e.propagationStopped).toBe(false)
  })

  it("keeps Obsidian's own tap on iOS from opening a timeline link", () => {
    // On iOS Obsidian's editor adds a touchend listener to the window at each
    // touch, and at the end of a tap calls its click handler directly: there
    // is no click event for the document guards to stop.
    const win = { name: 'window' }
    vi.stubGlobal('window', win)
    expect(setup().on(win)).toEqual([])
    platform.isIosApp = true
    const { on, guard } = setup()
    // Not capture: every other listener has the touch first.
    expect(on(win)).toEqual(['touchend'])
    const { ln } = line('cm-line', 'cf-ntl-line')
    const tap = (target: FakeEl) => {
      const stopImmediatePropagation = vi.fn<() => void>()
      const e = fakeEvent('touchend', {
        target,
        changedTouches: [{ clientX: 1, clientY: 1 }],
        stopImmediatePropagation
      })
      guard('touchend', win)(e)
      return { e, stopImmediatePropagation }
    }
    const url = tap(ln.createSpan({ cls: ['cm-url', 'cm-underline'], text: 'http://lawson-rowe-review.com/' }))
    // Obsidian's listener, added after this one, does not run.
    expect(url.stopImmediatePropagation).toHaveBeenCalledOnce()
    // The tap still places the caret.
    expect(url.e.defaultPrevented).toBe(false)
    const note = ln.createSpan({ cls: 'cm-hmd-internal-link' }).createSpan({ cls: 'cm-underline', text: 'Evidence' })
    expect(tap(note).stopImmediatePropagation).not.toHaveBeenCalled()
    expect(tap(ln.createSpan({ text: 'the user browsed' })).stopImmediatePropagation).not.toHaveBeenCalled()
  })
})

const STYLES = ['Events', 'Steps', 'Process chain']

describe('Make timeline: the lines a selection covers', () => {
  // Shift+Down twice from the start of line 1, or a triple-click on it and the
  // next: the selection ends at column 0 of line 3, and nothing of it is selected.
  const from = { line: 1, ch: 0 }
  const to = { line: 3, ch: 0 }

  it('turns only the lines selected into events, from the menu and the command', () => {
    const note = ['## F', '11:04 a', '11:05 b', 'Summary para']
    const made = ['## F', '%% timeline %%', '- 11:04 a', '- 11:05 b', 'Summary para']
    const fromMenu = editorOn(note, from, to)
    click(menuOf(fromMenu.editor), 'Make timeline', 'Events')
    expect(fromMenu.lines()).toEqual(made)
    const fromCommand = editorOn(note, from, to)
    runCommand('timeline-make', fromCommand.editor)
    expect(fromCommand.lines()).toEqual(made)
  })

  it('offers it when the line the selection ends on is a heading, which cannot be an event', () => {
    const note = editorOn(['## Findings', '11:04 a', '11:05 b', '### Attack chain summary'], from, to)
    expect(outline(menuOf(note.editor))).toContain('Make timeline ›')
    expect(runCommand('timeline-make', note.editor, true)).toBe(true)
  })
})

describe('Make timeline ›: a style for the list', () => {
  const LIST = ['## Alert story', '- 21:34 Alert fired', '- On host: DESKTOP1']

  it('offers the three styles, and nothing to insert, on a list', () => {
    expect(outline(menuOf(caretOn(LIST, 1).editor))).toEqual([
      'Make timeline ›',
      ...STYLES.map((s) => `Make timeline › ${s}`)
    ])
  })

  it('writes the style picked, from the menu and the commands', () => {
    const steps = caretOn(LIST, 2)
    click(menuOf(steps.editor), 'Make timeline', 'Steps')
    expect(steps.lines()).toEqual(['## Alert story', '%% timeline steps %%', ...LIST.slice(1)])
    const chain = caretOn(LIST, 1)
    expect(runCommand('timeline-make-chain', chain.editor, true)).toBe(true)
    runCommand('timeline-make-chain', chain.editor)
    expect(chain.lines()).toEqual(['## Alert story', '%% timeline chain %%', ...LIST.slice(1)])
    const viaSteps = caretOn(LIST, 1)
    runCommand('timeline-make-steps', viaSteps.editor)
    expect(viaSteps.lines()[1]).toBe('%% timeline steps %%')
  })
})

describe('Insert timeline ›: a new one at the caret, nothing selected', () => {
  const NOTE = ['## Alert story', '', 'A medium severity alert fired.']

  it('offers the three styles on a blank line or a paragraph', () => {
    const items = ['Insert timeline ›', ...STYLES.map((s) => `Insert timeline › ${s}`)]
    expect(outline(menuOf(caretOn(NOTE, 1).editor))).toEqual(items)
    expect(outline(menuOf(caretOn(NOTE, 2).editor))).toEqual(items)
    expect(outline(menuOf(caretOn(NOTE, 0).editor))).toEqual(items)
  })

  it('makes the blank line the marker and one empty item, the caret in it', () => {
    const note = caretOn(NOTE, 1)
    click(menuOf(note.editor), 'Insert timeline', 'Steps')
    expect(note.lines()).toEqual(['## Alert story', '%% timeline steps %%', '- ', '', 'A medium severity alert fired.'])
    expect(note.caret()).toEqual({ line: 2, ch: 2 })
  })

  it('is a command for each style, offered where the menu offers it', () => {
    for (const [id, marker] of [
      ['timeline-insert', '%% timeline %%'],
      ['timeline-insert-steps', '%% timeline steps %%'],
      ['timeline-insert-chain', '%% timeline chain %%']
    ]) {
      const note = caretOn(NOTE, 1)
      expect(runCommand(id, note.editor, true)).toBe(true)
      runCommand(id, note.editor)
      expect(note.lines()[1]).toBe(marker)
    }
    // On a list, the list is made a timeline instead.
    expect(runCommand('timeline-insert', caretOn(['- a', '- b'], 0).editor, true)).toBe(false)
  })

  it('is not offered in the frontmatter, in code or inside a timeline', () => {
    const fm = ['---', 'tags: [case]', '---', '']
    expect(outline(menuOf(caretOn(fm, 1).editor))).toEqual([])
    expect(runCommand('timeline-insert', caretOn(fm, 1).editor, true)).toBe(false)
    const code = ['```', '', '```']
    expect(outline(menuOf(caretOn(code, 1).editor))).toEqual([])
    expect(runCommand('timeline-insert-steps', caretOn(code, 1).editor, true)).toBe(false)
    const timeline = ['%% timeline %%', '- 11:04 a']
    expect(outline(menuOf(caretOn(timeline, 1).editor))).not.toContain('Insert timeline ›')
    expect(runCommand('timeline-insert-chain', caretOn(timeline, 1).editor, true)).toBe(false)
  })
})

describe("In a table cell's own editor", () => {
  const cell = (text: string) => {
    const note = caretOn([text], 0)
    Object.assign(note.editor, { inTableCell: true })
    return note
  }

  it('offers no timeline item or command, as Obsidian offers none of its own block items there', () => {
    for (const text of ['1.2.3.4', '- a', '']) {
      const note = cell(text)
      expect(outline(menuOf(note.editor))).toEqual([])
      for (const id of ['timeline-insert', 'timeline-insert-steps', 'timeline-make', 'timeline-make-chain']) {
        expect(runCommand(id, note.editor, true)).toBe(false)
      }
      expect(note.lines()).toEqual([text])
    }
    // The same text in the note's editor is offered them.
    expect(outline(menuOf(caretOn(['1.2.3.4'], 0).editor))).toContain('Insert timeline ›')
  })
})

describe('Inside a timeline: the items for its style', () => {
  const TAIL = ['Defang timeline', 'Copy timeline for ticket', 'Back to plain list']
  const style = (current: string) => ['Style ›', ...STYLES.map((s) => `Style › ${s}${s === current ? ' ✓' : ''}`)]
  // Out of order, so an events timeline would offer sorting.
  const timed = (marker: string) => [marker, '- 11:05 Alert fired: nltest', '- 11:04 On host: DESKTOP1']

  it('events: add, move, the kind, sort, delete', () => {
    expect(outline(menuOf(caretOn(timed('%% timeline %%'), 1).editor))).toEqual([
      'Add event below',
      'Move event down',
      'Set event kind…',
      'Sort events by time',
      'Delete event',
      ...style('Events'),
      ...TAIL
    ])
  })

  it('steps: labelled as steps, with no kind and no sorting', () => {
    expect(outline(menuOf(caretOn(timed('%% timeline steps %%'), 2).editor))).toEqual([
      'Add step below',
      'Move step up',
      'Delete step',
      ...style('Steps'),
      ...TAIL
    ])
  })

  it('chain: labelled as links, with Add child', () => {
    const chain = ['%% timeline chain %%', '- Initial process: cmd.exe', '    - Terminal process: nltest.exe']
    const items = ['Add link below', 'Add child', 'Delete link', ...style('Process chain'), ...TAIL]
    expect(outline(menuOf(caretOn(chain, 1).editor))).toEqual(items)
    expect(outline(menuOf(caretOn(chain, 2).editor))).toEqual(items)
    const note = caretOn(chain, 1)
    click(menuOf(note.editor), 'Add child')
    expect(note.lines()).toEqual([...chain, '    - '])
  })

  it('Style › rewrites the marker; the style it has already does nothing', () => {
    const note = caretOn(['  %% timeline steps %%', '  - a'], 1)
    click(menuOf(note.editor), 'Style', 'Process chain')
    expect(note.lines()).toEqual(['  %% timeline chain %%', '  - a'])
    click(menuOf(note.editor), 'Style', 'Process chain')
    expect(note.lines()).toEqual(['  %% timeline chain %%', '  - a'])
  })

  it('the header menu button shows the same items, at the marker', () => {
    const chain = ['%% timeline chain %%', '- Initial process: cmd.exe']
    const note = caretOn(chain, 1)
    const { callbacks } = registered()
    const view = { state: { field: () => ({ editor: note.editor }) } }
    callbacks.onHeaderMenu(view as never, 0, {} as MouseEvent)
    const shown = fakes.FakeMenu.shown
    expect(shown).toHaveLength(1)
    expect(outline(shown[0])).toEqual(outline(menuOf(caretOn(chain, 0).editor)))
    expect(outline(shown[0])).toEqual(['Add link below', ...style('Process chain'), ...TAIL])
  })
})

describe('Steps: the closing Details bullet and its facts', () => {
  const STORY = [
    '%% timeline steps %%',
    '- 21:34 Alert fired: Potential Recon Activity Via Nltest.EXE',
    '- On host: DESKTOP1.domain.local',
    '- Details',
    '    - Alert ID: SEC-2023-0704-0001',
    '    - Host: DESKTOP1.domain.local',
    '      192.168.56.95'
  ]
  const TAIL = ['Defang timeline', 'Copy timeline for ticket', 'Back to plain list']
  const style = ['Style ›', 'Style › Events', 'Style › Steps ✓', 'Style › Process chain']
  const withStep = [...STORY.slice(0, 3), '- ', ...STORY.slice(3)]

  it('offers no move past Details and none of it, and deletes it as details', () => {
    expect(outline(menuOf(caretOn(STORY, 2).editor))).toEqual([
      'Add step below',
      'Move step up',
      'Delete step',
      ...style,
      ...TAIL
    ])
    for (const line of [3, 4, 6]) {
      expect(outline(menuOf(caretOn(STORY, line).editor))).toEqual([
        'Add step below',
        'Delete details',
        ...style,
        ...TAIL
      ])
    }
    expect(runCommand('timeline-move-down', caretOn(STORY, 2).editor, true)).toBe(false)
    expect(runCommand('timeline-move-up', caretOn(STORY, 4).editor, true)).toBe(false)
  })

  it('adds a step above Details, from a fact, the command and the add row', () => {
    const fromFact = caretOn(STORY, 5)
    click(menuOf(fromFact.editor), 'Add step below')
    expect(fromFact.lines()).toEqual(withStep)
    expect(fromFact.caret()).toEqual({ line: 3, ch: 2 })
    const command = caretOn(STORY, 3)
    runCommand('timeline-add-event', command.editor)
    expect(command.lines()).toEqual(withStep)
    const row = caretOn(STORY, 1)
    const view = { state: { field: () => ({ editor: row.editor }) } }
    registered().callbacks.onAddEvent(view as never, 0)
    expect(row.lines()).toEqual(withStep)
  })
})

describe('Copy timeline for ticket', () => {
  it('copies a file named by itself as written, defanging the rest', () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const note = caretOn(['%% timeline steps %%', '- Process launch: nltest.exe', '- IP: 10.0.0.5'], 1)
    click(menuOf(note.editor), 'Copy timeline for ticket')
    expect(writeText).toHaveBeenCalledExactlyOnceWith('Steps (2)\n1. Process launch: nltest.exe\n2. IP: 10[.]0[.]0[.]5')
  })
})

describe('Commands for styles and links', () => {
  const EVENTS = ['%% timeline %%', '- 11:04 a']

  it('change the style, offered only where it is another style', () => {
    expect(runCommand('timeline-style-events', caretOn(EVENTS, 1).editor, true)).toBe(false)
    for (const [id, marker] of [
      ['timeline-style-steps', '%% timeline steps %%'],
      ['timeline-style-chain', '%% timeline chain %%']
    ]) {
      const note = caretOn(EVENTS, 0)
      expect(runCommand(id, note.editor, true)).toBe(true)
      runCommand(id, note.editor)
      expect(note.lines()).toEqual([marker, '- 11:04 a'])
    }
    expect(runCommand('timeline-style-steps', caretOn(['- a'], 0).editor, true)).toBe(false)
  })

  it('add a child in a chain only', () => {
    const chain = caretOn(['%% timeline chain %%', '- cmd.exe'], 1)
    expect(runCommand('timeline-add-child', chain.editor, true)).toBe(true)
    runCommand('timeline-add-child', chain.editor)
    expect(chain.lines()).toEqual(['%% timeline chain %%', '- cmd.exe', '\t- '])
    expect(runCommand('timeline-add-child', caretOn(EVENTS, 1).editor, true)).toBe(false)
  })

  it("hands Live Preview the chain's add row: a child of the last link", () => {
    const chain = ['%% timeline chain %%', '- Initial process: cmd.exe', '    - Terminal process: nltest.exe']
    const note = caretOn(chain, 1)
    const view = { state: { field: () => ({ editor: note.editor }) } }
    const { onAddChild } = registered().callbacks
    if (!onAddChild) throw new Error('no onAddChild')
    onAddChild(view as never, 2)
    expect(note.lines()).toEqual([...chain, '        - '])
    expect(note.caret()).toEqual({ line: 3, ch: 10 })
  })

  it('every command is registered once, the existing ids kept', () => {
    const ids = [...registered().commands.keys()]
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(
      expect.arrayContaining([
        'timeline-make',
        'timeline-make-steps',
        'timeline-make-chain',
        'timeline-insert',
        'timeline-insert-steps',
        'timeline-insert-chain',
        'timeline-style-events',
        'timeline-style-steps',
        'timeline-style-chain',
        'timeline-add-child',
        'timeline-add-event',
        'timeline-move-up',
        'timeline-move-down',
        'timeline-set-kind',
        'timeline-sort',
        'timeline-delete-event',
        'timeline-defang',
        'timeline-copy',
        'timeline-plain-list'
      ])
    )
  })
})

describe('The kind picker', () => {
  const NOTE = ['%% timeline %%', '- 21:34 domain\\user1 ran nltest']
  const KINDS = [
    'Auto (from the text)',
    'Web',
    'Execution',
    'File / download',
    'Email',
    'User',
    'Host',
    'Detection',
    'Response'
  ]

  it('lists every kind with User and Host, the current one checked, as a menu', () => {
    const note = caretOn(NOTE, 1)
    openKindMenu(note.editor, 1, {} as MouseEvent)
    const [menu] = fakes.FakeMenu.shown
    expect(outline(menu)).toEqual(KINDS.map((k) => (k === 'Auto (from the text)' ? `${k} ✓` : k)))
    click(menu, 'Host')
    expect(note.lines()[1]).toBe('- 21:34 Host: domain\\user1 ran nltest')
  })

  it('is a search from the command, User and Host among the kinds', () => {
    const note = caretOn(NOTE, 1)
    expect(runCommand('timeline-set-kind', note.editor, true)).toBe(true)
    runCommand('timeline-set-kind', note.editor)
    const [modal] = fakes.FakeSuggestModal.opened as {
      getSuggestions(q: string): string[]
      onChooseSuggestion(kind: string): void
    }[]
    expect(modal.getSuggestions('')).toEqual([
      'auto',
      'web',
      'execution',
      'file',
      'email',
      'user',
      'host',
      'detection',
      'response'
    ])
    expect(modal.getSuggestions('us')).toEqual(['user'])
    modal.onChooseSuggestion('user')
    expect(note.lines()[1]).toBe('- 21:34 User: domain\\user1 ran nltest')
  })

  it('is for events only: steps and chains have no kind to pick', () => {
    for (const marker of ['%% timeline steps %%', '%% timeline chain %%']) {
      const note = caretOn([marker, '- 21:34 domain\\user1 ran nltest'], 1)
      openKindMenu(note.editor, 1, {} as MouseEvent)
      expect(runCommand('timeline-set-kind', note.editor, true)).toBe(false)
    }
    expect(fakes.FakeMenu.shown).toEqual([])
  })
})
