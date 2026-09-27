import type { App } from 'obsidian'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent } from '../../test/fakeDom'
import { makeTask, type Project } from '../types'
import { attachFiles, renderAttachmentsSection, safeAttachmentName, type AttachTarget } from './AttachmentsSection'

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

/** Obsidian's attach calls, recording the paths created. Links print as
 * 'Relative path to file' does (Obsidian 1.13.7's fileToLinktext). */
/** The store's reserve/write pair, recording names and holding every write on one gate. */
function target() {
  const reserved: string[] = []
  const written: string[] = []
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const t: AttachTarget = {
    reserve: (name) => {
      reserved.push(name)
      return name
    },
    write: async (name) => {
      await gate
      if (name.endsWith('.fail')) throw new Error('disk full')
      written.push(name)
    }
  }
  return { t, reserved, written, release }
}

const pick = (name: string) => ({ name, arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) }) as File
const tick = () => new Promise((resolve) => globalThis.setTimeout(resolve, 0))

describe('attaching files', () => {
  it('keeps names a wikilink can hold', () => {
    expect(safeAttachmentName('invoice [final] #2|v1.pdf')).toBe('invoice -final- -2-v1.pdf')
    expect(safeAttachmentName('../../etc/passwd')).toBe('-..-etc-passwd')
    expect(safeAttachmentName('..')).toBe('attachment')
  })

  it('links every file before any byte is copied, so a save meanwhile cannot miss one', async () => {
    const { t, reserved, written, release } = target()
    const task = makeTask({ description: 'Seen on the host.\n' })
    const linked = vi.fn<() => void>()
    const done = attachFiles(task, t, [pick('shot.png'), pick('sample [1].exe')], linked)
    // The copies are still held: the links (and the host's redraw) are already in.
    expect(linked).toHaveBeenCalledOnce()
    expect(reserved).toEqual(['shot.png', 'sample -1-.exe'])
    // The picture shows inline; the sample is only ever a link, never an embed.
    expect(task.description).toBe('Seen on the host.\n\n![[shot.png]]\n[[sample -1-.exe]]')
    expect(written).toEqual([])
    release()
    expect(await done).toBe(2)
    expect(written).toEqual(['shot.png', 'sample -1-.exe'])
  })

  it('gives a name with no letter extension one, so its link resolves and Evidence lists it', async () => {
    // A VirusTotal download is named by its hash alone. Obsidian resolves a
    // link by file name only when the name has a '.', and Evidence skips a
    // ref with no letter extension ('image.001' is a version to it).
    const { t, reserved, release } = target()
    const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    const task = makeTask()
    release()
    await attachFiles(task, t, [pick(hash), pick('.env'), pick('image.001')], () => {})
    expect(reserved).toEqual([`${hash}.bin`, 'env.bin', 'image.001.bin'])
    const root = FakeEl.root()
    renderAttachmentsSection(root as unknown as HTMLElement, { app, project, task })
    expect(root.findAll('.pm-evidence-row')).toHaveLength(3)
  })

  it('a copy that fails keeps its link (Evidence lists it missing) and says what to do', async () => {
    const { t, release } = target()
    const task = makeTask()
    release()
    expect(await attachFiles(task, t, [pick('dump.fail'), pick('ok.pdf')], () => {})).toBe(1)
    expect(task.description).toBe('[[dump.fail]]\n[[ok.pdf]]')
    expect(notices).toEqual([
      'Could not copy dump.fail: disk full. Its link [[dump.fail]] points at nothing; remove it.'
    ])
  })

  it('the Attach picker links, lets the host redraw, then says it attached and redraws once copied', async () => {
    const { t, release } = target()
    const onLinked = vi.fn<() => void>()
    const onCopied = vi.fn<() => void>()
    const task = makeTask()
    const root = FakeEl.root()
    renderAttachmentsSection(root as unknown as HTMLElement, {
      app,
      project,
      task,
      attach: { ...t, onLinked, onCopied }
    })
    const picker = root.find('.pm-evidence-picker')
    Object.assign(picker, { files: [pick('capture.pcap')] })
    picker.dispatchEvent(fakeEvent('change'))
    await tick()
    expect(onLinked).toHaveBeenCalledOnce()
    expect(task.description).toBe('[[capture.pcap]]')
    expect(notices).toEqual([])
    expect(onCopied).not.toHaveBeenCalled()
    release()
    await tick()
    expect(notices).toEqual(['Attached 1 file'])
    // Evidence drew the link before the file existed; it draws again now.
    expect(onCopied).toHaveBeenCalledOnce()
  })

  it('offers to attach even before the case has any evidence', () => {
    const root = FakeEl.root()
    renderAttachmentsSection(root as unknown as HTMLElement, {
      app,
      project,
      task: makeTask(),
      attach: { ...target().t, onLinked: () => {}, onCopied: () => {} }
    })
    expect(root.findAll('.pm-evidence-add')).toHaveLength(1)
    expect(root.findAll('.pm-evidence-empty')).toHaveLength(1)
  })
})
