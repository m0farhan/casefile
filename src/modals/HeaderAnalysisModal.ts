import { ButtonComponent, Modal, Notice, setTooltip } from 'obsidian'
import type PMPlugin from '../main'
import { safeAsync } from '../utils'
import { type HeaderAnalysis, analyseHeaders, formatHeaderReport } from '../soc/emailHeaders'

/**
 * Paste email headers, read what they say.
 *
 * Everything on screen is a quotation or a comparison of quotations. There is
 * no score, no colour-coded verdict and no word like "suspicious": SPF failed
 * or it did not, the From domain matches the Return-Path or it does not, and
 * the analyst decides what that means. A header the paste does not contain is
 * printed under "Not in this paste" rather than silently reading as a pass —
 * the absence of an SPF result is not an SPF pass.
 *
 * Offline: nothing here resolves a name, fetches a key or checks a reputation.
 */
class HeaderAnalysisModal extends Modal {
  private analysis: HeaderAnalysis | null = null

  constructor(private plugin: PMPlugin) {
    super(plugin.app)
  }

  onOpen(): void {
    const { contentEl } = this
    this.modalEl.addClass('pm-modal', 'pm-modal--headers')
    contentEl.addClass('pm-headers')
    this.setTitle('Analyse email headers')
    contentEl.createEl('p', {
      cls: 'pm-headers-meta',
      text: 'Paste the full header block. Nothing leaves this vault — every line below is read from what you pasted.'
    })

    const input = contentEl.createEl('textarea', {
      cls: 'pm-headers-input',
      attr: { placeholder: 'Received: from …', rows: '8', spellcheck: 'false' }
    })
    const out = contentEl.createDiv('pm-headers-out')

    const row = contentEl.createDiv('pm-modal-btn-row')
    const copyBtn = new ButtonComponent(row).setButtonText('Copy report').setDisabled(true)
    setTooltip(copyBtn.buttonEl, 'Copies the analysis as markdown')
    copyBtn.onClick(
      safeAsync(async () => {
        if (!this.analysis) return
        await navigator.clipboard.writeText(formatHeaderReport(this.analysis))
        new Notice('Header report copied')
      })
    )
    const iocBtn = new ButtonComponent(row).setButtonText('Copy indicators').setCta().setDisabled(true)
    setTooltip(iocBtn.buttonEl, 'Copies the defanged indicators, ready to paste into a case')
    iocBtn.onClick(
      safeAsync(async () => {
        const lines = this.analysis?.indicators ?? []
        if (!lines.length) return
        await navigator.clipboard.writeText(lines.join('\n'))
        new Notice(`Copied ${lines.length} indicator${lines.length === 1 ? '' : 's'}`)
      })
    )

    input.addEventListener('input', () => {
      const raw = input.value
      this.analysis = raw.trim() ? analyseHeaders(raw, this.plugin.settings.ownedAssets) : null
      copyBtn.setDisabled(!this.analysis)
      iocBtn.setDisabled(!this.analysis?.indicators.length)
      this.render(out)
    })
    input.focus()
  }

  private render(out: HTMLElement): void {
    out.empty()
    const a = this.analysis
    if (!a) return

    const section = (title: string): HTMLElement => {
      out.createEl('h4', { cls: 'pm-headers-h', text: title })
      return out.createDiv('pm-headers-body')
    }

    const ids = section('Identities')
    for (const id of a.identities) {
      const line = ids.createDiv('pm-headers-row')
      line.createSpan({ cls: 'pm-headers-label', text: id.label })
      line.createSpan({ cls: 'pm-headers-value', text: id.value })
    }

    const auth = section('Authentication')
    if (a.auth.length) {
      for (const r of a.auth) {
        const line = auth.createDiv('pm-headers-row')
        line.createSpan({ cls: 'pm-headers-label', text: r.mechanism.toUpperCase() })
        // One neutral class per stated result. No pass/fail colouring: a DMARC
        // fail is a fact to read, not an alarm the plugin is entitled to raise.
        line.createSpan({ cls: 'pm-headers-result', text: r.result })
        if (r.detail) line.createSpan({ cls: 'pm-headers-value', text: r.detail })
      }
    } else {
      auth.createDiv({ cls: 'pm-headers-empty', text: 'Not recorded.' })
    }

    const path = section('Path')
    if (a.hops.length) {
      for (const hop of a.hops) {
        const line = path.createDiv('pm-headers-row')
        line.createSpan({ cls: 'pm-headers-label', text: String(hop.n) })
        line.createSpan({
          cls: 'pm-headers-value',
          text: `from ${hop.from} by ${hop.by} with ${hop.via}`
        })
        line.createSpan({
          cls: 'pm-headers-result',
          text: hop.at ? (hop.delaySec === null ? hop.at : `${hop.at} (+${hop.delaySec}s)`) : 'no time recorded'
        })
      }
    } else {
      path.createDiv({ cls: 'pm-headers-empty', text: 'Not recorded.' })
    }

    const obs = section('Observations')
    if (a.observations.length) for (const o of a.observations) obs.createDiv({ cls: 'pm-headers-note', text: o })
    else obs.createDiv({ cls: 'pm-headers-empty', text: 'Nothing to compare.' })

    const iocs = section(`Indicators (${a.indicators.length})`)
    if (a.indicators.length) for (const i of a.indicators) iocs.createDiv({ cls: 'pm-headers-ioc', text: i })
    else iocs.createDiv({ cls: 'pm-headers-empty', text: 'None found.' })

    if (a.notes.length) {
      const notes = section('Not in this paste')
      for (const n of a.notes) notes.createDiv({ cls: 'pm-headers-note', text: n })
    }
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

export function openHeaderAnalysis(plugin: PMPlugin): void {
  new HeaderAnalysisModal(plugin).open()
}
