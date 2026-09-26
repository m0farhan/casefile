import { describe, expect, it, vi } from 'vitest'
import { ProjectCard } from './ProjectCard'

vi.mock('../primitives/ProgressBar', () => ({
  ProgressBar: class {
    setSize(): this {
      return this
    }
    setValue(): this {
      return this
    }
    setColor(): this {
      return this
    }
  }
}))

/** A DOM stand-in: remembers attributes and listeners, and has a fixed box. */
interface FakeEl {
  attrs: Record<string, string>
  on: Record<string, (e: unknown) => void>
  [key: string]: unknown
}
function fakeEl(): FakeEl {
  const el: FakeEl = { attrs: {}, on: {} }
  Object.assign(el, {
    createDiv: () => fakeEl(),
    createSpan: () => fakeEl(),
    createEl: () => fakeEl(),
    setCssStyles: () => {},
    setAttr: (k: string, v: string) => (el.attrs[k] = v),
    setAttribute: (k: string, v: string) => (el.attrs[k] = v),
    addEventListener: (k: string, fn: (e: unknown) => void) => (el.on[k] = fn),
    getBoundingClientRect: () => ({ left: 40, bottom: 120 })
  })
  return el
}

function card(): { el: FakeEl; onClick: () => void; onContextMenu: (at: { x: number; y: number }) => void } {
  const onClick = vi.fn<() => void>()
  const onContextMenu = vi.fn<(at: { x: number; y: number }) => void>()
  const parent = fakeEl()
  const made = new ProjectCard(parent as unknown as HTMLElement, {
    title: 'Queue',
    icon: '📋',
    color: '#8b72be',
    tasksDone: 1,
    tasksTotal: 2,
    location: '',
    path: 'Queue/Queue.md',
    onClick,
    onContextMenu
  })
  return { el: made.el as unknown as FakeEl, onClick, onContextMenu }
}

const key = (target: unknown, k: string, shiftKey = false) => ({
  key: k,
  shiftKey,
  target,
  preventDefault: vi.fn<() => void>()
})

describe('ProjectCard', () => {
  it('is a focusable button that opens its board on Enter or Space', () => {
    const { el, onClick } = card()
    expect(el.attrs).toMatchObject({ role: 'button', tabindex: '0' })
    el.on.keydown?.(key(el, 'Enter'))
    el.on.keydown?.(key(el, ' '))
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it('opens the board menu at the card from Shift+F10 or the Menu key', () => {
    const { el, onContextMenu } = card()
    el.on.keydown?.(key(el, 'F10', true))
    el.on.keydown?.(key(el, 'ContextMenu'))
    expect(onContextMenu).toHaveBeenNthCalledWith(1, { x: 40, y: 120 })
    expect(onContextMenu).toHaveBeenCalledTimes(2)
  })
})
