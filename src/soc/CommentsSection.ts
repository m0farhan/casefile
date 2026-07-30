import { MarkdownRenderer, Component, setIcon } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, Task } from '../types'

export interface CommentsSectionHandle {
  destroy(): void
}

/**
 * Append-only investigation journal rendered from the task note's
 * `## Comments` body section. Entries are read-only in the UI (edit the note
 * for corrections — the "open as note" escape hatch); the composer appends
 * with a local-time minute stamp. Comments never touch fields: the caller
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
  opts: { onChange: () => void }
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
    if (c.at) entry.createDiv({ cls: 'pm-comment-at', text: c.at })
    const body = entry.createDiv('pm-comment-body')
    void MarkdownRenderer.render(plugin.app, c.text, body, sourcePath, comp)
  }

  const composer = section.createDiv('pm-comment-composer')
  const input = composer.createEl('textarea', { cls: 'pm-comment-input' })
  input.placeholder = 'Add to the investigation journal…'
  input.rows = 2
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
    }
  }
}
