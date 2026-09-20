import { ButtonComponent, Modal } from 'obsidian'
import type PMPlugin from '../main'
import { buildHandover, writeHandoverNote } from './handover'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The shift handover, on screen before it is anywhere else.
 *
 * A handover is produced at the end of a shift and usually pasted into a chat,
 * so the analyst has to READ it before it is committed — the old palette-only
 * command wrote the note first and showed it second, which is backwards and is
 * why the feature was never found. Compose on open, show the exact markdown the
 * buttons emit, and let the note be a choice.
 *
 * Vault-wide on purpose: a shift covers every case, not the project whose board
 * happens to be open, and it deliberately ignores the board filter — a filtered
 * handover would silently drop incidents the next shift owns.
 *
 * Nothing special happens when there is nothing to hand over: buildHandover
 * already prints every heading with "None." / "Nothing recorded." under it, and
 * that note IS the artifact ("checked at 07:58, nothing open"). No second
 * summary line that could drift from the body it summarises.
 */
class HandoverModal extends Modal {
  private md: string | null = null
  private closed = false

  constructor(private plugin: PMPlugin) {
    super(plugin.app)
  }

  onOpen(): void {
    const { contentEl } = this
    this.modalEl.addClass('pm-modal', 'pm-modal--handover')
    contentEl.addClass('pm-handover')
    this.setTitle('Shift handover')

    contentEl.createEl('p', {
      cls: 'pm-handover-meta',
      text: `Every case in the vault · activity from the last ${this.plugin.settings.handoverWindowHours}h · board filters do not apply. Nothing is written until you choose.`
    })
    // Plain text, not rendered markdown: this is what gets pasted, and case
    // titles/indicators are hostile pasted alert content — textContent only.
    const pre = contentEl.createEl('pre', { cls: 'pm-handover-preview', text: 'Composing…' })
    const row = contentEl.createDiv('pm-modal-btn-row')
    const copyBtn = new ButtonComponent(row).setButtonText('Copy').setDisabled(true)
    const writeBtn = new ButtonComponent(row)
      .setButtonText(`Write to ${this.plugin.settings.handoverPath}`)
      .setCta()
      .setDisabled(true)
    writeBtn.setTooltip('Overwrites the note at that path')

    void this.compose(pre, copyBtn, writeBtn)
  }

  private async compose(pre: HTMLElement, copyBtn: ButtonComponent, writeBtn: ButtonComponent): Promise<void> {
    let projects
    try {
      projects = await this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder)
    } catch (e) {
      // An empty preview would read as "nothing to hand over", which is the one
      // thing it must never say when it simply could not read the cases.
      if (this.closed) return
      pre.setText(`Could not read ${this.plugin.settings.projectsFolder || 'the vault'}: ${errText(e)}`)
      return
    }
    if (this.closed) return
    this.md = buildHandover(projects, this.plugin.settings, new Date().toISOString())
    pre.setText(this.md)
    copyBtn.setDisabled(false).onClick(() => void this.copy())
    writeBtn.setDisabled(false).onClick(() => void this.write())
  }

  private async copy(): Promise<void> {
    if (this.md === null) return
    await navigator.clipboard.writeText(this.md)
    this.plugin.showNotice('Shift handover copied')
  }

  private async write(): Promise<void> {
    if (this.md === null) return
    let path: string
    try {
      path = await writeHandoverNote(this.app, this.md, this.plugin.settings.handoverPath)
    } catch (e) {
      this.plugin.showNotice(`Could not write ${this.plugin.settings.handoverPath}: ${errText(e)}`, 6000)
      return
    }
    this.close()
    await this.app.workspace.openLinkText(path, '', true)
  }

  onClose(): void {
    this.closed = true
    this.contentEl.empty()
  }
}

export function openHandoverModal(plugin: PMPlugin): void {
  new HandoverModal(plugin).open()
}
