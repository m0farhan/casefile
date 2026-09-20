import { TFile, Menu, ButtonComponent } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, Task, StatusConfig } from '../types'
import { safeAsync, isTerminalStatus } from '../utils'
import { confirmDialog, openProjectModal } from '../ui/ModalFactory'
import { flattenTasks } from '../store/TaskTreeOps'
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
  ctx.toolbarEl.createEl('h2', { text: 'Project manager', cls: 'pm-toolbar-title' })

  new ButtonComponent(ctx.toolbarEl)
    .setButtonText('+ new board')
    .setCta()
    .onClick(() => openCreateProjectModal(ctx))
}

export async function renderProjectListContent(ctx: ProjectListContext): Promise<void> {
  const projects = await ctx.plugin.store.loadAllProjects(ctx.plugin.settings.projectsFolder)
  if (ctx.isStale()) return
  ctx.contentEl.empty()

  if (projects.length === 0) {
    new EmptyState(ctx.contentEl)
      .setIcon('📋')
      .setTitle('No boards yet')
      .setBody(
        'A board is a set of columns with its own cards. Make one for a case queue, an investigation, or a list of goals.'
      )
      .setAction('+ new board', () => openCreateProjectModal(ctx))
    return
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
      onClick: safeAsync(async () => {
        const file = ctx.plugin.app.vault.getAbstractFileByPath(project.filePath)
        if (file instanceof TFile) await ctx.openProjectFile(file)
      }),
      onContextMenu: (e) => openProjectContextMenu(ctx, project, e)
    })
  }
}

function openCreateProjectModal(ctx: ProjectListContext): void {
  openProjectModal(ctx.plugin, {
    onSave: async (project) => {
      const file = ctx.plugin.app.vault.getAbstractFileByPath(project.filePath)
      if (file instanceof TFile) await ctx.openProjectFile(file)
    }
  })
}

function openProjectContextMenu(ctx: ProjectListContext, project: Project, e: MouseEvent): void {
  const menu = new Menu()
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
          // Trashes the whole case folder — confirm like every task delete does (UX-02).
          const n = flattenTasks(project.tasks).length
          const msg = `Delete "${project.title}" and its ${n} task${n === 1 ? '' : 's'}? Files go to the trash.`
          if (!(await confirmDialog(ctx.plugin.app, msg))) return
          await ctx.plugin.store.deleteProject(project)
          await renderProjectListContent(ctx)
        })
      )
  )
  menu.showAtMouseEvent(e)
}

function countTasks(tasks: Task[], doneOnly: boolean, statuses: StatusConfig[]): number {
  let n = 0
  for (const t of tasks) {
    if (!doneOnly || isTerminalStatus(t.status, statuses)) n++
    n += countTasks(t.subtasks, doneOnly, statuses)
  }
  return n
}
