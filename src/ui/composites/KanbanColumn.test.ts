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

/** Two boards in one window, as in a split; a card of board `a` is being dragged. */
function splitBoards(): { a: FakeEl; b: FakeEl } {
  const win = FakeEl.root()
  const a = win.createDiv('pm-kanban-view')
  const b = win.createDiv('pm-kanban-view')
  a.createDiv('pm-kanban-card pm-kanban-card--dragging')
  // The fake document has no querySelector; the drop zone looks the dragged card up there.
  Object.assign(win.ownerDocument, { querySelector: (sel: string) => win.findAll(sel)[0] ?? null })
  return { a, b }
}

function column(parent: FakeEl, collapsed: boolean): void {
  new KanbanColumn(parent as unknown as HTMLElement, {
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
}

const entered = (parent: FakeEl, collapsed: boolean): FakeEl =>
  parent.find(collapsed ? '.pm-kanban-col-collapsed-label' : '.pm-kanban-empty')

describe('KanbanColumn drop zone', () => {
  // Chromium decides a drop from the last drag update before the release. On an
  // update that changes the element under the pointer it fires only dragenter,
  // and an uncancelled dragenter makes the operation none, so the drop was
  // refused and the card snapped back. Dragging a card onto an empty column's
  // "No items" slot hit exactly that: the zone cancelled dragover only.
  it('accepts a drop on the update the pointer enters it, expanded or collapsed', () => {
    const accepted: Record<string, boolean> = {}
    for (const collapsed of [false, true]) {
      const { a } = splitBoards()
      column(a, collapsed)
      const e = fakeEvent('dragenter')
      entered(a, collapsed).dispatchEvent(e)
      accepted[collapsed ? 'collapsed strip' : 'No items slot'] = e.defaultPrevented
    }
    expect(accepted).toEqual({ 'No items slot': true, 'collapsed strip': true })
  })

  // The other pane lit its ring and showed a move cursor, then dropped nothing.
  it("refuses another board's card drag up front, expanded or collapsed", () => {
    for (const collapsed of [false, true]) {
      const { b } = splitBoards()
      column(b, collapsed)
      const events = ['dragenter', 'dragover'].map((type) => fakeEvent(type))
      for (const e of events) entered(b, collapsed).dispatchEvent(e)
      expect(events.map((e) => e.defaultPrevented)).toEqual([false, false])
      expect(b.findAll('.pm-kanban-drop-target')).toHaveLength(0)
    }
  })
})
