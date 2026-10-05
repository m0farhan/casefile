import { type Editor, Menu, Notice } from 'obsidian'
import { defangText } from '../soc/toolbox'
import { safeAsync } from '../utils'

/** Copy text and say so. */
export function copyText(text: string, what = 'Copied'): void {
  safeAsync(async () => {
    await navigator.clipboard.writeText(text)
    new Notice(what)
  })()
}

/** Defangs the selection where it stands: the brackets only, nothing added around it. */
export function defangInPlace(editor: Editor): void {
  const text = editor.getSelection()
  const out = defangText(text)
  if (out === text) new Notice('Nothing in the selection to defang.')
  else editor.replaceSelection(out)
}

/** Copy text defanged, and say so only when something was defanged. */
export function copyDefanged(text: string): void {
  const out = defangText(text)
  copyText(out, out === text ? 'Copied (nothing to defang)' : 'Copied, defanged')
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
        .onClick(() => copyDefanged(text))
    )
    menu.showAtMouseEvent(e)
  })
}
