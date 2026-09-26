import { AbstractInputSuggest, App, Notice, getIconIds, setIcon } from 'obsidian'
import type { PriorityConfig, StatusConfig } from '../types'
import { IconButton } from './primitives/IconButton'
import { safeAsync } from '../utils'

/** Suggests Lucide icon ids for the status/priority icon inputs. Typed emoji are kept as-is. */
class IconSuggest extends AbstractInputSuggest<string> {
  protected getSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return getIconIds()
      .filter((id) => id.includes(q))
      .slice(0, 24)
  }

  renderSuggestion(id: string, el: HTMLElement): void {
    el.addClass('pm-icon-suggestion')
    setIcon(el.createSpan({ cls: 'pm-icon-suggestion-glyph' }), id)
    el.createSpan({ text: id })
  }
}

/** Wire icon-name suggestions to an icon input; picking a suggestion saves through the input's change handler. */
export function attachIconSuggest(app: App, input: HTMLInputElement): void {
  const suggest = new IconSuggest(app, input)
  suggest.onSelect((id) => {
    suggest.setValue(id)
    input.dispatchEvent(new Event('change'))
    suggest.close()
  })
}

/**
 * The row being dragged and the list it came from. The list itself is the
 * token: the page shows several palettes side by side, and an index carried
 * in dataTransfer meant nothing on another list — dropping severity #5 on the
 * verdicts spliced out nothing and saved a null, and the plugin then failed
 * to load. Text dragged in from outside carries no token at all.
 */
let dragging: { items: unknown[]; index: number } | null = null

/** Move one entry; an out-of-range or same-place move changes nothing and returns false. */
export function moveItem<T>(items: T[], from: number, to: number): boolean {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return false
  const [moved] = items.splice(from, 1)
  items.splice(to, 0, moved)
  return true
}

/**
 * The status a case left on a deleted status moves to: the first other one
 * of the same kind, closing for closing and open for open. Moving a closed
 * case to an open status reopened it; undefined means there is none.
 */
export function statusFallback(statuses: StatusConfig[], gone: StatusConfig): StatusConfig | undefined {
  return statuses.find((s) => s.id !== gone.id && s.complete === gone.complete)
}

/** Wire drag-to-reorder on a config row; on drop, moves the dragged item to this row's index. */
export function wireRowDragReorder<T>(row: HTMLElement, index: number, items: T[], onChanged: () => void): void {
  row.createSpan({ text: '⠿', cls: 'pm-settings-drag-handle' })
  row.draggable = true
  row.addEventListener('dragstart', (e) => {
    dragging = { items, index }
    // Some platforms start no drag without data; the drop never reads it.
    e.dataTransfer?.setData('text/plain', '')
    row.addClass('pm-settings-row--dragging')
  })
  row.addEventListener('dragend', () => {
    dragging = null
    row.removeClass('pm-settings-row--dragging')
  })
  row.addEventListener('dragover', (e) => {
    // Only this list's own rows are a drop target, so another list shows the no-drop cursor.
    if (dragging?.items === items) e.preventDefault()
  })
  row.addEventListener('drop', (e) => {
    e.preventDefault()
    const from = dragging
    dragging = null
    if (from?.items !== items || !moveItem(items, from.index, index)) return
    onChanged()
  })
}

interface PaletteEntry {
  id: string
  label: string
  color: string
  icon: string
}

interface PaletteListEditorOpts<T extends PaletteEntry> {
  app: App
  /** The list to edit; mutated in place. */
  items: T[]
  /** Called after every mutation (edit, reorder, delete) so the owner can persist. */
  onChanged: () => void
  /** Called after an entry is removed, e.g. to remap orphaned tasks. */
  onDeleted?: (deleted: T) => void
  /**
   * Asked before an entry is removed; resolving false keeps it. The owner
   * says what the delete will change (cases moved or cleared) and may refuse.
   */
  confirmDelete?: (item: T) => Promise<boolean>
  /** Notice shown when deleting would leave the list empty. */
  minOneMessage: string
  /** Extra per-row controls between the color picker and the delete button. */
  renderExtra?: (row: HTMLElement, item: T) => void
}

/**
 * The palette row editor (drag handle, icon with suggestions, label, color,
 * move up/down, delete) shared by the status and priority lists in both the
 * plugin settings and the per-project overrides in the project modal.
 */
function renderPaletteListEditor<T extends PaletteEntry>(container: HTMLElement, opts: PaletteListEditorOpts<T>): void {
  const rerender = (): void => renderPaletteListEditor(container, opts)
  container.empty()
  opts.items.forEach((item, i) => {
    const row = container.createDiv('pm-settings-status-row')

    wireRowDragReorder(row, i, opts.items, () => {
      opts.onChanged()
      rerender()
    })

    // Icon input: emoji or a Lucide icon id (with suggestions)
    const icon = row.createEl('input', { type: 'text', value: item.icon })
    icon.addClass('pm-settings-status-icon')
    icon.placeholder = ''
    attachIconSuggest(opts.app, icon)
    icon.addEventListener('change', () => {
      item.icon = icon.value
      opts.onChanged()
    })

    // Label input
    const label = row.createEl('input', { type: 'text', value: item.label })
    label.addClass('pm-settings-status-label')
    label.addEventListener('change', () => {
      item.label = label.value
      opts.onChanged()
    })

    // Color picker
    const color = row.createEl('input', { type: 'color', value: item.color })
    color.addEventListener('change', () => {
      item.color = color.value
      opts.onChanged()
    })

    opts.renderExtra?.(row, item)

    // Drag is mouse-only; these are the keyboard and touch route to the same move.
    for (const [glyph, tip, to] of [
      ['chevron-up', 'Move up', i - 1],
      ['chevron-down', 'Move down', i + 1]
    ] as const) {
      const btn = new IconButton(row)
        .setIcon(glyph)
        .setTooltip(tip)
        .onClick(() => {
          if (!moveItem(opts.items, i, to)) return
          opts.onChanged()
          rerender()
        })
      // Hidden, not left out, so the columns stay lined up at the ends.
      if (to < 0 || to >= opts.items.length) btn.el.setCssStyles({ visibility: 'hidden' })
    }

    new IconButton(row)
      .setIcon('x')
      .setTooltip('Remove')
      .onClick(
        safeAsync(async () => {
          if (opts.items.length <= 1) {
            new Notice(opts.minOneMessage)
            return
          }
          if (opts.confirmDelete && !(await opts.confirmDelete(item))) return
          // Found again: the list may have changed while the question was open.
          const at = opts.items.indexOf(item)
          if (at < 0) return
          opts.items.splice(at, 1)
          opts.onChanged()
          rerender()
          opts.onDeleted?.(item)
        })
      )
  })
}

export interface StatusListEditorOpts {
  app: App
  statuses: StatusConfig[]
  onChanged: () => void
  onDeleted?: (deleted: StatusConfig) => void
  confirmDelete?: (item: StatusConfig) => Promise<boolean>
}

/** Status list editor: palette rows plus the per-status Done toggle. */
export function renderStatusListEditor(container: HTMLElement, opts: StatusListEditorOpts): void {
  renderPaletteListEditor<StatusConfig>(container, {
    app: opts.app,
    items: opts.statuses,
    onChanged: opts.onChanged,
    onDeleted: opts.onDeleted,
    confirmDelete: opts.confirmDelete,
    minOneMessage: 'You must have at least one status.',
    renderExtra: (row, status) => {
      const completeLabel = row.createEl('label', { cls: 'pm-settings-complete-toggle' })
      const checkbox = completeLabel.createEl('input', { type: 'checkbox' })
      checkbox.checked = status.complete
      completeLabel.createSpan({ text: 'Done', cls: 'pm-settings-complete-text' })
      checkbox.addEventListener('change', () => {
        status.complete = checkbox.checked
        opts.onChanged()
      })

      const wipLabel = row.createEl('label', { cls: 'pm-settings-complete-toggle' })
      wipLabel.createSpan({ text: `WIP`, cls: 'pm-settings-complete-text' })
      const wip = wipLabel.createEl('input', {
        type: 'number',
        cls: 'pm-settings-wip-input',
        value: status.wipLimit !== undefined ? String(status.wipLimit) : ''
      })
      wip.min = '1'
      wip.step = '1'
      wip.addEventListener('change', () => {
        const n = Math.floor(Number(wip.value))
        if (n > 0) {
          status.wipLimit = n
          wip.value = String(n)
        } else {
          // Empty/0/invalid clears the limit: the key is omitted, never written as undefined
          delete status.wipLimit
          wip.value = ''
        }
        opts.onChanged()
      })
    }
  })
}

export interface PriorityListEditorOpts {
  app: App
  priorities: PriorityConfig[]
  onChanged: () => void
  onDeleted?: (deleted: PriorityConfig) => void
  confirmDelete?: (item: PriorityConfig) => Promise<boolean>
}

// The plain palette editor (no per-row extras). Named for its PriorityConfig row shape;
// since the priorities palette left the UI its callers are issue types, severities, and
// verdicts, so the min-one copy is generic.
export function renderPriorityListEditor(container: HTMLElement, opts: PriorityListEditorOpts): void {
  renderPaletteListEditor<PriorityConfig>(container, {
    app: opts.app,
    items: opts.priorities,
    onChanged: opts.onChanged,
    onDeleted: opts.onDeleted,
    confirmDelete: opts.confirmDelete,
    minOneMessage: 'You must keep at least one entry in this list.'
  })
}
