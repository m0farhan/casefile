import { Modal, setIcon } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, Task } from '../types'
import { isTerminalStatus } from '../utils'

/**
 * Soft workflow rule: closing an incident without a verdict prompts for one.
 * Returns extra patch fields to merge ({ verdict } or {} for "close without"),
 * or null when the user cancels the close entirely. UI-layer only — the store
 * never blocks a write. Bulk close is exempt (documented; bulk-set verdict
 * exists instead).
 */
export async function guardVerdictOnClose(
  plugin: PMPlugin,
  project: Project,
  task: Task,
  newStatus: string
): Promise<Partial<Task> | null> {
  if (task.issueType !== 'incident' || task.verdict) return {}
  const config = plugin.store.configFor(project)
  if (!isTerminalStatus(newStatus, config.statuses)) return {}

  return new Promise((resolve) => {
    let settled = false
    const done = (result: Partial<Task> | null) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const modal = new (class extends Modal {
      onOpen(): void {
        this.modalEl.addClass('pm-confirm-modal')
        this.contentEl.createEl('h3', { text: 'Verdict for this incident?' })
        this.contentEl.createEl('p', {
          cls: 'pm-modal-hint',
          text: 'Closing an incident records its verdict. Pick one, or close without.'
        })
        const list = this.contentEl.createDiv('pm-verdict-list')
        for (const v of config.verdicts) {
          const row = list.createEl('button', { cls: 'pm-verdict-option' })
          const dot = row.createSpan({ cls: 'pm-verdict-dot' })
          dot.setCssProps({ '--pm-glyph-color': v.color })
          row.createSpan({ text: v.label })
          row.addEventListener('click', () => {
            done({ verdict: v.id })
            this.close()
          })
        }
        const footer = this.contentEl.createDiv('pm-verdict-footer')
        const skip = footer.createEl('button', { text: 'Close without verdict', cls: 'pm-verdict-skip' })
        skip.addEventListener('click', () => {
          done({})
          this.close()
        })
        const cancel = footer.createEl('button', { cls: 'pm-verdict-cancel' })
        setIcon(cancel.createSpan(), 'x')
        cancel.createSpan({ text: 'Cancel' })
        cancel.addEventListener('click', () => {
          done(null)
          this.close()
        })
      }

      onClose(): void {
        done(null) // Esc / backdrop click cancels the close
        this.contentEl.empty()
      }
    })(plugin.app)
    modal.open()
  })
}
