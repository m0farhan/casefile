import type { App, Command, Editor, EditorPosition, EditorTransaction, Menu, Plugin } from 'obsidian'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent, type FakeEvent } from '../../test/fakeDom'
import { addTimelineItems, registerNoteTimeline, timelineLinkAt } from './menu'

const platform = vi.hoisted(() => ({ isAndroidApp: false, isIosApp: false }))

// menu.ts pulls in the live-preview and reading modules; their Obsidian base
// classes only need to exist (TaskDetailView.test idiom). Platform is a plain
// object a test can switch to Android.
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

afterEach(() => {
  platform.isAndroidApp = false
  platform.isIosApp = false
  vi.unstubAllGlobals()
})

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

describe('Make timeline: the lines a selection covers', () => {
  /** An Obsidian editor over a note and a selection: enough for the menu, the commands and applyEdit. */
  function editorOn(note: string[], from: EditorPosition, to: EditorPosition) {
    let doc = note.join('\n')
    const offset = (p: EditorPosition) =>
      doc
        .split('\n')
        .slice(0, p.line)
        .reduce((n, l) => n + l.length + 1, p.ch)
    const editor = {
      getValue: () => doc,
      getCursor: (which?: string) => (which === 'from' ? from : to),
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
      setCursor: () => {}
    }
    return { editor: editor as unknown as Editor, lines: () => doc.split('\n') }
  }

  /** The right-click menu's items, by title, each with its click. */
  function menuOf(editor: Editor): Map<string, () => void> {
    const items = new Map<string, () => void>()
    const menu = {
      addItem: (build: (item: object) => void) => {
        let title = ''
        let click = () => {}
        const item = {
          setTitle: (t: string) => {
            title = t
            return item
          },
          setIcon: () => item,
          onClick: (fn: () => void) => {
            click = fn
            return item
          }
        }
        build(item)
        items.set(title, click)
        return menu
      }
    }
    addTimelineItems(menu as unknown as Menu, editor, editor.getCursor().line, {} as App)
    return items
  }

  function makeCommand(): Command {
    vi.stubGlobal('activeDocument', {})
    const commands: Command[] = []
    const plugin = {
      app: {
        workspace: { on: () => ({}), onLayoutReady: () => {}, iterateAllLeaves: () => {} },
        metadataCache: { on: () => ({}) }
      },
      registerEditorExtension: () => {},
      registerMarkdownPostProcessor: () => {},
      registerEvent: () => {},
      registerDomEvent: () => {},
      addCommand: (c: Command) => commands.push(c)
    }
    registerNoteTimeline(plugin as unknown as Plugin)
    const make = commands.find((c) => c.id === 'timeline-make')
    if (!make?.editorCheckCallback) throw new Error('no Make timeline command')
    return make
  }

  // Shift+Down twice from the start of line 1, or a triple-click on it and the
  // next: the selection ends at column 0 of line 3, and nothing of it is selected.
  const from = { line: 1, ch: 0 }
  const to = { line: 3, ch: 0 }

  it('turns only the lines selected into events, from the menu and the command', () => {
    const note = ['## F', '11:04 a', '11:05 b', 'Summary para']
    const made = ['## F', '%% timeline %%', '- 11:04 a', '- 11:05 b', 'Summary para']
    const fromMenu = editorOn(note, from, to)
    menuOf(fromMenu.editor).get('Make timeline')?.()
    expect(fromMenu.lines()).toEqual(made)
    const fromCommand = editorOn(note, from, to)
    makeCommand().editorCheckCallback?.(false, fromCommand.editor, {} as never)
    expect(fromCommand.lines()).toEqual(made)
  })

  it('offers it when the line the selection ends on is a heading, which cannot be an event', () => {
    const note = editorOn(['## Findings', '11:04 a', '11:05 b', '### Attack chain summary'], from, to)
    expect(menuOf(note.editor).has('Make timeline')).toBe(true)
    expect(makeCommand().editorCheckCallback?.(true, note.editor, {} as never)).toBe(true)
  })
})
