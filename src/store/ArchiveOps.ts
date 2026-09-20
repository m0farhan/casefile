import type { App } from 'obsidian'
import { TFile, normalizePath } from 'obsidian'
import type { Project, StatusConfig, Task } from '../types'
import { parsePlainDate, today } from '../dates'
import { isTerminalStatus } from '../utils'
import { findParentId, findTaskById } from './TaskIndex'
import { repointDescendantFiles } from './TaskTreeOps'
import { ensureFolder, moveTaskAttachmentFolder } from './vaultFs'
import { taskFolderForProjectPath } from './layout'

/** Get the task subfolder path for a project */
function projectTaskFolder(project: Project): string {
  return taskFolderForProjectPath(project.filePath)
}

export async function archiveTask(app: App, project: Project, taskId: string): Promise<void> {
  const task = findTaskById(project, taskId)
  if (!task || !task.filePath) return

  const taskFolder = projectTaskFolder(project)
  const archiveFolder = normalizePath(taskFolder + '/Archive')
  await ensureFolder(app, archiveFolder)

  const fileName = task.filePath.split('/').pop()
  if (!fileName) return
  const newPath = normalizePath(archiveFolder + '/' + fileName)

  const file = app.vault.getAbstractFileByPath(task.filePath)
  if (file instanceof TFile) {
    const oldPath = task.filePath
    await app.vault.rename(file, newPath)
    const carried = await moveTaskAttachmentFolder(app, oldPath, newPath)
    // ponytail: nested subtask files ride along with the folder — archiving a
    // parent carries its subtree into Archive (cascade-archive on next load).
    if (carried) repointDescendantFiles(task, carried.from, carried.to)
    task.filePath = newPath
    task.archived = true
  }
}

export async function unarchiveTask(app: App, project: Project, taskId: string): Promise<void> {
  const task = findTaskById(project, taskId)
  if (!task || !task.filePath) return

  // Subtasks go back inside their parent's own folder; roots (and children of
  // still-archived parents) go back to the project task folder.
  const parentId = findParentId(project, taskId)
  const parent = parentId ? findTaskById(project, parentId) : null
  const destFolder =
    parent?.filePath && !parent.archived
      ? normalizePath(parent.filePath.replace(/\.md$/, ''))
      : projectTaskFolder(project)
  const fileName = task.filePath.split('/').pop()
  if (!fileName) return
  await ensureFolder(app, destFolder)
  const newPath = normalizePath(destFolder + '/' + fileName)

  const file = app.vault.getAbstractFileByPath(task.filePath)
  if (file instanceof TFile) {
    const oldPath = task.filePath
    await app.vault.rename(file, newPath)
    const carried = await moveTaskAttachmentFolder(app, oldPath, newPath)
    if (carried) repointDescendantFiles(task, carried.from, carried.to)
    task.filePath = newPath
    task.archived = false
  }
}

/**
 * Is this case old enough, and settled enough, to move itself into Archive?
 *
 * Pure, so the decision is testable without touching a vault. Every "no" here
 * is deliberate, because this moves the analyst's files on a timer:
 *
 * - TERMINAL BY CONFIG, not by the id `done`: an analyst who renamed or added a
 *   closing status still gets the behaviour they configured.
 * - A `completed` stamp that is missing, unparseable or in the future NEVER
 *   archives. The clock has to be a recorded fact; a case with no closing date
 *   is a case nobody finished.
 * - Whole days, counted from the stamp's own date. `days` is the analyst's
 *   setting, read at sweep time.
 * - DISARMED BY THE LOG. Once an `archived` entry exists, the append-only
 *   record says a human has already decided this case's archive state, and the
 *   timer never touches it again — so a case you pulled back out stays out.
 *   ponytail: one flag, not a comparison of the newest entry against the
 *   completion date. That variant re-arms on a reopen-and-reclose, but a date
 *   against a datetime compares by prefix and a same-day reclose would disarm
 *   permanently anyway. This one fails safe: archive it by hand.
 * - Already archived is a no-op.
 */
export function dueForAutoArchive(task: Task, statuses: StatusConfig[], days: number, now: string): boolean {
  if (task.archived) return false
  if (!isTerminalStatus(task.status, statuses)) return false
  if (task.activity.some((a) => a.field === 'archived')) return false
  const closed = parsePlainDate(task.completed)
  const today_ = parsePlainDate(now)
  if (!closed || !today_) return false
  const age = today_.since(closed).days
  return age >= days
}

/** Today's plain date, for callers that only need the sweep's clock. */
export function archiveToday(): string {
  return today().toString()
}
