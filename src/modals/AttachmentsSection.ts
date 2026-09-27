import { Notice, setIcon, type App } from 'obsidian'
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

// The attach rule, shared by every way a file enters a case: the Evidence
// section's button and drop here, and the description's paste and drop.

/**
 * The name a file is saved under: safeAttachmentName, plus '.bin' when that
 * leaves no letter extension (a hash-named sample, '.env', 'image.001').
 * Obsidian resolves a link by file name only when the name has a '.', and the
 * Evidence list takes only refs with a letter extension, so without one the
 * link could be dead, and Evidence said no file was attached.
 */
export function attachmentFileName(name: string): string {
  const clean = safeAttachmentName(name)
  return refExtension(clean) ? clean : `${clean}.bin`
}

/** Pictures embed so they show inline; anything else is a plain link, never an embed: it may be the malware sample. */
export function attachmentLink(name: string): string {
  return IMAGE_EXTENSIONS.has(refExtension(name)) ? `![[${name}]]` : `[[${name}]]`
}

/** The store's two attachment steps, bound to the case (ProjectStore.reserveAttachmentName, writeTaskAttachment). */
export interface AttachTarget {
  /** A vault-unique name for the file, held until written. */
  reserve: (fileName: string) => string
  write: (name: string, data: ArrayBuffer) => Promise<unknown>
}

/**
 * Attach files to a case: reserve each one a name unique in the vault, link
 * them all from the end of the description at once, then copy the bytes into
 * the case's own attachments folder. Linking first means no save can miss a
 * link: the case holds it from the moment of the attach, whatever closes or
 * saves while a large file copies. A copy that fails leaves its link listed as
 * missing under Evidence, and says so. Resolves once every copy has settled,
 * with how many were written.
 */
export async function attachFiles(
  task: Task,
  target: AttachTarget,
  files: File[],
  linked: () => void
): Promise<number> {
  const planned = files.map((f) => ({ f, name: target.reserve(attachmentFileName(f.name)) }))
  const links = planned.map(({ name }) => attachmentLink(name))
  task.description = [task.description.trimEnd(), links.join('\n')].filter(Boolean).join('\n\n')
  linked()
  let written = 0
  for (const { f, name } of planned) {
    try {
      await target.write(name, await f.arrayBuffer())
      written++
    } catch (e) {
      new Notice(
        `Could not copy ${f.name}: ${e instanceof Error ? e.message : String(e)}. Its link [[${name}]] points at nothing; remove it.`
      )
    }
  }
  return written
}

/**
 * Evidence section: every file embedded or linked in the case (description +
 * comments), listed in one place, and — when the host passes attach — a way
 * to attach more (button or drop). Without attach it renders nothing when
 * there are no refs. Never re-renders on its own; the host rebuild owns the
 * lifecycle.
 */
export function renderAttachmentsSection(
  container: HTMLElement,
  ctx: {
    app: App
    project: Project
    task: Task
    /** Where attached files go. onLinked: the links are on the task (before
     * any byte is copied), so the host saves and redraws. onCopied: the copies
     * settled, so the host redraws again and Evidence resolves them. */
    attach?: AttachTarget & { onLinked: () => void; onCopied: () => void }
  }
): void {
  const { app, project, task, attach } = ctx
  const refs = extractAttachmentRefs([task.description, ...(task.comments ?? []).map((c) => c.text)])
  if (refs.length === 0 && !attach) return

  const section = container.createDiv('pm-modal-section pm-evidence-section')
  const header = section.createDiv('pm-modal-section-header')
  header.createEl('h4', {
    text: refs.length ? `Evidence (${refs.length})` : 'Evidence',
    cls: 'pm-modal-section-title'
  })

  // Same source-path idiom as CommentsSection: task note, else the project note.
  const sourcePath = task.filePath || project.filePath || ''

  if (attach) {
    const add = safeAsync(async (files: File[]) => {
      if (!files.length) return
      const n = await attachFiles(task, attach, files, attach.onLinked)
      if (n) new Notice(n === 1 ? 'Attached 1 file' : `Attached ${n} files`)
      attach.onCopied()
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
