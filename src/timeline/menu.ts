import {
  Menu,
  Notice,
  Platform,
  SuggestModal,
  editorInfoField,
  type App,
  type Editor,
  type EditorPosition,
  type Plugin
} from 'obsidian'
import { EditorView } from '@codemirror/view'
import { copyDefanged, copyText as copyToClipboard } from '../ui/defangMenu'
import {
  addChild,
  addEventAtEnd,
  addEventBelow,
  applyEdit,
  backToPlainList,
  closingOf,
  copyText,
  defangTimeline,
  deleteEvent,
  insertTimeline,
  makeTimeline,
  moveEvent,
  selectedLines,
  setEventKind,
  setStyle,
  sortEventsByTime,
  type TimelineEdit
} from './actions'
import { kindLabel } from './dom'
import { noteTimelineExtension } from './livePreview'
import { defangTimelineText, findTimelines, timelineAt, type EventKind, type TimelineStyle } from './parse'
import { decorateTimelineSections, redrawOnTimelineChange } from './reading'

type KindChoice = EventKind | 'auto'

/** The kinds the picker offers, in the menu's order. Observed has no word, so Auto stands for it. */
const KIND_CHOICES: { kind: KindChoice; icon: string }[] = [
  { kind: 'auto', icon: 'wand-2' },
  { kind: 'web', icon: 'globe' },
  { kind: 'execution', icon: 'terminal' },
  { kind: 'file', icon: 'file' },
  { kind: 'email', icon: 'mail' },
  { kind: 'user', icon: 'user' },
  { kind: 'host', icon: 'monitor' },
  { kind: 'detection', icon: 'siren' },
  { kind: 'response', icon: 'shield-check' }
]

/** The styles a timeline is drawn in, in the submenus' order, with the header's icon. */
const STYLES: { style: TimelineStyle; title: string; icon: string }[] = [
  { style: 'events', title: 'Events', icon: 'git-commit-vertical' },
  { style: 'steps', title: 'Steps', icon: 'list-ordered' },
  { style: 'chain', title: 'Process chain', icon: 'git-fork' }
]

/** What the items call a top-level bullet in each style. */
const ITEM_NOUN: Record<TimelineStyle, string> = { events: 'event', steps: 'step', chain: 'link' }

const choiceLabel = (kind: KindChoice): string => (kind === 'auto' ? 'Auto (from the text)' : kindLabel(kind))

const noteLines = (editor: Editor): string[] => editor.getValue().split('\n')

/**
 * Obsidian's editor for one table cell in Live Preview, which holds the
 * cell's text only: a timeline written there breaks the cell, so no item or
 * command applies, as Obsidian's own block items do not. Not in its typings.
 */
const inTableCell = (editor: Editor): boolean => (editor as { inTableCell?: boolean }).inTableCell === true

/** Applies an edit when there is one; false when the item does not apply. */
function apply(editor: Editor, edit: TimelineEdit | null): boolean {
  if (!edit) return false
  applyEdit(editor, edit)
  return true
}

/** The timeline and event under the caret, if any. */
function here(editor: Editor, line = editor.getCursor().line) {
  return inTableCell(editor) ? null : timelineAt(findTimelines(noteLines(editor)), line)
}

/** The kind the event says now: its word when written, else Auto. Null outside an events timeline: steps and chains draw no kind. */
function currentChoice(editor: Editor, line: number): KindChoice | null {
  const at = here(editor, line)
  if (!at?.event || at.block.style !== 'events') return null
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

/** Insert timeline, where Make timeline does not apply: a list the caret or selection is on is made one instead. */
function insertEdit(editor: Editor, line: number, style: TimelineStyle): TimelineEdit | null {
  const lines = noteLines(editor)
  return makeTimeline(lines, ...selectedLines(editor)) ? null : insertTimeline(lines, line, style)
}

/** An item whose submenu offers the styles, `current` checked (TaskContextMenu's cast: setSubmenu is not in the typings). */
function addStyleItem(
  menu: Menu,
  title: string,
  icon: string,
  current: TimelineStyle | null,
  pick: (style: TimelineStyle) => void
): void {
  menu.addItem((item) => {
    item.setTitle(title).setIcon(icon)
    const sub = (item as unknown as { setSubmenu: () => Menu }).setSubmenu()
    for (const s of STYLES) {
      sub.addItem((si) =>
        si
          .setTitle(s.title)
          .setIcon(s.icon)
          .setChecked(s.style === current)
          .onClick(() => pick(s.style))
      )
    }
  })
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

/** Copy for ticket. The text comes back defanged already, so the notice says
 * whether the timeline itself held anything live, not whether the copy did. */
function copy(editor: Editor, line: number): void {
  const lines = noteLines(editor)
  const text = copyText(lines, line)
  if (text === null) return
  const live = defangTimeline(lines, line)?.changed ?? false
  copyToClipboard(defangTimelineText(text), live ? 'Copied, defanged' : 'Copied (nothing to defang)')
}

/**
 * The timeline's items for a menu at `line`: inside a timeline, its editing
 * items, named for its style; outside one, Make timeline › when the caret or
 * selection is on a list, else Insert timeline › where one can go. Items that
 * do not apply are left out; sorting that cannot be done honestly stays
 * visible, disabled, saying why.
 */
export function addTimelineItems(menu: Menu, editor: Editor, line: number, app: App): void {
  if (inTableCell(editor)) return
  const lines = noteLines(editor)
  const at = timelineAt(findTimelines(lines), line)
  if (!at) {
    const [from, to] = selectedLines(editor)
    if (makeTimeline(lines, from, to)) {
      addStyleItem(menu, 'Make timeline', 'git-commit-vertical', null, (style) =>
        apply(editor, makeTimeline(noteLines(editor), from, to, style))
      )
    } else if (insertTimeline(lines, line, 'events')) {
      addStyleItem(menu, 'Insert timeline', 'git-commit-vertical', null, (style) =>
        apply(editor, insertTimeline(noteLines(editor), line, style))
      )
    }
    return
  }
  const { style } = at.block
  const noun = ITEM_NOUN[style]
  const run = (title: string, icon: string, edit: (ls: string[]) => TimelineEdit | null) => {
    if (!edit(lines)) return
    menu.addItem((item) =>
      item
        .setTitle(title)
        .setIcon(icon)
        .onClick(() => apply(editor, edit(noteLines(editor))))
    )
  }
  run(`Add ${noun} below`, 'list-plus', (ls) => addEventBelow(ls, line))
  run('Add child', 'corner-down-right', (ls) => addChild(ls, line))
  run(`Move ${noun} up`, 'arrow-up', (ls) => moveEvent(ls, line, 'up'))
  run(`Move ${noun} down`, 'arrow-down', (ls) => moveEvent(ls, line, 'down'))
  if (currentChoice(editor, line) !== null) {
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
    // A steps list's closing bullet goes with its facts.
    const title = at.event === closingOf(at.block) ? 'Delete details' : `Delete ${noun}`
    menu.addItem((item) =>
      item
        .setTitle(title)
        .setIcon('trash-2')
        .setWarning(true)
        .onClick(() => apply(editor, deleteEvent(noteLines(editor), line)))
    )
  }
  addStyleItem(menu, 'Style', 'layout-list', style, (s) => apply(editor, setStyle(noteLines(editor), line, s)))
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
/** Links that stay in the vault, a note or a tag: they open as anywhere else. */
const VAULT_LINK = '.cm-hmd-internal-link, .cm-hashtag, a.internal-link, a.tag'
/** Rendered HTML rather than editor text: an embed's links, or the icon after a link to a site. */
const RENDERED = 'a, .external-link'
/** Obsidian's names for a link that leaves the vault. */
const EXTERNAL = new Set(['external-link', 'external-ref-link'])

/**
 * Whether a click lands on a link inside a timeline that would leave the
 * vault: a URL, an email or a link to a site. Such a click must not open it:
 * the text is pasted evidence, and its URL may be the attacker's. A markdown
 * link's text reads the same whether it points at a note or at a site, so
 * for editor text Obsidian's own reading of the link decides (`tokenType`);
 * when it cannot say, the link is kept from opening.
 */
export function timelineLinkAt(
  target: EventTarget | null,
  tokenType: () => string | null = () => null
): HTMLElement | null {
  // A text node or the window has no closest(); only an element can be a link.
  const el = target as HTMLElement | null
  if (typeof el?.closest !== 'function' || !el.closest('.cf-ntl-line')) return null
  const link = el.closest<HTMLElement>(LINK_TARGET)
  if (!link || link.closest(VAULT_LINK)) return null
  // Inside an embed, Obsidian's reading is of the embed's own link, not this one.
  if (link.closest(RENDERED)) return link
  const type = tokenType()
  return type !== null && !EXTERNAL.has(type) ? null : link
}

/** The Obsidian editor behind a CodeMirror view, when it is a note's editor. */
function editorOf(view: EditorView): Editor | null {
  return view.state.field(editorInfoField, false)?.editor ?? null
}

/** Obsidian's editor reads the link under the pointer with this before it opens one. Not in its typings. */
interface ClickableTokens {
  getClickableTokenAt(pos: EditorPosition): { type: string } | null
}

function readsTokens(editor: Editor): editor is Editor & ClickableTokens {
  return 'getClickableTokenAt' in editor && typeof editor.getClickableTokenAt === 'function'
}

/** What Obsidian takes the link under the pointer for ('internal-link', 'external-link', 'tag'…), or null. */
function clickableType(evt: { clientX: number; clientY: number }, el: HTMLElement): string | null {
  const dom = el.closest<HTMLElement>('.cm-editor')
  const view = dom ? EditorView.findFromDOM(dom) : null
  const editor = view ? editorOf(view) : null
  const at = view?.posAtCoords({ x: evt.clientX, y: evt.clientY }) ?? null
  if (!editor || !readsTokens(editor) || at === null) return null
  return editor.getClickableTokenAt(editor.offsetToPos(at))?.type ?? null
}

/**
 * Stops a click on a timeline link before Obsidian opens it. The caret was
 * already placed on mousedown, so a plain click still edits the chip; a
 * Mod-click, Obsidian's open gesture, copies the value defanged instead. The
 * middle button (auxclick) is stopped the same way. Obsidian's editor also
 * opens a link on mousedown, for the middle button and for any tap on
 * Android: that press is stopped too, and a tap still places the caret.
 */
function guardTimelineLinks(evt: MouseEvent): void {
  const press = evt.type === 'mousedown'
  if (press && evt.button !== 1 && !Platform.isAndroidApp) return
  const target = evt.target as HTMLElement | null
  const link = timelineLinkAt(target, () => (target ? clickableType(evt, target) : null))
  if (!link) return
  evt.stopPropagation()
  if (!press || evt.button === 1) evt.preventDefault()
  if (evt.type === 'click' && (evt.metaKey || evt.ctrlKey)) {
    const value = link.closest('.cf-ntl-ioc')?.textContent ?? link.textContent ?? ''
    if (value.trim()) copyDefanged(value.trim())
  }
}

/**
 * On iOS, Obsidian's editor opens a link from a tap of its own: each touch
 * adds a touchend listener to the window, which at the end of a tap calls the
 * click handler directly, with no click event for the guard above to stop.
 * This listener is added once, at load, so it runs before that one and keeps
 * it from running for a tap on a timeline link. Every other listener has had
 * the touch by then, the tap still places the caret, and the click the
 * browser fires after it is stopped above.
 */
function guardTimelineTaps(evt: TouchEvent): void {
  const touch = evt.changedTouches[0]
  const target = evt.target as HTMLElement | null
  if (touch && timelineLinkAt(target, () => (target ? clickableType(touch, target) : null))) {
    evt.stopImmediatePropagation()
  }
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
      onAddChild: (view, line) => {
        const editor = editorOf(view)
        if (editor) apply(editor, addChild(noteLines(editor), line))
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
  // Obsidian keeps a rendered section while its text is unchanged, and the
  // marker is the line above the list: adding or removing it alone redraws nothing.
  redrawOnTimelineChange(plugin)
  // Capture phase on each window's document, so it runs before Obsidian's own
  // handlers open the link; a popout window has a document of its own.
  const guarded = new WeakSet<Document>()
  const guard = (doc: Document) => {
    if (guarded.has(doc)) return
    guarded.add(doc)
    for (const type of ['click', 'auxclick', 'mousedown'] as const) {
      plugin.registerDomEvent(doc, type, guardTimelineLinks, { capture: true })
    }
  }
  guard(activeDocument)
  // Popouts come back with the layout, after the plugin loads; one opened later says so.
  app.workspace.onLayoutReady(() => app.workspace.iterateAllLeaves((leaf) => guard(leaf.getContainer().doc)))
  plugin.registerEvent(app.workspace.on('window-open', (win) => guard(win.doc)))
  // iOS has the one window, and Obsidian's tap listener goes on it.
  if (Platform.isIosApp) plugin.registerDomEvent(window, 'touchend', guardTimelineTaps)
  plugin.registerEvent(
    app.workspace.on('editor-menu', (menu, editor) => addTimelineItems(menu, editor, editor.getCursor().line, app))
  )

  // A command checks by building its edit and throwing it away; only a run applies it.
  const command = (id: string, name: string, build: (editor: Editor, line: number) => TimelineEdit | null) =>
    plugin.addCommand({
      id,
      name,
      editorCheckCallback: (checking, editor) => {
        const edit = inTableCell(editor) ? null : build(editor, editor.getCursor().line)
        if (!edit) return false
        if (!checking) applyEdit(editor, edit)
        return true
      }
    })
  for (const { style, title } of STYLES) {
    // Events keeps the plain ids and names it had before there were styles.
    const id = style === 'events' ? '' : `-${style}`
    const name = style === 'events' ? '' : `: ${title.toLowerCase()}`
    command(`timeline-make${id}`, `Make timeline${name}`, (editor) =>
      makeTimeline(noteLines(editor), ...selectedLines(editor), style)
    )
    command(`timeline-insert${id}`, `Insert timeline${name}`, (editor, line) => insertEdit(editor, line, style))
    command(`timeline-style-${style}`, `Change timeline style to ${title.toLowerCase()}`, (editor, line) =>
      setStyle(noteLines(editor), line, style)
    )
  }
  command('timeline-add-event', 'Add timeline event below', (editor, line) => addEventBelow(noteLines(editor), line))
  command('timeline-add-child', 'Add child to process chain link', (editor, line) => addChild(noteLines(editor), line))
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
