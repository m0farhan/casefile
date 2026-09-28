import { Menu, Notice } from 'obsidian'
import { defangText } from '../soc/toolbox'
import { safeAsync } from '../utils'

/** Copy text and say so. */
export function copyText(text: string, what = 'Copied'): void {
  safeAsync(async () => {
    await navigator.clipboard.writeText(text)
    new Notice(what)
  })()
}

/**
 * Right-click on text selected inside el: Copy, and Copy defanged for pasting
 * into a ticket, chat or email without handing anyone a live indicator. With
 * nothing selected there, the right-click is left alone.
 */
export function defangCopyMenu(el: HTMLElement): void {
  el.addEventListener('contextmenu', (e) => {
    const sel = el.ownerDocument.getSelection()
    const text = sel && !sel.isCollapsed && el.contains(sel.anchorNode) ? sel.toString() : ''
    if (!text.trim()) return
    e.preventDefault()
    const menu = new Menu()
    menu.addItem((item) =>
      item
        .setTitle('Copy')
        .setIcon('copy')
        .onClick(() => copyText(text))
    )
    menu.addItem((item) =>
      item
        .setTitle('Copy defanged')
        .setIcon('shield')
        .onClick(() => copyText(defangText(text), 'Copied, defanged'))
    )
    menu.showAtMouseEvent(e)
  })
}
