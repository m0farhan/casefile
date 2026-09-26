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
    })
  }
}
