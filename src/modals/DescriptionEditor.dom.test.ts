import type { EditorState } from '@codemirror/state'
import type { App } from 'obsidian'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEl } from '../../test/fakeDom'
import type PMPlugin from '../main'
import { makeProject, makeTask, type Task } from '../types'
import { renderDescriptionEditor, type DescriptionEditorContext } from './DescriptionEditor'

// The read-mode preview is driven here; the CodeMirror editor is not (views
// have no DOM in vitest), so EditorView is a stand-in that only holds a doc.
vi.mock('@codemirror/view', async (importOriginal) => {
  const real = await importOriginal<typeof import('@codemirror/view')>()
  const { EditorState: State } = await import('@codemirror/state')
  class EditorView {
    static lineWrapping = real.EditorView.lineWrapping
    static contentAttributes = real.EditorView.contentAttributes
    static updateListener = real.EditorView.updateListener
    static domEventHandlers = (h: Parameters<typeof real.EditorView.domEventHandlers>[0]) =>
      real.EditorView.domEventHandlers(h)
    state: EditorState
    constructor(cfg: { doc: string }) {
      this.state = State.create({ doc: cfg.doc })
    }
    dispatch(): void {}
    focus(): void {}
    destroy(): void {}
  }
  return { ...real, EditorView }
})
vi.mock('./NoteLinkSuggest', () => ({
  NoteLinkSuggest: class {
    attach(): void {}
    extension(): never[] {
      return []
    }
    onDocChanged(): void {}
    hide(): void {}
    contains(): boolean {
      return false
    }
    destroy(): void {}
  }
}))
vi.mock('../soc/safeRender', () => ({
  neutralizeExternalLinks: (): void => {},
  scrubRemoteEmbeds: (s: string) => s
}))
vi.mock('obsidian', async (importOriginal) => {
  const { FakeEl } = await import('../../test/fakeDom')
  return {
    ...(await importOriginal<object>()),
    Component: class {
      load(): void {}
      unload(): void {}
    },
    ExtraButtonComponent: class {
      extraSettingsEl = new FakeEl()
      constructor(parent: FakeEl) {
        parent.appendChild(this.extraSettingsEl)
      }
      setIcon(): this {
        return this
      }
      setTooltip(): this {
        return this
      }
    },
    // What Obsidian renders for '[[Other note]]\n\n- [ ] step': a note link
    // and one task checkbox.
    MarkdownRenderer: {
      render: (_app: unknown, _md: string, el: FakeEl): Promise<void> => {
        el.createEl('p').createEl('a', { cls: 'internal-link', attr: { 'data-href': 'Other note' } })
        el.createEl('ul').createEl('li').createEl('input', { type: 'checkbox' })
        Object.assign(el, {
          querySelectorAll: (sel: string) => (sel.startsWith(':scope') ? el.children : el.findAll('input'))
        })
        return Promise.resolve()
      }
    }
  }
})

beforeAll(() => {
  // The preview's click handler asks what was clicked by constructor; these
  // stand in for the constructors, compared by identity.
  const input = {}
  vi.stubGlobal('HTMLInputElement', input)
  vi.stubGlobal('HTMLImageElement', {})
  Object.assign(FakeEl.prototype, {
    instanceOf(this: FakeEl, type: unknown): boolean {
      return type === input && this.tagName === 'INPUT'
    }
  })
})

const openLinkText = vi.fn<(link: string, source: string) => Promise<void>>(() => Promise.resolve())
const app = { workspace: { openLinkText } } as unknown as App
const plugin = { settings: { incidentTemplates: [] } } as unknown as PMPlugin
const project = makeProject('Queue', 'Cases/Queue.md')

beforeEach(() => openLinkText.mockClear())

async function render(task: Task, extra: Partial<DescriptionEditorContext> = {}): Promise<FakeEl> {
  const root = FakeEl.root()
  renderDescriptionEditor(root as unknown as HTMLElement, { app, plugin, project, task, ...extra })
  // The preview renders asynchronously; its checkbox gets a listener once it has.
  await vi.waitFor(() => expect(root.find('input').listeners).toHaveLength(1))
  return root
}

/** Lets the click's promise chain run out. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('description preview', () => {
  it('ticking a checkbox reports the change, so the side panel schedules its save (a61)', async () => {
    const task = makeTask({ description: '[[Other note]]\n\n- [ ] step' })
    const onChange = vi.fn<() => void>()
    const root = await render(task, { onChange })
    root.find('input').click()
    expect(task.description).toBe('[[Other note]]\n\n- [x] step')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('opens a note link only once onNavigateAway has settled, and not at all when it answers false (a66)', async () => {
    let answer: (ok: boolean) => void = () => {}
    const onNavigateAway = vi.fn<() => Promise<boolean>>(() => new Promise<boolean>((resolve) => (answer = resolve)))
    const root = await render(makeTask({ description: '[[Other note]]\n\n- [ ] step' }), { onNavigateAway })

    root.find('a').click()
    expect(onNavigateAway).toHaveBeenCalledTimes(1)
    await flush()
    expect(openLinkText).not.toHaveBeenCalled()
    answer(false)
    await flush()
    expect(openLinkText).not.toHaveBeenCalled()

    root.find('a').click()
    answer(true)
    await flush()
    expect(openLinkText).toHaveBeenCalledExactlyOnceWith('Other note', 'Cases/Queue.md')
  })

  it('still follows the link after a handler that returns nothing', async () => {
    const onNavigateAway = vi.fn<() => void>()
    const root = await render(makeTask({ description: '[[Other note]]\n\n- [ ] step' }), { onNavigateAway })
    root.find('a').click()
    await flush()
    expect(openLinkText).toHaveBeenCalledExactlyOnceWith('Other note', 'Cases/Queue.md')
  })
})
