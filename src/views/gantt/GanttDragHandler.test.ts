import { describe, expect, it, vi } from 'vitest'
import type PMPlugin from '../../main'
import type { UndoEntry } from '../../main'
import { today } from '../../dates'
import { rebuildTaskIndex } from '../../store/TaskIndex'
import { makeProject, makeTask, type Project, type Task } from '../../types'
import { attachBarMove, makeDragState } from './GanttDragHandler'
import { buildTimelineConfig, dateToX, getSnapPoints } from './TimelineConfig'

type Fn = (e: Record<string, unknown>) => void

/** Just the element surface a bar drag touches. */
class FakeEl {
  attrs = new Map<string, string>()
  listeners: { type: string; fn: Fn }[] = []
  classList = { add: (): void => {}, remove: (): void => {} }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v)
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k)
  }
  querySelector(): null {
    return null
  }
  querySelectorAll(): never[] {
    return []
  }
  addEventListener(type: string, fn: Fn): void {
    this.listeners.push({ type, fn })
  }
  removeEventListener(type: string, fn: Fn): void {
    this.listeners = this.listeners.filter((l) => l.type !== type || l.fn !== fn)
  }
  fire(type: string, e: Record<string, unknown> = {}): void {
    const ev = { button: 0, preventDefault: (): void => {}, stopPropagation: (): void => {}, ...e }
    for (const l of this.listeners.slice()) if (l.type === type) l.fn(ev)
  }
}

describe('Gantt bar drag undo entry', () => {
  it('names the case and board, and refuses once the case is gone', async () => {
    const doc = new FakeEl()
    vi.stubGlobal('activeDocument', doc)
    const day = (n: number): string => today().add({ days: n }).toString()
    const task: Task = makeTask({ title: 'Case A', start: day(2), due: day(4) })
    const project: Project = Object.assign(makeProject('Queue', 'Queue/Queue.md'), { tasks: [task] })
    rebuildTaskIndex(project)
    const entries: UndoEntry[] = []
    const updateTask = vi.fn<() => Promise<void>>(async () => {})
    const plugin = {
      store: {
        updateTask,
        scheduleAfterChange: async () => 0,
        configFor: () => ({ autoSchedule: false })
      },
      pushUndo: (e: UndoEntry) => entries.push(e)
    } as unknown as PMPlugin
    const cfg = buildTimelineConfig([task], 'day')
    const rect = new FakeEl()
    const x = dateToX(cfg, today().add({ days: 2 }))
    attachBarMove(
      rect as unknown as SVGRectElement,
      new FakeEl() as unknown as SVGGElement,
      task,
      x,
      cfg.dayWidth * 3,
      cfg,
      getSnapPoints(cfg),
      makeDragState(),
      plugin,
      project,
      async () => {}
    )
    rect.fire('mousedown', { clientX: 0 })
    doc.fire('mousemove', { clientX: cfg.dayWidth * 2 })
    doc.fire('mouseup')
    await vi.waitFor(() => expect(entries).toHaveLength(1))
    expect(entries[0].label).toBe('dates of "Case A" on Queue')

    project.tasks = []
    rebuildTaskIndex(project)
    updateTask.mockClear()
    await expect(entries[0].undo()).rejects.toThrow('no longer on this board')
    await expect(entries[0].redo()).rejects.toThrow('no longer on this board')
    expect(updateTask).not.toHaveBeenCalled()
  })
})
