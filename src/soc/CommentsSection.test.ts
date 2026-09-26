import type { App } from 'obsidian'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent } from '../../test/fakeDom'
import type PMPlugin from '../main'
import { makeTask, type Project } from '../types'
import { renderCommentsSection } from './CommentsSection'

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
})
