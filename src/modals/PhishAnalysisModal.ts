import { ButtonComponent, Modal, Notice, SuggestModal, type TFile, setTooltip } from 'obsidian'
import type PMPlugin from '../main'
import { type PhishReport, analysePhishing, formatPhishReport } from '../soc/phish'
import { extractIocsFromText } from '../soc/ioc'
import { openProjectPicker, openTaskModal } from '../ui/ModalFactory'
import { type Ioc, makeTask } from '../types'
import { getDefaultPriorityId, getDefaultStatusId, safeAsync } from '../utils'

/**
 * A phishing email, read offline.
 *
 * Everything on screen is a quotation, a comparison of quotations, or a hash
 * this machine computed from bytes it was given. There is no score, no
 * colour-coded verdict and no word like "suspicious": SPF failed or it did
 * not, the link unwraps to a different host or it does not, the attachment is
 * a type that can carry macros or it is not. The analyst reaches the verdict
 * and their name goes on it — which is the whole reason the verdict lives on
 * the case and not in here.
 *
 * The HTML body is shown as SOURCE and is never handed to a renderer, so
 * opening a phishing mail to analyse it is not the thing that tells the sender
 * you opened it. No remote image is fetched, no link is resolved, nothing
 * leaves the vault.
 */
class PhishAnalysisModal extends Modal {
  private report: PhishReport | null = null
  private raw = ''
  /** Ids the analyst ticked. They become tags on the case, nothing more. */
  private readonly chosen = new Set<string>()

  constructor(private plugin: PMPlugin) {
    super(plugin.app)
  }

  onOpen(): void {
    const { contentEl } = this
    this.modalEl.addClass('pm-modal', 'pm-modal--headers')
    contentEl.addClass('pm-headers')
    this.setTitle('Analyse a phishing email')
    contentEl.createEl('p', {
      cls: 'pm-headers-meta',
      text: 'Paste the headers or the whole message, or load a .eml from the vault. Nothing is rendered, resolved or sent — every line below is read from what you gave it.'
    })

    const input = contentEl.createEl('textarea', {
      cls: 'pm-headers-input',
      attr: { placeholder: 'Received: from …', rows: '7', spellcheck: 'false' }
    })
    const out = contentEl.createDiv('pm-headers-out')
    // PhishTool resolves a case against a classification set, which is what
    // makes its dashboard countable. Same vocabulary here, ticked by the
    // analyst and written as ordinary tags — the card already reads tags, so
    // nothing new is stored and the note stays plain markdown.
    contentEl.createEl('h4', { cls: 'pm-headers-h', text: 'Classification (optional)' })
    const chipRow = contentEl.createDiv('pm-headers-chips')
    for (const classification of this.plugin.settings.phishClassifications) {
      const chip = chipRow.createSpan({ cls: 'pm-headers-chip', text: classification.label })
      chip.addEventListener('click', () => {
        if (this.chosen.has(classification.id)) this.chosen.delete(classification.id)
        else this.chosen.add(classification.id)
        chip.toggleClass('is-on', this.chosen.has(classification.id))
      })
    }

    const row = contentEl.createDiv('pm-modal-btn-row')

    const loadBtn = new ButtonComponent(row).setButtonText('Load .eml')
    setTooltip(loadBtn.buttonEl, 'Read a .eml file already in this vault')
    const copyBtn = new ButtonComponent(row).setButtonText('Copy report').setDisabled(true)
    const iocBtn = new ButtonComponent(row).setButtonText('Copy indicators').setDisabled(true)
    const caseBtn = new ButtonComponent(row).setButtonText('Create case').setCta().setDisabled(true)

    const refresh = safeAsync(async () => {
      this.raw = input.value
      this.report = this.raw.trim()
        ? await analysePhishing(this.raw, this.plugin.settings.ownedAssets, this.plugin.settings.phishBrands)
        : null
      copyBtn.setDisabled(!this.report)
      caseBtn.setDisabled(!this.report)
      iocBtn.setDisabled(!this.report?.headers.indicators.length)
      this.render(out)
    })

    input.addEventListener('input', refresh)
    loadBtn.onClick(
      safeAsync(async () => {
        const files = this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === 'eml')
        if (!files.length) {
          new Notice('No .eml files in this vault.')
          return
        }
        openEmlPicker(this.plugin, files, (file) => {
          void (async () => {
            input.value = await this.app.vault.cachedRead(file)
            refresh()
          })()
        })
      })
    )
    copyBtn.onClick(
      safeAsync(async () => {
        if (!this.report) return
        await navigator.clipboard.writeText(formatPhishReport(this.report))
        new Notice('Analysis copied')
      })
    )
    iocBtn.onClick(
      safeAsync(async () => {
        const lines = this.report?.headers.indicators ?? []
        if (!lines.length) return
        await navigator.clipboard.writeText(lines.join('\n'))
        new Notice(`Copied ${lines.length} indicator${lines.length === 1 ? '' : 's'}`)
      })
    )
    caseBtn.onClick(safeAsync(async () => this.createCase()))
    input.focus()
  }

  /**
   * Open a case carrying the whole analysis.
   *
   * The description is the report verbatim, so the case records what was read
   * and not a summary of it, and the indicators arrive already typed. Severity
   * and verdict are deliberately left unset: this modal has no opinion, and a
   * case born with a verdict is a case nobody judged.
   */
  private async createCase(): Promise<void> {
    if (!this.report) return
    const projects = await this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder)
    if (!projects.length) {
      new Notice('No boards yet. Create a board first.')
      return
    }
    const subject = this.report.headers.identities.find((i) => i.label === 'Subject')?.value ?? ''
    const title = subject && subject !== 'not recorded' ? subject : 'Reported phishing email'
    const iocs: Ioc[] = extractIocsFromText(this.raw, [])
    const seen = new Set(iocs.map((i) => i.value.toLowerCase()))
    for (const link of this.report.links) {
      if (link.target && !seen.has(link.target.toLowerCase())) {
        seen.add(link.target.toLowerCase())
        iocs.push({ type: 'url', value: link.target, note: link.wrappedBy ? `unwrapped from ${link.wrappedBy}` : '' })
      }
    }
    for (const attachment of this.report.attachments) {
      if (!seen.has(attachment.sha256)) {
        seen.add(attachment.sha256)
        iocs.push({ type: 'hash', value: attachment.sha256, note: `${attachment.filename} (hashed here)` })
      }
    }
    openProjectPicker(this.plugin, projects, (project) => {
      void (async () => {
        const config = this.plugin.store.configFor(project)
        const task = makeTask({
          title: title.slice(0, 120),
          issueType: 'incident',
          status: getDefaultStatusId(config.statuses),
          priority: getDefaultPriorityId(config.priorities),
          tags: ['phishing', ...[...this.chosen].map(classificationTag)],
          description: formatPhishReport(this.report as PhishReport),
          iocs
        })
        await this.plugin.store.insertTask(project, task)
        this.close()
        openTaskModal(this.plugin, project, { task, onSave: () => {} })
      })()
    })
  }

  private render(out: HTMLElement): void {
    out.empty()
    const report = this.report
    if (!report) return
    const a = report.headers

    const section = (title: string): HTMLElement => {
      out.createEl('h4', { cls: 'pm-headers-h', text: title })
      return out.createDiv('pm-headers-body')
    }
    const row = (parent: HTMLElement, label: string, value: string, extra?: string): void => {
      const line = parent.createDiv('pm-headers-row')
      line.createSpan({ cls: 'pm-headers-label', text: label })
      line.createSpan({ cls: 'pm-headers-value', text: value })
      if (extra) line.createSpan({ cls: 'pm-headers-result', text: extra })
    }

    const ids = section('Identities')
    for (const id of a.identities) row(ids, id.label, id.value)

    const auth = section('Authentication')
    if (a.auth.length) for (const r of a.auth) row(auth, r.mechanism.toUpperCase(), r.result, r.detail)
    else auth.createDiv({ cls: 'pm-headers-empty', text: 'Not recorded.' })

    const path = section('Path')
    if (a.hops.length) {
      for (const hop of a.hops) {
        row(
          path,
          String(hop.n),
          `from ${hop.from} by ${hop.by} with ${hop.via}`,
          hop.at ? (hop.delaySec === null ? hop.at : `${hop.at} (+${hop.delaySec}s)`) : 'no time recorded'
        )
      }
    } else {
      path.createDiv({ cls: 'pm-headers-empty', text: 'Not recorded.' })
    }

    const obs = section('Observations')
    if (a.observations.length) for (const o of a.observations) obs.createDiv({ cls: 'pm-headers-note', text: o })
    else obs.createDiv({ cls: 'pm-headers-empty', text: 'Nothing to compare.' })

    const links = section(`Links (${report.links.length})`)
    if (report.links.length) {
      for (const link of report.links) {
        const line = links.createDiv('pm-headers-link')
        // Defanged and inert: this is a phishing link and it is never clickable.
        line.createDiv({ cls: 'pm-headers-ioc', text: link.target.replace(/\./g, '[.]') })
        if (link.wrappedBy) {
          line.createDiv({ cls: 'pm-headers-note', text: `unwrapped from ${link.wrappedBy}` })
        }
        for (const flag of link.flags) line.createDiv({ cls: 'pm-headers-flag', text: flag })
      }
    } else {
      links.createDiv({ cls: 'pm-headers-empty', text: 'None found.' })
    }

    const atts = section(`Attachments (${report.attachments.length})`)
    if (report.attachments.length) {
      for (const attachment of report.attachments) {
        const line = atts.createDiv('pm-headers-link')
        line.createDiv({
          cls: 'pm-headers-value',
          text: `${attachment.filename} — ${attachment.contentType}, ${attachment.size} bytes`
        })
        line.createDiv({ cls: 'pm-headers-ioc', text: `SHA-256 ${attachment.sha256}` })
        line.createDiv({ cls: 'pm-headers-ioc', text: `SHA-1   ${attachment.sha1}` })
        line.createDiv({ cls: 'pm-headers-note', text: 'hash computed here, from the bytes in the file' })
        for (const fact of attachment.facts) line.createDiv({ cls: 'pm-headers-flag', text: fact })
      }
    } else {
      atts.createDiv({ cls: 'pm-headers-empty', text: 'None.' })
    }

    if (report.text.trim()) {
      const body = section('Body (plain text)')
      body.createEl('pre', { cls: 'pm-headers-pre', text: report.text.trim().slice(0, 4000) })
    }
    if (report.htmlSource.trim()) {
      const body = section('Body (HTML source — not rendered)')
      body.createEl('pre', { cls: 'pm-headers-pre', text: report.htmlSource.trim().slice(0, 4000) })
    }

    const iocs = section(`Indicators (${a.indicators.length})`)
    if (a.indicators.length) for (const i of a.indicators) iocs.createDiv({ cls: 'pm-headers-ioc', text: i })
    else iocs.createDiv({ cls: 'pm-headers-empty', text: 'None found.' })

    const notes = [...a.notes, ...report.notes]
    if (notes.length) {
      const el = section('Not in this paste')
      for (const n of notes) el.createDiv({ cls: 'pm-headers-note', text: n })
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

/** Pick a .eml already in the vault. Read-only: the file is never modified. */
class EmlPickerModal extends SuggestModal<TFile> {
  constructor(
    plugin: PMPlugin,
    private files: TFile[],
    private onChoose: (file: TFile) => void
  ) {
    super(plugin.app)
    this.setPlaceholder('Pick a .eml file…')
  }

  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase().trim()
    return q ? this.files.filter((f) => f.path.toLowerCase().includes(q)) : this.files
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.addClass('mod-complex')
    const content = el.createDiv({ cls: 'suggestion-content' })
    content.createDiv({ cls: 'suggestion-title', text: file.name })
    content.createDiv({ cls: 'suggestion-note', text: file.parent?.path ?? '' })
  }

  onChooseSuggestion(file: TFile): void {
    this.onChoose(file)
  }
}

function openEmlPicker(plugin: PMPlugin, files: TFile[], onChoose: (file: TFile) => void): void {
  new EmlPickerModal(plugin, files, onChoose).open()
}

/** `CRED_HARV` → `cred-harv`: a tag, lowercase and hyphenated like every other. */
function classificationTag(id: string): string {
  return id.toLowerCase().replace(/_/g, '-')
}

export function openPhishAnalysis(plugin: PMPlugin): void {
  new PhishAnalysisModal(plugin).open()
}
