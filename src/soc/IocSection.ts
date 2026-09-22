import type { Ioc, IocType, Task } from '../types'
import {
  IOC_TYPE_LABELS,
  assetRule,
  defangIoc,
  detectIocType,
  extractIocsFromText,
  formatIocLine,
  hasIocShape,
  parseIocPaste,
  refangIoc,
  vtWaitMs
} from './ioc'
import { IconButton } from '../ui/primitives/IconButton'
import { safeAsync } from '../utils'
import { Notice, requestUrl } from 'obsidian'
import {
  PROVIDER_LABELS,
  buildRequests,
  parseReputation,
  skippedProviders,
  type RepProvider,
  type RepVerdict
} from './reputation'

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
    reputationKeys?: { virustotal?: string; abuseipdb?: string; abusech?: string }
    /**
     * The analyst's asset boundary (settings.ownedAssets). A THUNK, not a value:
     * the settings handler replaces the array on every keystroke and nothing
     * re-renders an open pane, so a captured snapshot would let a domain added
     * two minutes ago go to VirusTotal. Required, not optional — a host that
     * forgets it would send the org's own domains out.
     */
    ownedAssets: () => string[]
    /**
     * Cross-case sightings of a (refanged) value — cases other than this one
     * holding the same indicator. Absent = no seen-before hints render.
     */
    // ponytail: the asset suppression lives inside iocSightings, whose `owned`
    // argument is required, so every caller is compiler-forced. A future host
    // that hand-rolls findSightings instead would bypass it — wire it through
    // iocSightings like the three current hosts do.
    findSightings?: (value: string) => { key: string; title: string }[]
  }
): void {
  const section = container.createDiv('pm-modal-section pm-ioc-section')
  const header = section.createDiv('pm-modal-section-header')
  const title = header.createEl('h4', { cls: 'pm-modal-section-title' })
  // Quiet per-row progress line for the paced check-all run; blank when idle.
  const progressEl = header.createSpan({ cls: 'pm-ioc-checkall-progress' })
  const checkAllBtn = new IconButton(header).setIcon('radar').setTooltip('Check all indicators')
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
    const assets = found.filter((i) => assetRule(i.value, opts.ownedAssets())).length
    new Notice(`Added ${found.length} indicator(s) from the note${assets ? ` · ${assets} marked as your assets` : ''}`)
  })
  const copyAllBtn = new IconButton(header).setIcon('clipboard-copy').setTooltip('Copy defanged block')
  copyAllBtn.onClick(
    safeAsync(async () => {
      if (!task.iocs.length) return
      const owned = opts.ownedAssets()
      await navigator.clipboard.writeText(task.iocs.map((i) => formatIocLine(i, owned)).join('\n'))
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
        chip.queried && chip.queried !== refangIoc(ioc.value)
          ? `${PROVIDER_LABELS[chip.provider]} (${defangIoc(chip.queried, 'domain')})`
          : PROVIDER_LABELS[chip.provider]
      const text = `${label} · ${chip.summary}`
      const cls = `pm-ioc-rep-chip pm-ioc-rep--${chip.verdict}`
      if (!chip.link) {
        // Skipped provider (no key): plain chip, nowhere to click through to.
        strip.createSpan({ cls, text })
        continue
      }
      const a = strip.createEl('a', {
        cls,
        text,
        href: chip.link,
        attr: { 'aria-label': `Open on ${PROVIDER_LABELS[chip.provider]}` }
      })
      a.setAttribute('rel', 'noopener')
    }
  }

  const checkReputation = async (ioc: Ioc) => {
    const owned = opts.ownedAssets()
    // Defence in depth: asset rows carry no check button and buildRequests would
    // return nothing anyway — but say why rather than look broken. Reads the
    // thunk, so a rule added since this pane rendered still holds here.
    const asset = assetRule(ioc.value, owned)
    if (asset) {
      new Notice(`Your own asset (${asset.rule}) — recorded on the case, never sent to a reputation provider`)
      return
    }
    const reqs = buildRequests(ioc.type, ioc.value, opts.reputationKeys ?? {}, owned)
    if (!reqs.length) {
      new Notice('No reputation provider covers this indicator — add keys in the plugin settings')
      return
    }
    const key = repKey(ioc)
    if (repCache.get(key) === 'loading') return // in-flight; a re-click must not double-spend quota
    // A provider this type supports but with no key gets an explicit chip —
    // a silent omission reads as "the provider said nothing", which is wrong.
    const skipped = skippedProviders(ioc.type, opts.reputationKeys ?? {}).map(
      (provider): RepChip => ({
        provider,
        verdict: 'unknown',
        summary: 'no key in settings',
        link: '',
        queried: ''
      })
    )
    repCache.set(key, 'loading')
    fillRepStrip(ioc)
    const chips = await Promise.all(
      reqs.map(async (req): Promise<RepChip> => {
        const base = { provider: req.provider, link: req.link, queried: req.queried }
        try {
          const res = await requestUrl({
            url: req.url,
            method: req.method,
            body: req.body,
            headers: req.headers,
            throw: false
          })
          return { ...base, ...parseReputation(req.provider, res.status, res.text) }
        } catch {
          return { ...base, verdict: 'unknown', summary: 'network error' }
        }
      })
    )
    repCache.set(key, [...chips, ...skipped])
    fillRepStrip(ioc)
  }

  // Check every row sequentially, pacing VirusTotal-bearing lookups to its
  // free tier (vtWaitMs). Rows with a cached result this session are skipped
  // and counted honestly; rows no configured provider covers are counted too.
  // Each iteration (and each slice of a pacing wait) re-checks that the rows
  // container is still mounted, so a modal close mid-run stops the loop with
  // at most one short timer left to fire harmlessly.
  let checkingAll = false
  const runCheckAll = async () => {
    if (checkingAll || !task.iocs.length) return
    const keys = opts.reputationKeys ?? {}
    if (!keys.virustotal?.trim() && !keys.abuseipdb?.trim() && !keys.abusech?.trim()) {
      new Notice('No reputation provider covers this indicator — add keys in the plugin settings')
      return
    }
    checkingAll = true
    checkAllBtn.el.addClass('pm-icon-btn--busy')
    checkAllBtn.el.setAttribute('aria-disabled', 'true')
    const vtStarts: number[] = []
    let checked = 0
    let alreadyChecked = 0
    let uncovered = 0
    let assets = 0
    let aborted = false
    const rows = [...task.iocs]
    const owned = opts.ownedAssets()
    try {
      for (const [i, ioc] of rows.entries()) {
        if (!rowsEl.isConnected) {
          aborted = true
          break
        }
        progressEl.setText(`Checking ${i + 1} of ${rows.length}…`)
        if (!task.iocs.includes(ioc)) continue // row removed mid-run
        if (assetRule(ioc.value, owned)) {
          assets++
          continue
        }
        if (Array.isArray(repCache.get(repKey(ioc)))) {
          alreadyChecked++
          continue
        }
        const reqs = buildRequests(ioc.type, ioc.value, keys, owned)
        if (!reqs.length) {
          uncovered++
          continue
        }
        if (reqs.some((r) => r.provider === 'virustotal')) {
          // ponytail: chunked sleep so an unmount mid-wait never leaves a 15s dangling timer
          while (vtWaitMs(vtStarts, Date.now()) > 0 && rowsEl.isConnected) {
            const step = Math.min(500, vtWaitMs(vtStarts, Date.now()))
            await new Promise<void>((resolve) => window.setTimeout(resolve, step))
          }
          if (!rowsEl.isConnected) {
            aborted = true
            break
          }
          vtStarts.push(Date.now())
        }
        await checkReputation(ioc)
        checked++
      }
    } finally {
      progressEl.setText('')
      checkingAll = false
      checkAllBtn.el.removeClass('pm-icon-btn--busy')
      checkAllBtn.el.removeAttribute('aria-disabled')
    }
    if (aborted) return
    const parts = [`Checked ${checked} indicator${checked === 1 ? '' : 's'}`]
    if (alreadyChecked) parts.push(`${alreadyChecked} already checked`)
    if (assets) parts.push(`${assets} your own assets — not sent`)
    if (uncovered) parts.push(`${uncovered} not covered by configured providers`)
    new Notice(parts.join(' · '))
  }
  checkAllBtn.onClick(safeAsync(runCheckAll))

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
      // Recorded, and visibly ours. Derived from settings at render time, never
      // written to the note — which is why it applies to cases 2.21 wrote.
      // ponytail: computed at render, so an already-open pane keeps the old mark
      // until it re-renders. The gate in buildRequests/checkReputation reads the
      // thunk live and is what actually holds; this is a label, not a guard.
      const asset = assetRule(ioc.value, opts.ownedAssets())
      if (asset) {
        valueEl.createSpan({
          cls: 'pm-ioc-asset',
          text: `ASSET · ${asset.rule}`,
          attr: {
            title: asset.builtIn
              ? 'A private, loopback or link-local range — built into Responder, not from your settings. ' +
                'Recorded here as evidence, never sent to a reputation provider, and not searched across cases.'
              : 'Matches your asset boundary — your own estate. Recorded here as evidence, never sent ' +
                'to a reputation provider, and not searched across cases. Derived from your settings, ' +
                'not stored in the note.'
          }
        })
      }
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
      // Seen-before hint: same tucked-under-the-row placement as the reputation
      // strip. An asset is never searched (iocSightings suppresses it), so say
      // that — drawing nothing would read as "never seen on another case".
      if (asset) {
        rowsEl.createDiv({
          cls: 'pm-ioc-sightings',
          text: 'Cross-case sightings are not computed for your own assets.'
        })
      } else {
        const sightings = opts.findSightings?.(refangIoc(ioc.value)) ?? []
        if (sightings.length) {
          const hint = rowsEl.createDiv('pm-ioc-sightings')
          const names = sightings.slice(0, 3).map((s) => s.key || s.title)
          const extra = sightings.length > 3 ? ` and ${sightings.length - 3} more` : ''
          const text = `Also in ${names.join(', ')}${extra}`
          if (onPivot) {
            const link = hint.createSpan({ cls: 'pm-ioc-sightings-link', text })
            link.addEventListener('click', () => onPivot(refangIoc(ioc.value)))
          } else {
            hint.setText(text)
          }
        }
      }
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
    const tokens = text.split(/[\s,]+/).filter(Boolean)
    if (tokens.length < 2) return
    e.preventDefault()
    const added = parseIocPaste(
      text,
      task.iocs.map((i) => i.value)
    )
    // Two counts, two reasons, never merged (the Check-all rule) — and the
    // dropped tokens are NAMED, because "3 skipped" about a hash the analyst
    // pasted from a report is a claim they cannot check.
    const dropped = tokens.filter((t) => !hasIocShape(refangIoc(t)))
    const dupes = tokens.length - dropped.length - added.length
    const parts: string[] = []
    if (added.length) parts.push(`Added ${added.length} indicator${added.length === 1 ? '' : 's'}`)
    if (dropped.length) {
      const sample = dropped
        .slice(0, 3)
        .map((t) => `"${t}"`)
        .join(', ')
      parts.push(`${dropped.length} not indicator-shaped (${sample}${dropped.length > 3 ? ', …' : ''})`)
    }
    if (dupes > 0) parts.push(`${dupes} already recorded`)
    if (parts.length) new Notice(parts.join(' · '))
    if (!added.length) return
    task.iocs.push(...added)
    renderRows()
    opts.onChange()
  })

  renderRows()
}
