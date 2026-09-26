import { describe, expect, it, vi } from 'vitest'
import { IconButton } from './IconButton'

// The suite runs in plain node, so this models only what IconButton touches.
class FakeEl {
  attrs = new Map<string, string>()
  classes = new Set<string>()
  listeners: { type: string; fn: (e: unknown) => void }[] = []
  win = {}
  addClass(c: string): void {
    this.classes.add(c)
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
  dispatchEvent(e: { type: string }): boolean {
    for (const l of this.listeners.slice()) if (l.type === e.type) l.fn(e)
    return true
  }
  getBoundingClientRect(): { left: number; bottom: number } {
    return { left: 120, bottom: 64 }
  }
}

// ExtraButtonComponent in 1.13 answers Enter/Space by calling its own onClick
// callback only; IconButton never sets that callback, so the stub leaves it out.
vi.mock('obsidian', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ExtraButtonComponent: class {
    extraSettingsEl = new FakeEl()
    setIcon(): this {
      return this
    }
    setTooltip(): this {
      return this
    }
  }
}))

vi.stubGlobal(
  'MouseEvent',
  class {
    type: string
    init: MouseEventInit
    constructor(type: string, init: MouseEventInit) {
      this.type = type
      this.init = init
    }
  }
)

const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
  type: 'keydown',
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
  preventDefault: vi.fn<() => void>(),
  stopPropagation: vi.fn<() => void>()
})

function mount() {
  const handler = vi.fn<(e: unknown) => void>()
  const btn = new IconButton({} as HTMLElement).onClick(handler)
  return { el: btn.el as unknown as FakeEl, handler }
}

describe('IconButton keyboard', () => {
  it('is a focusable button', () => {
    const { el } = mount()
    expect(el.attrs.get('tabindex')).toBe('0')
    expect(el.attrs.get('role')).toBe('button')
  })

  it.each(['Enter', ' '])('%j runs the click handler once and stops there', (k) => {
    const { el, handler } = mount()
    const e = key(k)
    el.dispatchEvent(e)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(e.stopPropagation).toHaveBeenCalled()
    expect(e.preventDefault).toHaveBeenCalled()
    // The click carries the button's position, so a menu opened at the
    // pointer opens at the button.
    const click = handler.mock.calls[0][0] as { init: MouseEventInit }
    expect(click.init).toMatchObject({ bubbles: true, clientX: 120, clientY: 64, view: el.win })
  })

  it('leaves modified Enter and other keys alone', () => {
    const { el, handler } = mount()
    for (const e of [key('Enter', { metaKey: true }), key('Enter', { ctrlKey: true }), key('a'), key('Escape')]) {
      el.dispatchEvent(e)
      expect(e.stopPropagation).not.toHaveBeenCalled()
    }
    expect(handler).not.toHaveBeenCalled()
  })
})
