import { App, ButtonComponent, ExtraButtonComponent, Modal, Notice } from 'obsidian'
import type PMPlugin from '../main'
import { type Project, type Task, makeTask } from '../types'
import { TaskFileNameConflictError } from '../store'
import { safeAsync, getDefaultStatusId, getDefaultPriorityId } from '../utils'
import { openTaskModal } from '../ui/ModalFactory'
import { parseAlertPaste, type ParsedAlert } from '../soc/alertIntake'
import { assetRule, iocSightings } from '../soc/ioc'
import { suggestCategory } from '../soc/alertCategory'

const EMPTY_PARSE: ParsedAlert = {
  title: '',
  severityId: '',
  occurredAt: '',
  detectedAt: '',
  description: '',
  iocs: []
}

/**
 * One-paste case intake: the analyst pastes a monitoring alert ("Key : Value"
 * lines), the preview shows what was honestly parsed — unparsed fields stay
 * empty, never guessed — and Create inserts an incident and opens it through
 * the same path a board card click uses (openTaskModal honors the
 * modal-vs-panel setting).
 */
export class AlertIntakeModal extends Modal {
  private parsed: ParsedAlert = EMPTY_PARSE
  private occurredAt = ''
  private detectedAt = ''
  private titleInput!: HTMLInputElement
  private severitySelect!: HTMLSelectElement
  /** Derived from the title, never stored until Create — see renderCategory. */
  private category = ''
  private categoryEl!: HTMLElement
  private occurredEl!: HTMLElement
  private detectedEl!: HTMLElement
  private iocCountEl!: HTMLElement
  private sightingsEl!: HTMLElement
  private linkCheckbox: HTMLInputElement | null = null
  private sightedTaskIds: string[] = []
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

    this.categoryEl = row('Kind')
    this.categoryEl.addClass('pm-alert-detected')
    // Occurred first: that is the order the two things happen in.
    this.occurredEl = row('Occurred')
    this.occurredEl.addClass('pm-alert-detected')
    this.detectedEl = row('Detected')
    this.detectedEl.addClass('pm-alert-detected')

    this.iocCountEl = preview.createDiv('pm-alert-ioc-count')
    this.sightingsEl = preview.createDiv('pm-alert-sightings')
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
    this.renderCategory()
    this.renderStamp('occurredAt', this.parsed.occurredAt)
    this.renderStamp('detectedAt', this.parsed.detectedAt)
    const n = this.parsed.iocs.length
    const assets = this.parsed.iocs.filter((i) => assetRule(i.value, this.plugin.settings.ownedAssets)).length
    this.iocCountEl.setText(
      n === 0
        ? 'No indicators found'
        : `${n} indicator${n === 1 ? '' : 's'} found${assets ? ` · ${assets} your own assets` : ''}`
    )
    this.renderSightings()
    this.createBtn.setDisabled(!this.parsed.title.trim())
  }

  /**
   * Seen-before check over the parsed indicators: name the other cases
   * holding any of them and offer to link them on create (relates-to,
   * checked by default). Real counts only — no hits, no line.
   */
  private renderSightings(): void {
    this.sightingsEl.empty()
    this.linkCheckbox = null
    const byCase = new Map<string, { key: string; title: string }>()
    // The denominator is the SEARCHED set: a partial search printed as a
    // complete one is a fabricated count, not a rounding error (SD-05).
    const owned = this.plugin.settings.ownedAssets
    const searched = this.parsed.iocs.filter((i) => !assetRule(i.value, owned))
    const notSearched = this.parsed.iocs.length - searched.length
    let seen = 0
    for (const ioc of searched) {
      const hits = iocSightings(ioc.value, this.project.tasks, '', owned)
      if (hits.length) seen++
      for (const h of hits) byCase.set(h.taskId, h)
    }
    this.sightedTaskIds = [...byCase.keys()]
    if (!seen) return
    const total = searched.length
    const names = [...byCase.values()].slice(0, 3).map((c) => c.key || c.title)
    const extra = byCase.size > 3 ? ` and ${byCase.size - 3} more` : ''
    const skipped = notSearched ? ` · ${notSearched} your own assets not searched` : ''
    this.sightingsEl.createDiv({
      cls: 'pm-ioc-sightings',
      text: `${seen} of ${total} indicator${total === 1 ? '' : 's'} seen before — ${names.join(', ')}${extra}${skipped}`
    })
    const label = this.sightingsEl.createEl('label', { cls: 'pm-alert-link-cases' })
    this.linkCheckbox = label.createEl('input', { type: 'checkbox' })
    this.linkCheckbox.checked = true
    label.appendText('Link related cases')
  }

  /**
   * The kind of alert, DERIVED from the title and shown with the exact word
   * that matched, so the analyst can see why. It is a suggestion until Create:
   * confirming writes it as an ordinary tag on the case, which is what the card
   * glyph reads. Nothing is written if they clear it, and a title that names no
   * category says so rather than picking one.
   */
  private renderCategory(): void {
    const hit = suggestCategory(this.titleInput.value || this.parsed.title, this.plugin.settings.alertCategories)
    this.category = hit?.id ?? ''
    this.categoryEl.empty()
    if (!hit) {
      this.categoryEl.createSpan({ cls: 'pm-alert-empty', text: 'Not recognised from the title' })
      return
    }
    this.categoryEl.createSpan({ text: `${hit.label} — matched "${hit.matched}"` })
    new ExtraButtonComponent(this.categoryEl)
      .setIcon('x')
      .setTooltip('Do not tag this case')
      .onClick(() => {
        this.category = ''
        this.categoryEl.empty()
        this.categoryEl.createSpan({ cls: 'pm-alert-empty', text: 'Not recorded' })
      })
  }

  /**
   * Preview one parsed stamp. The empty text states only what is true here —
   * the paste did not name that time. It does NOT promise what the SLA will do:
   * this renders from the parse alone, and a case with no severity or an
   * Informational one has no clock at all (sev5 ships without a policy). The
   * panel of the case this opens discloses the anchor, where the policy is known.
   */
  private renderStamp(key: 'occurredAt' | 'detectedAt', iso: string): void {
    this[key] = iso
    const el = key === 'occurredAt' ? this.occurredEl : this.detectedEl
    el.empty()
    if (!iso) {
      // Honest empty: no timestamp was parsed, so none is shown or stored.
      el.createSpan({ cls: 'pm-alert-empty', text: 'Not found in paste' })
      return
    }
    el.createSpan({ text: new Date(iso).toLocaleString() })
    new ExtraButtonComponent(el)
      .setIcon('x')
      .setTooltip('Clear')
      .onClick(() => this.renderStamp(key, ''))
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
      // The confirmed category, as an ordinary tag — the card glyph reads tags,
      // so nothing new is stored and the note stays plain markdown.
      tags: this.category ? [this.category] : [],
      description: this.parsed.description,
      iocs: this.parsed.iocs,
      occurredAt: this.occurredAt,
      detectedAt: this.detectedAt
    })
    // Link sighted cases before insertTask so links serialize with the first save.
    if (this.linkCheckbox?.checked && this.sightedTaskIds.length) {
      task.links = this.sightedTaskIds.map((taskId) => ({ type: 'relates-to' as const, taskId }))
    }
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
