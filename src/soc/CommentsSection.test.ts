import type { App } from 'obsidian'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent } from '../../test/fakeDom'
import type PMPlugin from '../main'
import { makeTask, type Project } from '../types'
import { renderCommentsSection } from './CommentsSection'

const confirm = vi.hoisted(() => ({ answer: true }))
vi.mock('../ui/ModalFactory', () => ({ confirmDialog: () => Promise.resolve(confirm.answer) }))

vi.mock('obsidian', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Component: class {
    load(): void {}
    unload(): void {}
  },
  // A rendered journal entry: the embed Obsidian draws for ![[payload.html]].
  MarkdownRenderer: {
    render: (_app: unknown, _md: string, el: FakeEl) => {
      el.createSpan({ cls: 'internal-embed', attr: { src: 'payload.html' } })
      return Promise.resolve()
    }
  }
}))

const app = {
  metadataCache: {
    getFirstLinkpathDest: (link: string) =>
      link === 'payload.html' ? { path: 'Cases/payload.html', extension: 'html' } : null
  }
} as unknown as App
const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())

// The composer sizes itself on the next tick through window.setTimeout.
beforeEach(() => {
  vi.stubGlobal('window', globalThis)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderCommentsSection', () => {
  it('a journal embed of a file Obsidian cannot show copies its path instead of opening', () => {
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const root = FakeEl.root()
    const task = makeTask({
      filePath: 'Cases/Case.md',
      comments: [{ at: '2026-09-26 10:00', text: '![[payload.html]]' }]
    })
    renderCommentsSection(
      root as unknown as HTMLElement,
      { app } as unknown as PMPlugin,
      { filePath: 'Cases/Board.md' } as Project,
      task,
      {
        onChange: () => {}
      }
    )
    const click = fakeEvent('click')
    root.find('.internal-embed').dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(writeText).toHaveBeenCalledWith('Cases/payload.html')
  })

  it('deletes the chosen comment after a confirm, and keeps it when cancelled', async () => {
    const task = makeTask({
      comments: [
        { at: '2026-09-26 10:00', text: 'first' },
        { at: '2026-09-26 10:05', text: 'second' },
        { at: '2026-09-26 10:09', text: 'third' }
      ]
    })
    const onChange = vi.fn<() => void>()
    const root = FakeEl.root()
    renderCommentsSection(root as unknown as HTMLElement, { app } as unknown as PMPlugin, {} as Project, task, {
      onChange
    })
    const second = () => root.findAll('.pm-comment-delete')[1]
    const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0))

    confirm.answer = false
    second().dispatchEvent(fakeEvent('click'))
    await flush()
    expect(task.comments?.map((c) => c.text)).toEqual(['first', 'second', 'third'])
    expect(onChange).not.toHaveBeenCalled()

    confirm.answer = true
    second().dispatchEvent(fakeEvent('click'))
    await flush()
    expect(task.comments?.map((c) => c.text)).toEqual(['first', 'third'])
    expect(onChange).toHaveBeenCalledOnce()
  })
})
