import { setIcon, type App } from 'obsidian'
import { extractAttachmentRefs, refExtension, IMAGE_EXTENSIONS } from '../soc/attachments'
import { IconButton } from '../ui/primitives/IconButton'
import type { Project, Task } from '../types'

/** File size shown at honest precision — never rounded up past its unit. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/**
 * Evidence section: every file embedded or linked in the case (description +
 * comments), listed in one place. Renders nothing when there are no refs —
 * hosts call this unconditionally. Never re-renders on its own; the host
 * rebuild owns the lifecycle (no listeners beyond row buttons).
 */
export function renderAttachmentsSection(
  container: HTMLElement,
  ctx: { app: App; project: Project; task: Task }
): void {
  const { app, project, task } = ctx
  const refs = extractAttachmentRefs([task.description, ...(task.comments ?? []).map((c) => c.text)])
  if (refs.length === 0) return

  const section = container.createDiv('pm-modal-section pm-evidence-section')
  const header = section.createDiv('pm-modal-section-header')
  header.createEl('h4', { text: `Evidence (${refs.length})`, cls: 'pm-modal-section-title' })

  // Same source-path idiom as CommentsSection: task note, else the project note.
  const sourcePath = task.filePath || project.filePath || ''
  const list = section.createDiv('pm-evidence-list')

  for (const ref of refs) {
    const file = app.metadataCache.getFirstLinkpathDest(ref, sourcePath)
    const row = list.createDiv('pm-evidence-row')

    const icon = row.createSpan('pm-evidence-icon')
    setIcon(icon, IMAGE_EXTENSIONS.has(refExtension(ref)) ? 'image' : 'file-text')

    row.createSpan({ cls: 'pm-evidence-name', text: file ? file.name : ref })

    if (file) {
      if (file.stat.size > 0) row.createSpan({ cls: 'pm-evidence-size', text: formatSize(file.stat.size) })
      new IconButton(row)
        .setIcon('arrow-up-right')
        .setTooltip('Open')
        .setRevealOnHover(true)
        .onClick(() => {
          void app.workspace.openLinkText(ref, sourcePath)
        })
    } else {
      // A dangling reference is evidence of a problem — keep it listed.
      row.createSpan({ cls: 'pm-evidence-missing', text: 'missing' })
    }
  }
}
