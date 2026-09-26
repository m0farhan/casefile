import { TFile, Menu, ButtonComponent } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, Task, StatusConfig } from '../types'
import { safeAsync, isTerminalStatus } from '../utils'
import { confirmDialog, openProjectModal, promptText } from '../ui/ModalFactory'
import { parentFolderOf, projectFolderForProjectPath, taskFolderForProjectPath } from '../store/layout'
import { flattenTasks } from '../store/TaskTreeOps'
import { NestedBoardError } from '../store'
import { EmptyState } from '../ui/primitives/EmptyState'
import { ProjectCard } from '../ui/composites/ProjectCard'

export interface ProjectListContext {
  plugin: PMPlugin
  toolbarEl: HTMLElement
  contentEl: HTMLElement
  isStale: () => boolean
  openProjectFile: (file: TFile) => Promise<void>
}

export function renderProjectListToolbar(ctx: ProjectListContext): void {
  ctx.toolbarEl.empty()
  ctx.toolbarEl.createEl('h2', { text: 'Boards', cls: 'pm-toolbar-title' })

  new ButtonComponent(ctx.toolbarEl)
    .setButtonText('+ new board')
    .setCta()
    .onClick(() => openCreateProjectModal(ctx))
}

/** Render the board cards; returns the boards drawn, so the pane knows which paths to watch. */
export async function renderProjectListContent(ctx: ProjectListContext): Promise<Project[]> {
  const projects = await ctx.plugin.store.loadAllProjects(ctx.plugin.settings.projectsFolder)
  if (ctx.isStale()) return projects
  ctx.contentEl.empty()

  if (projects.length === 0) {
    new EmptyState(ctx.contentEl)
      .setIcon('📋')
      .setTitle('No boards yet')
      .setBody(
        'A board is a set of columns with its own cards. Make one for a case queue, an investigation, or a list of goals.'
      )
      .setAction('+ new board', () => openCreateProjectModal(ctx))
    return projects
  }

  const grid = ctx.contentEl.createDiv('pm-project-grid')
  for (const project of projects) {
    const statuses = ctx.plugin.store.configFor(project).statuses
    const total = countTasks(project.tasks, false, statuses)
    const done = countTasks(project.tasks, true, statuses)
    new ProjectCard(grid, {
      title: project.title,
      icon: project.icon,
      color: project.color,
      tasksDone: done,
      tasksTotal: total,
      location: parentFolderOf(project.filePath),
      path: project.filePath,
      onClick: safeAsync(async () => {
        const file = ctx.plugin.app.vault.getAbstractFileByPath(project.filePath)
        if (file instanceof TFile) await ctx.openProjectFile(file)
      }),
      onContextMenu: (at) => openProjectContextMenu(ctx, project, projects, at)
    })
  }
  return projects
}

function openCreateProjectModal(ctx: ProjectListContext): void {
  openProjectModal(ctx.plugin, {
    onSave: async (project) => {
      const file = ctx.plugin.app.vault.getAbstractFileByPath(project.filePath)
      if (file instanceof TFile) await ctx.openProjectFile(file)
    }
  })
}

function openProjectContextMenu(
  ctx: ProjectListContext,
  project: Project,
  boards: Project[],
  at: { x: number; y: number }
): void {
  const menu = new Menu()
  menu.addItem((item) =>
    item
      .setTitle('Move to folder…')
      .setIcon('folder-input')
      .onClick(
        safeAsync(async () => {
          const current = parentFolderOf(project.filePath)
          const next = await promptText(
            ctx.plugin.app,
            `Folder for "${project.title}". Empty means the vault root; the board keeps its own folder inside it, cases and all.`,
            'Vault root',
            { value: current, allowEmpty: true }
          )
          if (next === null) return
          const base = next.trim().replace(/^\/+|\/+$/g, '')
          if (base === current) return
          if (await ctx.plugin.moveProjectToFolder(project, base)) {
            await renderProjectListContent(ctx)
          }
        })
      )
  )

  menu.addItem((item) =>
    item
      .setTitle('Edit board')
      .setIcon('settings')
      .onClick(() => {
        openProjectModal(ctx.plugin, {
          project,
          onSave: async () => {
            await renderProjectListContent(ctx)
          }
        })
      })
  )
  menu.addItem((item) =>
    item
      .setTitle('Delete board')
      .setIcon('trash')
      .onClick(
        safeAsync(async () => {
          // Trashes the whole board folder, and a board filed inside it would
          // go too, unnamed by the confirm below: refuse first, naming it.
          const folder = projectFolderForProjectPath(project.filePath) ?? taskFolderForProjectPath(project.filePath)
          const nested = boards.filter((b) => b.filePath !== project.filePath && b.filePath.startsWith(`${folder}/`))
          if (nested.length) {
            const names = nested.map((b) => `"${b.title}"`).join(', ')
            ctx.plugin.showNotice(
              `Not deleting "${project.title}": ${names} ${nested.length === 1 ? 'is a board' : 'are boards'} filed inside its folder. Move ${nested.length === 1 ? 'it' : 'them'} out first.`,
              8000
            )
            return
          }
          // Trashes the whole case folder — confirm like every task delete does (UX-02).
          const n = flattenTasks(project.tasks).length
          const msg = `Delete "${project.title}" and its ${n} task${n === 1 ? '' : 's'}? Files go to the trash.`
          if (!(await confirmDialog(ctx.plugin.app, msg))) return
          try {
            await ctx.plugin.store.deleteProject(project)
          } catch (e) {
            // The store's own check, for a nested board this list did not show.
            if (!(e instanceof NestedBoardError)) throw e
            ctx.plugin.showNotice(e.message, 8000)
            return
          }
          await renderProjectListContent(ctx)
        })
      )
  )
  menu.showAtPosition(at)
}

function countTasks(tasks: Task[], doneOnly: boolean, statuses: StatusConfig[]): number {
  let n = 0
  for (const t of tasks) {
    if (!doneOnly || isTerminalStatus(t.status, statuses)) n++
    n += countTasks(t.subtasks, doneOnly, statuses)
  }
  return n
}
