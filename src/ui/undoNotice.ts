import { Notice } from 'obsidian'
import { safeAsync } from '../utils'

/**
 * Notice with an Undo button for one-click actions that are risky to fat-finger
 * (board drops, archive, bulk edits). 8 seconds, then it's gone — the undo
 * window, not an undo stack. The button disables itself on first click so a
 * double-click can't run the restore twice.
 */
export function showUndoNotice(message: string, undo: () => Promise<void>): void {
  const frag = createFragment((f) => {
    f.createSpan({ text: message })
  })
  const btn = frag.createEl('button', { text: 'Undo', cls: 'pm-undo-btn' })
  const notice = new Notice(frag, 8000)
  btn.addEventListener(
    'click',
    safeAsync(async () => {
      if (btn.disabled) return
      btn.disabled = true
      notice.hide()
      await undo()
      new Notice('Undone')
    })
  )
}
