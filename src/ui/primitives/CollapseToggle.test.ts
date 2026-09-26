import { describe, expect, it, vi } from 'vitest'
import { CollapseToggle } from './CollapseToggle'

// The suite runs in plain node, so this models only what CollapseToggle touches.
class FakeEl {
  attrs = new Map<string, string>()
  classes = new Set<string>()
  listeners: { type: string; fn: (e: unknown) => void }[] = []
  parent: FakeEl | null = null
  createDiv(info: { cls: string; attr?: Record<string, string> }): FakeEl {
    const el = new FakeEl()
    el.parent = this
    for (const c of info.cls.split(' ')) el.classes.add(c)
    for (const [k, v] of Object.entries(info.attr ?? {})) el.attrs.set(k, v)
    return el
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
