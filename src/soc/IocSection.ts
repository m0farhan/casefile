import type { Ioc, IocType, Task } from '../types'
import {
  IOC_TYPE_LABELS,
  defangIoc,
  detectIocType,
  extractIocsFromText,
  formatIocLine,
  parseIocPaste,
  refangIoc
} from './ioc'
import { IconButton } from '../ui/primitives/IconButton'
import { safeAsync } from '../utils'
import { Notice, requestUrl } from 'obsidian'
import { PROVIDER_LABELS, buildRequests, parseReputation, type RepProvider, type RepVerdict } from './reputation'

const IOC_TYPES = Object.keys(IOC_TYPE_LABELS) as IocType[]

function renderTypeSelect(parent: HTMLElement, value: IocType): HTMLSelectElement {
  const sel = parent.createEl('select', { cls: 'pm-prop-select pm-ioc-type' })
  for (const t of IOC_TYPES) sel.createEl('option', { value: t, text: IOC_TYPE_LABELS[t] })
  sel.value = value
  return sel
}

/**
 * Indicators section: one row per IOC (type select, defanged value, optional
 * note, find-across-cases + copy-real-value + remove) and an add-row form.
 * Display always defangs via defangIoc; only the copy button touches the real
 * value. Mutates task.iocs in place and reports every commit through
 * opts.onChange. `onPivot` (when the host provides it) receives the row's
 * refanged real value, for the cross-case indicator search.
 */
interface RepChip {
  provider: RepProvider
  verdict: RepVerdict
  summary: string
  link: string
  queried: string
}

export function renderIocSection(
  container: HTMLElement,
  task: Task,
  opts: {
    onChange: () => void
    onPivot?: (value: string) => void
    /** Provider API keys for the live reputation button; absent/empty = provider off. */
    reputationKeys?: { virustotal?: string; abuseipdb?: string }
  }
): void {
  const section = container.createDiv('pm-modal-section pm-ioc-section')
  const header = section.createDiv('pm-modal-section-header')
  const title = header.createEl('h4', { cls: 'pm-modal-section-title' })
  // Auto-populate from the note: scan description + comments for indicators
  // (defanged or real), skip ones already recorded, append the rest.
  const scanBtn = new IconButton(header).setIcon('text-search').setTooltip('Extract indicators from this note')
  scanBtn.onClick(() => {
    const prose = [task.description, ...(task.comments ?? []).map((c) => c.text)].join('\n')
    const found = extractIocsFromText(
      prose,
      task.iocs.map((i) => i.value)
    )
    if (!found.length) {
      new Notice('No new indicators found in the note')
      return
    }
    task.iocs.push(...found)
    renderRows()
    opts.onChange()
    new Notice(`Added ${found.length} indicator(s) from the note`)
  })
  const copyAllBtn = new IconButton(header).setIcon('clipboard-copy').setTooltip('Copy defanged block')
  copyAllBtn.onClick(
    safeAsync(async () => {
      if (!task.iocs.length) return
      await navigator.clipboard.writeText(task.iocs.map(formatIocLine).join('\n'))
      copyAllBtn.setIcon('check')
      window.setTimeout(() => copyAllBtn.setIcon('clipboard-copy'), 700)
    })
  )
  const rowsEl = section.createDiv('pm-ioc-rows')

  // Reputation results are ephemeral session state: keyed by type:value (a
  // result belongs to the type it was queried as) so they survive row
  // re-renders, dropped when the section re-mounts. Async completions patch
  // ONLY the row's own strip — never a full renderRows(), which would wipe an
  // uncommitted note draft being typed on another row and steal its focus.
  const repCache = new Map<string, RepChip[] | 'loading'>()
  const repKey = (ioc: Ioc) => `${ioc.type}:${ioc.value}`
  const repStrips = new Map<Ioc, HTMLElement>()

  const fillRepStrip = (ioc: Ioc) => {
    const strip = repStrips.get(ioc)
    if (!strip || !strip.isConnected) return
    strip.empty()
    // Reads the CURRENT key: after a mid-flight type change the old result
    // stays cached under the old type and honestly shows nothing here
    // (flipping the type back shows it again).
    const state = repCache.get(repKey(ioc))
    if (!state) return
    if (state === 'loading') {
      strip.createSpan({ cls: 'pm-ioc-rep-loading', text: 'Checking…' })
      return
    }
    for (const chip of state) {
      const label =
        chip.queried !== refangIoc(ioc.value)
          ? `${PROVIDER_LABELS[chip.provider]} (${defangIoc(chip.queried, 'domain')})`
          : PROVIDER_LABELS[chip.provider]
      const a = strip.createEl('a', {
        cls: `pm-ioc-rep-chip pm-ioc-rep--${chip.verdict}`,
        text: `${label} · ${chip.summary}`,
        href: chip.link,
        attr: { 'aria-label': `Open on ${PROVIDER_LABELS[chip.provider]}` }
      })
      a.setAttribute('rel', 'noopener')
    }
  }

  const checkReputation = async (ioc: Ioc) => {
    const reqs = buildRequests(ioc.type, ioc.value, opts.reputationKeys ?? {})
    if (!reqs.length) {
      new Notice('No reputation provider covers this indicator — add keys in the plugin settings')
      return
    }
    const key = repKey(ioc)
    if (repCache.get(key) === 'loading') return // in-flight; a re-click must not double-spend quota
    repCache.set(key, 'loading')
    fillRepStrip(ioc)
    const chips = await Promise.all(
      reqs.map(async (req): Promise<RepChip> => {
        const base = { provider: req.provider, link: req.link, queried: req.queried }
        try {
          const res = await requestUrl({ url: req.url, headers: req.headers, throw: false })
          return { ...base, ...parseReputation(req.provider, res.status, res.text) }
        } catch {
          return { ...base, verdict: 'unknown', summary: 'network error' }
        }
      })
    )
    repCache.set(key, chips)
    fillRepStrip(ioc)
  }

  const renderRows = () => {
    title.setText(`Indicators (${task.iocs.length})`)
    rowsEl.empty()
    for (const [i, ioc] of task.iocs.entries()) {
      const row = rowsEl.createDiv('pm-ioc-row')
      const sel = renderTypeSelect(row, ioc.type)
      sel.addEventListener('change', () => {
        ioc.type = sel.value as IocType
        renderRows() // re-defang + recolor for the new type
        opts.onChange()
      })
      const valueEl = row.createDiv('pm-ioc-value')
      const dot = valueEl.createSpan({ cls: 'pm-ioc-dot' })
      dot.setCssProps({ '--pm-ioc-color': `var(--gs-ioc-${ioc.type})` })
      // The defanged text is itself the copy affordance (Obsidian disables
      // text selection app-wide, so without this the value can't be grabbed
      // at all). Click = copy defanged; drag-select is re-enabled via CSS and
      // must not trigger the copy. The row button still copies the real value.
      const textSpan = valueEl.createSpan({
        text: defangIoc(ioc.value, ioc.type),
        cls: 'pm-ioc-value-text',
        attr: { title: 'Copy defanged' }
      })
      textSpan.addEventListener(
        'click',
        safeAsync(async () => {
          const sel = activeWindow.getSelection()
          if (sel && !sel.isCollapsed && textSpan.contains(sel.anchorNode)) return
          await navigator.clipboard.writeText(defangIoc(ioc.value, ioc.type))
          textSpan.classList.add('pm-ioc-copied')
          window.setTimeout(() => textSpan.classList.remove('pm-ioc-copied'), 600)
        })
      )
      const noteInput = row.createEl('input', {
        type: 'text',
        cls: 'pm-prop-text pm-ioc-note',
        attr: { placeholder: 'Note…' }
      })
      noteInput.value = ioc.note ?? ''
      noteInput.addEventListener('change', () => {
        const v = noteInput.value.trim()
        // Omit the key entirely when blank — the YAML emitter writes literal `undefined` otherwise.
        if (v) ioc.note = v
        else delete ioc.note
        opts.onChange()
      })
      new IconButton(row)
        .setIcon('radar')
        .setTooltip('Check reputation')
        .onClick(() => void checkReputation(ioc))
      const onPivot = opts.onPivot
      if (onPivot) {
        new IconButton(row)
          .setIcon('search')
          .setTooltip('Find this indicator across cases')
          .onClick(() => onPivot(refangIoc(ioc.value)))
      }
      const copyBtn = new IconButton(row).setIcon('copy').setTooltip('Copy real value')
      copyBtn.onClick(
        safeAsync(async () => {
          await navigator.clipboard.writeText(ioc.value)
          copyBtn.setIcon('check')
          window.setTimeout(() => copyBtn.setIcon('copy'), 700)
        })
      )
      new IconButton(row)
        .setIcon('x')
        .setTooltip('Remove indicator')
        .onClick(() => {
          task.iocs.splice(i, 1)
          renderRows()
          opts.onChange()
        })
      repStrips.set(ioc, rowsEl.createDiv('pm-ioc-rep'))
      fillRepStrip(ioc)
    }
  }

  const addRow = section.createDiv('pm-ioc-row pm-ioc-add')
  const addSel = renderTypeSelect(addRow, 'ip')
  const valueInput = addRow.createEl('input', {
    type: 'text',
    cls: 'pm-prop-text pm-ioc-value-input',
    attr: { placeholder: 'Value', spellcheck: 'false' }
  })
  const noteInput = addRow.createEl('input', {
    type: 'text',
    cls: 'pm-prop-text pm-ioc-note',
    attr: { placeholder: 'Note (optional)' }
  })
  const addBtn = addRow.createEl('button', { cls: 'pm-soc-btn', text: 'Add' })
  const commitAdd = () => {
    const value = refangIoc(valueInput.value)
    if (!value) return
    const ioc: Ioc = { type: addSel.value as IocType, value }
    const note = noteInput.value.trim()
    if (note) ioc.note = note
    task.iocs.push(ioc)
    valueInput.value = ''
    noteInput.value = ''
    renderRows()
    opts.onChange()
    valueInput.focus()
  }
  addBtn.addEventListener('click', commitAdd)
  valueInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitAdd()
  })
  // Auto-select the detected type as the value arrives (typing or single paste);
  // the analyst can still override the select before committing.
  valueInput.addEventListener('input', () => {
    const v = refangIoc(valueInput.value)
    if (v) addSel.value = detectIocType(v)
  })
  // Multi-indicator paste: split/refang/classify/dedup and append every new
  // row in one commit. Single tokens fall through to the default paste path.
  valueInput.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') ?? ''
    if (text.split(/[\s,]+/).filter(Boolean).length < 2) return
    e.preventDefault()
    const added = parseIocPaste(
      text,
      task.iocs.map((i) => i.value)
    )
    if (!added.length) return
    task.iocs.push(...added)
    renderRows()
    opts.onChange()
  })

  renderRows()
}
