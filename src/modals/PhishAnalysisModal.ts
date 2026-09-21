import { ButtonComponent, Modal, Notice, SuggestModal, type TFile, setTooltip } from 'obsidian'
import type PMPlugin from '../main'
import { formatDelay } from '../soc/emailHeaders'
import { IMAGE_CAP, hexDump, imageDataUrl, previewKind, previewText } from '../soc/preview'
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
/** How much body is painted on screen. The full text always reaches the report. */
const BODY_PREVIEW = 4000

type TabId = 'message' | 'links' | 'attachments' | 'body' | 'indicators'

class PhishAnalysisModal extends Modal {
  private report: PhishReport | null = null
  private raw = ''
  /** Monotonic: a slow run must never overwrite the result of a newer one. */
  private runId = 0
  private debounce: number | null = null
  private tab: TabId = 'message'

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
      attr: { placeholder: 'Received: from …', rows: '5', spellcheck: 'false' }
    })
    const out = contentEl.createDiv('pm-headers-out')
    const row = contentEl.createDiv('pm-modal-btn-row')

    const loadBtn = new ButtonComponent(row).setButtonText('Load .eml')
    setTooltip(loadBtn.buttonEl, 'Read a .eml file already in this vault')
    const copyBtn = new ButtonComponent(row).setButtonText('Copy report').setDisabled(true)
    const iocBtn = new ButtonComponent(row).setButtonText('Copy indicators').setDisabled(true)
    const caseBtn = new ButtonComponent(row).setButtonText('Create case').setCta().setDisabled(true)

    const refresh = safeAsync(async () => {
      const run = ++this.runId
      const raw = input.value
      const report = raw.trim()
        ? await analysePhishing(raw, this.plugin.settings.ownedAssets, this.plugin.settings.phishBrands)
        : null
      // A newer keystroke already started: drop this result on the floor
      // rather than painting a stale message over the current one.
      if (run !== this.runId) return
      this.raw = raw
      this.report = report
      copyBtn.setDisabled(!report)
      caseBtn.setDisabled(!report)
      iocBtn.setDisabled(!report?.indicators.length)
      this.render(out)
    })

    // Debounced: the full parse hashes every attachment, and running it on
    // each keystroke of a pasted 4MB message locks the UI thread.
    input.addEventListener('input', () => {
      if (this.debounce !== null) window.clearTimeout(this.debounce)
      this.debounce = window.setTimeout(refresh, 300)
    })
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
        const lines = this.report?.indicators ?? []
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
    // Built from the PARSED message, not the raw paste — the same set the
    // Indicators panel and the copy button show, so the three cannot diverge.
    const headerBlock = this.raw.split(/\n\s*\n/)[0] ?? ''
    const iocs: Ioc[] = extractIocsFromText(`${headerBlock}\n${this.report.text}`, [])
    const seen = new Set(iocs.map((i) => i.value.toLowerCase()))
    for (const link of this.report.links) {
      if (link.target && !seen.has(link.target.toLowerCase())) {
        seen.add(link.target.toLowerCase())
        iocs.push({ type: 'url', value: link.target, note: link.wrappedBy ? `unwrapped from ${link.wrappedBy}` : '' })
      }
    }
    for (const attachment of this.report.attachments) {
      if (attachment.sha256 && !seen.has(attachment.sha256)) {
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
          tags: ['phishing'],
          description: formatPhishReport(this.report as PhishReport),
          iocs
        })
        await this.plugin.store.insertTask(project, task)
        this.close()
        openTaskModal(this.plugin, project, { task, onSave: () => {} })
      })()
    })
  }

  /**
   * One pane at a time, because a phishing analysis is five different
   * questions and answering them in one scroll means the analyst reads the
   * first and scrolls past the rest.
   */
  private render(out: HTMLElement): void {
    out.empty()
    const report = this.report
    if (!report) return

    const tabs: { id: TabId; label: string }[] = [
      { id: 'message', label: 'Message' },
      { id: 'links', label: `Links (${report.links.length})` },
      { id: 'attachments', label: `Attachments (${report.attachments.length})` },
      { id: 'body', label: 'Body' },
      { id: 'indicators', label: `Indicators (${report.indicators.length})` }
    ]
    const strip = out.createDiv('pm-headers-tabs')
    const panel = out.createDiv('pm-headers-panel')
    for (const tab of tabs) {
      const button = strip.createEl('button', { cls: 'pm-headers-tab', text: tab.label })
      button.toggleClass('is-on', this.tab === tab.id)
      button.addEventListener('click', () => {
        this.tab = tab.id
        this.render(out)
      })
    }
    this.renderPanel(panel, report)
  }

  private renderPanel(panel: HTMLElement, report: PhishReport): void {
    const section = (title: string): HTMLElement => {
      panel.createEl('h4', { cls: 'pm-headers-h', text: title })
      return panel.createDiv('pm-headers-body')
    }
    const a = report.headers
    if (this.tab === 'message') {
      const ids = section('Identities')
      for (const id of a.identities) {
        const line = ids.createDiv('pm-headers-row')
        line.createSpan({ cls: 'pm-headers-label', text: id.label })
        // "not recorded" is an absence, and it should not read like a value.
        line.createSpan({
          cls: id.value === 'not recorded' ? 'pm-headers-value pm-headers-absent' : 'pm-headers-value',
          text: id.value
        })
      }

      const auth = section('Authentication')
      if (a.auth.length) {
        for (const r of a.auth) {
          const line = auth.createDiv('pm-headers-row')
          line.createSpan({ cls: 'pm-headers-label', text: r.mechanism.toUpperCase() })
          // The word the header states, coloured as what it states. A faithful
          // rendering of a stated result, not a judgement on the mail.
          line.createSpan({ cls: `pm-headers-result ${resultClass(r.result)}`, text: r.result })
          line.createSpan({ cls: 'pm-headers-detail', text: r.detail })
          line.createSpan({ cls: 'pm-headers-by', text: `asserted by ${r.assertedBy}` })
        }
      } else {
        auth.createDiv({ cls: 'pm-headers-empty', text: 'Not recorded.' })
      }

      const path = section('Path')
      if (a.hops.length) {
        for (const hop of a.hops) {
          const line = path.createDiv('pm-headers-row')
          line.createSpan({ cls: 'pm-headers-label pm-headers-hop', text: String(hop.n) })
          line.createSpan({ cls: 'pm-headers-value', text: `from ${hop.from} by ${hop.by} with ${hop.via}` })
          if (!hop.at) {
            line.createSpan({ cls: 'pm-headers-absent', text: 'no time recorded' })
          } else if (hop.delaySec !== null && hop.delaySec < 0) {
            line.createSpan({
              cls: 'pm-headers-result pm-headers-warn',
              text: `${hop.at} ${formatDelay(hop.delaySec)}`
            })
          } else {
            line.createSpan({
              cls: 'pm-headers-result',
              text: hop.delaySec === null ? hop.at : `${hop.at} (+${hop.delaySec}s)`
            })
          }
        }
      } else {
        path.createDiv({ cls: 'pm-headers-empty', text: 'Not recorded.' })
      }

      const obs = section('Observations')
      if (a.observations.length) {
        for (const o of a.observations) {
          // Coloured from the comparison's own outcome, not from its wording.
          obs.createDiv({ cls: o.aligned ? 'pm-headers-ok' : 'pm-headers-warn', text: o.text })
        }
      } else {
        obs.createDiv({ cls: 'pm-headers-empty', text: 'Nothing to compare.' })
      }

      if (report.senderFacts.length) {
        const sender = section('Sender domain')
        for (const fact of report.senderFacts) sender.createDiv({ cls: 'pm-headers-flag', text: fact })
      }
      return
    }

    if (this.tab === 'links') {
      const links = section('Links')
      if (!report.links.length) {
        links.createDiv({ cls: 'pm-headers-empty', text: 'None found.' })
        return
      }
      for (const link of report.links) {
        const line = links.createDiv('pm-headers-link')
        // Defanged and inert: this is a phishing link and it is never clickable.
        line.createDiv({ cls: 'pm-headers-ioc', text: link.target.replace(/\./g, '[.]') })
        if (link.wrappedBy) line.createDiv({ cls: 'pm-headers-note', text: `unwrapped from ${link.wrappedBy}` })
        for (const flag of link.flags) line.createDiv({ cls: 'pm-headers-flag', text: flag })
      }
      if (report.droppedLinks > 0) {
        links.createDiv({
          cls: 'pm-headers-note',
          text: `${report.droppedLinks} further links are in this message and are not listed.`
        })
      }
      return
    }

    if (this.tab === 'attachments') {
      this.renderAttachments(section('Attachments'))
      return
    }

    if (this.tab === 'body') {
      const showBody = (title: string, value: string): void => {
        const trimmed = value.trim()
        const body = section(title)
        if (!trimmed) {
          body.createDiv({ cls: 'pm-headers-empty', text: 'Not recorded.' })
          return
        }
        body.createEl('pre', { cls: 'pm-headers-pre', text: trimmed.slice(0, BODY_PREVIEW) })
        if (trimmed.length > BODY_PREVIEW) {
          body.createDiv({
            cls: 'pm-headers-note',
            text: `Showing the first ${BODY_PREVIEW.toLocaleString()} of ${trimmed.length.toLocaleString()} characters. The copied report carries the rest.`
          })
        }
      }
      showBody('Plain text', report.text)
      showBody('HTML source — read, never rendered', report.htmlSource)
      return
    }

    const iocs = section('Indicators')
    if (report.indicators.length) {
      for (const i of report.indicators) iocs.createDiv({ cls: 'pm-headers-ioc', text: i })
    } else {
      iocs.createDiv({ cls: 'pm-headers-empty', text: 'None found.' })
    }
    const notes = [...a.notes, ...report.notes]
    if (notes.length) {
      const el = section('Not in this paste')
      for (const n of notes) el.createDiv({ cls: 'pm-headers-note', text: n })
    }
  }

  /**
   * Each attachment, with what it is and — where it is safe — what it looks like.
   *
   * A raster image is drawn from its own bytes as a data URL, which reaches
   * nothing and runs nothing. Everything else is read: SVG and HTML are shown
   * as source because they are documents a browser would execute, and anything
   * else falls back to its header bytes, which is where the answer usually is.
   */
  private renderAttachments(host: HTMLElement): void {
    const report = this.report
    if (!report) return
    if (!report.attachments.length) {
      host.createDiv({ cls: 'pm-headers-empty', text: 'None.' })
      return
    }
    for (const attachment of report.attachments) {
      const card = host.createDiv('pm-att-card')
      card.createDiv({ cls: 'pm-att-name', text: attachment.filename })
      card.createDiv({
        cls: 'pm-headers-note',
        text: `${attachment.contentType} · ${attachment.sha256 ? `${attachment.size.toLocaleString()} bytes` : 'size not recorded'}`
      })
      if (attachment.sha256) {
        card.createDiv({ cls: 'pm-headers-ioc', text: `SHA-256 ${attachment.sha256}` })
        card.createDiv({ cls: 'pm-headers-ioc', text: `SHA-1   ${attachment.sha1}` })
        card.createDiv({ cls: 'pm-headers-note', text: 'hashes computed here, from the bytes in the file' })
      } else {
        card.createDiv({ cls: 'pm-headers-note', text: 'hashes not recorded — this part could not be decoded' })
      }
      if (attachment.sniffed) card.createDiv({ cls: 'pm-headers-note', text: `bytes begin as ${attachment.sniffed}` })
      for (const fact of attachment.facts) card.createDiv({ cls: 'pm-headers-flag', text: fact })
      for (const found of attachment.inside) {
        card.createDiv({ cls: 'pm-headers-flag', text: `found inside the file: ${found}` })
      }
      this.renderPreview(card, attachment)
    }
  }

  private renderPreview(card: HTMLElement, attachment: PhishReport['attachments'][number]): void {
    if (!attachment.bytes.length) return
    const kind = previewKind(attachment.contentType, attachment.filename, attachment.sniffed, attachment.bytes)
    if (kind === 'image') {
      const url = imageDataUrl(attachment.bytes, attachment.sniffed)
      if (!url) {
        card.createDiv({
          cls: 'pm-headers-note',
          text: `Image is larger than ${(IMAGE_CAP / 1_000_000).toFixed(0)}MB, so it is not drawn here.`
        })
        return
      }
      card.createEl('img', {
        cls: 'pm-att-image',
        attr: { src: url, alt: `Attachment ${attachment.filename}` }
      })
      // Said out loud, because "nothing is rendered" is this screen's promise
      // and an image on it looks like an exception to that promise.
      card.createDiv({
        cls: 'pm-headers-note',
        text: 'Drawn from the bytes in the file. Its own bytes say it is a raster image, so there is nothing in it to fetch or run.'
      })
      return
    }
    if (kind === 'text') {
      const { text, truncated } = previewText(attachment.bytes)
      card.createEl('pre', { cls: 'pm-headers-pre', text })
      card.createDiv({
        cls: 'pm-headers-note',
        text: truncated ? 'Read as text, never rendered. Cut at 20,000 characters.' : 'Read as text, never rendered.'
      })
      return
    }
    card.createEl('pre', { cls: 'pm-headers-pre pm-att-hex', text: hexDump(attachment.bytes) })
    card.createDiv({
      cls: 'pm-headers-note',
      text: `First ${Math.min(attachment.bytes.length, 512)} bytes. Nothing here is executed or opened.`
    })
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

/** The stated result word, mapped to how it reads. Nothing is inferred. */
function resultClass(result: string): string {
  if (result === 'pass') return 'pm-headers-ok'
  if (['fail', 'softfail', 'permerror', 'temperror', 'reject', 'quarantine'].includes(result)) {
    return 'pm-headers-warn'
  }
  return 'pm-headers-neutral'
}

export function openPhishAnalysis(plugin: PMPlugin): void {
  new PhishAnalysisModal(plugin).open()
}
