import { ExtraButtonComponent } from 'obsidian'

export class IconButton {
  el: HTMLElement
  private button: ExtraButtonComponent

  constructor(parentEl: HTMLElement) {
    this.button = new ExtraButtonComponent(parentEl)
    this.el = this.button.extraSettingsEl
    this.el.addClass('pm-icon-btn')
    // The component is a div. Older Obsidian builds give it no tab stop and no
    // key handling, and newer ones answer Enter/Space only by calling the
    // component's own onClick callback, which this class never sets (routing
    // clicks through it would re-dispatch into itself). So the button makes
    // itself focusable and turns the keys into a click here.
    this.el.setAttr('tabindex', '0')
    this.el.setAttr('role', 'button')
    this.el.addEventListener('keydown', this.onKeyDown)
  }

  setIcon(name: string): this {
    this.button.setIcon(name)
    return this
  }

  setTooltip(text: string): this {
    this.button.setTooltip(text)
    return this
  }

  setRevealOnHover(enabled: boolean): this {
    this.el.toggleClass('pm-icon-btn--hover-only', enabled)
    return this
  }

  onClick(handler: (e: MouseEvent) => unknown): this {
    this.el.addEventListener('click', handler)
    return this
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    // A modified Enter belongs to whatever owns that shortcut (a modal's save).
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
    e.preventDefault()
    // Stops the board's own Enter, which would open the selected row as well.
    e.stopPropagation()
    // Handlers that open a menu at the pointer (showAtMouseEvent) read the
    // position, so the click carries the button's own rather than 0,0.
    const r = this.el.getBoundingClientRect()
    this.el.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: this.el.win,
        clientX: r.left,
        clientY: r.bottom
      })
    )
  }
}
