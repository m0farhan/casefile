/**
 * A DOM stand-in for view tests: the suite runs in plain node, with no DOM.
 * It models the element helpers Obsidian adds (createEl and friends, classes,
 * attributes, text) and event dispatch through a capture pass, the target and
 * bubbling, so a test can drive a view the way a click or a key would. There
 * is no layout, focus order or CSS. A value set on a date input is sanitised
 * the way the HTML spec does it (anything but YYYY-MM-DD reads as ''), since
 * the date controls depend on that rule.
 */

type Info = string | { cls?: string | string[]; text?: string; attr?: Record<string, string>; [k: string]: unknown }

export interface FakeEvent {
  type: string
  target?: FakeEl
  key?: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  defaultPrevented: boolean
  propagationStopped: boolean
  preventDefault(): void
  stopPropagation(): void
  [k: string]: unknown
}

export function fakeEvent(type: string, init: Record<string, unknown> = {}): FakeEvent {
  const e: FakeEvent = {
    type,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault: () => {
      e.defaultPrevented = true
    },
    stopPropagation: () => {
      e.propagationStopped = true
    },
    ...init
  }
  return e
}

const doc = { activeElement: null as FakeEl | null }

export class FakeEl {
  parent: FakeEl | null = null
  children: FakeEl[] = []
  classes = new Set<string>()
  attrs = new Map<string, string>()
  listeners: { type: string; fn: (e: FakeEvent) => unknown; capture: boolean }[] = []
  /** Only a root created by a test counts as mounted; a subtree removed by empty() is not. */
  mounted = false
  data = ''
  type = ''
  checked = false
  hidden = false
  disabled = false
  rows = 0
  placeholder = ''
  spellcheck = true
  scrollTop = 0
  href = ''
  selected = false
  style: Record<string, string> = {}
  private rawValue = ''
  readonly ownerDocument = doc
  readonly win = {}

  constructor(
    readonly tagName = 'DIV',
    info?: Info
  ) {
    this.tagName = tagName.toUpperCase()
    if (info === undefined) return
    if (typeof info === 'string') {
      this.addClass(...info.split(' '))
      return
    }
    const { cls, text, attr, ...rest } = info
    if (cls) this.addClass(...(Array.isArray(cls) ? cls : cls.split(' ')))
    for (const [k, v] of Object.entries(attr ?? {})) this.setAttr(k, v)
    for (const [k, v] of Object.entries(rest)) (this as unknown as Record<string, unknown>)[k] = v
    if (text !== undefined) this.setText(text)
  }

  /** A mounted root to render into. */
  static root(): FakeEl {
    const el = new FakeEl()
    el.mounted = true
    return el
  }

  get value(): string {
    return this.rawValue
  }
  set value(v: string) {
    this.rawValue = this.tagName === 'INPUT' && this.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v) ? '' : v
  }

  get isConnected(): boolean {
    let el: FakeEl = this
    while (el.parent) el = el.parent
    return el.mounted
  }

  get textContent(): string {
    return this.tagName === '#TEXT' ? this.data : this.children.map((c) => c.textContent).join('')
  }

  createEl(tag: string, info?: Info): FakeEl {
    const el = new FakeEl(tag, info)
    this.appendChild(el)
    return el
  }
  createDiv(info?: Info): FakeEl {
    return this.createEl('div', info)
  }
  createSpan(info?: Info): FakeEl {
    return this.createEl('span', info)
  }
  appendChild(el: FakeEl): FakeEl {
    el.remove()
    el.parent = this
    this.children.push(el)
    return el
  }
  remove(): void {
    if (!this.parent) return
    this.parent.children = this.parent.children.filter((c) => c !== this)
    this.parent = null
  }
  empty(): void {
    for (const c of this.children) c.parent = null
    this.children = []
  }
  setText(text: string): void {
    this.empty()
    this.appendText(text)
  }
  appendText(text: string): void {
    const node = new FakeEl('#text')
    node.data = text
    this.appendChild(node)
  }
  getText(): string {
    return this.textContent
  }

  addClass(...cls: string[]): void {
    for (const c of cls) if (c) this.classes.add(c)
  }
  removeClass(...cls: string[]): void {
    for (const c of cls) this.classes.delete(c)
  }
  toggleClass(cls: string, on: boolean): void {
    if (on) this.classes.add(cls)
    else this.classes.delete(cls)
  }
  hasClass(cls: string): boolean {
    return this.classes.has(cls)
  }
  get classList(): { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean } {
    return { add: (c) => this.addClass(c), remove: (c) => this.removeClass(c), contains: (c) => this.hasClass(c) }
  }

  setAttr(k: string, v: string | number | boolean): void {
    this.attrs.set(k, String(v))
  }
  setAttribute(k: string, v: string): void {
    this.setAttr(k, v)
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k)
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k)
  }
  setCssProps(props: Record<string, string>): void {
    Object.assign(this.style, props)
  }
  setCssStyles(props: Record<string, string>): void {
    Object.assign(this.style, props)
  }

  addEventListener(type: string, fn: (e: FakeEvent) => unknown, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture
    this.listeners.push({ type, fn, capture })
  }
  removeEventListener(type: string, fn: (e: FakeEvent) => unknown): void {
    this.listeners = this.listeners.filter((l) => l.type !== type || l.fn !== fn)
  }
  /** Capture pass from the root down, then the target, then bubbling up. */
  dispatchEvent(e: FakeEvent): boolean {
    e.target ??= this
    const path: FakeEl[] = []
    for (let el: FakeEl | null = this; el; el = el.parent) path.push(el)
    const run = (el: FakeEl, capture: boolean | null) => {
      for (const l of el.listeners.slice()) {
        if (l.type === e.type && (capture === null || l.capture === capture)) void l.fn(e)
      }
    }
    for (const el of path.slice(1).reverse()) {
      run(el, true)
      if (e.propagationStopped) return !e.defaultPrevented
    }
    run(this, null)
    for (const el of path.slice(1)) {
      if (e.propagationStopped) break
      run(el, false)
    }
    return !e.defaultPrevented
  }
  click(): void {
    this.dispatchEvent(fakeEvent('click'))
  }
  focus(): void {
    doc.activeElement = this
  }
  blur(): void {
    if (doc.activeElement === this) doc.activeElement = null
  }
  select(): void {}
  setSelectionRange(): void {}
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }

  contains(node: unknown): boolean {
    for (let el = node as FakeEl | null; el; el = el.parent) if (el === this) return true
    return false
  }
  /** Simple selectors only, comma-separated: `tag`, `.cls`, `tag.cls.cls`. */
  matches(selector: string): boolean {
    return selector.split(',').some((part) => {
      const [tag, ...cls] = part.trim().split('.')
      return (!tag || tag.toUpperCase() === this.tagName) && cls.every((c) => this.classes.has(c))
    })
  }
  closest(selector: string): FakeEl | null {
    for (let el: FakeEl | null = this; el; el = el.parent) if (el.matches(selector)) return el
    return null
  }
  /** Every descendant, depth first. */
  descendants(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.descendants()])
  }
  findAll(selector: string): FakeEl[] {
    return this.descendants().filter((el) => el.tagName !== '#TEXT' && el.matches(selector))
  }
  find(selector: string): FakeEl {
    const el = this.findAll(selector)[0]
    if (!el) throw new Error(`no element matches ${selector}`)
    return el
  }
}
