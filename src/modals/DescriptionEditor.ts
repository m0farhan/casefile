import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import type { Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { Component, MarkdownRenderer, Notice, type App } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, Task } from '../types'
import { IconButton } from '../ui/primitives/IconButton'
import { toggleInlineMarker } from './inlineFormat'
import { computeInlineMarks, fenceMap } from './livePreviewMarks'
import { NoteLinkSuggest } from './NoteLinkSuggest'

export interface DescriptionEditorContext {
  app: App
  plugin: PMPlugin
  project: Project
  /** Mutated in place (task.description) exactly like the modal's deep clone was. */
  task: Task
  /** Called before following an internal link (the modal closes itself here; a leaf view does nothing). */
  onNavigateAway?: () => void
  /** Called on every doc change (the detail panel schedules its autosave here). */
  onChange?: () => void
}

export interface DescriptionEditorHandle {
  destroy(): void
}

// ── Live-preview decorations ──────────────────────────────────────────────
// Inline **bold** / *em* / `code` render styled with their markers hidden,
// except where the main selection touches the formatted range — there the
// raw markers reveal (Obsidian Live Preview behavior). All other markdown
// (headings, lists, links) stays raw; the debounced preview panel below
// covers full rendering.

const inlineDeco = {
  strong: Decoration.mark({ class: 'cm-cf-strong' }),
  em: Decoration.mark({ class: 'cm-cf-em' }),
  code: Decoration.mark({ class: 'cm-cf-code' })
} as const
const hideMarker = Decoration.replace({})

function buildLivePreviewDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const doc = view.state.doc
  // ponytail: whole-doc fence scan on every rebuild — descriptions are small;
  // cache the fence map against the doc if profiles ever say otherwise.
  const fenced = fenceMap(doc.toString())
  const sel = view.state.selection.main
  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = doc.lineAt(pos)
      if (!fenced[line.number - 1]) {
        for (const mark of computeInlineMarks(line.text)) {
          const f = line.from + mark.from
          const t = line.from + mark.to
          ranges.push(inlineDeco[mark.cls].range(f, t))
          const revealed = sel.from <= t && sel.to >= f
          if (!revealed) {
            for (const [ms, me] of mark.markers) {
              ranges.push(hideMarker.range(line.from + ms, line.from + me))
            }
          }
        }
      }
      pos = line.to + 1
    }
  }
  return Decoration.set(ranges, true)
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildLivePreviewDecorations(view)
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildLivePreviewDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations }
)

/**
 * The description preview/edit section extracted from TaskModal.render() as a
 * behavior-identical free function, so the detail side panel can reuse it.
 * Owns the CodeMirror EditorView, the MarkdownRenderer Components and the
 * [[ note-link suggest; callers MUST call destroy() before re-rendering or
 * closing.
 */
export function renderDescriptionEditor(
  container: HTMLElement,
  ctx: DescriptionEditorContext
): DescriptionEditorHandle {
  const { app, plugin, project, task } = ctx

  const descSection = container.createDiv('pm-modal-section pm-modal-desc-section')
  descSection.createEl('h4', { text: 'Description', cls: 'pm-modal-section-title' })

  const descToolbar = descSection.createDiv('pm-desc-toolbar')
  const descPreview = descSection.createDiv('pm-modal-desc-preview')
  const editorWrap = descSection.createDiv('pm-modal-description')
  // Live preview while editing: the editor stays raw markdown (honest source,
  // inline marks aside), the formatted result renders right below as you type.
  const liveWrap = descSection.createDiv('pm-desc-live')
  liveWrap.createDiv({ cls: 'pm-desc-live-label', text: 'Preview' })
  const liveEl = liveWrap.createDiv('pm-desc-live-body')

  const hasContent = () => task.description.trim().length > 0
  const sourcePath = task.filePath || project.filePath || ''

  let descComp = new Component()
  descComp.load()

  let liveComp = new Component()
  liveComp.load()
  let liveTimer: number | null = null
  const renderLive = async () => {
    if (!hasContent()) {
      liveWrap.classList.add('pm-hidden')
      return
    }
    liveWrap.classList.remove('pm-hidden')
    liveComp.unload()
    liveComp = new Component()
    liveComp.load()
    liveEl.empty()
    await MarkdownRenderer.render(app, task.description, liveEl, sourcePath, liveComp)
  }
  const scheduleLive = () => {
    if (liveTimer !== null) window.clearTimeout(liveTimer)
    liveTimer = window.setTimeout(() => void renderLive(), 250)
  }

  // Note link suggest (inline [[ autocomplete)
  const noteSuggest = new NoteLinkSuggest(app)
  noteSuggest.attach(descSection)

  const insertAttachments = async (items: { blob: Blob; name: string }[]): Promise<void> => {
    for (const { blob, name } of items) {
      try {
        const buffer = await blob.arrayBuffer()
        const file = await plugin.store.saveTaskAttachment(project, task, name, buffer)
        const snippet = `![[${file.name}]]`
        const { from, to } = view.state.selection.main
        view.dispatch({
          changes: { from, to, insert: snippet },
          selection: { anchor: from + snippet.length }
        })
      } catch (err) {
        console.error('Failed to save attachment', err)
        new Notice('Failed to save attachment')
      }
    }
  }

  const showPreview = () => {
    if (!hasContent()) return
    void renderPreview()
    editorWrap.classList.add('pm-hidden')
    descToolbar.classList.add('pm-hidden')
    liveWrap.classList.add('pm-hidden')
    descPreview.classList.remove('pm-hidden')
  }

  const view = new EditorView({
    parent: editorWrap,
    doc: task.description,
    extensions: [
      noteSuggest.extension(),
      history(),
      placeholder('Add a description…'),
      EditorView.lineWrapping,
      // The old textarea spellchecked (browser default); keep that.
      EditorView.contentAttributes.of({ spellcheck: 'true' }),
      livePreviewPlugin,
      keymap.of([
        // Format hotkeys first so they win over any default binding.
        {
          key: 'Mod-b',
          run: () => {
            applyMarker('**')
            return true
          }
        },
        {
          key: 'Mod-i',
          run: () => {
            applyMarker('*')
            return true
          }
        },
        {
          key: 'Mod-e',
          run: () => {
            applyMarker('`')
            return true
          }
        },
        ...historyKeymap,
        ...defaultKeymap
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        task.description = update.state.doc.toString()
        ctx.onChange?.()
        scheduleLive()
        noteSuggest.onDocChanged(update.view)
      }),
      EditorView.domEventHandlers({
        paste: (e) => {
          const items = e.clipboardData?.items
          if (!items) return false
          const attachments: { blob: Blob; name: string }[] = []
          for (const item of Array.from(items)) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
              const file = item.getAsFile()
              if (file) {
                const stamp = new Date().toISOString().replace(/[:.]/g, '-')
                const sub = (item.type.split('/')[1] || 'png').split('+')[0]
                const ext = sub === 'jpeg' ? 'jpg' : sub
                attachments.push({ blob: file, name: `Pasted-${stamp}.${ext}` })
              }
            }
          }
          if (attachments.length === 0) return false
          e.preventDefault()
          void insertAttachments(attachments)
          return true
        },
        // File drops are the section listener's job (it also covers drops on
        // the toolbar/preview); returning true stops CodeMirror from reading
        // the files as text while the event bubbles on to that listener.
        drop: (e) => Boolean(e.dataTransfer?.files.length),
        blur: (e) => {
          const rel = e.relatedTarget as Node | null
          if (rel && noteSuggest.contains(rel)) return false
          noteSuggest.hide()
          showPreview()
          return false
        }
      })
    ]
  })

  // Inline formatting: toolbar buttons + editor hotkeys wrap/unwrap the selection.
  const applyMarker = (marker: string) => {
    const { state } = view
    const sel = state.selection.main
    const r = toggleInlineMarker(state.doc.toString(), sel.from, sel.to, marker)
    // ponytail: whole-doc replace — toggleInlineMarker returns full text and
    // descriptions are small; selection restored explicitly so nothing jumps.
    view.dispatch({
      changes: { from: 0, to: state.doc.length, insert: r.value },
      selection: { anchor: r.selStart, head: r.selEnd }
    })
    view.focus()
  }
  const formatButtons: [string, string, string][] = [
    ['bold', 'Bold (Cmd+B)', '**'],
    ['italic', 'Italic (Cmd+I)', '*'],
    ['code', 'Inline code (Cmd+E)', '`']
  ]
  for (const [icon, tip, marker] of formatButtons) {
    const btn = new IconButton(descToolbar).setIcon(icon).setTooltip(tip)
    // mousedown would steal focus (and the selection) from the editor.
    btn.el.addEventListener('mousedown', (e) => e.preventDefault())
    btn.onClick(() => applyMarker(marker))
  }

  const toggleCheckbox = (index: number) => {
    let count = 0
    task.description = task.description.replace(/^([ \t]*[-*+] \[)([ x])(\])/gm, (match, pre, state, post) => {
      if (count++ === index) return pre + (state === ' ' ? 'x' : ' ') + post
      return match
    })
    void renderPreview()
  }

  const attachCheckboxListeners = () => {
    descPreview.querySelectorAll('input[type="checkbox"]').forEach((el, i) => {
      const cb = el as HTMLInputElement
      cb.removeAttribute('disabled')
      cb.addEventListener('click', (e) => {
        e.preventDefault()
        toggleCheckbox(i)
      })
    })
  }

  // MarkdownRenderer emits external anchors with target="_blank"; Electron
  // silently drops file:// under that, so route file:// clicks through window.open.
  const attachFileLinkHandlers = () => {
    descPreview.querySelectorAll<HTMLAnchorElement>('a.external-link').forEach((a) => {
      if (!a.href.startsWith('file://')) return
      a.addEventListener('click', (e) => {
        e.preventDefault()
        activeWindow.open(a.href)
      })
    })
  }

  const renderPreview = async () => {
    descComp.unload()
    descComp = new Component()
    descComp.load()
    descPreview.empty()
    await MarkdownRenderer.render(app, task.description, descPreview, sourcePath, descComp)
    attachCheckboxListeners()
    attachFileLinkHandlers()
  }

  const showEdit = (caret?: number) => {
    descPreview.classList.add('pm-hidden')
    descToolbar.classList.remove('pm-hidden')
    editorWrap.classList.remove('pm-hidden')
    void renderLive()
    // Preview-side edits (checkbox toggles) land on task.description only —
    // sync the doc before the editor becomes the source of truth again.
    if (view.state.doc.toString() !== task.description) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: task.description } })
    }
    if (caret !== undefined) {
      const pos = Math.min(caret, view.state.doc.length)
      view.dispatch({ selection: { anchor: pos } })
    }
    window.setTimeout(() => view.focus(), 0)
  }

  descSection.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
  })

  descSection.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return
    e.preventDefault()
    if (editorWrap.classList.contains('pm-hidden')) {
      showEdit(task.description.length)
    }
    const attachments = Array.from(files).map((f) => ({ blob: f, name: f.name }))
    void insertAttachments(attachments)
  })

  // Walk the rendered text and the markdown source in step, skipping the source
  // characters that produced no output, so a caret in the preview lands on the
  // character that rendered it rather than on the syntax around it.
  const sourceOffsetOf = (renderedIndex: number) => {
    const rendered = descPreview.textContent || ''
    const src = task.description
    const plain = (c: string) => (/\s/.test(c) ? ' ' : c)
    let cursor = 0
    for (let i = 0; i < renderedIndex && i < rendered.length; i++) {
      const ch = plain(rendered[i])
      while (cursor < src.length && plain(src[cursor]) !== ch) cursor++
      cursor++
    }
    return Math.min(cursor, src.length)
  }

  const clickedSourceOffset = (e: MouseEvent) => {
    const doc = descPreview.ownerDocument
    const caret = doc.caretPositionFromPoint?.(e.clientX, e.clientY)
    const node = caret?.offsetNode
    if (!node || node.nodeType !== Node.TEXT_NODE || !descPreview.contains(node)) return undefined
    const walker = doc.createTreeWalker(descPreview, NodeFilter.SHOW_TEXT)
    let rendered = 0
    let current = walker.nextNode()
    while (current && current !== node) {
      rendered += (current.textContent || '').length
      current = walker.nextNode()
    }
    return current ? sourceOffsetOf(rendered + caret.offset) : undefined
  }

  descPreview.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    if (target.instanceOf(HTMLInputElement) && target.type === 'checkbox') return

    const link = target.closest('a')

    if (link) {
      // Internal link (Obsidian note link)
      if (link.classList.contains('internal-link')) {
        e.preventDefault()
        e.stopPropagation()
        const href = link.getAttribute('data-href') || link.getAttribute('href') || ''
        ctx.onNavigateAway?.()
        void app.workspace.openLinkText(href, sourcePath)
        return
      }
      // External link - let browser handle it
      return
    }

    if (target.instanceOf(HTMLImageElement)) return

    const selection = activeWindow.getSelection()
    if (selection && !selection.isCollapsed && descPreview.contains(selection.anchorNode)) return

    // Click on non-link text = edit
    showEdit(clickedSourceOffset(e))
  })

  if (hasContent()) {
    editorWrap.classList.add('pm-hidden')
    descToolbar.classList.add('pm-hidden')
    liveWrap.classList.add('pm-hidden')
    void renderPreview()
  } else {
    descPreview.classList.add('pm-hidden')
    liveWrap.classList.add('pm-hidden')
  }

  return {
    destroy(): void {
      if (liveTimer !== null) window.clearTimeout(liveTimer)
      descComp.unload()
      liveComp.unload()
      noteSuggest.destroy()
      view.destroy()
    }
  }
}
