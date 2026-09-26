import type { App } from 'obsidian'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEl } from '../../test/fakeDom'
import { makeTask, type Project } from '../types'
import { renderAttachmentsSection } from './AttachmentsSection'

const { notices } = vi.hoisted(() => ({ notices: [] as string[] }))

vi.mock('obsidian', async (importOriginal) => {
  const { FakeEl } = await import('../../test/fakeDom')
  return {
    ...(await importOriginal<object>()),
    Notice: class {
      constructor(message: string) {
        notices.push(message)
      }
      hide(): void {}
    },
    // IconButton's component: the tooltip is kept as the label to find it by.
    ExtraButtonComponent: class {
      extraSettingsEl = new FakeEl()
      constructor(parent: FakeEl) {
        parent.appendChild(this.extraSettingsEl)
      }
      setIcon(): this {
        return this
      }
      setTooltip(text: string): this {
        this.extraSettingsEl.setAttr('aria-label', text)
        return this
      }
    }
  }
})

// Dropped evidence, resolved the way the metadata cache resolves a link.
const files: Record<string, { name: string; path: string; extension: string; stat: { size: number } }> = {
  'payload.html': { name: 'payload.html', path: 'Cases/payload.html', extension: 'html', stat: { size: 2048 } },
  'shot.png': { name: 'shot.png', path: 'Cases/shot.png', extension: 'png', stat: { size: 10 } }
}
const openLinkText = vi.fn<(link: string) => Promise<void>>()
const app = {
  metadataCache: { getFirstLinkpathDest: (link: string) => files[link] ?? null },
  workspace: { openLinkText }
} as unknown as App
const project = { filePath: 'Cases/Board.md' } as Project
const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())

beforeEach(() => {
  notices.length = 0
  writeText.mockClear()
  openLinkText.mockClear()
  vi.stubGlobal('navigator', { clipboard: { writeText } })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const label = (root: FakeEl, text: string) => root.descendants().filter((el) => el.getAttribute('aria-label') === text)

describe('renderAttachmentsSection', () => {
  it('opens a file Obsidian shows itself, and only copies the path of any other', async () => {
    const root = FakeEl.root()
    const task = makeTask({ description: '![[payload.html]]\n![[shot.png]]' })
    renderAttachmentsSection(root as unknown as HTMLElement, { app, project, task })
    const [html, png] = root.findAll('.pm-evidence-row')
    expect(label(html, 'Open')).toHaveLength(0)
    expect(label(png, 'Open')).toHaveLength(1)

    label(html, 'Copy path — opens outside Obsidian')[0].click()
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(writeText).toHaveBeenCalledWith('Cases/payload.html')
    expect(notices[0]).toMatch(/^Path copied — \.html files are not opened from a case/)
    expect(openLinkText).not.toHaveBeenCalled()
  })
})
