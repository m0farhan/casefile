import { Notice } from 'obsidian'
import type PMPlugin from '../../main'
import type { Project, Task } from '../../types'
import { safeAsync } from '../../utils'
import { parsePlainDate } from '../../dates'
import type { TimelineCfg } from './TimelineConfig'
import { dateToX, xToDate, snapX } from './TimelineConfig'

export interface DragState {
  isDragging: boolean
  dragSide: 'left' | 'right' | 'move' | null
  dragTask: Task | null
  dragStartX: number
  dragBarEl: SVGRectElement | null
  dragInitialX: number
  dragInitialW: number
  dragMoved: boolean
}

export function makeDragState(): DragState {
  return {
    isDragging: false,
    dragSide: null,
    dragTask: null,
    dragStartX: 0,
    dragBarEl: null,
    dragInitialX: 0,
    dragInitialW: 0,
    dragMoved: false
  }
}

export function attachDragHandle(
  handle: SVGRectElement,
  side: 'left' | 'right',
  task: Task,
  rect: SVGRectElement,
  barGroup: SVGGElement,
  x: number,
  width: number,
  cfg: TimelineCfg,
  snapPoints: number[],
  drag: DragState,
  plugin: PMPlugin,
  project: Project,
  onRefresh: () => Promise<void>
): () => void {
  let activeCleanup: (() => void) | null = null

  handle.addEventListener('mousedown', (e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    drag.isDragging = true
    drag.dragMoved = false
    drag.dragSide = side
    drag.dragTask = task
    drag.dragStartX = e.clientX
    drag.dragBarEl = rect
    drag.dragInitialX = x
    drag.dragInitialW = width

    const snapThreshold = cfg.dayWidth * 0.4
    // The left handle may carry start up to the due day and no further, so a
    // drag can never save a start after the due date. A start-only task has no
    // bound. The due day's x sits on a day boundary, so the snap on release
    // leaves it alone and the saved start is exactly the due date.
    const due = parsePlainDate(task.due)
    const maxLeftX = due ? dateToX(cfg, due) : Infinity

    const onMove = (ev: MouseEvent) => {
      if (!drag.isDragging || !drag.dragBarEl) return
      const dx = ev.clientX - drag.dragStartX
      if (Math.abs(dx) > 3) drag.dragMoved = true
      let newX = drag.dragInitialX
      let newW: number
      if (drag.dragSide === 'left') {
        newX = Math.max(0, drag.dragInitialX + dx)
        newX = Math.min(snapX(newX, snapPoints, snapThreshold), maxLeftX)
        newW = drag.dragInitialX + drag.dragInitialW - newX
      } else {
        newW = drag.dragInitialW + dx
        const rightEdge = snapX(newX + newW, snapPoints, snapThreshold)
        newW = rightEdge - newX
      }
      newW = Math.max(cfg.dayWidth, newW)
      drag.dragBarEl.setAttribute('x', String(newX))
      drag.dragBarEl.setAttribute('width', String(newW))
      repositionBarChildren(barGroup, newX, newW)
    }

    const onUp = safeAsync(async () => {
      activeDocument.removeEventListener('mousemove', onMove)
      activeDocument.removeEventListener('mouseup', onUp)
      activeCleanup = null
      if (!drag.isDragging || !drag.dragTask || !drag.dragBarEl) return
      drag.isDragging = false
      if (!drag.dragMoved) return

      const finalX = parseFloat(drag.dragBarEl.getAttribute('x') ?? '0')
      const finalW = parseFloat(drag.dragBarEl.getAttribute('width') ?? '0')

      const snappedX = snapX(finalX, snapPoints, snapThreshold)
      const snappedRight = snapX(finalX + finalW, snapPoints, snapThreshold)

      const taskId = drag.dragTask.id
      const oldStart = drag.dragTask.start
      const oldDue = drag.dragTask.due

      const patch: Partial<Task> = {}
      if (drag.dragSide === 'left') {
        patch.start = xToDate(cfg, snappedX).toString()
      } else {
        patch.due = xToDate(cfg, snappedRight).subtract({ days: 1 }).toString()
      }
      try {
        await plugin.store.updateTask(project, taskId, patch)
      } catch (err) {
        drag.dragBarEl.setAttribute('x', String(drag.dragInitialX))
        drag.dragBarEl.setAttribute('width', String(drag.dragInitialW))
        repositionBarChildren(barGroup, drag.dragInitialX, drag.dragInitialW)
        new Notice('Failed to save date change. Please try again.')
        console.error('GanttDragHandler: save failed', err)
        return
      }
      const redoPatch: Partial<Task> = { ...patch }
      plugin.pushUndo({
        undo: async () => {
          await plugin.store.updateTask(project, taskId, { start: oldStart, due: oldDue })
          if (plugin.store.configFor(project).autoSchedule) {
            new Notice('Dates reverted. Dependent task dates may need adjustment.')
          }
          await onRefresh()
        },
        redo: async () => {
          await plugin.store.updateTask(project, taskId, redoPatch)
          await plugin.store.scheduleAfterChange(project, taskId)
          await onRefresh()
        }
      })
      await plugin.store.scheduleAfterChange(project, drag.dragTask.id)
      await onRefresh()
    })

    activeDocument.addEventListener('mousemove', onMove)
    activeDocument.addEventListener('mouseup', onUp)
    activeCleanup = () => {
      activeDocument.removeEventListener('mousemove', onMove)
      activeDocument.removeEventListener('mouseup', onUp)
    }
  })

  return () => {
    if (activeCleanup) {
      activeCleanup()
      activeCleanup = null
      drag.isDragging = false
      drag.dragBarEl = null
    }
  }
}

export function attachBarMove(
  rect: SVGRectElement,
  barGroup: SVGGElement,
  task: Task,
  x: number,
  width: number,
  cfg: TimelineCfg,
  snapPoints: number[],
  drag: DragState,
  plugin: PMPlugin,
  project: Project,
  onRefresh: () => Promise<void>
): () => void {
  let activeCleanup: (() => void) | null = null

  rect.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    drag.isDragging = true
    drag.dragMoved = false
    drag.dragSide = 'move'
    drag.dragTask = task
    drag.dragStartX = e.clientX
    drag.dragBarEl = rect
    drag.dragInitialX = x
    drag.dragInitialW = width

    const snapThreshold = cfg.dayWidth * 0.4
    let lastSnappedX = x

    const onMove = (ev: MouseEvent) => {
      if (!drag.isDragging || !drag.dragBarEl) return
      const dx = ev.clientX - drag.dragStartX
      if (Math.abs(dx) > 3) drag.dragMoved = true
      lastSnappedX = Math.max(0, drag.dragInitialX + dx)
      lastSnappedX = snapX(lastSnappedX, snapPoints, snapThreshold)
      const translateX = lastSnappedX - drag.dragInitialX
      barGroup.setAttribute('transform', `translate(${translateX}, 0)`)
    }

    const onUp = safeAsync(async () => {
      activeDocument.removeEventListener('mousemove', onMove)
      activeDocument.removeEventListener('mouseup', onUp)
      rect.classList.remove('pm-gantt-bar-grabbing')
      activeCleanup = null
      if (!drag.isDragging || !drag.dragTask || !drag.dragBarEl) return
      drag.isDragging = false
      if (!drag.dragMoved) {
        barGroup.removeAttribute('transform')
        return
      }

      const taskId = drag.dragTask.id
      const oldStart = drag.dragTask.start
      const oldDue = drag.dragTask.due

      const snappedX = snapX(lastSnappedX, snapPoints, snapThreshold)
      const snappedRight = snapX(snappedX + drag.dragInitialW, snapPoints, snapThreshold)

      const newStart = xToDate(cfg, snappedX)
      const newEnd = xToDate(cfg, snappedRight).subtract({ days: 1 })

      const patch: Partial<Task> = {
        start: newStart.toString(),
        due: newEnd.toString()
      }
      try {
        await plugin.store.updateTask(project, taskId, patch)
      } catch (err) {
        barGroup.removeAttribute('transform')
        new Notice('Failed to save date change. Please try again.')
        console.error('GanttDragHandler: move save failed', err)
        return
      }
      const redoPatch: Partial<Task> = { ...patch }
      plugin.pushUndo({
        undo: async () => {
          await plugin.store.updateTask(project, taskId, { start: oldStart, due: oldDue })
          if (plugin.store.configFor(project).autoSchedule) {
            new Notice('Dates reverted. Dependent task dates may need adjustment.')
          }
          await onRefresh()
        },
        redo: async () => {
          await plugin.store.updateTask(project, taskId, redoPatch)
          await plugin.store.scheduleAfterChange(project, taskId)
          await onRefresh()
        }
      })
      await plugin.store.scheduleAfterChange(project, drag.dragTask.id)
      await onRefresh()
    })

    rect.classList.add('pm-gantt-bar-grabbing')
    activeDocument.addEventListener('mousemove', onMove)
    activeDocument.addEventListener('mouseup', onUp)
    activeCleanup = () => {
      activeDocument.removeEventListener('mousemove', onMove)
      activeDocument.removeEventListener('mouseup', onUp)
    }
  })

  return () => {
    if (activeCleanup) {
      activeCleanup()
      activeCleanup = null
      drag.isDragging = false
      drag.dragBarEl = null
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const HANDLE_W = 8

/** Reposition label, handles, and progress overlay to match new bar x/width during resize. */
function repositionBarChildren(barGroup: SVGGElement, newX: number, newW: number): void {
  const label = barGroup.querySelector('.pm-gantt-bar-label')
  if (label) {
    label.setAttribute('x', String(newX + 8))
    if (newW <= 55) {
      label.setAttribute('visibility', 'hidden')
    } else {
      label.removeAttribute('visibility')
    }
  }

  const handles = barGroup.querySelectorAll('.pm-gantt-drag-handle')
  if (handles.length === 2) {
    handles[0].setAttribute('x', String(newX))
    handles[1].setAttribute('x', String(newX + newW - HANDLE_W))
  }

  const progress = barGroup.querySelector('.pm-gantt-bar-progress')
  if (progress) {
    progress.setAttribute('x', String(newX))
  }

  const icon = barGroup.querySelector('.pm-gantt-bar-icon')
  if (icon) {
    icon.setAttribute('x', String(newX + newW + 4))
  }
}
