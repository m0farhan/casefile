import { type Editor, Notice, SuggestModal } from 'obsidian'
import type PMPlugin from '../main'
import { type ToolResult, derivedCallout, runToolbox } from '../soc/toolbox'

interface Entry {
  name: string
  result: ToolResult
}

/** First line of a result, short enough to judge from the list. */
function preview(body: string): string {
  const first = body.split('\n').find((l) => l.trim()) ?? ''
  return first.length > 110 ? first.slice(0, 109) + '…' : first
}

/**
 * The transforms that APPLY to this selection, each showing what it produced.
 *
 * Only applicable ones are listed, which is the honest half: the picker never
 * offers "decode base64" for something that is not base64 and then hands back
 * rubbish. The preview means the analyst chooses a result they have already
 * read rather than a verb they hope does the right thing.
 */
class ToolboxModal extends SuggestModal<Entry> {
  constructor(
    plugin: PMPlugin,
    private entries: Entry[],
    private onPick: (entry: Entry) => void
  ) {
    super(plugin.app)
    this.setPlaceholder('Transform the selection…')
  }

  getSuggestions(query: string): Entry[] {
    const q = query.toLowerCase().trim()
    return q ? this.entries.filter((e) => e.name.toLowerCase().includes(q)) : this.entries
  }

  renderSuggestion(entry: Entry, el: HTMLElement): void {
    el.addClass('mod-complex')
    const content = el.createDiv({ cls: 'suggestion-content' })
    content.createDiv({ cls: 'suggestion-title', text: entry.name })
    // textContent only: this is decoded content from an alert.
    content.createDiv({ cls: 'suggestion-note', text: preview(entry.result.body) })
  }

  onChooseSuggestion(entry: Entry): void {
    this.onPick(entry)
  }
}

/**
 * Run every transform over the selection and let the analyst place one.
 *
 * The result is INSERTED below the selection, never substituted for it: the
 * note has to keep the thing that was decoded next to what it decoded to, or
 * the record loses the evidence and keeps only the conclusion.
 */
export async function openToolbox(plugin: PMPlugin, editor: Editor): Promise<void> {
  const selection = editor.getSelection().trim()
  if (!selection) {
    new Notice('Select something first.')
    return
  }
  // Captured before the modal takes focus — the selection is gone by then.
  const to = editor.getCursor('to')
  const entries = await runToolbox(selection)
  if (!entries.length) {
    new Notice('Nothing in this selection could be decoded or read as a time.')
    return
  }
  new ToolboxModal(plugin, entries, (entry) => {
    const callout = derivedCallout(entry.result.title, entry.result.body)
    editor.replaceRange(`\n\n${callout}\n`, { line: to.line, ch: editor.getLine(to.line).length })
  }).open()
}
