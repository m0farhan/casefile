import type { App } from 'obsidian'
import { TFile, normalizePath } from 'obsidian'
import type { Project } from '../types'
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
