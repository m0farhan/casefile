import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type PMPlugin from '../../main'
import { today } from '../../dates'
import { flattenTasks } from '../../store/TaskTreeOps'
import { makeProject, makeTask, type Project, type Task } from '../../types'
import { openTaskModal } from '../../ui/ModalFactory'
import { attachDragHandle, makeDragState } from './GanttDragHandler'
import { handleLinkDotClick, makeLinkState } from './GanttLinkHandler'
import type { RendererContext } from './GanttRenderer'
import { renderDependencyArrows, renderMilestoneLabels, renderTaskBar, spanX } from './GanttTaskBarRenderer'
import { buildTimelineConfig, dateToX, getSnapPoints } from './TimelineConfig'

// The aliased obsidian stub has no ButtonComponent; the view-layer siblings the
// gantt pulls in become bare stand-ins so only gantt code runs for real.
vi.mock('obsidian', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ButtonComponent: class {
    setButtonText(): this {
      return this
    }
    onClick(): this {
      return this
    }
  }
}))
vi.mock('../../ui/ModalFactory', () => ({ openTaskModal: vi.fn<() => void>() }))
vi.mock('../../ui/composites/addButton', () => ({ renderAddButton: vi.fn<() => void>() }))
vi.mock('../../ui/StatusBadge', () => ({ renderStatusDot: vi.fn<() => void>() }))
vi.mock('../../ui/primitives/SegmentedControl', () => ({ SegmentedControl: vi.fn<() => void>() }))
vi.mock('../../ui/primitives/CollapseToggle', () => ({ CollapseToggle: vi.fn<() => void>() }))
vi.mock('../../ui/primitives/IconButton', () => ({
  IconButton: class {
    setIcon(): this {
      return this
    }
    setTooltip(): this {
      return this
    }
    setRevealOnHover(): this {
      return this
    }
    onClick(): this {
      return this
    }
  }
}))

// -- Minimal fake DOM -------------------------------------------------------
// The suite runs in plain node (no jsdom in this repo), so this models only the
// element surface the gantt renderers and handlers touch.

type Fn = (e: unknown) => void

interface ElInfo {
  cls?: string
  text?: string
  attr?: Record<string, string>
}

class FakeEl {
  tagName: string
  classes = new Set<string>()
  attrs = new Map<string, string>()
  children: FakeEl[] = []
  parent: FakeEl | null = null
  listeners: { type: string; fn: Fn }[] = []
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  textContent = ''
  draggable = false
  isContentEditable = false
  offsetHeight = 0
  clientHeight = 0
  clientWidth = 0
  scrollTop = 0
  scrollLeft = 0
  classList = {
    add: (...cs: string[]): void => this.addClass(...cs),
    remove: (...cs: string[]): void => this.removeClass(...cs),
    contains: (c: string): boolean => this.classes.has(c)
  }

  constructor(tag: string) {
    this.tagName = tag
  }

  get firstChild(): FakeEl | null {
    return this.children[0] ?? null
  }

  createEl(tag: string, info?: ElInfo | string): FakeEl {
    const el = new FakeEl(tag)
    const o = typeof info === 'string' ? { cls: info } : (info ?? {})
    if (o.cls) el.addClass(...o.cls.split(' '))
    if (o.text) el.textContent = o.text
    for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, v)
    return this.appendChild(el)
  }

  createDiv(info?: ElInfo | string): FakeEl {
    return this.createEl('div', info)
  }

  createSpan(info?: ElInfo | string): FakeEl {
    return this.createEl('span', info)
  }

  addClass(...cs: string[]): void {
    for (const c of cs) if (c) this.classes.add(c)
  }

  removeClass(...cs: string[]): void {
    for (const c of cs) this.classes.delete(c)
  }

  setAttribute(k: string, v: string): void {
    if (k === 'class') this.addClass(...v.split(' '))
    this.attrs.set(k, v)
  }

  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null
  }

  removeAttribute(k: string): void {
    this.attrs.delete(k)
  }

  appendChild(el: FakeEl): FakeEl {
    el.parent = this
    this.children.push(el)
    return el
  }

  insertBefore(el: FakeEl, ref: FakeEl | null): FakeEl {
    el.parent = this
    const i = ref ? this.children.indexOf(ref) : -1
    if (i < 0) this.children.push(el)
    else this.children.splice(i, 0, el)
    return el
  }

  empty(): void {
    this.children = []
  }

  matches(sel: string): boolean {
    return sel.split(',').some((s) => {
      const t = s.trim()
      return t.startsWith('.') ? this.classes.has(t.slice(1)) : this.tagName.toLowerCase() === t.toLowerCase()
    })
  }

  closest(sel: string): FakeEl | null {
    return this.matches(sel) ? this : (this.parent?.closest(sel) ?? null)
  }

  querySelectorAll(sel: string): FakeEl[] {
    const out: FakeEl[] = []
    const walk = (el: FakeEl): void => {
      for (const c of el.children) {
        if (c.matches(sel)) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }

  querySelector(sel: string): FakeEl | null {
    return this.querySelectorAll(sel)[0] ?? null
  }

  addEventListener(type: string, fn: Fn): void {
    this.listeners.push({ type, fn })
  }

  removeEventListener(type: string, fn: Fn): void {
    const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn)
    if (i >= 0) this.listeners.splice(i, 1)
  }

  fire(type: string, e: Record<string, unknown> = {}): void {
    const ev = { target: this, preventDefault: (): void => {}, stopPropagation: (): void => {}, ...e }
    for (const l of this.listeners.slice()) if (l.type === type) l.fn(ev)
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 0, height: 0 }
  }
}

class FakeDoc extends FakeEl {
  body = new FakeEl('body')

  createElementNS(_ns: string, tag: string): FakeEl {
    return new FakeEl(tag)
  }
}

let doc = new FakeDoc('#document')
vi.stubGlobal('window', { requestAnimationFrame: (): number => 0 })
vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (): string => '' }))

beforeEach(() => {
  doc = new FakeDoc('#document')
  vi.stubGlobal('activeDocument', doc)
  vi.mocked(openTaskModal).mockClear()
})

// -- Fixtures ---------------------------------------------------------------

const asEl = <T>(el: FakeEl): T => el as unknown as T
const byClass = (root: FakeEl, cls: string): FakeEl[] => root.querySelectorAll(`.${cls}`)
const day = (offset: number): string => today().add({ days: offset }).toString()

// The spies are returned beside the plugin, so tests never pull a method off it unbound.
function fakePlugin(): {
  plugin: PMPlugin
  updateTask: Mock<(project: Project, taskId: string, patch: Partial<Task>) => Promise<void>>
  undoLastAction: Mock<() => Promise<void>>
} {
  const updateTask = vi.fn<(project: Project, taskId: string, patch: Partial<Task>) => Promise<void>>(async () => {})
  const undoLastAction = vi.fn<() => Promise<void>>(async () => {})
  const plugin = {
    settings: { ganttGranularity: 'day', ganttWeekLabel: 'weekNumber', currentUser: '' },
    store: {
      configFor: () => ({ statuses: [], priorities: [], severities: [], autoSchedule: false }),
      updateTask,
      scheduleAfterChange: vi.fn<() => Promise<number>>(async () => 0)
    },
    pushUndo: vi.fn<() => void>(),
    undoLastAction,
    redoLastAction: vi.fn<() => Promise<void>>(async () => {})
  } as unknown as PMPlugin
  return { plugin, updateTask, undoLastAction }
}

function boardWith(tasks: Task[]): Project {
  const project = makeProject('Board', 'Board.md')
  project.tasks = tasks
  return project
}

function rendererCtx(
  tasks: Task[],
  plugin = fakePlugin().plugin
): { ctx: RendererContext; svg: FakeEl; header: FakeEl } {
  const cfg = buildTimelineConfig(tasks, 'day')
  const svg = new FakeEl('svg')
  const header = new FakeEl('svg')
  const ctx: RendererContext = {
    svgEl: asEl(svg),
    headerSvgEl: asEl(header),
    cfg,
    snapPoints: getSnapPoints(cfg),
    plugin,
    project: boardWith(tasks),
    statuses: [],
    flatTasks: flattenTasks(tasks),
    drag: makeDragState(),
    link: makeLinkState(),
    onRefresh: async () => {},
    cleanupFns: []
  }
  return { ctx, svg, header }
}

// -- a54: left handle past the due date -------------------------------------

describe('left resize handle', () => {
  // Drags the left handle by whole days and returns the patch the drop saves.
  async function dragLeft(task: Task, days: number): Promise<Partial<Task>> {
    const { plugin, updateTask } = fakePlugin()
    const { ctx } = rendererCtx([task], plugin)
    const span = spanX(task, ctx.cfg)
    if (!span) throw new Error('fixture task is outside the chart range')
    const handle = new FakeEl('rect')
    attachDragHandle(
      asEl(handle),
      'left',
      task,
      asEl(new FakeEl('rect')),
      asEl(new FakeEl('g')),
      span.left,
      span.right - span.left,
      ctx.cfg,
      ctx.snapPoints,
      ctx.drag,
      plugin,
      ctx.project,
      async () => {}
    )
    handle.fire('mousedown', { clientX: 0 })
    doc.fire('mousemove', { clientX: days * ctx.cfg.dayWidth })
    doc.fire('mouseup')
    await vi.waitFor(() => expect(updateTask).toHaveBeenCalledOnce())
    return updateTask.mock.calls[0][2]
  }

  it('stops at the due date instead of saving a start after it', async () => {
    expect(await dragLeft(makeTask({ start: day(2), due: day(8) }), 10)).toEqual({ start: day(8) })
  })

  it('still moves the start of a start-only task later', async () => {
    expect(await dragLeft(makeTask({ start: day(2), due: '' }), 5)).toEqual({ start: day(7) })
  })
})

// -- a57: transitive dependency loops ---------------------------------------

describe('link dots', () => {
  it('refuses a link that closes a loop through another task', async () => {
    const a = makeTask({ id: 'A', title: 'A' })
    const b = makeTask({ id: 'B', title: 'B', dependencies: ['A'] })
    const c = makeTask({ id: 'C', title: 'C', dependencies: ['B'] })
    const d = makeTask({ id: 'D', title: 'D' })
    const project = boardWith([a, b, c, d])
    const { plugin, updateTask } = fakePlugin()
    const link = makeLinkState()
    const click = (id: string, side: 'left' | 'right'): void =>
      handleLinkDotClick(asEl(new FakeEl('circle')), id, side, link, plugin, project, async () => {})

    // C's output into A's input would make A -> B -> C -> A.
    click('C', 'right')
    click('A', 'left')
    // A link with no loop still saves, so the refusal above is not a dead handler.
    click('C', 'right')
    click('D', 'left')

    await vi.waitFor(() => expect(updateTask).toHaveBeenCalled())
    expect(updateTask.mock.calls).toEqual([[project, 'D', { dependencies: ['C'] }]])
  })
})

// -- a59: arrows from the shapes as drawn -----------------------------------

describe('dependency arrows', () => {
  const arrowEnd = (arrow: FakeEl): number => {
    const parts = (arrow.getAttribute('d') ?? '').trim().split(/\s+/)
    return Number(parts[parts.length - 2])
  }

  it('draws an arrow into a successor that has only a due date', () => {
    const a = makeTask({ id: 'A', start: day(1), due: day(3) })
    const b = makeTask({ id: 'B', start: '', due: day(10), dependencies: ['A'] })
    const { ctx, svg } = rendererCtx([a, b])
    renderDependencyArrows(ctx)
    const arrows = byClass(svg, 'pm-gantt-arrow')
    expect(arrows).toHaveLength(1)
    expect(arrowEnd(arrows[0])).toBe(dateToX(ctx.cfg, today().add({ days: 10 })))
  })

  it('ends a milestone arrow at the diamond, not at a hidden start date', () => {
    const a = makeTask({ id: 'A', start: day(1), due: day(3) })
    // The '+ milestone' button used to save a start of today that the form hides.
    const m = makeTask({ id: 'M', type: 'milestone', start: day(0), due: day(20), dependencies: ['A'] })
    const { ctx, svg } = rendererCtx([a, m])
    renderDependencyArrows(ctx)
    const arrows = byClass(svg, 'pm-gantt-arrow')
    expect(arrows).toHaveLength(1)
    const cx = dateToX(ctx.cfg, today().add({ days: 20 })) + ctx.cfg.dayWidth / 2
    expect(arrowEnd(arrows[0])).toBe(cx - 12)
  })
})

// -- a55: rows with a date the range cannot show ----------------------------

describe('a date outside the chart range', () => {
  it('draws no bar or drag handle and states the stored date instead', () => {
    const near = makeTask({ id: 'N', start: day(1), due: day(3) })
    const far = makeTask({ id: 'F', start: day(1), due: '2206-09-26' })
    const { ctx } = rendererCtx([near, far])
    const g = new FakeEl('g')
    renderTaskBar(asEl(g), far, 1, 0, ctx)
    expect(byClass(g, 'pm-gantt-bar')).toHaveLength(0)
    expect(byClass(g, 'pm-gantt-drag-handle')).toHaveLength(0)
    const notes = byClass(g, 'pm-gantt-out-of-range')
    expect(notes).toHaveLength(1)
    expect(notes[0].textContent).toContain('due 2206-09-26')
    notes[0].fire('click')
    expect(openTaskModal).toHaveBeenCalledOnce()
  })

  it('draws no diamond, milestone line or label for a far milestone', () => {
    const m = makeTask({ id: 'M', type: 'milestone', start: '', due: '9999-12-31' })
    const { ctx, svg, header } = rendererCtx([m])
    const g = new FakeEl('g')
    renderTaskBar(asEl(g), m, 0, 0, ctx)
    renderMilestoneLabels(ctx)
    expect(byClass(g, 'pm-gantt-milestone')).toHaveLength(0)
    expect(byClass(g, 'pm-gantt-out-of-range')[0]?.textContent).toContain('due 9999-12-31')
    expect(svg.querySelectorAll('line')).toHaveLength(0)
    expect(byClass(header, 'pm-gantt-milestone-label')).toHaveLength(0)
  })
})
