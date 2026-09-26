import type { App } from 'obsidian'
import { TFile } from 'obsidian'
import { describe, expect, it, vi } from 'vitest'
import type PMPlugin from '../main'
import { DEFAULT_SETTINGS, makeProject } from '../types'
import { ImportModal } from './ImportModal'

vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  class Modal {
    contentEl = fakeEl()
    modalEl = fakeEl()
    constructor(public app: unknown) {}
  }
  class ButtonComponent {
    setButtonText(): this {
      return this
    }
    setCta(): this {
      return this
    }
    setDisabled(): this {
      return this
    }
    onClick(): this {
      return this
    }
  }
  return { ...real, Modal, ButtonComponent }
})

/** A DOM stand-in: keeps tag, class and text, and its children. */
interface FakeEl {
  tag: string
  cls: string
  text: string
  kids: FakeEl[]
  [key: string]: unknown
}
function fakeEl(tag = 'div', info?: string | { cls?: string; text?: string }): FakeEl {
  const opts = typeof info === 'string' ? { cls: info } : (info ?? {})
  const el: FakeEl = { tag, cls: opts.cls ?? '', text: opts.text ?? '', kids: [] }
  const child = (t: string, i?: string | { cls?: string; text?: string }): FakeEl => {
    const kid = fakeEl(t, i)
    el.kids.push(kid)
    return kid
  }
  Object.assign(el, {
    empty: () => (el.kids.length = 0),
    addClass: () => {},
    toggleClass: () => {},
    setText: (t: string) => (el.text = t),
    addEventListener: () => {},
    querySelectorAll: () => [],
    createDiv: (i?: string | { cls?: string; text?: string }) => child('div', i),
    createSpan: (i?: { cls?: string; text?: string }) => child('span', i),
    createEl: child
  })
  return el
}
const all = (el: FakeEl): FakeEl[] => [el, ...el.kids.flatMap(all)]

function note(path: string): TFile {
  return Object.assign(new TFile(), { path, extension: 'md', basename: path.replace(/^.*\/|\.md$/g, '') })
}

/** What a test reads off the modal, private fields included. */
interface Opened {
  contentEl: FakeEl
  files: { file: TFile }[]
}

function openOn(files: TFile[], frontmatter: Record<string, Record<string, unknown>> = {}): Opened {
  const app = {
    vault: { getFiles: () => files },
    metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: frontmatter[f.path] }) }
  }
  const plugin = {
    settings: DEFAULT_SETTINGS,
    store: { configFor: () => ({ statuses: DEFAULT_SETTINGS.statuses, priorities: DEFAULT_SETTINGS.priorities }) }
  } as unknown as PMPlugin
  const modal = new ImportModal(app as unknown as App, plugin)
  modal.setProject(makeProject('Queue', 'Queue/Queue.md'))
  modal.onOpen()
  return modal as unknown as Opened
}

describe('ImportModal', () => {
  it('never offers a board note or a case note, and names the board it imports into', () => {
    const modal = openOn([note('Other/Other.md'), note('Queue/Tasks/Case.md'), note('Notes/Idea.md')], {
      'Other/Other.md': { 'pm-project': true },
      'Queue/Tasks/Case.md': { 'pm-task': true }
    })
    expect(modal.files.map((f) => f.file.path)).toEqual(['Notes/Idea.md'])
    expect(all(modal.contentEl).map((e) => e.text)).toContain('Select notes to import into Queue')
  })

  it('draws at most 200 rows, and says how many more matched and what Select all takes', () => {
    const files = Array.from({ length: 250 }, (_, i) => note(`Notes/n${i}.md`))
    const modal = openOn(files)
    const els = all(modal.contentEl)
    expect(els.filter((e) => e.cls.startsWith('import-file-item'))).toHaveLength(200)
    expect(els.map((e) => e.text)).toContain('Showing 200 of 250 matches. Refine the search to see the rest.')
    expect(els.map((e) => e.text)).toContain('Select all 250 matches')
  })
})
