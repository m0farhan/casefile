import { Notice, setIcon, type App, type TFile } from 'obsidian'
import { extractAttachmentRefs, opensInApp, refExtension, IMAGE_EXTENSIONS } from '../soc/attachments'
import { IconButton } from '../ui/primitives/IconButton'
import { safeAsync } from '../utils'
import type { Project, Task } from '../types'

/** File size shown at honest precision — never rounded up past its unit. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/**
 * A file name that survives as a wikilink target: Obsidian links break on
 * `# ^ [ ] |`, and path separators or control characters in a name from
 * outside the vault have no business in one.
 */
export function safeAttachmentName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f\\/:*?"<>|#^[\]]+/g, '-').trim()
  return clean.replace(/^\.+/, '') || 'attachment'
}

/**
 * Copy picked or dropped files into the vault where Obsidian's own attachment
 * setting puts them (next to the note, a folder, …), and link each from the
 * end of the description, which is what the Evidence list reads. Images are
 * embedded so they show inline; anything else is a plain link, never an
 * embed: the file may be the malware sample. Returns how many were attached.
 */
export async function attachFiles(app: App, task: Task, sourcePath: string, files: File[]): Promise<number> {
  const links: string[] = []
  for (const f of files) {
    try {
      const path = await app.fileManager.getAvailablePathForAttachment(safeAttachmentName(f.name), sourcePath)
      const file: TFile = await app.vault.createBinary(path, await f.arrayBuffer())
      const target = app.metadataCache.fileToLinktext(file, sourcePath, false)
      links.push(IMAGE_EXTENSIONS.has(file.extension.toLowerCase()) ? `![[${target}]]` : `[[${target}]]`)
    } catch (e) {
      new Notice(`Could not attach ${f.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (links.length) task.description = [task.description.trimEnd(), links.join('\n')].filter(Boolean).join('\n\n')
  return links.length
}

/**
 * Evidence section: every file embedded or linked in the case (description +
 * comments), listed in one place, and — when the host passes onChange — a way
 * to attach more (button or drop). Without onChange it renders nothing when
 * there are no refs. Never re-renders on its own; the host rebuild owns the
 * lifecycle.
 */
export function renderAttachmentsSection(
  container: HTMLElement,
  ctx: { app: App; project: Project; task: Task; onChange?: () => void }
): void {
  const { app, project, task, onChange } = ctx
  const refs = extractAttachmentRefs([task.description, ...(task.comments ?? []).map((c) => c.text)])
  if (refs.length === 0 && !onChange) return

  const section = container.createDiv('pm-modal-section pm-evidence-section')
  const header = section.createDiv('pm-modal-section-header')
  header.createEl('h4', {
    text: refs.length ? `Evidence (${refs.length})` : 'Evidence',
    cls: 'pm-modal-section-title'
  })

  // Same source-path idiom as CommentsSection: task note, else the project note.
  const sourcePath = task.filePath || project.filePath || ''

  if (onChange) {
    const add = safeAsync(async (files: File[]) => {
      if (!files.length) return
      const n = await attachFiles(app, task, sourcePath, files)
      if (!n) return
      new Notice(n === 1 ? 'Attached 1 file' : `Attached ${n} files`)
      onChange()
    })
    const picker = section.createEl('input', { type: 'file', cls: 'pm-evidence-picker', attr: { multiple: '' } })
    picker.addEventListener('change', () => {
      add(Array.from(picker.files ?? []))
      picker.value = ''
    })
    const btn = header.createEl('button', { cls: 'pm-evidence-add' })
    setIcon(btn.createSpan(), 'paperclip')
    btn.createSpan({ text: 'Attach' })
    btn.addEventListener('click', () => picker.click())
    // Files dropped anywhere on the section attach too. dragenter as well as
    // dragover, or a quick release is refused (see KanbanColumn acceptDrops).
    const accept = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      section.addClass('pm-evidence-section--drop')
    }
    section.addEventListener('dragenter', accept)
    section.addEventListener('dragover', accept)
    section.addEventListener('dragleave', (e) => {
      if (!section.contains(e.relatedTarget as Node | null)) section.removeClass('pm-evidence-section--drop')
    })
    section.addEventListener('drop', (e) => {
      section.removeClass('pm-evidence-section--drop')
      if (!e.dataTransfer?.files.length) return
      e.preventDefault()
      add(Array.from(e.dataTransfer.files))
    })
    if (refs.length === 0) {
      section.createDiv({ cls: 'pm-evidence-empty', text: 'No files attached. Attach one, or drop it here.' })
      return
    }
  }
  const list = section.createDiv('pm-evidence-list')

  for (const ref of refs) {
    const file = app.metadataCache.getFirstLinkpathDest(ref, sourcePath)
    const row = list.createDiv('pm-evidence-row')

    const icon = row.createSpan('pm-evidence-icon')
    setIcon(icon, IMAGE_EXTENSIONS.has(refExtension(ref)) ? 'image' : 'file-text')

    row.createSpan({ cls: 'pm-evidence-name', text: file ? file.name : ref })

    if (file) {
      if (file.stat.size > 0) row.createSpan({ cls: 'pm-evidence-size', text: formatSize(file.stat.size) })
      // Open only what Obsidian shows itself. Anything else it would hand to
      // the system's default app: a dropped .html renders live and fetches, a
      // .lnk or .hta runs. Decided on the file the link resolves to, not on
      // the link text.
      if (opensInApp(file.extension)) {
        new IconButton(row)
          .setIcon('arrow-up-right')
          .setTooltip('Open')
          .setRevealOnHover(true)
          .onClick(() => {
            void app.workspace.openLinkText(ref, sourcePath)
          })
      } else {
        const path = file.path
        new IconButton(row)
          .setIcon('copy')
          .setTooltip('Copy path — opens outside Obsidian')
          .setRevealOnHover(true)
          .onClick(
            safeAsync(async () => {
              await navigator.clipboard.writeText(path)
              new Notice(
                `Path copied — .${file.extension} files are not opened from a case; Obsidian would hand them to the system's default app.`
              )
            })
          )
      }
    } else {
      // A dangling reference is evidence of a problem — keep it listed.
      row.createSpan({ cls: 'pm-evidence-missing', text: 'missing' })
    }
  }
}
