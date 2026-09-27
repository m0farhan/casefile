import { ButtonComponent, ItemView, Notice, SuggestModal, type TFile, type WorkspaceLeaf, setTooltip } from 'obsidian'
import type PMPlugin from '../main'
import { formatDelay } from '../soc/emailHeaders'
import { IMAGE_CAP, hexDump, imageDataUrl, previewKind, previewText } from '../soc/preview'
import {
  type EmbeddedImage,
  type PhishReport,
  STRUCTURE_LIST_CAP,
  analysePhishing,
  caseIocs,
  entriesRead,
  flaggedEntries,
  flaggedOleEntries,
  formatPhishReport,
  innerFileFacts,
  isPicture,
  linksSection,
  relationshipType,
  showsDerivedDomain
} from '../soc/phish'
import { defangIoc, visibleName } from '../soc/ioc'
import { openProjectPicker, openTaskModal } from '../ui/ModalFactory'
import { makeTask } from '../types'
import { TaskFileNameConflictError } from '../store/ProjectStore'
import { BOARD_REFUSAL, TITLE_REFUSAL } from '../modals/TaskModal'
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

/**
 * One formatter for every count on screen. `toLocaleString()` builds a new one
 * per call in Chromium, and a ZIP directory listing makes tens of thousands of
 * those calls: 81,920 of them took about 450 ms. The output is the same.
 */
const NUMBER = new Intl.NumberFormat()

type TabId = 'message' | 'links' | 'attachments' | 'body' | 'indicators'

export const PHISH_VIEW_TYPE = 'casefile-phish-analysis'

/**
 * A tab, not a dialog. It began as a modal, and a modal is the wrong shape for
 * the work: it covers the board, it caps the report at a fraction of the
 * screen, and it has to close before the case it produced can be looked at.
 * As a workspace view it takes the whole pane, sits beside the case it feeds,
 * and two of them can be open at once to compare one message with another.
 */
export class PhishAnalysisView extends ItemView {
  private report: PhishReport | null = null
  private raw = ''
  /**
   * A message read from a file or from an attachment, analysed from here and
   * not put in the paste box. The box lays out every line it holds, so a 10 MB
   * .eml cost over a second there before the analysis began, and again on each
   * keystroke. Typing or Reset drops it and the box is the message again.
   */
  private loaded: string | null = null
  /** Monotonic: a slow run must never overwrite the result of a newer one. */
  private runId = 0
  private debounce: number | null = null
  private tab: TabId = 'message'
  private tabStrip: HTMLElement | null = null
  private input: HTMLTextAreaElement | null = null
  /** Says which file is being analysed while the paste box is empty. */
  private loadNote: HTMLElement | null = null
  private refresh: (() => void) | null = null

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: PMPlugin
  ) {
    super(leaf)
  }

  getViewType(): string {
    return PHISH_VIEW_TYPE
  }

  /**
   * Titled from the subject once there is one: every analyser tab used to be
   * "Phishing analysis", so two open side by side could not be told apart.
   */
  getDisplayText(): string {
    const subject = this.report ? subjectOf(this.report) : ''
    return subject ? `Phish: ${tabTitle(subject)}` : 'Phishing analysis'
  }

  getIcon(): string {
    return 'fish'
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this
    contentEl.empty()
    // pm-root carries the design tokens. As a modal the analyser got them from
    // `.pm-modal`; as a view without this, every colour in it is undefined and
    // the bands, the observations and the auth results all render flat.
    contentEl.addClass('pm-root', 'pm-headers', 'pm-phish-view')
    contentEl.createEl('h2', { cls: 'pm-phish-view-title', text: 'Analyse a phishing email' })
    contentEl.createEl('p', {
      cls: 'pm-headers-meta',
      text: 'Paste the headers or the whole message, or load a .eml from the vault. Nothing is rendered, resolved or sent — every line below is read from what you gave it.'
    })

    const input = contentEl.createEl('textarea', {
      cls: 'pm-headers-input',
      attr: { placeholder: 'Received: from …', rows: '5', spellcheck: 'false' }
    })
    const loadNote = contentEl.createDiv('pm-headers-note pm-phish-loaded')
    // Outside the scroll box: the strip that switches panes must stay put, or
    // it scrolls off the top of a long pane and the only way back is to scroll
    // up through the thing you were trying to leave.
    this.tabStrip = contentEl.createDiv('pm-headers-tabs')
    const out = contentEl.createDiv('pm-headers-out')
    const row = contentEl.createDiv('pm-modal-btn-row')

    const resetBtn = new ButtonComponent(row).setButtonText('Reset').setDisabled(true)
    setTooltip(resetBtn.buttonEl, 'Clear the message and its analysis to start another')
    const loadBtn = new ButtonComponent(row).setButtonText('Load .eml')
    setTooltip(loadBtn.buttonEl, 'Read a .eml file already in this vault')
    const copyBtn = new ButtonComponent(row).setButtonText('Copy report').setDisabled(true)
    const iocBtn = new ButtonComponent(row).setButtonText('Copy indicators').setDisabled(true)
    const caseBtn = new ButtonComponent(row).setButtonText('Create case').setCta().setDisabled(true)
    // From the moment the message changes until its analysis lands, the report
    // on screen is the previous message's. These three act on that report, so
    // they wait: a case filed in that window was the old mail under the new
    // one's name.
    const stale = (): void => {
      copyBtn.setDisabled(true)
      iocBtn.setDisabled(true)
      caseBtn.setDisabled(true)
    }

    const refresh = safeAsync(async () => {
      const run = ++this.runId
      stale()
      const raw = this.loaded ?? input.value
      const report = raw.trim()
        ? await analysePhishing(raw, this.plugin.settings.ownedAssets, this.plugin.settings.phishBrands)
        : null
      // A newer keystroke already started: drop this result on the floor
      // rather than painting a stale message over the current one.
      if (run !== this.runId) return
      this.raw = raw
      this.report = report
      resetBtn.setDisabled(!raw)
      copyBtn.setDisabled(!report)
      caseBtn.setDisabled(!report)
      iocBtn.setDisabled(!report?.indicators.length)
      this.render(out)
      // Re-reads getDisplayText, so the tab takes the new subject — or goes
      // back to "Phishing analysis" after Reset. obsidian.d.ts does not declare
      // updateHeader, so it is looked for rather than assumed: on a build
      // without it the tab keeps the title it had instead of the call throwing.
      ;(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.()
      // updateHeader renames only the tab. The title inside the pane is set
      // once, when the view loads, so it is set again here; on a phone it is
      // the only title shown. Looked for, as above, because the typings do not
      // declare it on a view.
      ;(this as unknown as { titleEl?: HTMLElement }).titleEl?.setText(this.getDisplayText())
    })
    this.input = input
    this.loadNote = loadNote
    this.refresh = refresh

    // Debounced: the full parse hashes every attachment, and running it on
    // each keystroke of a pasted 4MB message locks the UI thread.
    input.addEventListener('input', () => {
      stale()
      // Typing replaces a loaded message: the box is the message again.
      this.loaded = null
      loadNote.setText('')
      if (this.debounce !== null) window.clearTimeout(this.debounce)
      this.debounce = window.setTimeout(refresh, 300)
    })
    // Nothing here was ever saved — the source .eml, if there was one, is
    // untouched in the vault — so there is nothing to confirm.
    resetBtn.onClick(() => {
      if (this.debounce !== null) window.clearTimeout(this.debounce)
      this.debounce = null
      this.tab = 'message'
      this.loaded = null
      loadNote.setText('')
      input.value = ''
      refresh()
      input.focus()
    })
    loadBtn.onClick(
      safeAsync(async () => {
        const files = this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === 'eml')
        if (!files.length) {
          new Notice('No .eml files in this vault.')
          return
        }
        // safeAsync, not a bare promise: a file moved while the picker was open
        // fails the read, and that must say so rather than do nothing.
        openEmlPicker(
          this.plugin,
          files,
          safeAsync(async (file) => {
            const text = await this.app.vault.cachedRead(file)
            this.analyse(text, `${visibleName(file.name)} (${NUMBER.format(file.stat.size)} bytes)`)
          })
        )
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
        // Escaped as the tab draws them: a soft hyphen in a host is invisible,
        // and a block list pasted from the clipboard then never matches.
        const lines = (this.report?.indicators ?? []).map(visibleName)
        if (!lines.length) return
        await navigator.clipboard.writeText(lines.join('\n'))
        new Notice(`Copied ${lines.length} indicator${lines.length === 1 ? '' : 's'}`)
      })
    )
    caseBtn.onClick(safeAsync(async () => this.createCase()))
    input.focus()
  }

  /**
   * Analyse a whole message read from elsewhere — a .eml in the vault, or a
   * message attached to another — named by `source` in the line under the
   * paste box. The box is left empty (see `loaded`), and the text is never cut
   * to fit it: an excerpt the tool cut itself would hash a truncated
   * attachment as if it were the file.
   */
  analyse(text: string, source: string): void {
    if (!this.input || !this.loadNote || !this.refresh) return
    if (this.debounce !== null) window.clearTimeout(this.debounce)
    this.debounce = null
    this.loaded = text
    this.input.value = ''
    this.loadNote.setText(`Loaded ${source}. Analysed in full; not shown here.`)
    this.refresh()
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
    // Read once, here. A new analysis can land while the board picker is open,
    // and a case whose title came from one message and whose description came
    // from the next describes neither.
    const report = this.report
    const raw = this.raw
    if (!report) return
    const projects = await this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder)
    if (!projects.length) {
      new Notice('No boards yet. Create a board first.')
      return
    }
    // The sender wrote the subject, so it is escaped as the tab title is.
    const title = visibleName(subjectOf(report)) || 'Reported phishing email'
    // Built from the PARSED message by the same code as the Indicators tab,
    // so a lure a structure reader found inside a PDF is on the case too.
    const iocs = caseIocs(report, raw)
    // safeAsync, not a bare promise: the caller's own guard has returned by
    // the time a board is picked, so anything thrown here was never seen.
    openProjectPicker(
      this.plugin,
      projects,
      safeAsync(async (project) => {
        const config = this.plugin.store.configFor(project)
        const task = makeTask({
          // Cut by UTF-16 unit, then a half emoji dropped: the note keeps the
          // title as written, so half a surrogate would be saved as U+FFFD.
          // Not Array.from, which would walk a subject that can be megabytes.
          title: title.slice(0, 120).replace(/[\uD800-\uDBFF]$/, ''),
          issueType: 'incident',
          status: getDefaultStatusId(config.statuses),
          priority: getDefaultPriorityId(config.priorities),
          tags: ['phishing'],
          assignees: this.plugin.settings.currentUser ? [this.plugin.settings.currentUser] : [],
          description: formatPhishReport(report),
          iocs
        })
        try {
          await this.plugin.store.insertTask(project, task)
        } catch (err) {
          // Two mails can share a subject, and a subject IS the title here, so
          // this is the ordinary case rather than the exotic one. It used to
          // throw past the caller, leaving the modal open with no explanation
          // and the board's in-memory copy holding a case that was never saved.
          if (err instanceof TaskFileNameConflictError) {
            new Notice(`Case not created: a note named "${err.fileName}" already exists.`)
            return
          }
          // The store's own refusals say why (see TaskModal): a subject of only
          // dots has no character a file name can keep.
          if (
            err instanceof Error &&
            (err.message.startsWith(TITLE_REFUSAL) || err.message.startsWith(BOARD_REFUSAL))
          ) {
            new Notice(`Case not created. ${err.message}`)
            return
          }
          throw err
        }
        // The analysis stays open. A modal had to close to show the case; a tab
        // is exactly where the evidence should sit while the case is written.
        openTaskModal(this.plugin, project, { task, onSave: () => {} })
      })
    )
  }

  /**
   * One pane at a time, because a phishing analysis is five different
   * questions and answering them in one scroll means the analyst reads the
   * first and scrolls past the rest.
   */
  private render(out: HTMLElement): void {
    out.empty()
    const report = this.report
    if (!report) {
      // The strip lives outside `out`, so emptying `out` alone left the last
      // message's tab counts sitting over an empty pane.
      this.tabStrip?.empty()
      return
    }

    const tabs: { id: TabId; label: string }[] = [
      { id: 'message', label: 'Message' },
      { id: 'links', label: `Links (${report.links.length})` },
      {
        id: 'attachments',
        label: `Attachments (${report.attachments.length}${report.inlineImages.length ? `, ${report.inlineImages.length} inline` : ''})`
      },
      { id: 'body', label: 'Body' },
      { id: 'indicators', label: `Indicators (${report.indicators.length})` }
    ]
    const strip = this.tabStrip ?? out.createDiv('pm-headers-tabs')
    strip.empty()
    const panel = out.createDiv('pm-headers-panel')
    for (const tab of tabs) {
      const on = this.tab === tab.id
      // aria-pressed says which pane is showing; the underline alone said it
      // only to someone who can see it.
      const button = strip.createEl('button', {
        cls: 'pm-headers-tab',
        text: tab.label,
        attr: { 'aria-pressed': String(on) }
      })
      button.toggleClass('is-on', on)
      button.addEventListener('click', () => {
        this.tab = tab.id
        this.render(out)
        // The strip was rebuilt, so the button that had focus is gone and focus
        // fell to the page. Hand it to the new one, or a keyboard user starts
        // the strip again after every switch.
        strip.querySelector<HTMLElement>('.pm-headers-tab.is-on')?.focus()
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
    // Everything on this tab quotes the sender's headers, so it is shown
    // through visibleName, as attachment names are: a right-to-left override in
    // the From domain reversed the tool's own sentence around it, and made
    // "moc.lapyap" read as paypal.com. The parsed values stay raw; only what
    // is drawn is escaped.
    if (this.tab === 'message') {
      const ids = section('Identities')
      for (const id of a.identities) {
        const line = ids.createDiv('pm-headers-row')
        line.createSpan({ cls: 'pm-headers-label', text: id.label })
        // "not recorded" is an absence, and it should not read like a value.
        line.createSpan({
          cls: id.value === 'not recorded' ? 'pm-headers-value pm-headers-absent' : 'pm-headers-value',
          text: visibleName(id.value)
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
          line.createSpan({ cls: 'pm-headers-detail', text: visibleName(r.detail) })
          // The parser's own words for a missing host read as a host after
          // "asserted by". A host a header names is one token and cannot hold
          // this phrase, so matching it never swallows a real one.
          const by = r.assertedBy.includes('no asserting host stated') ? '' : 'asserted by '
          line.createSpan({ cls: 'pm-headers-by', text: `${by}${visibleName(r.assertedBy)}` })
        }
      } else {
        auth.createDiv({ cls: 'pm-headers-empty', text: 'Not recorded.' })
      }

      const path = section('Path')
      if (a.hops.length) {
        for (const hop of a.hops) {
          const line = path.createDiv('pm-headers-row')
          line.createSpan({ cls: 'pm-headers-label pm-headers-hop', text: String(hop.n) })
          line.createSpan({
            cls: 'pm-headers-value',
            text: visibleName(`from ${hop.from} by ${hop.by} with ${hop.via}`)
          })
          if (!hop.at) {
            line.createSpan({ cls: 'pm-headers-absent', text: 'no time recorded' })
          } else if (hop.delaySec !== null && hop.delaySec < 0) {
            // The stamp keeps its own unbreakable span; the sentence after it
            // wraps. As one unbreakable span the sentence was 650px wide and
            // squeezed the hop beside it to a column of single letters — on
            // the one hop this tab marks as possibly forged.
            line.createSpan({ cls: 'pm-headers-result pm-headers-warn', text: hop.at })
            line.createSpan({ cls: 'pm-hop-delay', text: formatDelay(hop.delaySec).trim() })
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
          obs.createDiv({ cls: `pm-obs ${o.aligned ? 'pm-obs--match' : 'pm-obs--differ'}`, text: visibleName(o.text) })
        }
      } else {
        obs.createDiv({ cls: 'pm-headers-empty', text: 'Nothing to compare.' })
      }

      if (report.senderFacts.length) {
        const sender = section('Sender domain')
        for (const fact of report.senderFacts) sender.createDiv({ cls: 'pm-headers-flag', text: visibleName(fact) })
      }
      return
    }

    if (this.tab === 'links') {
      // The heading, the empty text and the notes are the report's own, from
      // one helper, so the tab and the copied report cannot drift apart.
      const words = linksSection(report)
      const links = section(words.heading)
      if (!report.links.length) links.createDiv({ cls: 'pm-headers-empty', text: words.none })
      for (const link of report.links) {
        const line = links.createDiv('pm-headers-link')
        // Defanged and inert: this is a phishing link and it is never clickable.
        // The same defang as the report and the Indicators tab — bracketing only
        // the dots left `http` live and the colon on any other scheme, so a
        // link copied off this pane was not the inert string the report gives.
        line.createDiv({ cls: 'pm-headers-ioc', text: visibleName(defangIoc(link.target, 'url')) })
        // A link in an attached message says so, or the phisher's link reads
        // as one the reporter sent.
        if (link.origin) line.createDiv({ cls: 'pm-headers-note', text: `in the body of ${visibleName(link.origin)}` })
        if (showsDerivedDomain(link)) {
          line.createDiv({
            cls: 'pm-headers-note',
            text: `derived domain ${visibleName(defangIoc(link.apexDomain, 'domain'))}`
          })
        }
        if (link.wrappedBy) line.createDiv({ cls: 'pm-headers-note', text: `unwrapped from ${link.wrappedBy}` })
        // A flag can quote the host as written, before the URL parser cleaned it.
        for (const flag of link.flags) line.createDiv({ cls: 'pm-headers-flag', text: visibleName(flag) })
      }
      if (report.droppedLinks > 0) {
        links.createDiv({
          cls: 'pm-headers-note',
          text: `${report.droppedLinks} further links are in this message and are not listed.`
        })
      }
      for (const note of words.notes) links.createDiv({ cls: 'pm-headers-note', text: note })
      return
    }

    if (this.tab === 'attachments') {
      this.renderAttachments(section('Attachments'), report.attachments)
      // Apart from the real attachments: a signature logo among four files
      // makes the mail read as heavier than it is. Only drawable pictures land
      // here; a PDF sent inline is an attachment, so "inline" in the tab label
      // always means an image. Nothing checks that the body uses them, so the
      // heading says only what their own headers say.
      if (report.inlineImages.length) {
        this.renderAttachments(
          section('Inline images — marked inline or given a Content-ID by their own headers'),
          report.inlineImages
        )
      }
      return
    }

    if (this.tab === 'body') {
      const showText = (host: HTMLElement, trimmed: string): void => {
        host.createEl('pre', { cls: 'pm-headers-pre', text: trimmed.slice(0, BODY_PREVIEW) })
        if (trimmed.length > BODY_PREVIEW) {
          host.createDiv({
            cls: 'pm-headers-note',
            text: `Showing the first ${NUMBER.format(BODY_PREVIEW)} of ${NUMBER.format(trimmed.length)} characters here. The copied report and the case carry all of it.`
          })
        }
      }
      // Most readable first: on an HTML-only mail the first section is empty
      // and the lure used to be somewhere inside several kilobytes of markup,
      // past the preview cut.
      const blocks = (b: { text: string; htmlText: string; htmlSource: string }): [string, string][] => [
        ['Plain text', b.text.trim()],
        ['Text extracted from the HTML — not rendered', b.htmlText.trim()],
        ['HTML source — read, never rendered', b.htmlSource.trim()]
      ]
      for (const [title, trimmed] of blocks(report)) {
        const body = section(title)
        if (trimmed) showText(body, trimmed)
        else body.createDiv({ cls: 'pm-headers-empty', text: 'Not recorded.' })
      }
      // An attached message's text is its own block under its own name, as in
      // the report: joined to the outer text, the phisher's sentence read as
      // the reporter's. The name is the sender's, so it sits in a span that
      // keeps its case — the band's capitals would turn a ß into SS.
      for (const f of report.forwarded) {
        const heading = panel.createEl('h4', {
          cls: 'pm-headers-h pm-headers-h--named',
          text: 'Text of the attached message '
        })
        heading.createSpan({ cls: 'pm-headers-h-name', text: visibleName(f.origin) })
        const body = panel.createDiv('pm-headers-body')
        const present = blocks(f).filter(([, trimmed]) => trimmed)
        if (!present.length) body.createDiv({ cls: 'pm-headers-empty', text: 'Not recorded.' })
        for (const [title, trimmed] of present) {
          body.createDiv({ cls: 'pm-headers-sub', text: title })
          showText(body, trimmed)
        }
      }
      return
    }

    // Escaped as the Links tab escapes the same values: a soft hyphen in a host
    // is invisible, and a block list copied off this pane then never matches.
    const iocs = section('Indicators')
    if (report.indicators.length) {
      for (const i of report.indicators) iocs.createDiv({ cls: 'pm-headers-ioc', text: visibleName(i) })
    } else {
      iocs.createDiv({ cls: 'pm-headers-empty', text: 'None found.' })
    }
    // Two headings, as the copied report has. The header notes say what the
    // paste lacks; the parser notes describe parts that ARE in it — a part
    // that would not decode, a charset that may be mangled — and under "Not in
    // this paste" they said the opposite. Parser notes can quote a part's name.
    const notes = (title: string, list: string[]): void => {
      if (!list.length) return
      const el = section(title)
      for (const n of list) el.createDiv({ cls: 'pm-headers-note', text: visibleName(n) })
    }
    notes('Not in this paste', a.notes)
    notes('Parser notes', report.notes)
  }

  /**
   * Each attachment, with what it is and — where it is safe — what it looks like.
   *
   * The card reads top down in the order the questions come: what it is (its
   * declared type beside what its bytes begin as), what is odd about it, the
   * hashes to look it up by, what was found inside it, and last whatever the
   * readers drew or listed — which can run to screens.
   *
   * A raster image is drawn from its own bytes as a data URL, which reaches
   * nothing and runs nothing. Everything else is read: SVG and HTML are shown
   * as source because they are documents a browser would execute, and anything
   * else falls back to its header bytes, which is where the answer usually is.
   */
  private renderAttachments(host: HTMLElement, list: PhishReport['attachments']): void {
    if (!list.length) {
      host.createDiv({ cls: 'pm-headers-empty', text: 'None.' })
      return
    }
    // Capped as the rows inside a card are: a mail of 20,000 tiny parts drew
    // 20,000 cards on every click of this tab.
    capped(host, list, (at, attachment) => {
      const card = at.createDiv('pm-att-card')
      card.createDiv({ cls: 'pm-att-name', text: visibleName(attachment.filename) })
      // Found inside an attached message: said first, or the phisher's payload
      // reads as something the reporter sent.
      if (attachment.origin) {
        card.createDiv({ cls: 'pm-headers-note', text: `inside ${visibleName(attachment.origin)}` })
      }
      // An undecoded part has no size and no first bytes, and its own fact says
      // why, so the line shows neither rather than a "0 bytes" it never had.
      const begins = attachment.sniffed ? ` · bytes begin as ${attachment.sniffed}` : ''
      const size = attachment.sha256 ? `${NUMBER.format(attachment.size)} bytes` : 'size not recorded'
      card.createDiv({ cls: 'pm-headers-note', text: `${visibleName(attachment.contentType)}${begins} · ${size}` })
      if (isMessage(attachment)) {
        // The forwarded message's own headers — its Received chain, its
        // authentication results — are only analysed as headers in a tab of
        // their own. Nothing is fetched: the bytes are already in memory.
        const open = new ButtonComponent(card)
          .setButtonText('Analyse this message in a new tab')
          .setClass('pm-att-open')
          .onClick(() =>
            openPhishAnalysis(this.plugin, {
              text: new TextDecoder().decode(attachment.bytes),
              source: `${visibleName(attachment.filename) || 'an attached message'} (${NUMBER.format(attachment.bytes.length)} bytes)`
            })
          )
        setTooltip(
          open.buttonEl,
          'Open the attached message in its own analyser tab: its own headers, path, links and attachments. Nothing is fetched.'
        )
      }
      // Facts can quote the sender's own words (a declared type), so they are
      // escaped as names are.
      for (const fact of attachment.facts) card.createDiv({ cls: 'pm-headers-flag', text: visibleName(fact) })
      if (attachment.sha256) {
        hashRow(card, 'SHA-256', attachment.sha256)
        hashRow(card, 'SHA-1', attachment.sha1)
        hashRow(card, 'MD5', attachment.md5)
        // Not "from the bytes in the file": a 7bit, 8bit or hard-broken
        // quoted-printable part's bytes were rebuilt here from its text, and
        // its facts above say so.
        card.createDiv({ cls: 'pm-headers-note', text: 'hashes computed here' })
      }
      // After the hashes: this list can hold a hundred lines, and it must never
      // push the hashes off the screen.
      cappedRows(
        card,
        attachment.inside.map((found) => ({
          cls: 'pm-headers-flag',
          text: `found inside the file: ${visibleName(found)}`
        }))
      )
      if (!this.renderStructure(card, attachment)) this.renderPreview(card, attachment)
    })
  }

  /**
   * What the PDF, ZIP or compound-file reader found, in the order the copied
   * report prints it: what the reader found — names, links, flagged entries,
   * external targets, the files inside — then the pictures the document shows
   * the victim, then the reader's own notes. The pictures used to come first,
   * and at up to 60vh each they pushed /OpenAction and the remote template
   * below the fold. False when no reader ran, so the caller falls back to the
   * plain preview.
   *
   * Every name here was written by the sender and is shown through
   * visibleName, so a right-to-left override cannot reverse the sentence
   * around it and a newline cannot draw a row for an entry that does not exist.
   */
  private renderStructure(card: HTMLElement, attachment: PhishReport['attachments'][number]): boolean {
    const { pdf, office, ole } = attachment
    if (!pdf && !office && !ole) return false
    const box = card.createDiv('pm-att-structure')
    if (pdf) {
      // The report's words. /Encrypt is a name the scan matched in the bytes,
      // not a resolved fact about the file; the reader's note below says what
      // it may hide.
      box.createDiv({
        cls: 'pm-headers-note',
        text: `PDF ${pdf.version || 'version not recorded'}${pdf.encrypted ? ' · /Encrypt present' : ''}`
      })
      if (pdf.markers.length) {
        box.createDiv({
          cls: 'pm-headers-flag',
          text: `Names found: ${pdf.markers.map((m) => `${m.name} ×${m.count}`).join(', ')}`
        })
      }
      cappedRows(
        box,
        pdf.uris.map((uri) => ({ cls: 'pm-headers-ioc', text: `link (/URI) ${visibleName(defangIoc(uri, 'url'))}` }))
      )
    }
    if (office) {
      entryList(
        box,
        entriesRead(office.entries.length),
        office.entries.length,
        // Encryption sits with the method, before the name: the sender's text
        // always ends the row, so nothing it writes can pass for a column.
        () =>
          office.entries.map(
            (e) => `${sizeText(e.size)}\t${e.method}${e.encrypted ? ', encrypted' : ''}\t${visibleName(e.name)}`
          )
      )
      cappedRows(
        box,
        flaggedEntries(office).map((f) => ({
          cls: 'pm-headers-flag',
          text: `${visibleName(f.name)} — ${f.why.join('; ')}`
        }))
      )
      cappedRows(
        box,
        office.externalTargets.map((t) => ({
          cls: 'pm-headers-flag',
          text: `External target ${visibleName(defangIoc(t.target, 'url'))} — ${visibleName(relationshipType(t.type))}, declared in ${visibleName(t.from)}`
        }))
      )
      // Flagged only where the bytes disagree with the name; a plain hash is a note.
      cappedRows(
        box,
        office.files.map((f) => ({
          cls: f.mismatch ? 'pm-headers-flag' : 'pm-headers-note',
          text: `${visibleName(f.name)} — ${innerFileFacts(f)}`
        }))
      )
    }
    if (ole) {
      entryList(box, entriesRead(ole.entries.length, 'the compound-file directory'), ole.entries.length, () =>
        ole.entries.map((e) => `${sizeText(e.size)}\t${e.type}\t${visibleName(e.name)}`)
      )
      cappedRows(
        box,
        flaggedOleEntries(ole).map((f) => ({
          cls: 'pm-headers-flag',
          text: `${visibleName(f.name)} (${f.type}) — ${f.why.join('; ')}`
        }))
      )
    }
    // Never for the compound-file reader: it lists names and opens no stream,
    // so it has no pictures to draw — and no line saying it found none.
    for (const image of pdf?.images ?? office?.images ?? []) this.renderEmbedded(box, image)
    // A reader's note can name an entry, so it is escaped as a name is.
    for (const note of [...(pdf?.notes ?? []), ...(office?.notes ?? []), ...(ole?.notes ?? [])]) {
      box.createDiv({ cls: 'pm-headers-note', text: visibleName(note) })
    }
    return true
  }

  /**
   * One picture from inside a document — drawn only when its own bytes say it
   * is a raster image. A /DCTDecode stream whose bytes are a program is called
   * a stream, by the rule the report uses, so the two cannot disagree.
   */
  private renderEmbedded(host: HTMLElement, image: EmbeddedImage): void {
    const where = visibleName(image.where)
    host.createDiv({
      cls: 'pm-headers-note',
      text: `${isPicture(image.sniffed) ? 'Picture' : 'Stream'} at ${where} · ${NUMBER.format(image.bytes.length)} bytes`
    })
    hashRow(host, 'SHA-256', image.sha256)
    const url =
      previewKind('', '', image.sniffed, image.bytes) === 'image' ? imageDataUrl(image.bytes, image.sniffed) : null
    if (url) {
      host.createEl('img', { cls: 'pm-att-image', attr: { src: url, alt: `Picture at ${where}` } })
      return
    }
    host.createDiv({
      cls: 'pm-headers-note',
      text: `Not drawn: its bytes begin as ${image.sniffed || 'nothing this recognises'}${image.bytes.length > IMAGE_CAP ? ', and it is over the size limit' : ''}.`
    })
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
        attr: { src: url, alt: `Attachment ${visibleName(attachment.filename)}` }
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

  async onClose(): Promise<void> {
    // Cancel the pending parse and retire the run token: a debounce that fires
    // after close would analyse into a DOM that no longer exists, and a run
    // already in flight must not paint its result on the way out.
    if (this.debounce !== null) window.clearTimeout(this.debounce)
    this.debounce = null
    this.runId++
    this.tabStrip = null
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
    // Escaped as the load note escapes it: a mail client saves a message under
    // its Subject, so the sender can write this name. Filtering keeps the raw path.
    content.createDiv({ cls: 'suggestion-title', text: visibleName(file.name) })
    content.createDiv({ cls: 'suggestion-note', text: visibleName(file.parent?.path ?? '') })
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

/**
 * Open the analyser in a NEW tab every time. Reusing one tab would throw away
 * the message already in it, and comparing a reported mail with the one that
 * arrived an hour earlier is ordinary work, not an edge case.
 */
export function openPhishAnalysis(plugin: PMPlugin, message?: { text: string; source: string }): void {
  const leaf = plugin.app.workspace.getLeaf('tab')
  void (async () => {
    await leaf.setViewState({ type: PHISH_VIEW_TYPE, active: true })
    if (message && leaf.view instanceof PhishAnalysisView) leaf.view.analyse(message.text, message.source)
  })()
}

/** A forwarded message, by its declared type or its name — the button only re-analyses bytes already here. */
function isMessage(a: PhishReport['attachments'][number]): boolean {
  return a.bytes.length > 0 && (/^message\/rfc822$/i.test(a.contentType) || /\.eml$/i.test(a.filename))
}

/** The message's own Subject, or '' when it has none. */
function subjectOf(report: PhishReport): string {
  const subject = report.headers.identities.find((i) => i.label === 'Subject')?.value ?? ''
  return subject === 'not recorded' ? '' : subject
}

/**
 * A subject short enough for a tab: escaped, because the sender wrote it, and
 * cut by code point, because a phishing subject often opens with an emoji and
 * cutting by UTF-16 unit leaves half of one. Only the first 80 units are
 * looked at: they hold at least 40 code points, and a subject can be megabytes.
 */
function tabTitle(subject: string): string {
  const chars = Array.from(visibleName(subject.slice(0, 80)))
  return chars.length > 40 ? `${chars.slice(0, 39).join('')}…` : chars.join('')
}

/**
 * One hash per row, its label in a span that cannot be selected, so copying
 * the row — or double-clicking the value — takes the hash and not the word
 * in front of it.
 */
function hashRow(host: HTMLElement, label: string, value: string): void {
  const row = host.createDiv('pm-headers-ioc')
  row.createSpan({ cls: 'pm-att-hash-label', text: label })
  row.createSpan({ text: value })
}

/**
 * The first STRUCTURE_LIST_CAP items, and the rest behind a native disclosure.
 * Uncapped, a ZIP of two hundred encrypted programs was four hundred flagged
 * lines and put the next attachment twenty-six screens down. Nothing is
 * dropped: the rest is one click away, and is drawn on that click — built up
 * front, twenty ZIPs of 4,096 entries were 80,000 rows nobody had opened,
 * rebuilt on every click of a tab.
 */
function capped<T>(host: HTMLElement, items: T[], draw: (host: HTMLElement, item: T) => void): void {
  for (const item of items.slice(0, STRUCTURE_LIST_CAP)) draw(host, item)
  if (items.length <= STRUCTURE_LIST_CAP) return
  const more = host.createEl('details', { cls: 'pm-att-entries' })
  more.createEl('summary', { text: `${NUMBER.format(items.length - STRUCTURE_LIST_CAP)} more` })
  more.addEventListener('toggle', () => items.slice(STRUCTURE_LIST_CAP).forEach((item) => draw(more, item)), {
    once: true
  })
}

function cappedRows(host: HTMLElement, rows: { cls: string; text: string }[]): void {
  capped(host, rows, (at, row) => at.createDiv(row))
}

/**
 * A directory's listing behind a native disclosure, headed by how many entries
 * were READ from it — which is not how many it declares, when the listing
 * stopped early; the reader's own note says why. A .docx holds twenty ordinary
 * parts and they should not push the findings off screen. Nothing is drawn
 * when nothing was read, rather than an empty list that looks like an empty
 * archive. The listing is built when first opened, as capped's rows are.
 */
function entryList(host: HTMLElement, summary: string, count: number, rows: () => string[]): void {
  if (!count) return
  const all = host.createEl('details', { cls: 'pm-att-entries' })
  all.createEl('summary', { text: summary })
  all.addEventListener('toggle', () => all.createEl('pre', { cls: 'pm-headers-pre', text: rows().join('\n') }), {
    once: true
  })
}

/** A declared size, or the words for its absence — never a made-up number. */
function sizeText(size: number | null): string {
  return size === null ? 'size not recorded' : `${NUMBER.format(size)} bytes`
}
