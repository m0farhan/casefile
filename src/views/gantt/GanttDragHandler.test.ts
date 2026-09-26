import { describe, expect, it, vi } from 'vitest'
import type PMPlugin from '../../main'
import type { UndoEntry } from '../../main'
import { today } from '../../dates'
import { rebuildTaskIndex } from '../../store/TaskIndex'
import { makeProject, makeTask, type Project, type Task } from '../../types'
import { attachBarMove, makeDragState } from './GanttDragHandler'
import { buildTimelineConfig, dateToX, getSnapPoints } from './TimelineConfig'

const { notices } = vi.hoisted(() => ({ notices: [] as string[] }))
vi.mock('obsidian', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Notice: class {
    constructor(message: string) {
      notices.push(message)
    }
    hide(): void {}
  }
}))

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

/** Drags Case A's bar two days later on a board of its own, recording the undo entry it pushes. */
async function dragCaseA(store: Record<string, unknown>): Promise<{ entries: UndoEntry[]; project: Project }> {
  const doc = new FakeEl()
  vi.stubGlobal('activeDocument', doc)
  const day = (n: number): string => today().add({ days: n }).toString()
  const task: Task = makeTask({ title: 'Case A', start: day(2), due: day(4) })
  const project: Project = Object.assign(makeProject('Queue', 'Queue/Queue.md'), { tasks: [task] })
  rebuildTaskIndex(project)
  const entries: UndoEntry[] = []
  const plugin = {
    store: { updateTask: async () => {}, scheduleAfterChange: async () => 0, ...store },
    pushUndo: (e: UndoEntry) => entries.push(e)
  } as unknown as PMPlugin
  const cfg = buildTimelineConfig([task], 'day')
  const rect = new FakeEl()
  const x = dateToX(cfg, today().add({ days: 2 }))
  const onRefresh = vi.fn<() => Promise<void>>(async () => {})
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
    onRefresh
  )
  rect.fire('mousedown', { clientX: 0 })
  doc.fire('mousemove', { clientX: cfg.dayWidth * 2 })
  doc.fire('mouseup')
  // The drag is done once the view refreshes after scheduling.
  await vi.waitFor(() => expect(onRefresh).toHaveBeenCalled())
  return { entries, project }
}

describe('Gantt bar drag undo entry', () => {
  it('names the case and board, and refuses once the case is gone', async () => {
    const updateTask = vi.fn<() => Promise<void>>(async () => {})
    const { entries, project } = await dragCaseA({ updateTask })
    expect(entries).toHaveLength(1)
    expect(entries[0].label).toBe('dates of "Case A" on Queue')

    project.tasks = []
    rebuildTaskIndex(project)
    updateTask.mockClear()
    await expect(entries[0].undo()).rejects.toThrow('no longer on this board')
    await expect(entries[0].redo()).rejects.toThrow('no longer on this board')
    expect(updateTask).not.toHaveBeenCalled()
  })

  it('leaves the one undo message to the plugin, and it names the tasks auto-scheduling moved', async () => {
    const { entries } = await dragCaseA({
      scheduleAfterChange: async () => 2,
      configFor: () => ({ autoSchedule: true })
    })
    // plugin.replay announces 'Reverted <label>.'; undo put back Case A only.
    expect(entries[0].label).toBe(
      'dates of "Case A" on Queue (auto-scheduling moved 2 tasks after the drag; check their dates)'
    )
    notices.length = 0
    await entries[0].undo()
    expect(notices).toEqual([])
  })
})
