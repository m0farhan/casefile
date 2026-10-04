import { guardVerdictOnClose } from '../../soc/verdictGuard'
import { ButtonComponent, ExtraButtonComponent, Menu, Notice } from 'obsidian'
import type { Task } from '../../types'
import { flattenTasks, collectAllAssignees, collectAllTags } from '../../store'
import { STATUS_STAMPED_FIELDS, undoOfStatusChange } from '../../store/ProjectStore'
import { findTaskById } from '../../store/TaskIndex'
import { formatBadgeText, isTerminalStatus } from '../../utils'
import { today } from '../../dates'
import { promptText } from '../../ui/ModalFactory'
import { showUndoNotice } from '../../ui/undoNotice'
import { TaskPickerModal } from '../../modals/PickerModals'
import type { TableContext } from './TableRenderer'
import { updateSelectAllCheckbox } from './TableRow'

export type BulkAction =
  | { type: 'set-assignee'; assignee: string }
  | { type: 'set-tag'; tag: string }
  | { type: 'set-due-date'; due: string }
  | { type: 'set-progress'; progress: number }
  | { type: 'set-parent'; parentId: string }
  | { type: 'remove-parent' }
  | { type: 'archive' }
  | { type: 'unarchive' }
  | { type: 'delete' }

export interface BulkActionBarOpts {
  ctx: TableContext
  onAction: (action: BulkAction) => void
}

/**
 * Render or update the bulk action bar.
 * Shows when selectedTaskIds.size > 0, hidden otherwise.
 */
export function renderBulkActionBar(opts: BulkActionBarOpts): void {
  const { ctx, onAction } = opts
  const existing = ctx.container.querySelector('.pm-bulk-bar')

  if (ctx.state.selectedTaskIds.size === 0) {
    existing?.remove()
    return
  }

  // Reuse existing bar or create a new one
  const bar = existing ?? createBar(ctx.container)
  updateBarContent(bar as HTMLElement, ctx, onAction)
}

function createBar(container: HTMLElement): HTMLElement {
  const bar = createDiv({ cls: 'pm-bulk-bar' })
  container.prepend(bar)
  return bar
}

function updateBarContent(bar: HTMLElement, ctx: TableContext, onAction: (a: BulkAction) => void): void {
  bar.empty()
  const count = ctx.state.selectedTaskIds.size

  // Left section: count + actions
  const left = bar.createDiv('pm-bulk-bar-left')
  left.createSpan({ text: `${count} selected`, cls: 'pm-bulk-bar-count' })

  // Status, severity and verdict are applied only through runBulkPatch, never
  // onAction: every bulk status change passes the verdict guard (CP-01) and
  // gets an exact undo.
  new ButtonComponent(left).setButtonText('Set status').onClick((e) => {
    const menu = new Menu()
    for (const s of ctx.statuses) {
      menu.addItem((item) =>
        item.setTitle(formatBadgeText(s.icon, s.label)).onClick(() => runBulkPatch(ctx, { status: s.id }))
      )
    }
    menu.showAtMouseEvent(e)
  })

  new ButtonComponent(left).setButtonText('Set severity').onClick((e) => {
    const menu = new Menu()
    for (const s of ctx.plugin.store.configFor(ctx.project).severities) {
      menu.addItem((item) =>
        item.setTitle(formatBadgeText(s.icon, s.label)).onClick(() => runBulkPatch(ctx, { severity: s.id }))
      )
    }
    menu.addSeparator()
    menu.addItem((item) => item.setTitle('Clear severity').onClick(() => runBulkPatch(ctx, { severity: '' })))
    menu.showAtMouseEvent(e)
  })

  // A plain board records no verdict, so it gets no verdict button.
  if (ctx.boardType !== 'plain') {
    new ButtonComponent(left).setButtonText('Set verdict').onClick((e) => {
      const menu = new Menu()
      for (const v of ctx.plugin.store.configFor(ctx.project).verdicts) {
        menu.addItem((item) =>
          item.setTitle(formatBadgeText(v.icon, v.label)).onClick(() => runBulkPatch(ctx, { verdict: v.id }))
        )
      }
      menu.addSeparator()
      menu.addItem((item) => item.setTitle('Clear verdict').onClick(() => runBulkPatch(ctx, { verdict: '' })))
      menu.showAtMouseEvent(e)
    })
  }

  // Assignee button
  new ButtonComponent(left).setButtonText('Set assignee').onClick((e) => {
    const menu = new Menu()
    const allMembers = collectAllAssignees(ctx.project.tasks, [
      ...ctx.project.teamMembers,
      ...ctx.plugin.settings.globalTeamMembers
    ])
    for (const m of allMembers) {
      menu.addItem((item) => item.setTitle(m).onClick(() => onAction({ type: 'set-assignee', assignee: m })))
    }
    menu.addSeparator()
    menu.addItem((item) =>
      item.setTitle('+ new assignee...').onClick(async () => {
        const name = await promptText(ctx.plugin.app, 'Enter assignee name:', 'Name')
        if (name) onAction({ type: 'set-assignee', assignee: name })
      })
    )
    menu.addSeparator()
    menu.addItem((item) =>
      item.setTitle('Clear assignees').onClick(() => onAction({ type: 'set-assignee', assignee: '' }))
    )
    menu.showAtMouseEvent(e)
  })

  // Tag button
  new ButtonComponent(left).setButtonText('Set tag').onClick((e) => {
    const menu = new Menu()
    const allTags = collectAllTags(ctx.project.tasks)
    for (const t of allTags) {
      menu.addItem((item) => item.setTitle(t).onClick(() => onAction({ type: 'set-tag', tag: t })))
    }
    menu.addSeparator()
    menu.addItem((item) =>
      item.setTitle('+ new tag...').onClick(async () => {
        const tag = await promptText(ctx.plugin.app, 'Enter tag:', 'Tag')
        if (tag) onAction({ type: 'set-tag', tag })
      })
    )
    menu.addSeparator()
    menu.addItem((item) => item.setTitle('Clear tags').onClick(() => onAction({ type: 'set-tag', tag: '' })))
    menu.showAtMouseEvent(e)
  })

  // Due Date button
  new ButtonComponent(left).setButtonText('Set due date').onClick((e) => {
    const menu = new Menu()
    const now = today()
    const ahead = (days: number) => now.add({ days }).toString()
    menu.addItem((item) =>
      item.setTitle(`Today (${ahead(0)})`).onClick(() => onAction({ type: 'set-due-date', due: ahead(0) }))
    )
    menu.addItem((item) =>
      item.setTitle(`Tomorrow (${ahead(1)})`).onClick(() => onAction({ type: 'set-due-date', due: ahead(1) }))
    )
    menu.addItem((item) =>
      item.setTitle(`In 1 week (${ahead(7)})`).onClick(() => onAction({ type: 'set-due-date', due: ahead(7) }))
    )
    menu.addItem((item) =>
      item.setTitle(`In 2 weeks (${ahead(14)})`).onClick(() => onAction({ type: 'set-due-date', due: ahead(14) }))
    )
    menu.addSeparator()
    menu.addItem((item) =>
      item.setTitle('Pick date...').onClick(() => {
        const input = activeDocument.createEl('input')
        input.type = 'date'
        input.addClass('pm-offscreen')
        activeDocument.body.appendChild(input)
        input.addEventListener('change', () => {
          if (input.value) onAction({ type: 'set-due-date', due: input.value })
          input.remove()
        })
        input.addEventListener('blur', () => window.setTimeout(() => input.remove(), 200))
        input.showPicker()
      })
    )
    menu.addSeparator()
    menu.addItem((item) => item.setTitle('Clear due date').onClick(() => onAction({ type: 'set-due-date', due: '' })))
    menu.showAtMouseEvent(e)
  })

  // Progress button
  new ButtonComponent(left).setButtonText('Set progress').onClick((e) => {
    const menu = new Menu()
    for (const pct of [0, 25, 50, 75, 100]) {
      menu.addItem((item) => item.setTitle(`${pct}%`).onClick(() => onAction({ type: 'set-progress', progress: pct })))
    }
    menu.showAtMouseEvent(e)
  })

  // Set parent / Remove parent buttons
  new ButtonComponent(left).setButtonText('Set parent').onClick(() => {
    const selectedIdSet = new Set(ctx.state.selectedTaskIds)
    // Collect all descendants of selected tasks to prevent circular refs
    const excludedIds = new Set<string>(selectedIdSet)
    for (const id of selectedIdSet) {
      const task = findTaskById(ctx.project, id)
      if (task) {
        for (const ft of flattenTasks(task.subtasks)) {
          excludedIds.add(ft.task.id)
        }
      }
    }
    const candidates = flattenTasks(ctx.project.tasks)
      .filter((ft) => !excludedIds.has(ft.task.id))
      .map((ft) => ft.task)
    const modal = new TaskPickerModal(ctx.plugin.app, candidates, (chosen) => {
      onAction({ type: 'set-parent', parentId: chosen.id })
    })
    modal.open()
  })

  new ButtonComponent(left).setButtonText('Remove parent').onClick(() => onAction({ type: 'remove-parent' }))

  // Archive / Unarchive button — show based on selected tasks' state
  const selectedIds = [...ctx.state.selectedTaskIds]
  const selectedTasks = selectedIds.map((id) => findTaskById(ctx.project, id)).filter(Boolean) as Task[]
  const hasArchived = selectedTasks.some((t) => t.archived)
  const hasNonArchived = selectedTasks.some((t) => !t.archived)

  if (hasNonArchived) {
    new ButtonComponent(left).setButtonText('Archive').onClick(() => onAction({ type: 'archive' }))
  }
  if (hasArchived) {
    new ButtonComponent(left).setButtonText('Unarchive').onClick(() => onAction({ type: 'unarchive' }))
  }

  // Delete button
  new ButtonComponent(left)
    .setButtonText('Delete')
    .setWarning()
    .onClick(() => onAction({ type: 'delete' }))

  // Right section: clear selection
  const right = bar.createDiv('pm-bulk-bar-right')
  new ExtraButtonComponent(right)
    .setIcon('x')
    .setTooltip('Clear selection')
    .onClick(() => {
      ctx.state.selectedTaskIds.clear()
      if (ctx.state.tableBody) {
        const cbs = ctx.state.tableBody.querySelectorAll('.pm-select-checkbox')
        cbs.forEach((checkbox) => {
          ;(checkbox as HTMLInputElement).checked = false
        })
      }
      updateSelectAllCheckbox(ctx.state)
      renderBulkActionBar({ ctx, onAction })
    })
}

/**
 * Apply a status, severity or verdict patch to the selection through
 * store.updateTasks (which activity-stamps severity and verdict), with an undo
 * that restores each task's captured prior values through that same path.
 *
 * A bulk close runs the verdict guard ONCE for all selected incidents without
 * a verdict (CP-01); restoring prior values never moves a task INTO terminal
 * without a verdict it already had — no re-prompt on undo.
 */
export async function runBulkPatch(ctx: TableContext, patch: Partial<Task>): Promise<void> {
  // A verdict belongs to incidents only: other selected tasks are left out of
  // the write, the undo and the count, so the notice counts what changed.
  const ids = [...ctx.state.selectedTaskIds].filter(
    (id) => patch.verdict === undefined || findTaskById(ctx.project, id)?.issueType === 'incident'
  )
  if (!ids.length) {
    if (patch.verdict !== undefined) new Notice('No incidents selected: a verdict is recorded on incidents only')
    return
  }
  try {
    let verdict: string | undefined
    if (patch.status !== undefined && isTerminalStatus(patch.status, ctx.statuses)) {
      const unverdicted = ids
        .map((id) => findTaskById(ctx.project, id))
        .filter((t): t is Task => !!t && t.issueType === 'incident' && !t.verdict)
      if (unverdicted.length) {
        const extra = await guardVerdictOnClose(
          ctx.plugin,
          ctx.project,
          unverdicted[0],
          patch.status,
          unverdicted.length
        )
        if (extra === null) return // cancelled: the whole bulk change is dropped
        verdict = extra.verdict
      }
    }
    // Capture each task's prior values of the patched fields BEFORE the write.
    // A status change also moves the stamps the store sets beside it (the
    // completion date, the Done fill of progress and the incident
    // response/resolution times), so those are captured too: undoing a close
    // must not leave the SLA clock stopped or the bar full.
    const keys = [
      ...Object.keys(patch),
      ...(verdict ? ['verdict'] : []),
      ...(patch.status !== undefined ? STATUS_STAMPED_FIELDS : [])
    ] as (keyof Task)[]
    const prior = new Map<string, Partial<Task>>()
    for (const id of ids) {
      const t = findTaskById(ctx.project, id)
      if (t) prior.set(id, Object.fromEntries(keys.map((k) => [k, t[k]])))
    }
    if (verdict) {
      const v = verdict
      await ctx.plugin.store.updateTasks(ctx.project, ids, (t) =>
        t.issueType === 'incident' && !t.verdict ? { ...patch, verdict: v } : patch
      )
    } else {
      await ctx.plugin.store.updateTasks(ctx.project, ids, patch)
    }
    if (patch.status !== undefined) {
      const { statuses } = ctx.plugin.store.configFor(ctx.project)
      for (const [id, prev] of prior) {
        const after = findTaskById(ctx.project, id)
        if (after) undoOfStatusChange(prev, after, statuses)
      }
    }
    ctx.state.selectedTaskIds.clear()
    await ctx.onRefresh()
    const n = prior.size
    showUndoNotice(`Updated ${n} task${n === 1 ? '' : 's'}`, async () => {
      await ctx.plugin.store.updateTasks(ctx.project, [...prior.keys()], (t) => prior.get(t.id) ?? null)
      await ctx.onRefresh()
    })
  } catch (err) {
    console.error('Bulk action failed', err)
    new Notice('Bulk action failed. Please try again.')
    await ctx.onRefresh()
  }
}
