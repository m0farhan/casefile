import { App, ButtonComponent, ExtraButtonComponent, Modal, Notice } from 'obsidian'
import type PMPlugin from '../main'
import { type Project, type Task, makeTask } from '../types'
import { TaskFileNameConflictError } from '../store'
import { safeAsync, getDefaultStatusId, getDefaultPriorityId } from '../utils'
import { openTaskModal } from '../ui/ModalFactory'
import { parseAlertPaste, type ParsedAlert } from '../soc/alertIntake'

const EMPTY_PARSE: ParsedAlert = { title: '', severityId: '', detectedAt: '', description: '', iocs: [] }

/**
 * One-paste case intake: the analyst pastes a monitoring alert ("Key : Value"
 * lines), the preview shows what was honestly parsed — unparsed fields stay
 * empty, never guessed — and Create inserts an incident and opens it through
 * the same path a board card click uses (openTaskModal honors the
 * modal-vs-panel setting).
 */
export class AlertIntakeModal extends Modal {
  private parsed: ParsedAlert = EMPTY_PARSE
  private detectedAt = ''
  private titleInput!: HTMLInputElement
  private severitySelect!: HTMLSelectElement
  private detectedEl!: HTMLElement
  private iocCountEl!: HTMLElement
  private createBtn!: ButtonComponent

  constructor(
    app: App,
    private plugin: PMPlugin,
    private project: Project,
    /** Refresh hook — called after the case is inserted and on later saves of the opened case. */
    private onCreated: (task: Task) => void | Promise<void>
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.addClass('pm-alert-intake')
    this.modalEl.addClass('pm-modal')
    const config = this.plugin.store.configFor(this.project)

    contentEl.createEl('h2', { text: 'New case from pasted alert' })

    const paste = contentEl.createEl('textarea', {
      cls: 'pm-alert-paste',
      attr: { placeholder: 'Paste the alert text here…', rows: '8' }
    })
    paste.addEventListener('input', () => {
      this.parsed = parseAlertPaste(paste.value, { severities: config.severities })
      this.renderPreviewValues()
    })

    const preview = contentEl.createDiv('pm-alert-preview')

    const row = (label: string): HTMLElement => {
      const r = preview.createDiv('pm-prop-row')
      r.createSpan({ cls: 'pm-prop-label', text: label })
      return r.createDiv('pm-prop-value')
    }

    this.titleInput = row('Title').createEl('input', { type: 'text', cls: 'pm-prop-text' })
    this.titleInput.addEventListener('input', () => {
      this.createBtn.setDisabled(!this.titleInput.value.trim())
    })

    this.severitySelect = row('Severity').createEl('select', { cls: 'pm-prop-select' })
    this.severitySelect.createEl('option', { text: 'No severity', value: '' })
    for (const s of config.severities) {
      this.severitySelect.createEl('option', { text: s.label, value: s.id })
    }

    this.detectedEl = row('Detected')
    this.detectedEl.addClass('pm-alert-detected')

    this.iocCountEl = preview.createDiv('pm-alert-ioc-count')
    preview.createDiv({ cls: 'pm-alert-note', text: 'The full paste becomes the case description.' })

    const footer = contentEl.createDiv('pm-modal-btn-row')
    new ButtonComponent(footer).setButtonText('Cancel').onClick(() => this.close())
    this.createBtn = new ButtonComponent(footer).setButtonText('Create case').setCta().onClick(this.create)

    this.renderPreviewValues()
    window.setTimeout(() => paste.focus(), 10)
  }

  onClose(): void {
    this.contentEl.empty()
  }

  /** Re-derive the preview from the latest parse (a fresh paste overwrites manual tweaks). */
  private renderPreviewValues(): void {
    this.titleInput.value = this.parsed.title
    this.severitySelect.value = this.parsed.severityId
    this.renderDetected(this.parsed.detectedAt)
    const n = this.parsed.iocs.length
    this.iocCountEl.setText(n === 0 ? 'No indicators found' : `${n} indicator${n === 1 ? '' : 's'} found`)
    this.createBtn.setDisabled(!this.parsed.title.trim())
  }

  private renderDetected(iso: string): void {
    this.detectedAt = iso
    this.detectedEl.empty()
    if (!iso) {
      // Honest empty: no timestamp was parsed, so none is shown or stored.
      this.detectedEl.createSpan({ cls: 'pm-alert-empty', text: 'Not found in paste' })
      return
    }
    this.detectedEl.createSpan({ text: new Date(iso).toLocaleString() })
    new ExtraButtonComponent(this.detectedEl)
      .setIcon('x')
      .setTooltip('Clear detected time')
      .onClick(() => this.renderDetected(''))
  }

  private readonly create = safeAsync(async () => {
    const title = this.titleInput.value.trim()
    if (!title) return
    const config = this.plugin.store.configFor(this.project)
    const task = makeTask({
      title,
      issueType: 'incident',
      status: getDefaultStatusId(config.statuses),
      // priority is UI-retired but still written to frontmatter (round-trip default)
      priority: getDefaultPriorityId(config.priorities),
      severity: this.severitySelect.value,
      description: this.parsed.description,
      iocs: this.parsed.iocs,
      detectedAt: this.detectedAt
    })
    try {
      await this.plugin.store.insertTask(this.project, task)
    } catch (err) {
      if (err instanceof TaskFileNameConflictError) {
        new Notice(`Case not created: a note named "${err.fileName}" already exists.`)
        return
      }
      throw err
    }
    this.close()
    await this.onCreated(task)
    openTaskModal(this.plugin, this.project, { task, onSave: this.onCreated })
  })
}
