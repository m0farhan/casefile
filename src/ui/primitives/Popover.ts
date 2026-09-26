import { Platform } from 'obsidian'

export interface PopoverOptions {
  anchor: HTMLElement
  host?: HTMLElement
  align?: 'left' | 'right'
  width?: number
  onClose?: () => void
}

const VIEWPORT_MARGIN = 12
const ANCHOR_GAP = 4

/**
 * Floating panel anchored to a trigger element, for content Obsidian's `Menu`
 * can't host (date inputs, search fields, number fields). Position is written as
 * CSS custom properties (`--pop-top` / `--pop-left`) read by `.pm-pop`, so no
 * static inline styles are assigned.
 *
 * The caller owns the lifecycle: fill `contentEl`, call `open()`, then `close()`
 * on selection. It also closes on outside pointer-down and on Escape (the Escape
 * handler stops propagation so the host modal stays open).
 *
 * When the anchor sits inside a modal the panel mounts into that modal element,
 * not `document.body`: Obsidian's modal traps focus and yanks it back to the
 * first field whenever focus lands on an element outside the modal, which would
 * make a focusable popover (a date input, a search box) impossible to type in.
 * `.pm-pop` is `position: fixed`, so it still escapes the modal's `overflow:
 * hidden` and positions by viewport coordinates.
 *
 * On phones it renders as a bottom sheet (`pm-pop--sheet`) instead of an anchored
 * box, so it stays usable without hover or precise positioning.
 *
 * Opening moves focus into the panel, onto the current choice when a row is
 * marked `aria-selected`, else onto the first field or button, because the panel
 * is appended after everything else in its host and Tab from the anchor would
 * otherwise walk the rest of the modal or workspace first. A caller that owns a
 * search or date field focuses it after `open()`, which takes over. Closing with
 * focus inside hands it back to the anchor. Arrow keys step between option rows.
 */
export class Popover {
  readonly contentEl: HTMLElement
  private readonly el: HTMLElement
  private readonly anchor: HTMLElement
  private readonly host: HTMLElement
  private readonly win: Window
  private readonly doc: Document
  private readonly align: 'left' | 'right'
  private readonly width?: number
  private readonly onCloseCb?: () => void
  private opened = false

  constructor(opts: PopoverOptions) {
    this.anchor = opts.anchor
    this.win = activeWindow
    this.doc = activeDocument
    this.host = opts.host ?? this.anchor.closest<HTMLElement>('.modal') ?? this.doc.body
    this.align = opts.align ?? 'left'
    this.width = opts.width
    this.onCloseCb = opts.onClose
    this.el = createDiv('pm-pop')
    if (Platform.isPhone) this.el.addClass('pm-pop--sheet')
    if (this.width != null) this.el.setCssProps({ '--pop-width': `${this.width}px` })
    this.contentEl = this.el.createDiv('pm-pop-body')
  }

  get isOpen(): boolean {
    return this.opened
  }

  open(): void {
    if (this.opened) return
    this.opened = true
    this.anchor.setAttribute('aria-expanded', 'true')
    this.host.appendChild(this.el)
    this.reposition()
    const target =
      this.contentEl.querySelector<HTMLElement>('[aria-selected="true"]') ??
      this.contentEl.querySelector<HTMLElement>('input, select, textarea, button')
    target?.focus()
    this.doc.addEventListener('mousedown', this.onOutsideDown, true)
    this.doc.addEventListener('keydown', this.onKeyDown, true)
    this.win.addEventListener('scroll', this.reposition, true)
    this.win.addEventListener('resize', this.reposition)
  }

  close(): void {
    if (!this.opened) return
    this.opened = false
    this.anchor.setAttribute('aria-expanded', 'false')
    this.doc.removeEventListener('mousedown', this.onOutsideDown, true)
    this.doc.removeEventListener('keydown', this.onKeyDown, true)
    this.win.removeEventListener('scroll', this.reposition, true)
    this.win.removeEventListener('resize', this.reposition)
    // Only when focus is inside: an outside click keeps its own target, since its
    // default focus change runs after this capture-phase pointer-down.
    if (this.el.contains(this.doc.activeElement)) this.anchor.focus()
    this.el.remove()
    this.onCloseCb?.()
  }

  private reposition = (): void => {
    if (!this.opened || Platform.isPhone) return
    const r = this.anchor.getBoundingClientRect()
    const vw = this.win.innerWidth
    const vh = this.win.innerHeight
    const pw = this.el.offsetWidth || this.width || 200
    const ph = this.el.offsetHeight || 200
    let top = r.bottom + ANCHOR_GAP
    if (top + ph > vh - VIEWPORT_MARGIN) top = Math.max(VIEWPORT_MARGIN, r.top - ph - ANCHOR_GAP)
    let left = this.align === 'right' ? r.right - pw : r.left
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - pw - VIEWPORT_MARGIN))
    this.el.setCssProps({ '--pop-top': `${top}px`, '--pop-left': `${left}px` })
  }

  private onOutsideDown = (e: MouseEvent): void => {
    const target = e.target as Node
    if (this.el.contains(target) || this.anchor.contains(target)) return
    this.close()
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      this.close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    // Only from an option row: this listener sees every key on the document
    // first, and a focused date input steps its own fields with the arrows.
    const items = Array.from(this.el.querySelectorAll<HTMLElement>('.pm-pop-item'))
    const at = items.findIndex((it) => it === this.doc.activeElement)
    if (at < 0) return
    e.preventDefault()
    items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus()
  }
}
