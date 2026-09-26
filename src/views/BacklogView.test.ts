import { beforeEach, describe, expect, it, vi } from 'vitest'
import type PMPlugin from '../main'
import { DEFAULT_STATUSES, makeDefaultFilter, makeTask, type Project } from '../types'
import { openTaskModal } from '../ui/ModalFactory'
import { BacklogView } from './BacklogView'

// The stub carries no view or modal classes; the import chain only needs them to exist.
vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  function Stub(): void {}
  return new Proxy(real, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string]
      if (typeof prop !== 'string' || prop === 'then') return undefined
      return Stub
    },
    has: () => true
  })
})
vi.mock('../ui/ModalFactory', () => ({ openTaskModal: vi.fn<() => void>() }))
vi.mock('../ui/TaskContextMenu', () => ({ buildTaskContextMenu: vi.fn<() => void>() }))
vi.mock('../ui/composites/issueMeta', () => ({
  renderIssueTypeIcon: vi.fn<() => void>(),
  renderKeyChip: vi.fn<() => void>()
}))
vi.mock('../ui/StatusBadge', () => ({ renderStatusBadge: vi.fn<() => void>() }))

/** A DOM stand-in that remembers each element's class, attributes and listeners. */
interface Node {
  el: HTMLElement
  cls: string
  attrs: Record<string, string>
  on: Record<string, (e: unknown) => void>
}
const nodes: Node[] = []
function fakeEl(cls = ''): HTMLElement {
  const node = { cls, attrs: {}, on: {} } as Node
  const child = (info?: string | { cls?: string }) => fakeEl(typeof info === 'string' ? info : (info?.cls ?? ''))
  node.el = {
    dataset: {},
    empty: () => {},
    createDiv: child,
    createSpan: child,
    createEl: (_tag: string, info?: { cls?: string }) => child(info),
    setAttribute: (k: string, v: string) => (node.attrs[k] = v),
    addEventListener: (k: string, fn: (e: unknown) => void) => (node.on[k] = fn)
  } as unknown as HTMLElement
  nodes.push(node)
  return node.el
}

function renderRow(): Node {
  const project = { tasks: [makeTask({ title: 'Triage', bucket: 'this-week' })] } as unknown as Project
  const plugin = {
    store: { configFor: () => ({ statuses: DEFAULT_STATUSES, priorities: [], severities: [], issueTypes: [] }) },
    settings: { currentUser: '' }
  } as unknown as PMPlugin
  new BacklogView(fakeEl(), project, plugin, () => Promise.resolve(), makeDefaultFilter()).render()
  const row = nodes.find((n) => n.cls === 'pm-backlog-row')
  if (!row) throw new Error('no backlog row rendered')
  return row
}

beforeEach(() => {
  nodes.length = 0
  vi.mocked(openTaskModal).mockClear()
})

describe('BacklogView row', () => {
  it('is a focusable button that opens the task on Enter or Space', () => {
    const row = renderRow()
    expect(row.attrs).toMatchObject({ role: 'button', tabindex: '0' })
    for (const key of ['Enter', ' ']) {
      const preventDefault = vi.fn<() => void>()
      row.on.keydown?.({ key, target: row.el, preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
    }
    expect(openTaskModal).toHaveBeenCalledTimes(2)
  })

  it('leaves keys aimed at the status badge inside it alone', () => {
    const row = renderRow()
    row.on.keydown?.({ key: 'Enter', target: {}, preventDefault: vi.fn<() => void>() })
    expect(openTaskModal).not.toHaveBeenCalled()
  })
})
