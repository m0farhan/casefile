import { type App, FuzzySuggestModal, type FuzzyMatch, getIconIds, setIcon } from 'obsidian'

/**
 * Pick one of the icons Obsidian ships, by fuzzy search over their names.
 * Every row draws its own glyph, so the analyst chooses by sight, not by
 * guessing what "radio-tower" looks like. The id is kept exactly as Obsidian
 * lists it, the same value the palette icon field stores.
 */
export class IconPickerModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private onPick: (id: string) => void
  ) {
    super(app)
    this.setPlaceholder('Search icons…')
  }

  getItems(): string[] {
    return getIconIds()
  }

  getItemText(id: string): string {
    return iconLabel(id)
  }

  renderSuggestion(match: FuzzyMatch<string>, el: HTMLElement): void {
    el.addClass('pm-icon-suggestion')
    setIcon(el.createSpan({ cls: 'pm-icon-suggestion-glyph' }), match.item)
    el.createSpan({ text: iconLabel(match.item) })
  }

  onChooseItem(id: string): void {
    this.onPick(id)
  }
}

/** Obsidian lists its Lucide set as "lucide-fish"; the prefix says nothing to a reader. */
export function iconLabel(id: string): string {
  return id.startsWith('lucide-') ? id.slice('lucide-'.length) : id
}
