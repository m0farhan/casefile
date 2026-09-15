import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderFilterDropdown } from './FilterDropdown'

// The aliased obsidian stub has setIcon but no component/platform exports;
// ChipButton needs ButtonComponent and Popover needs Platform.
vi.mock('obsidian', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Platform: { isPhone: false },
  ButtonComponent: class {
    buttonEl: unknown
    constructor(parent: { createEl: (tag: string) => unknown }) {
      this.buttonEl = parent.createEl('button')
    }
    setButtonText(text: string): this {
      ;(this.buttonEl as { textContent: string }).textContent = text
      return this
    }
    onClick(fn: (e: unknown) => void): this {
      ;(this.buttonEl as { addEventListener: (t: string, f: (e: unknown) => void) => void }).addEventListener(
        'click',
        fn
      )
      return this
    }
  }
}))

// -- Minimal fake DOM -------------------------------------------------------
// The suite runs in plain node (no jsdom in this repo), so this models only
// the element surface FilterDropdown, ChipButton and Popover actually touch.

interface Listener {
  type: string
  fn: (e: unknown) => void
}

interface ElInfo {
  cls?: string
  text?: string
}

class FakeEl {
  tagName: string
  classes = new Set<string>()
  attrs = new Map<string, string>()
  children: FakeEl[] = []
  parent: FakeEl | null = null
  listeners: Listener[] = []
  textContent = ''
  cssProps: Record<string, string> = {}
  offsetWidth = 0
  offsetHeight = 0

  constructor(tag: string) {
    this.tagName = tag
  }

  get ownerDocument(): typeof doc {
    return doc
  }

  createEl(tag: string, info?: ElInfo | string): FakeEl {
    const el = new FakeEl(tag)
    const o = typeof info === 'string' ? { cls: info } : (info ?? {})
    if (o.cls) for (const c of o.cls.split(' ')) el.classes.add(c)
    if (o.text) el.textContent = o.text
    this.appendChild(el)
    return el
  }

  createDiv(info?: ElInfo | string): FakeEl {
    return this.createEl('div', info)
  }

  createSpan(info?: ElInfo | string): FakeEl {
    return this.createEl('span', info)
  }

  addClass(...cs: string[]): void {
    for (const c of cs) this.classes.add(c)
  }

  toggleClass(c: string, on: boolean): void {
    if (on) this.classes.add(c)
    else this.classes.delete(c)
  }

  hasClass(c: string): boolean {
    return this.classes.has(c)
  }

  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v)
  }

  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null
  }

  setCssProps(p: Record<string, string>): void {
    Object.assign(this.cssProps, p)
  }

  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.push({ type, fn })
  }

  removeEventListener(type: string, fn: (e: unknown) => void): void {
    const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn)
    if (i >= 0) this.listeners.splice(i, 1)
  }

  fire(type: string, e: unknown = { target: this }): void {
    for (const l of this.listeners.slice()) if (l.type === type) l.fn(e)
  }

  appendChild(el: FakeEl): FakeEl {
    el.parent = this
    this.children.push(el)
    return el
  }

  remove(): void {
    if (!this.parent) return
    const i = this.parent.children.indexOf(this)
    if (i >= 0) this.parent.children.splice(i, 1)
    this.parent = null
  }

  contains(el: FakeEl): boolean {
    return el === this || this.children.some((c) => c.contains(el))
  }

  closest(): null {
    return null
  }

  empty(): void {
    for (const c of this.children) c.parent = null
    this.children = []
  }

  focus(): void {
    doc.activeElement = this
  }

  getBoundingClientRect(): { top: number; bottom: number; left: number; right: number } {
    return { top: 40, bottom: 60, left: 20, right: 90 }
  }
}

const docListeners: Listener[] = []
const winListeners: Listener[] = []

const doc = {
  body: new FakeEl('body'),
  activeElement: null as FakeEl | null,
  addEventListener(type: string, fn: (e: unknown) => void): void {
    docListeners.push({ type, fn })
  },
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    const i = docListeners.findIndex((l) => l.type === type && l.fn === fn)
    if (i >= 0) docListeners.splice(i, 1)
  },
  fire(type: string, e: unknown): void {
    for (const l of docListeners.slice()) if (l.type === type) l.fn(e)
  }
}

const win = {
  innerWidth: 1024,
  innerHeight: 768,
  addEventListener(type: string, fn: (e: unknown) => void): void {
    winListeners.push({ type, fn })
  },
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    const i = winListeners.findIndex((l) => l.type === type && l.fn === fn)
    if (i >= 0) winListeners.splice(i, 1)
  }
}

// Popover reads Obsidian's window globals and the createDiv global helper.
vi.stubGlobal('activeDocument', doc)
vi.stubGlobal('activeWindow', win)
vi.stubGlobal('createDiv', (cls?: string): FakeEl => {
  const el = new FakeEl('div')
  if (cls) for (const c of cls.split(' ')) el.classes.add(c)
  return el
})

// -- Helpers ----------------------------------------------------------------

const byClass = (root: FakeEl, cls: string): FakeEl[] => {
  const out: FakeEl[] = []
  const walk = (el: FakeEl): void => {
    if (el.classes.has(cls)) out.push(el)
    for (const c of el.children) walk(c)
  }
  walk(root)
  return out
}

const OPTIONS = [
  { id: 'open', label: 'Open' },
  { id: 'closed', label: 'Closed' }
]

function mount(selected: string[] = []): { chip: FakeEl; selected: string[]; onChange: ReturnType<typeof vi.fn> } {
  const parent = doc.body.createDiv()
  const onChange = vi.fn<(selected: string[]) => void>()
  const chip = renderFilterDropdown(
    parent as unknown as HTMLElement,
    'Status',
    selected,
    OPTIONS,
    onChange
  ) as unknown as FakeEl
  return { chip, selected, onChange }
}

const pops = (): FakeEl[] => byClass(doc.body, 'pm-pop')

const optionRows = (): FakeEl[] => byClass(doc.body, 'pm-pop-item').filter((r) => r.getAttribute('role') === 'option')

const clearRow = (): FakeEl | undefined => byClass(doc.body, 'pm-pop-item').find((r) => r.textContent === 'Clear')

const isChecked = (row: FakeEl): boolean => !byClass(row, 'pm-pop-check')[0].hasClass('pm-pop-check--hidden')

beforeEach(() => {
  doc.body = new FakeEl('body')
  doc.activeElement = null
  docListeners.length = 0
  winListeners.length = 0
})

// -- Tests ------------------------------------------------------------------

describe('renderFilterDropdown', () => {
  it('toggles an option through onChange and keeps the popover open', () => {
    const { chip, selected, onChange } = mount()
    chip.fire('click')
    expect(pops()).toHaveLength(1)
    expect(chip.getAttribute('aria-expanded')).toBe('true')

    const [openRow] = optionRows()
    openRow.fire('click')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(selected).toEqual(['open'])
    expect(openRow.getAttribute('aria-selected')).toBe('true')
    expect(isChecked(openRow)).toBe(true)
    // The whole point: still open after the toggle.
    expect(pops()).toHaveLength(1)
  })

  it('updates the chip label count in place as options toggle', () => {
    const { chip } = mount()
    expect(chip.textContent).toBe('Status')
    chip.fire('click')
    const [openRow, closedRow] = optionRows()

    openRow.fire('click')
    expect(chip.textContent).toBe('Status: 1')
    expect(chip.hasClass('pm-chip-btn--active')).toBe(true)

    closedRow.fire('click')
    expect(chip.textContent).toBe('Status: 2')

    openRow.fire('click')
    expect(chip.textContent).toBe('Status: 1')
  })

  it('Clear empties the selection, unchecks every row, hides itself and stays open', () => {
    const { chip, selected, onChange } = mount(['open', 'closed'])
    chip.fire('click')
    expect(clearRow()).toBeDefined()

    clearRow()?.fire('click')
    expect(selected).toEqual([])
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(optionRows().some(isChecked)).toBe(false)
    expect(clearRow()).toBeUndefined()
    expect(byClass(doc.body, 'pm-filter-pop-sep')).toHaveLength(0)
    expect(chip.textContent).toBe('Status')
    expect(pops()).toHaveLength(1)
  })

  it('the Clear row appears once a first option is toggled on', () => {
    const { chip } = mount()
    chip.fire('click')
    expect(clearRow()).toBeUndefined()
    optionRows()[0].fire('click')
    expect(clearRow()).toBeDefined()
  })

  it('Escape closes, refocuses the chip and leaves no document or window listeners', () => {
    const { chip } = mount()
    chip.fire('click')
    expect(docListeners.length).toBeGreaterThan(0)

    doc.fire('keydown', { key: 'Escape', stopPropagation: () => {} })
    expect(pops()).toHaveLength(0)
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(doc.activeElement).toBe(chip)
    expect(docListeners).toHaveLength(0)
    expect(winListeners).toHaveLength(0)

    // A second open still works after the teardown.
    chip.fire('click')
    expect(pops()).toHaveLength(1)
  })

  it('outside pointer-down closes and clicking the chip again toggles', () => {
    const { chip } = mount()
    chip.fire('click')
    doc.fire('mousedown', { target: doc.body.createDiv() })
    expect(pops()).toHaveLength(0)
    expect(docListeners).toHaveLength(0)

    chip.fire('click')
    expect(pops()).toHaveLength(1)
    chip.fire('click')
    expect(pops()).toHaveLength(0)
    expect(docListeners).toHaveLength(0)
  })
})
