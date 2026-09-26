import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CollapseToggle } from './CollapseToggle'

/** Observers watching the fake document; a test fires them the way a redraw would. */
const observers = new Set<{ fn: () => void }>()
const timers: (() => void)[] = []
const doc = {
  body: null as unknown as FakeEl,
  focused: null as FakeEl | null,
  // As a browser does: a focused element taken out of the document leaves focus on the body.
  get activeElement(): FakeEl {
    return this.focused?.isConnected ? this.focused : this.body
  },
  defaultView: {
    MutationObserver: class {
      constructor(readonly fn: () => void) {}
      observe(): void {
        observers.add(this)
      }
      disconnect(): void {
        observers.delete(this)
      }
    },
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: () => {}
  }
}
const redrawn = () => {
  for (const o of observers) o.fn()
}

// The suite runs in plain node, so this models only what CollapseToggle touches.
class FakeEl {
  attrs = new Map<string, string>()
  classes = new Set<string>()
  dataset: Record<string, string> = {}
  listeners: { type: string; fn: (e: unknown) => void }[] = []
  parent: FakeEl | null = null
  children: FakeEl[] = []
  mounted = false
  readonly ownerDocument = doc
  createDiv(info: { cls: string; attr?: Record<string, string> } = { cls: '' }): FakeEl {
    const el = new FakeEl()
    el.parent = this
    this.children.push(el)
    for (const c of info.cls.split(' ')) if (c) el.classes.add(c)
    for (const [k, v] of Object.entries(info.attr ?? {})) el.attrs.set(k, v)
    return el
  }
  get parentElement(): FakeEl | null {
    return this.parent
  }
  get isConnected(): boolean {
    return this.parent ? this.parent.isConnected : this.mounted
  }
  empty(): void {
    for (const c of this.children) c.parent = null
    this.children = []
  }
  focus(): void {
    doc.focused = this
  }
  /** Only the selectors CollapseToggle uses: `[data-task-id]` and `.cls`. */
  matches(sel: string): boolean {
    return sel === '[data-task-id]' ? this.dataset.taskId !== undefined : this.classes.has(sel.slice(1))
  }
  closest(sel: string): FakeEl | null {
    return this.matches(sel) ? this : (this.parent?.closest(sel) ?? null)
  }
  querySelectorAll(sel: string): FakeEl[] {
    return this.children.flatMap((c) => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)])
  }
  toggleClass(c: string, on: boolean): void {
    if (on) this.classes.add(c)
    else this.classes.delete(c)
  }
  setAttr(k: string, v: string): void {
    this.attrs.set(k, v)
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.push({ type, fn })
  }
  // Dispatch with bubbling, the part the activity header relies on.
  fire(e: { type: string; propagationStopped?: boolean }): void {
    for (const l of this.listeners.slice()) if (l.type === e.type) l.fn(e)
    if (!e.propagationStopped) this.parent?.fire(e)
  }
  click(): void {
    this.fire({ type: 'click' })
  }
}

const key = (k: string, mods: Record<string, boolean> = {}) => {
  const e = {
    type: 'keydown',
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
    propagationStopped: false,
    preventDefault: vi.fn<() => void>(),
    stopPropagation: vi.fn<() => void>(() => {
      e.propagationStopped = true
    })
  }
  return e
}

function mount(collapsed: boolean) {
  const host = new FakeEl()
  const onToggle = vi.fn<() => void>()
  const hostKeys = vi.fn<(e: unknown) => void>()
  const hostClicks = vi.fn<(e: unknown) => void>()
  host.addEventListener('keydown', hostKeys)
  host.addEventListener('click', hostClicks)
  const toggle = new CollapseToggle(host as unknown as HTMLElement, { collapsed, onToggle })
  return { el: toggle.el as unknown as FakeEl, onToggle, hostKeys, hostClicks }
}

describe('CollapseToggle keyboard', () => {
  it('is a focusable button that states whether it is expanded', () => {
    expect(Object.fromEntries(mount(true).el.attrs)).toMatchObject({
      role: 'button',
      tabindex: '0',
      'aria-expanded': 'false',
      'aria-label': 'Expand subtasks'
    })
    expect(mount(false).el.attrs.get('aria-expanded')).toBe('true')
  })

  it.each(['Enter', ' '])('%j toggles once and the key goes no further', (k) => {
    const { el, onToggle, hostKeys, hostClicks } = mount(true)
    const e = key(k)
    el.fire(e)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(e.preventDefault).toHaveBeenCalled()
    // The table's container Enter never sees it...
    expect(hostKeys).not.toHaveBeenCalled()
    // ...but the click still bubbles, as a pointer click does, so a header
    // that toggles from its own click listener works from the keyboard too.
    expect(hostClicks).toHaveBeenCalledTimes(1)
  })

  it('leaves modified Enter and other keys alone', () => {
    const { el, onToggle, hostKeys } = mount(false)
    el.fire(key('Enter', { metaKey: true }))
    el.fire(key('ArrowDown'))
    expect(onToggle).not.toHaveBeenCalled()
    expect(hostKeys).toHaveBeenCalledTimes(2)
  })
})

describe('CollapseToggle focus across a redraw', () => {
  beforeEach(() => {
    observers.clear()
    timers.length = 0
    doc.body = new FakeEl()
    doc.body.mounted = true
    doc.focused = null
  })

  /** A table body holding one row per task id, drawn again from scratch the way the table and gantt do. */
  function table(ids: string[]) {
    const view = doc.body.createDiv({ cls: 'pm-table-view' })
    const tbody = view.createDiv()
    const draw = () => {
      tbody.empty()
      return ids.map((id) => {
        const row = tbody.createDiv()
        row.dataset.taskId = id
        return new CollapseToggle(row.createDiv() as unknown as HTMLElement, { collapsed: true, onToggle: () => {} })
          .el as unknown as FakeEl
      })
    }
    return { draw }
  }

  it('puts focus back on the same row after a keyboard toggle', () => {
    const { draw } = table(['a', 'b', 'c'])
    const old = draw()[1]
    old.focus()
    old.fire(key('Enter'))
    const now = draw()[1]
    redrawn()
    expect(doc.activeElement).toBe(now)
    expect(observers.size).toBe(0)
  })

  it('waits out a redraw that empties the rows before it draws them again', () => {
    const { draw } = table(['a', 'b'])
    const old = draw()[0]
    old.focus()
    old.fire(key(' '))
    old.parent?.parent?.empty()
    redrawn()
    expect(observers.size).toBe(1)
    const now = draw()[0]
    redrawn()
    expect(doc.activeElement).toBe(now)
  })

  it('leaves focus alone once it has moved on, and after a pointer click', () => {
    const { draw } = table(['a'])
    const old = draw()[0]
    old.focus()
    old.fire(key('Enter'))
    const elsewhere = doc.body.createDiv()
    elsewhere.focus()
    draw()
    redrawn()
    expect(doc.activeElement).toBe(elsewhere)
    expect(observers.size).toBe(0)

    const again = draw()[0]
    again.click()
    expect(observers.size).toBe(0)
  })

  it('stops watching a host that flips in place', () => {
    const { draw } = table(['a'])
    const el = draw()[0]
    el.focus()
    el.fire(key('Enter'))
    redrawn()
    expect(doc.activeElement).toBe(el)
    for (const t of timers) t()
    expect(observers.size).toBe(0)
  })
})
