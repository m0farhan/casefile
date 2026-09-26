import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from 'obsidian'
import type { PriorityConfig } from '../types'
import { moveItem, renderPriorityListEditor, wireRowDragReorder } from './PaletteListEditor'

vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  class AbstractInputSuggest {
    onSelect(): void {}
    setValue(): void {}
    close(): void {}
  }
  return { ...real, AbstractInputSuggest, getIconIds: () => [] }
})

interface FakeButton {
  icon: string
  tip: string
  hidden: boolean
  click: () => unknown
}
const buttons: FakeButton[] = []
vi.mock('./primitives/IconButton', () => ({
  IconButton: class {
    b: FakeButton = { icon: '', tip: '', hidden: false, click: () => undefined }
    el = { setCssStyles: (s: { visibility?: string }) => (this.b.hidden = s.visibility === 'hidden') }
    constructor() {
      buttons.push(this.b)
    }
    setIcon(icon: string): this {
      this.b.icon = icon
      return this
    }
    setTooltip(tip: string): this {
      this.b.tip = tip
      return this
    }
    onClick(fn: () => unknown): this {
      this.b.click = fn
      return this
    }
  }
}))

/** A DOM stand-in: remembers listeners and hands out children of the same kind. */
type Listener = (e: unknown) => void
interface FakeEl {
  on: Record<string, Listener>
  [key: string]: unknown
}
function fakeEl(): FakeEl & HTMLElement {
  const el: FakeEl = {
    on: {},
    value: '',
    empty: () => {},
    addClass: () => {},
    removeClass: () => {},
    createDiv: () => fakeEl(),
    createSpan: () => fakeEl(),
    createEl: (_tag: string, info?: { value?: string }) => Object.assign(fakeEl(), { value: info?.value ?? '' }),
    addEventListener: (k: string, fn: Listener) => (el.on[k] = fn)
  }
  return el as FakeEl & HTMLElement
}

/** A browser drag carries one DataTransfer from dragstart to drop. */
let transfer = new Map<string, string>()
const ev = (): unknown => ({
  preventDefault: () => {},
  dataTransfer: { setData: (k: string, v: string) => transfer.set(k, v), getData: (k: string) => transfer.get(k) ?? '' }
})

function wire<T>(items: T[], onChanged: () => void): (FakeEl & HTMLElement)[] {
  return items.map((_, i) => {
    const row = fakeEl()
    wireRowDragReorder(row, i, items, onChanged)
    return row
  })
}

const entry = (id: string): PriorityConfig => ({ id, label: id, color: '#8a94a0', icon: '' })

beforeEach(() => {
  buttons.length = 0
  transfer = new Map()
})

describe('wireRowDragReorder', () => {
  it('leaves both lists alone when a row is dropped on another list', () => {
    const severities = ['s1', 's2', 's3', 's4', 's5']
    const verdicts = ['v1', 'v2', 'v3', 'v4']
    const onChanged = vi.fn<() => void>()
    const sevRows = wire(severities, onChanged)
    const verdictRows = wire(verdicts, onChanged)
    sevRows[4].on.dragstart(ev())
    verdictRows[1].on.drop(ev())
    // Today: verdicts gains an undefined, which data.json saves as null.
    expect(verdicts).toEqual(['v1', 'v2', 'v3', 'v4'])
    sevRows[0].on.dragstart(ev())
    verdictRows[3].on.drop(ev())
    expect(severities).toEqual(['s1', 's2', 's3', 's4', 's5'])
    expect(verdicts).toEqual(['v1', 'v2', 'v3', 'v4'])
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('ignores text dragged in from outside the list', () => {
    const items = ['a', 'b', 'c']
    const onChanged = vi.fn<() => void>()
    const rows = wire(items, onChanged)
    const outside = { preventDefault: () => {}, dataTransfer: { getData: () => '2', setData: () => {} } }
    rows[0].on.drop(outside)
    expect(items).toEqual(['a', 'b', 'c'])
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('still reorders within one list', () => {
    const items = ['a', 'b', 'c']
    const onChanged = vi.fn<() => void>()
    const rows = wire(items, onChanged)
    rows[0].on.dragstart(ev())
    rows[2].on.drop(ev())
    expect(items).toEqual(['b', 'c', 'a'])
    expect(onChanged).toHaveBeenCalledOnce()
  })
})

describe('moveItem', () => {
  it('moves to either end and refuses out-of-range or same-place moves', () => {
    const items = ['a', 'b', 'c']
    expect(moveItem(items, 0, 2)).toBe(true)
    expect(items).toEqual(['b', 'c', 'a'])
    expect(moveItem(items, 2, 0)).toBe(true)
    expect(items).toEqual(['a', 'b', 'c'])
    expect(moveItem(items, 1, 1)).toBe(false)
    expect(moveItem(items, 0, -1)).toBe(false)
    expect(moveItem(items, 2, 3)).toBe(false)
    expect(items).toEqual(['a', 'b', 'c'])
  })
})

describe('renderPriorityListEditor', () => {
  const render = (items: PriorityConfig[], extra: Partial<Parameters<typeof renderPriorityListEditor>[1]> = {}) => {
    const onChanged = vi.fn<() => void>()
    renderPriorityListEditor(fakeEl(), { app: {} as App, priorities: items, onChanged, ...extra })
    return onChanged
  }

  it('moves a row with the up and down buttons, which hide where there is nowhere to go', () => {
    const items = [entry('a'), entry('b'), entry('c')]
    const onChanged = render(items)
    const ups = buttons.filter((b) => b.tip === 'Move up')
    const downs = buttons.filter((b) => b.tip === 'Move down')
    expect(ups.map((b) => b.hidden)).toEqual([true, false, false])
    expect(downs.map((b) => b.hidden)).toEqual([false, false, true])
    downs[0].click()
    expect(items.map((e) => e.id)).toEqual(['b', 'a', 'c'])
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('asks before removing, and keeps the entry when the answer is no', async () => {
    const items = [entry('a'), entry('b')]
    const confirmDelete = vi.fn<(item: PriorityConfig) => Promise<boolean>>(async () => false)
    const onDeleted = vi.fn<(item: PriorityConfig) => void>()
    const onChanged = render(items, { confirmDelete, onDeleted })
    buttons.filter((b) => b.tip === 'Remove')[1].click()
    await vi.waitFor(() => expect(confirmDelete).toHaveBeenCalledWith(items[1]))
    await Promise.resolve()
    expect(items.map((e) => e.id)).toEqual(['a', 'b'])
    expect(onChanged).not.toHaveBeenCalled()
    expect(onDeleted).not.toHaveBeenCalled()

    confirmDelete.mockResolvedValue(true)
    buttons.filter((b) => b.tip === 'Remove')[1].click()
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledOnce())
    expect(items.map((e) => e.id)).toEqual(['a'])
  })
})
