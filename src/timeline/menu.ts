import { Menu, Notice, SuggestModal, editorInfoField, type App, type Editor, type Plugin } from 'obsidian'
import type { EditorView } from '@codemirror/view'
import { copyDefanged } from '../ui/defangMenu'
import {
  addEventAtEnd,
  addEventBelow,
  applyEdit,
  backToPlainList,
  copyText,
  defangTimeline,
  deleteEvent,
  makeTimeline,
  moveEvent,
  setEventKind,
  sortEventsByTime,
  type TimelineEdit
} from './actions'
import { kindLabel } from './dom'
import { noteTimelineExtension } from './livePreview'
import { findTimelines, timelineAt, type EventKind } from './parse'
import { decorateTimelineSections } from './reading'

type KindChoice = EventKind | 'auto'

/** The kinds the picker offers, in the menu's order. Observed has no word, so Auto stands for it. */
const KIND_CHOICES: { kind: KindChoice; icon: string }[] = [
  { kind: 'auto', icon: 'wand-2' },
  { kind: 'detection', icon: 'siren' },
  { kind: 'response', icon: 'shield-check' },
  { kind: 'execution', icon: 'terminal' },
  { kind: 'web', icon: 'globe' },
  { kind: 'file', icon: 'file' },
  { kind: 'email', icon: 'mail' }
]

const choiceLabel = (kind: KindChoice): string => (kind === 'auto' ? 'Auto (from the text)' : kindLabel(kind))

const noteLines = (editor: Editor): string[] => editor.getValue().split('\n')

/** Applies an edit when there is one; false when the item does not apply. */
function apply(editor: Editor, edit: TimelineEdit | null): boolean {
  if (!edit) return false
  applyEdit(editor, edit)
  return true
}

/** The timeline and event under the caret, if any. */
function here(editor: Editor, line = editor.getCursor().line) {
  return timelineAt(findTimelines(noteLines(editor)), line)
}

/** The kind the event says now: its word when written, else Auto. */
function currentChoice(editor: Editor, line: number): KindChoice | null {
  const at = here(editor, line)
  if (!at?.event) return null
  return at.event.kindExplicit ? at.event.kind : 'auto'
}

function setKind(editor: Editor, line: number, kind: KindChoice): void {
  apply(editor, setEventKind(noteLines(editor), line, kind))
}

/** The kind picker as a menu, where a click on a node or a kind word opens it. */
export function openKindMenu(editor: Editor, line: number, evt: MouseEvent): void {
  const current = currentChoice(editor, line)
  if (current === null) return
  const menu = new Menu()
  for (const { kind, icon } of KIND_CHOICES) {
    menu.addItem((item) =>
      item
        .setTitle(choiceLabel(kind))
        .setIcon(icon)
        .setChecked(kind === current)
        .onClick(() => setKind(editor, line, kind))
    )
  }
  menu.showAtMouseEvent(evt)
}

/** The kind picker for the keyboard and the mobile toolbar (a command has no click to anchor a menu to). */
class KindSuggest extends SuggestModal<KindChoice> {
  constructor(
    app: App,
    private readonly editor: Editor,
    private readonly line: number
  ) {
    super(app)
    this.setPlaceholder('Event kind')
  }
  getSuggestions(query: string): KindChoice[] {
    const q = query.toLowerCase()
    return KIND_CHOICES.map((c) => c.kind).filter((k) => choiceLabel(k).toLowerCase().includes(q))
  }
  renderSuggestion(kind: KindChoice, el: HTMLElement): void {
    el.setText(choiceLabel(kind))
  }
  onChooseSuggestion(kind: KindChoice): void {
    setKind(this.editor, this.line, kind)
  }
}

/** The sort's edit, or null when it is already in order or cannot be done honestly. */
function sortedEdit(lines: string[], line: number): TimelineEdit | null {
  const sort = sortEventsByTime(lines, line)
  return sort && 'edit' in sort ? sort.edit : null
}

function defang(editor: Editor, line: number): void {
  const result = defangTimeline(noteLines(editor), line)
  if (!result) return
  if (!result.changed) {
    new Notice('Nothing in the timeline to defang.')
    return
  }
  applyEdit(editor, result.edit)
}

function copy(editor: Editor, line: number): void {
  const text = copyText(noteLines(editor), line)
  if (text !== null) copyDefanged(text)
}

/**
 * The timeline's items for a menu at `line`: inside a timeline, its editing
 * items; outside one, Make timeline when the caret or selection is on a list.
 * Items that do not apply are left out; sorting that cannot be done honestly
 * stays visible, disabled, saying why.
 */
export function addTimelineItems(menu: Menu, editor: Editor, line: number, app: App): void {
  const lines = noteLines(editor)
  const at = timelineAt(findTimelines(lines), line)
  if (!at) {
    const from = editor.getCursor('from').line
    const to = editor.getCursor('to').line
    if (!makeTimeline(lines, from, to)) return
    menu.addItem((item) =>
      item
        .setTitle('Make timeline')
        .setIcon('git-commit-vertical')
        .onClick(() => apply(editor, makeTimeline(noteLines(editor), from, to)))
    )
    return
  }
  const run = (title: string, icon: string, edit: (ls: string[]) => TimelineEdit | null) => {
    if (!edit(lines)) return
    menu.addItem((item) =>
      item
        .setTitle(title)
        .setIcon(icon)
        .onClick(() => apply(editor, edit(noteLines(editor))))
    )
  }
  run('Add event below', 'list-plus', (ls) => addEventBelow(ls, line))
  run('Move event up', 'arrow-up', (ls) => moveEvent(ls, line, 'up'))
  run('Move event down', 'arrow-down', (ls) => moveEvent(ls, line, 'down'))
  if (at.event) {
    menu.addItem((item) =>
      item
        .setTitle('Set event kind…')
        .setIcon('tag')
        .onClick(() => new KindSuggest(app, editor, line).open())
    )
  }
  const sort = sortEventsByTime(lines, line)
  if (sort) {
    menu.addItem((item) => {
      item.setTitle('Sort events by time').setIcon('arrow-down-wide-narrow')
      if ('reason' in sort) item.setTitle(`Sort events by time: ${sort.reason}`).setDisabled(true)
      else item.onClick(() => apply(editor, sortedEdit(noteLines(editor), line)))
    })
  }
  if (at.event) {
    menu.addItem((item) =>
      item
        .setTitle('Delete event')
        .setIcon('trash-2')
        .setWarning(true)
        .onClick(() => apply(editor, deleteEvent(noteLines(editor), line)))
    )
  }
  menu.addItem((item) =>
    item
      .setTitle('Defang timeline')
      .setIcon('shield')
      .onClick(() => defang(editor, line))
  )
  menu.addItem((item) =>
    item
      .setTitle('Copy timeline for ticket')
      .setIcon('clipboard-copy')
      .onClick(() => copy(editor, line))
  )
  run('Back to plain list', 'list', (ls) => backToPlainList(ls, line))
}

/** What Obsidian's Live Preview opens on a click: a bare URL, an email or a link. */
const LINK_TARGET = '.cm-url, .cm-link, .cm-underline, .cm-hmd-barelink, .external-link, a'

/**
 * Whether a click lands on a link inside a timeline. Such a click must not
 * open it: the text is pasted evidence, and its URL may be the attacker's.
 */
export function timelineLinkAt(target: EventTarget | null): HTMLElement | null {
  // A text node or the window has no closest(); only an element can be a link.
  const el = target as HTMLElement | null
  if (typeof el?.closest !== 'function' || !el.closest('.cf-ntl-line')) return null
  return el.closest<HTMLElement>(LINK_TARGET)
}

/**
 * Stops a click on a timeline link before Obsidian opens it. The caret was
 * already placed on mousedown, so a plain click still edits the chip; a
 * Mod-click, Obsidian's open gesture, copies the value defanged instead. The
 * middle button (auxclick) is stopped the same way.
 */
function guardTimelineLinks(evt: MouseEvent): void {
  const link = timelineLinkAt(evt.target)
  if (!link) return
  evt.preventDefault()
  evt.stopPropagation()
  if (evt.type === 'click' && (evt.metaKey || evt.ctrlKey)) {
    const value = link.closest('.cf-ntl-ioc')?.textContent ?? link.textContent ?? ''
    if (value.trim()) copyDefanged(value.trim())
  }
}

/** The Obsidian editor behind a CodeMirror view, when it is a note's editor. */
function editorOf(view: EditorView): Editor | null {
  return view.state.field(editorInfoField, false)?.editor ?? null
}

/**
 * Everything the note timeline adds to Obsidian: the Live Preview drawing,
 * the Reading view drawing, the right-click items and one command per item
 * (every item also works from the palette and a mobile toolbar).
 */
export function registerNoteTimeline(plugin: Plugin): void {
  const { app } = plugin
  plugin.registerEditorExtension(
    noteTimelineExtension({
      onKindClick: (view, line, evt) => {
        const editor = editorOf(view)
        if (editor) openKindMenu(editor, line, evt)
      },
      onAddEvent: (view, markerLine) => {
        const editor = editorOf(view)
        if (editor) apply(editor, addEventAtEnd(noteLines(editor), markerLine))
      },
      onHeaderMenu: (view, markerLine, evt) => {
        const editor = editorOf(view)
        if (!editor) return
        const menu = new Menu()
        addTimelineItems(menu, editor, markerLine, app)
        menu.showAtMouseEvent(evt)
      },
      onDefang: (view, markerLine) => {
        const editor = editorOf(view)
        if (editor) defang(editor, markerLine)
      }
    })
  )
  plugin.registerMarkdownPostProcessor((el, ctx) => decorateTimelineSections(el, ctx))
  // Capture phase on the document, so it runs before Obsidian's own handler opens the link.
  for (const type of ['click', 'auxclick'] as const) {
    plugin.registerDomEvent(activeDocument, type, guardTimelineLinks, { capture: true })
  }
  plugin.registerEvent(
    app.workspace.on('editor-menu', (menu, editor) => addTimelineItems(menu, editor, editor.getCursor().line, app))
  )

  // A command checks by building its edit and throwing it away; only a run applies it.
  const command = (id: string, name: string, build: (editor: Editor, line: number) => TimelineEdit | null) =>
    plugin.addCommand({
      id,
      name,
      editorCheckCallback: (checking, editor) => {
        const edit = build(editor, editor.getCursor().line)
        if (!edit) return false
        if (!checking) applyEdit(editor, edit)
        return true
      }
    })
  command('timeline-make', 'Make timeline', (editor) =>
    makeTimeline(noteLines(editor), editor.getCursor('from').line, editor.getCursor('to').line)
  )
  command('timeline-add-event', 'Add timeline event below', (editor, line) => addEventBelow(noteLines(editor), line))
  command('timeline-move-up', 'Move timeline event up', (editor, line) => moveEvent(noteLines(editor), line, 'up'))
  command('timeline-move-down', 'Move timeline event down', (editor, line) =>
    moveEvent(noteLines(editor), line, 'down')
  )
  plugin.addCommand({
    id: 'timeline-set-kind',
    name: 'Set timeline event kind',
    editorCheckCallback: (checking, editor) => {
      const line = editor.getCursor().line
      if (currentChoice(editor, line) === null) return false
      if (!checking) new KindSuggest(app, editor, line).open()
      return true
    }
  })
  command('timeline-sort', 'Sort timeline events by time', (editor, line) => sortedEdit(noteLines(editor), line))
  command('timeline-delete-event', 'Delete timeline event', (editor, line) => deleteEvent(noteLines(editor), line))
  plugin.addCommand({
    id: 'timeline-defang',
    name: 'Defang timeline',
    editorCheckCallback: (checking, editor) => {
      const line = editor.getCursor().line
      if (!here(editor, line)) return false
      if (!checking) defang(editor, line)
      return true
    }
  })
  plugin.addCommand({
    id: 'timeline-copy',
    name: 'Copy timeline for ticket',
    editorCheckCallback: (checking, editor) => {
      const line = editor.getCursor().line
      if (!here(editor, line)) return false
      if (!checking) copy(editor, line)
      return true
    }
  })
  command('timeline-plain-list', 'Turn timeline back into a plain list', (editor, line) =>
    backToPlainList(noteLines(editor), line)
  )
}
