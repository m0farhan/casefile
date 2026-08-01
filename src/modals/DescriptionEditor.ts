import { Component, MarkdownRenderer, Notice, type App } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, Task } from '../types'
import { NoteLinkSuggest } from './NoteLinkSuggest'
import { IconButton } from '../ui/primitives/IconButton'
import { toggleInlineMarker } from './inlineFormat'

export interface DescriptionEditorContext {
  app: App
  plugin: PMPlugin
  project: Project
  /** Mutated in place (task.description) exactly like the modal's deep clone was. */
  task: Task
  /** Called before following an internal link (the modal closes itself here; a leaf view does nothing). */
  onNavigateAway?: () => void
}

export interface DescriptionEditorHandle {
  destroy(): void
}

/**
 * The description preview/edit section extracted from TaskModal.render() as a
 * behavior-identical free function, so the detail side panel can reuse it.
 * Owns the MarkdownRenderer Component and the [[ note-link suggest; callers
 * MUST call destroy() before re-rendering or closing.
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
  const descArea = descSection.createEl('textarea', { cls: 'pm-modal-description' })
  descArea.placeholder = 'Add a description…'
  descArea.value = task.description

  // Inline formatting: toolbar buttons + editor hotkeys wrap/unwrap the selection.
  const applyMarker = (marker: string) => {
    const r = toggleInlineMarker(descArea.value, descArea.selectionStart, descArea.selectionEnd, marker)
    descArea.value = r.value
    task.description = r.value
    descArea.setSelectionRange(r.selStart, r.selEnd)
    descArea.focus()
  }
  const formatButtons: [string, string, string][] = [
    ['bold', 'Bold (Cmd+B)', '**'],
    ['italic', 'Italic (Cmd+I)', '*'],
    ['code', 'Inline code (Cmd+E)', '`']
  ]
  for (const [icon, tip, marker] of formatButtons) {
    const btn = new IconButton(descToolbar).setIcon(icon).setTooltip(tip)
    // mousedown would steal focus (and the selection) from the textarea.
    btn.el.addEventListener('mousedown', (e) => e.preventDefault())
    btn.onClick(() => applyMarker(marker))
  }
  descArea.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
    const marker = e.key === 'b' ? '**' : e.key === 'i' ? '*' : e.key === 'e' ? '`' : null
    if (!marker) return
    e.preventDefault()
    applyMarker(marker)
  })

  const autoResize = () => {
    const saved: [HTMLElement, number][] = []
    let ancestor = descArea.parentElement
    while (ancestor) {
      if (ancestor.scrollTop > 0) saved.push([ancestor, ancestor.scrollTop])
      ancestor = ancestor.parentElement
    }
    descArea.setCssProps({ '--desc-height': 'auto' })
    descArea.setCssProps({ '--desc-height': descArea.scrollHeight + 'px' })
    for (const [el, top] of saved) el.scrollTop = top
  }

  const insertAttachments = async (items: { blob: Blob; name: string }[]): Promise<void> => {
    for (const { blob, name } of items) {
      try {
        const buffer = await blob.arrayBuffer()
        const file = await plugin.store.saveTaskAttachment(project, task, name, buffer)
        const snippet = `![[${file.name}]]`
        descArea.setRangeText(snippet, descArea.selectionStart, descArea.selectionEnd, 'end')
        task.description = descArea.value
        autoResize()
      } catch (err) {
        console.error('Failed to save attachment', err)
        new Notice('Failed to save attachment')
      }
    }
  }

  const hasContent = () => task.description.trim().length > 0
  const sourcePath = task.filePath || project.filePath || ''

  let descComp = new Component()
  descComp.load()

  const toggleCheckbox = (index: number) => {
    let count = 0
    task.description = task.description.replace(/^([ \t]*[-*+] \[)([ x])(\])/gm, (match, pre, state, post) => {
      if (count++ === index) return pre + (state === ' ' ? 'x' : ' ') + post
      return match
    })
    descArea.value = task.description
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
    descArea.classList.remove('pm-hidden')
    descArea.value = task.description
    window.setTimeout(() => {
      autoResize()
      descArea.focus()
      if (caret !== undefined) descArea.setSelectionRange(caret, caret)
    }, 0)
  }

  const showPreview = () => {
    if (!hasContent()) return
    void renderPreview()
    descArea.classList.add('pm-hidden')
    descToolbar.classList.add('pm-hidden')
    descPreview.classList.remove('pm-hidden')
  }

  descArea.addEventListener('input', () => {
    task.description = descArea.value
    autoResize()
  })
  descArea.addEventListener('blur', () => showPreview())

  descArea.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items
    if (!items) return
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
    if (attachments.length === 0) return
    e.preventDefault()
    void insertAttachments(attachments)
  })

  descSection.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
  })

  descSection.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return
    e.preventDefault()
    if (descArea.classList.contains('pm-hidden')) {
      showEdit()
      descArea.selectionStart = descArea.selectionEnd = descArea.value.length
    }
    const attachments = Array.from(files).map((f) => ({ blob: f, name: f.name }))
    void insertAttachments(attachments)
  })

  // Note link suggest (inline [[ autocomplete)
  const noteSuggest = new NoteLinkSuggest(app, descArea, (newValue) => {
    task.description = newValue
    autoResize()
  })
  noteSuggest.attach(descSection)

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
    descArea.classList.add('pm-hidden')
    descToolbar.classList.add('pm-hidden')
    void renderPreview()
  } else {
    descPreview.classList.add('pm-hidden')
    window.setTimeout(autoResize, 0)
  }

  return {
    destroy(): void {
      descComp.unload()
      noteSuggest.destroy()
    }
  }
}
