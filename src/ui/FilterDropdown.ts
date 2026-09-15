import { setIcon } from 'obsidian'
import { ChipButton } from './primitives/ChipButton'
import { Popover } from './primitives/Popover'

/**
 * Multi-select filter chip. Clicking the chip opens a stay-open popover (the
 * `Popover` primitive owns anchoring and the close-on-outside/Escape
 * lifecycle): each row click toggles that option and updates the chip label
 * and row check in place, so an analyst can set five filters in five clicks
 * instead of reopening a menu per click.
 */
export function renderFilterDropdown(
  parent: HTMLElement,
  label: string,
  selected: string[],
  options: { id: string; label: string }[],
  onChange: (selected: string[]) => void
): HTMLElement {
  const btn = new ChipButton(parent).setAriaLabel(`Filter by ${label}`)

  const updateLabel = () => {
    const has = selected.length > 0
    btn.setLabel(has ? `${label}: ${selected.length}` : label).setActive(has)
  }
  updateLabel()

  let pop: Popover | null = null
  btn.onClick(() => {
    if (pop?.isOpen) {
      pop.close()
      return
    }
    const doc = btn.el.ownerDocument
    // Registered before open(), so it runs ahead of the Popover's own
    // Escape-close handler (same target and phase, registration order) and
    // the chip regains focus as the panel closes.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') btn.el.focus()
    }
    doc.addEventListener('keydown', onEsc, true)
    // ponytail: if the chip is torn out of the DOM while the panel is open,
    // the Popover's outside-pointerdown path still closes the orphan.
    pop = new Popover({
      anchor: btn.el,
      onClose: () => {
        doc.removeEventListener('keydown', onEsc, true)
        pop = null
      }
    })

    const body = pop.contentEl
    body.addClass('pm-filter-pop')
    const list = body.createDiv('pm-pop-list')
    list.setAttribute('role', 'listbox')
    const footer = body.createDiv()
    const rowSyncs: (() => void)[] = []

    // Separator + Clear, present only while something is selected.
    const renderFooter = () => {
      footer.empty()
      if (selected.length === 0) return
      footer.createDiv('pm-filter-pop-sep')
      const clear = footer.createEl('button', { cls: 'pm-pop-item', text: 'Clear' })
      clear.addEventListener('click', () => {
        selected.length = 0
        onChange(selected)
        updateLabel()
        for (const sync of rowSyncs) sync()
        renderFooter()
      })
    }

    for (const opt of options) {
      const item = list.createEl('button', { cls: 'pm-pop-item' })
      item.setAttribute('role', 'option')
      item.createSpan({ cls: 'pm-pop-item-label', text: opt.label })
      const check = item.createSpan({ cls: 'pm-pop-check' })
      setIcon(check, 'check')
      const sync = () => {
        const on = selected.includes(opt.id)
        item.setAttribute('aria-selected', String(on))
        check.toggleClass('pm-pop-check--hidden', !on)
      }
      sync()
      rowSyncs.push(sync)
      item.addEventListener('click', () => {
        const idx = selected.indexOf(opt.id)
        if (idx >= 0) selected.splice(idx, 1)
        else selected.push(opt.id)
        onChange(selected)
        updateLabel()
        sync()
        renderFooter()
      })
    }
    renderFooter()
    pop.open()
  })

  btn.el.setAttribute('role', 'combobox')
  btn.el.setAttribute('aria-expanded', 'false')
  return btn.el
}
