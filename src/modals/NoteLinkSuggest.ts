import { Prec, type Extension } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { App, prepareFuzzySearch, TFile } from 'obsidian'

/** File-type metadata for suggest dropdown. */
const FILE_TYPE_LABELS: Record<string, string> = {
  canvas: 'Canvas',
  base: 'Database'
}

/**
 * Inline note-link suggest dropdown for the CodeMirror description editor.
 * Triggers on `[[` and shows matching vault files (notes, canvases, databases).
 * The host wires `extension()` into the EditorView and calls `onDocChanged`
 * from its update listener; the dropdown positions itself via coordsAtPos.
 */
export class NoteLinkSuggest {
  private container: HTMLDivElement
  private view: EditorView | null = null
  private items: TFile[] = []
  private activeIndex = 0
  private open = false
  private query = ''
  private triggerStart = -1 // position of the first `[`

  constructor(private app: App) {
    this.container = createDiv('pm-note-suggest')
  }

  /** Must be called to attach the dropdown to the DOM. */
  attach(parent: HTMLElement): void {
    parent.appendChild(this.container)
  }

  destroy(): void {
    this.view = null
    this.container.remove()
  }

  /** True while the dropdown is showing (host gates blur/preview on it). */
  get isOpen(): boolean {
    return this.open
  }

  /** Is this node inside the dropdown? (blur relatedTarget containment) */
  contains(node: Node): boolean {
    return this.container.contains(node)
  }

  /**
   * Navigation keymap. Prec.highest so arrows/enter/escape beat the editor
   * keymaps while the dropdown is open; every binding is a no-op when closed.
   */
  extension(): Extension {
    const when = (run: () => void) => () => {
      if (!this.open) return false
      run()
      return true
    }
    return Prec.highest(
      keymap.of([
        { key: 'ArrowDown', run: when(() => this.move(1)) },
        { key: 'ArrowUp', run: when(() => this.move(-1)) },
        { key: 'Enter', run: when(() => this.accept(this.items[this.activeIndex])) },
        { key: 'Tab', run: when(() => this.accept(this.items[this.activeIndex])) },
        { key: 'Escape', run: when(() => this.hide()) }
      ])
    )
  }

  /** Call on every doc change: detects/updates the `[[` trigger at the cursor. */
  onDocChanged(view: EditorView): void {
    this.view = view
    const pos = view.state.selection.main.head
    const text = view.state.doc.sliceString(Math.max(0, pos - 82), pos)
    const match = text.match(/\[\[([^\]]{0,80})$/)

    if (match) {
      this.triggerStart = pos - match[0].length
      this.query = match[1]
      this.updateItems()
      if (this.items.length > 0) {
        this.show()
      } else {
        this.hide()
      }
    } else {
      this.hide()
    }
  }

  hide(): void {
    if (!this.open) return
    this.open = false
    this.container.removeClass('pm-note-suggest--visible')
    this.triggerStart = -1
  }

  // ── Core logic ──────────────────────────────────────────────────────────

  private move(delta: number): void {
    this.activeIndex = (this.activeIndex + delta + this.items.length) % this.items.length
    this.renderItems()
  }

  private updateItems(): void {
    const files = this.app.vault
      .getFiles()
      .filter((f) => /\.(md|canvas|base)$/.test(f.extension ? `.${f.extension}` : f.path))
    if (!this.query) {
      // Show recently modified files when no query
      this.items = files.sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 8)
    } else {
      const fuzzy = prepareFuzzySearch(this.query)
      const queryLower = this.query.toLowerCase()
      const scored: { file: TFile; score: number }[] = []
      for (const file of files) {
        const nameResult = fuzzy(file.basename)
        if (!nameResult) continue
        // Boost exact substring matches and penalise long names
        // so "Week 15" beats "gantt-week-label--date-display..."
        let score = nameResult.score
        const nameLower = file.basename.toLowerCase()
        if (nameLower.startsWith(queryLower)) score -= 10
        else if (nameLower.includes(queryLower)) score -= 5
        score += file.basename.length * 0.01 // prefer shorter names
        scored.push({ file, score })
      }
      scored.sort((a, b) => a.score - b.score)
      this.items = scored.slice(0, 8).map((s) => s.file)
    }
    this.activeIndex = 0
  }

  private accept(file: TFile): void {
    const view = this.view
    if (!view || !file || this.triggerStart < 0) return
    const linkName = file.extension === 'md' ? file.basename : `${file.basename}.${file.extension}`
    const insertion = `[[${linkName}]]`
    const from = this.triggerStart
    const to = view.state.selection.main.head
    this.hide()
    view.dispatch({
      changes: { from, to, insert: insertion },
      selection: { anchor: from + insertion.length }
    })
    view.focus()
  }

  private show(): void {
    this.open = true
    this.container.addClass('pm-note-suggest--visible')
    this.position()
    // onDocChanged runs mid-dispatch, before CodeMirror's measure phase —
    // re-position next frame so coordsAtPos reflects the just-typed text.
    window.requestAnimationFrame(() => {
      if (this.open) this.position()
    })
    this.renderItems()
  }

  // ── Positioning ─────────────────────────────────────────────────────────

  private position(): void {
    const view = this.view
    if (!view) return
    const coords = view.coordsAtPos(view.state.selection.main.head)
    if (!coords) return

    const parent = this.container.offsetParent instanceof HTMLElement ? this.container.offsetParent : null
    const parentRect = parent?.getBoundingClientRect()
    const top = coords.bottom - (parentRect?.top ?? 0) + 4
    let left = coords.left - (parentRect?.left ?? 0)

    // Clamp to not overflow the right side of the host
    const maxLeft = (parent?.clientWidth ?? 600) - 280
    if (left > maxLeft) left = Math.max(0, maxLeft)

    this.container.setCssStyles({ top: `${top}px`, left: `${left}px` })
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  private renderItems(): void {
    this.container.empty()
    this.items.forEach((file, i) => {
      const row = this.container.createDiv({
        cls: 'pm-note-suggest-item' + (i === this.activeIndex ? ' pm-note-suggest-item--active' : '')
      })
      const nameRow = row.createDiv({ cls: 'pm-note-suggest-name-row' })
      nameRow.createSpan({ cls: 'pm-note-suggest-name', text: file.basename })
      const typeLabel = FILE_TYPE_LABELS[file.extension]
      if (typeLabel) {
        nameRow.createSpan({ cls: 'pm-note-suggest-type', text: typeLabel })
      }
      if (file.parent && file.parent.path !== '/') {
        row.createDiv({ cls: 'pm-note-suggest-path', text: file.parent.path })
      }
      row.addEventListener('mousedown', (e) => {
        e.preventDefault() // prevent blur
        this.accept(file)
      })
      row.addEventListener('mouseenter', () => {
        this.activeIndex = i
        this.renderItems()
      })
    })

    // Scroll active item into view
    const activeEl = this.container.querySelector('.pm-note-suggest-item--active')
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' })
  }
}
