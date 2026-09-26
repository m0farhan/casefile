import { setIcon } from 'obsidian'

export interface CollapseToggleProps {
  collapsed: boolean
  onToggle: (e: MouseEvent) => unknown
}

export class CollapseToggle {
  el: HTMLElement

  constructor(parentEl: HTMLElement, props: CollapseToggleProps) {
    // aria-expanded is set once: the table and gantt rebuild the row on every
    // toggle, and a host that flips in place keeps the attribute up itself.
    this.el = parentEl.createDiv({
      cls: 'tree-item-icon collapse-icon pm-collapse-toggle',
      attr: { role: 'button', tabindex: '0', 'aria-expanded': String(!props.collapsed) }
    })
    setIcon(this.el, 'right-triangle')
    this.el.toggleClass('is-collapsed', props.collapsed)
    this.el.setAttr('aria-label', props.collapsed ? 'Expand subtasks' : 'Collapse subtasks')
    this.el.addEventListener('click', props.onToggle)
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      e.preventDefault()
      // Stops the table's own Enter, which would open the selected row too.
      e.stopPropagation()
      // A click, not a direct onToggle call, so the key takes the pointer's
      // path, including a host that toggles from its own click listener.
      this.el.click()
      this.refocusAfterRedraw()
    })
  }

  /**
   * The table and gantt answer a toggle by drawing their rows again, which
   * removes this focused toggle and drops focus to the document. Watch for the
   * redraw and focus the new toggle of the same row. Keyboard only: a pointer
   * click leaves focus where the pointer put it.
   */
  private refocusAfterRedraw(): void {
    const id = this.el.closest<HTMLElement>('[data-task-id]')?.dataset.taskId
    if (id === undefined) return
    const doc = this.el.ownerDocument
    const win = doc.defaultView
    if (!win) return
    // Nearest first. The nearest one still in the document after the redraw is
    // the view root the row was drawn into again.
    const ancestors: HTMLElement[] = []
    for (let n = this.el.parentElement; n; n = n.parentElement) ancestors.push(n)
    const findNew = (): HTMLElement | undefined => {
      const root = ancestors.find((a) => a.isConnected)
      if (!root) return undefined
      return Array.from(root.querySelectorAll<HTMLElement>('.pm-collapse-toggle')).find(
        (t) => t.closest<HTMLElement>('[data-task-id]')?.dataset.taskId === id
      )
    }
    const observer = new win.MutationObserver(() => {
      // Not drawn again yet, or a host that flips in place.
      if (this.el.isConnected) return
      // Focus has moved on to something else: leave it there.
      if (doc.activeElement && doc.activeElement !== doc.body) {
        stop()
        return
      }
      const next = findNew()
      if (!next) return
      next.focus()
      stop()
    })
    // ponytail: gives up after 3 s, so a host that flips in place is not watched
    // for good; a redraw slower than that leaves focus on the document as before.
    const timer = win.setTimeout(() => observer.disconnect(), 3000)
    const stop = () => {
      observer.disconnect()
      win.clearTimeout(timer)
    }
    observer.observe(doc.body, { childList: true, subtree: true })
  }
}
