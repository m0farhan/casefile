import { describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent } from '../../../test/fakeDom'
import { KanbanColumn } from './KanbanColumn'

vi.mock('obsidian', () => ({ setIcon: () => {} }))
vi.mock('./KanbanCard', () => ({ KanbanCard: vi.fn<() => void>() }))
vi.mock('../primitives/IconButton', () => ({
  IconButton: class {
    setIcon(): this {
      return this
    }
    setTooltip(): this {
      return this
    }
    onClick(): this {
      return this
    }
  }
}))

// FakeEl has no dataset; the column tags itself and its card list with the status.
Object.defineProperty(FakeEl.prototype, 'dataset', {
  get(this: FakeEl & { ds?: Record<string, string> }) {
    return (this.ds ??= {})
  }
})

describe('KanbanColumn drop zone', () => {
  // Chromium decides a drop from the last drag update before the release. On an
  // update that changes the element under the pointer it fires only dragenter,
  // and an uncancelled dragenter makes the operation none, so the drop was
  // refused and the card snapped back. Dragging a card onto an empty column's
  // "No items" slot hit exactly that: the zone cancelled dragover only.
  it('accepts a drop on the update the pointer enters it, expanded or collapsed', () => {
    const accepted: Record<string, boolean> = {}
    for (const collapsed of [false, true]) {
      const root = FakeEl.root()
      new KanbanColumn(root as unknown as HTMLElement, {
        status: { id: 'in-progress', label: 'In Progress', color: '#6ba3d6', icon: '' },
        cards: [],
        collapsed,
        onToggleCollapse: () => {},
        onCardClick: () => {},
        onCardContextMenu: () => {},
        onCardDragStart: () => {},
        onCardDragEnd: () => {},
        onDrop: () => Promise.resolve()
      })
      const entered = root.find(collapsed ? '.pm-kanban-col-collapsed-label' : '.pm-kanban-empty')
      const e = fakeEvent('dragenter')
      entered.dispatchEvent(e)
      accepted[collapsed ? 'collapsed strip' : 'No items slot'] = e.defaultPrevented
    }
    expect(accepted).toEqual({ 'No items slot': true, 'collapsed strip': true })
  })
})
