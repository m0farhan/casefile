import { neutralizeExternalLinks, scrubRemoteEmbeds } from './safeRender'
import { MarkdownRenderer, Component, setIcon } from 'obsidian'
import { confirmDialog } from '../ui/ModalFactory'
import type PMPlugin from '../main'
import type { Project, Task } from '../types'

export interface CommentsSectionHandle {
  destroy(): void
  /** Half-typed composer text — callers snapshot it before a rerender and pass it back via initialDraft. */
  getDraft(): string
  /** True when the composer input held focus (callers restore focus across rerenders). */
  hasFocus(): boolean
  focusDraft(): void
}

/**
 * Append-only investigation journal rendered from the task note's
 * `## Comments` body section. Entries are not edited in the UI (edit the note
 * for corrections — the "open as note" escape hatch), but any one can be
 * deleted after a confirm; the composer appends with a local-time minute stamp. Comments never touch fields: the caller
 * persists task.comments through the normal task save, and the store's
 * body serializer owns the on-disk section.
 *
 * REQUIRES a hydrated body (task.comments defined) — callers already
 * loadTaskBody before rendering the editor surfaces.
 */
export function renderCommentsSection(
  container: HTMLElement,
  plugin: PMPlugin,
  project: Project,
  task: Task,
  opts: { onChange: () => void; initialDraft?: string }
): CommentsSectionHandle {
  const section = container.createDiv('pm-modal-section pm-comments-section')
  const header = section.createDiv('pm-modal-section-header')
  const count = task.comments?.length ?? 0
  header.createEl('h4', {
    text: count ? `Comments (${count})` : 'Comments',
    cls: 'pm-modal-section-title'
  })

  const comp = new Component()
  comp.load()
  const sourcePath = task.filePath || project.filePath || ''

  const list = section.createDiv('pm-comments-list')
  for (const c of task.comments ?? []) {
    const entry = list.createDiv('pm-comment')
    const head = entry.createDiv('pm-comment-head')
    head.createDiv({ cls: 'pm-comment-at', text: c.at })
    const del = head.createEl('button', {
      cls: 'pm-comment-delete clickable-icon',
      attr: { 'aria-label': 'Delete comment' }
    })
    setIcon(del, 'trash-2')
    del.addEventListener('click', () => {
      void (async () => {
        if (!(await confirmDialog(plugin.app, 'Delete this comment? It is removed from the case note.'))) return
        // By identity, not index: the list may have been re-read while the prompt was open.
        const at = task.comments?.indexOf(c) ?? -1
        if (at === -1) return
        task.comments = task.comments?.filter((_, i) => i !== at)
        opts.onChange()
      })()
    })
    const body = entry.createDiv('pm-comment-body')
    void MarkdownRenderer.render(plugin.app, scrubRemoteEmbeds(c.text), body, sourcePath, comp)
  }
  // With the app, a link or embed of a file Obsidian cannot show itself
  // copies its path instead of handing the file to the system (evidence).
  neutralizeExternalLinks(list, plugin.app, sourcePath)

  const composer = section.createDiv('pm-comment-composer')
  const input = composer.createEl('textarea', { cls: 'pm-comment-input' })
  input.placeholder = 'Add to the investigation journal…'
  input.rows = 2
  if (opts.initialDraft) input.value = opts.initialDraft
  // Grows with what is typed (CSS caps it at a share of the window, then it scrolls).
  const fit = () => {
    input.setCssStyles({ height: 'auto' })
    input.setCssStyles({ height: `${input.scrollHeight + 2}px` })
  }
  input.addEventListener('input', fit)
  window.setTimeout(fit, 0)
  const addBtn = composer.createEl('button', { cls: 'pm-comment-add' })
  setIcon(addBtn.createSpan(), 'corner-down-left')
  addBtn.createSpan({ text: 'Add' })

  const submit = () => {
    const text = input.value.trim()
    if (!text) return
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const at = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
    task.comments = [...(task.comments ?? []), { at, text }]
    input.value = ''
    fit()
    opts.onChange()
  }
  addBtn.addEventListener('click', submit)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    }
  })

  return {
    destroy(): void {
      comp.unload()
    },
    getDraft(): string {
      return input.value
    },
    hasFocus(): boolean {
      return input.ownerDocument.activeElement === input
    },
    focusDraft(): void {
      input.focus()
      // Caret at the end — the natural resume point for a half-typed draft.
      input.setSelectionRange(input.value.length, input.value.length)
    }
  }
}
