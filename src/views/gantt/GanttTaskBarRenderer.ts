import { Notice } from 'obsidian'
import type { Task } from '../../types'
import { openTaskModal } from '../../ui/ModalFactory'
import { svgEl, getStatusConfig, safeAsync } from '../../utils'
import { Temporal, parsePlainDate } from '../../dates'
import type { TimelineCfg } from './TimelineConfig'
import {
  ROW_HEIGHT,
  HEADER_HEIGHT,
  BAR_PADDING,
  BAR_BORDER_RADIUS,
  dateToX,
  xToDate,
  outOfRange,
  snapX
} from './TimelineConfig'
import { attachDragHandle, attachBarMove } from './GanttDragHandler'
import { handleLinkDotClick } from './GanttLinkHandler'
import type { RendererContext } from './GanttRenderer'

const MILESTONE_SIZE = 12

/**
 * Horizontal extent of a task's shape, from the same dates it is drawn with: a
 * milestone's diamond sits on due (else start), a bar runs from start (else
 * due) to the end of due (else start). Arrows attach to these edges, so a
 * due-only task or a milestone gets its arrow where its shape is. Null when
 * the task has no date, or a drawn date falls outside the range.
 */
export function spanX(task: Task, cfg: TimelineCfg): { left: number; right: number } | null {
  const start = parsePlainDate(task.start)
  const due = parsePlainDate(task.due)
  if (task.type === 'milestone') {
    const date = due ?? start
    if (!date || outOfRange(cfg, date)) return null
    const cx = dateToX(cfg, date) + cfg.dayWidth / 2
    return { left: cx - MILESTONE_SIZE, right: cx + MILESTONE_SIZE }
  }
  const first = start ?? due
  if (!first || (start && outOfRange(cfg, start)) || (due && outOfRange(cfg, due))) return null
  // A task with end date E occupies the day E, so the bar's right edge sits at the start of E+1.
  const left = dateToX(cfg, first)
  return { left, right: left + Math.max(8, dateToX(cfg, (due ?? first).add({ days: 1 })) - left) }
}

// ─── Task bars ─────────────────────────────────────────────────────────────

export function renderTaskBar(g: SVGGElement, task: Task, row: number, _depth: number, ctx: RendererContext): void {
  if (!parsePlainDate(task.start) && !parsePlainDate(task.due)) {
    renderEmptyRowClickTarget(g, task, row, ctx)
    return
  }

  const statusConfig = getStatusConfig(ctx.statuses, task.status)
  const color = statusConfig?.color ?? getComputedStyle(ctx.svgEl).getPropertyValue('--interactive-accent').trim()
  const rowY = HEADER_HEIGHT + row * ROW_HEIGHT
  const y = rowY + BAR_PADDING
  const height = ROW_HEIGHT - BAR_PADDING * 2

  // Row hover background
  const hover = svgEl('rect', {
    x: 0,
    y: rowY,
    width: ctx.cfg.totalWidth,
    height: ROW_HEIGHT,
    class: 'pm-gantt-row-hover'
  })
  g.appendChild(hover)

  const span = spanX(task, ctx.cfg)
  if (!span) {
    renderOutOfRangeNote(g, hover, task, rowY, ctx)
    return
  }

  // Milestone → render diamond
  if (task.type === 'milestone') {
    renderMilestoneDiamond(g, task, row, color, ctx, (span.left + span.right) / 2)
    return
  }

  // Normal task bar
  const x = span.left
  const width = span.right - span.left

  // Group for bar + handles
  const barGroup = svgEl('g', { class: 'pm-gantt-bar-group' })
  g.appendChild(barGroup)

  // Main bar — flat fill, no gradient/shadow/sheen
  const rect = svgEl('rect', {
    x,
    y,
    width,
    height,
    rx: BAR_BORDER_RADIUS,
    ry: BAR_BORDER_RADIUS,
    fill: color,
    opacity: 0.4,
    class: 'pm-gantt-bar'
  })
  barGroup.appendChild(rect)

  // Completed portion — solid fill over the faint track so progress reads at a glance
  if (task.progress > 0) {
    const pw = (task.progress / 100) * width
    barGroup.appendChild(
      svgEl('rect', {
        x,
        y,
        width: pw,
        height,
        rx: BAR_BORDER_RADIUS,
        ry: BAR_BORDER_RADIUS,
        fill: color,
        opacity: 0.9,
        class: 'pm-gantt-bar-progress'
      })
    )
  }

  // Recurrence indicator
  if (task.recurrence) {
    const icon = svgEl('text', {
      x: x + width + 4,
      y: y + height / 2 + 5,
      class: 'pm-gantt-bar-icon'
    })
    icon.textContent = 'R'
    barGroup.appendChild(icon)
  }

  // Label inside bar
  if (width > 55) {
    const label = svgEl('text', {
      x: x + 8,
      y: y + height / 2 + 5,
      class: 'pm-gantt-bar-label'
    })
    const maxChars = Math.max(4, Math.floor((width - 16) / 7.5))
    label.textContent = task.title.length > maxChars ? task.title.slice(0, maxChars - 1) + '\u2026' : task.title
    barGroup.appendChild(label)
  }

  // Tooltip (status only; priority is UI-retired, and severity already badges elsewhere)
  const ttEl = svgEl('title', {})
  const assigneesStr = task.assignees.length ? `\nAssignees: ${task.assignees.join(', ')}` : ''
  ttEl.textContent = `${task.title}\n${statusConfig?.label ?? task.status}\nStart: ${task.start || '\u2014'}  Due: ${task.due || '\u2014'}\nProgress: ${task.progress}%${assigneesStr}`
  rect.appendChild(ttEl)

  // Drag handles
  const HANDLE_W = 8
  for (const side of ['left', 'right'] as const) {
    const hx = side === 'left' ? x : x + width - HANDLE_W
    const handle = svgEl('rect', {
      x: hx,
      y,
      width: HANDLE_W,
      height,
      rx: 3,
      ry: 3,
      class: 'pm-gantt-drag-handle',
      cursor: 'ew-resize'
    })
    const cleanup = attachDragHandle(
      handle,
      side,
      task,
      rect,
      barGroup,
      x,
      width,
      ctx.cfg,
      ctx.snapPoints,
      ctx.drag,
      ctx.plugin,
      ctx.project,
      ctx.onRefresh
    )
    ctx.cleanupFns.push(cleanup)
    barGroup.appendChild(handle)
  }

  // Link dots (dependency connectors) — positioned outside bar edges
  const DOT_R = 4
  const DOT_GAP = 4
  for (const side of ['left', 'right'] as const) {
    const cx = side === 'left' ? x - DOT_GAP - DOT_R : x + width + DOT_GAP + DOT_R
    const cy = y + height / 2
    const dot = svgEl('circle', {
      cx,
      cy,
      r: DOT_R,
      class: 'pm-gantt-link-dot',
      cursor: 'crosshair'
    })
    dot.addEventListener('mousedown', (e: MouseEvent) => {
      e.stopPropagation()
    })
    dot.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation()
      handleLinkDotClick(dot, task.id, side, ctx.link, ctx.plugin, ctx.project, ctx.onRefresh)
    })
    barGroup.appendChild(dot)
  }

  // Move whole bar by dragging (only when both dates exist)
  if (task.start && task.due) {
    const moveCleanup = attachBarMove(
      rect,
      barGroup,
      task,
      x,
      width,
      ctx.cfg,
      ctx.snapPoints,
      ctx.drag,
      ctx.plugin,
      ctx.project,
      ctx.onRefresh
    )
    ctx.cleanupFns.push(moveCleanup)
    rect.setAttribute('cursor', 'grab')
  } else {
    rect.setAttribute('cursor', 'pointer')
  }

  // Click to open modal (suppressed if drag occurred)
  rect.addEventListener('click', () => {
    if (ctx.drag.dragMoved) {
      ctx.drag.dragMoved = false
      return
    }
    openTaskModal(ctx.plugin, ctx.project, { task, onSave: () => ctx.onRefresh() })
  })
}

// ─── Empty row click-to-set-dates ─────────────────────────────────────────

function renderEmptyRowClickTarget(g: SVGGElement, task: Task, row: number, ctx: RendererContext): void {
  const rowY = HEADER_HEIGHT + row * ROW_HEIGHT

  // Invisible rect covering the full row — acts as click target
  const hitArea = svgEl('rect', {
    x: 0,
    y: rowY,
    width: ctx.cfg.totalWidth,
    height: ROW_HEIGHT,
    fill: 'transparent',
    cursor: 'cell',
    class: 'pm-gantt-empty-row-hit'
  })

  // Hover preview bar (hidden until mouseover)
  const previewY = rowY + BAR_PADDING
  const previewH = ROW_HEIGHT - BAR_PADDING * 2
  const previewW = Math.max(ctx.cfg.dayWidth, 8)
  const preview = svgEl('rect', {
    x: 0,
    y: previewY,
    width: previewW,
    height: previewH,
    rx: BAR_BORDER_RADIUS,
    ry: BAR_BORDER_RADIUS,
    class: 'pm-gantt-empty-row-preview',
    'pointer-events': 'none'
  })
  preview.classList.add('pm-hidden')

  g.appendChild(hitArea)
  g.appendChild(preview)

  const snapPoints = ctx.snapPoints
  const snapThreshold = ctx.cfg.dayWidth * 0.4

  // Track mouse to position the preview bar
  hitArea.addEventListener('mousemove', (e: MouseEvent) => {
    const svgRect = ctx.svgEl.getBoundingClientRect()
    const rawX = e.clientX - svgRect.left
    const snapped = snapX(rawX, snapPoints, snapThreshold)
    preview.setAttribute('x', String(snapped))
    preview.classList.remove('pm-hidden')
  })

  hitArea.addEventListener('mouseleave', () => {
    preview.classList.add('pm-hidden')
  })

  // Click to set start=due=clicked date and save
  hitArea.addEventListener(
    'click',
    safeAsync(async (e: MouseEvent) => {
      const svgRect = ctx.svgEl.getBoundingClientRect()
      const rawX = e.clientX - svgRect.left
      const snapped = snapX(rawX, snapPoints, snapThreshold)
      const iso = xToDate(ctx.cfg, snapped).toString()

      try {
        await ctx.plugin.store.updateTask(ctx.project, task.id, { start: iso, due: iso })
      } catch (err) {
        new Notice('Failed to set task dates. Please try again.')
        console.error('GanttTaskBarRenderer: click-to-set-dates failed', err)
        return
      }
      await ctx.plugin.store.scheduleAfterChange(ctx.project, task.id)
      await ctx.onRefresh()
    })
  )

  // Tooltip
  const tt = svgEl('title', {})
  tt.textContent = 'Click to set dates'
  hitArea.appendChild(tt)
}

// ─── Dates outside the range ──────────────────────────────────────────────

/**
 * A row with a date the range cannot show gets no bar, diamond, drag or arrow:
 * each would stand for a date the chart does not have, and a drag would rewrite
 * that date from clamped geometry. The row states the stored date in text at
 * the chart's edge on that date's side, and clicking the note opens the task.
 */
function renderOutOfRangeNote(
  g: SVGGElement,
  hover: SVGRectElement,
  task: Task,
  rowY: number,
  ctx: RendererContext
): void {
  const outside: string[] = []
  let after = false
  for (const [label, value] of [
    ['start', task.start],
    ['due', task.due]
  ] as const) {
    const d = parsePlainDate(value)
    if (!d || !outOfRange(ctx.cfg, d)) continue
    outside.push(`${label} ${value}`)
    if (Temporal.PlainDate.compare(d, ctx.cfg.endDate) >= 0) after = true
  }
  const text = `Outside the chart range: ${outside.join(', ')}`

  const note = svgEl('text', {
    x: after ? ctx.cfg.totalWidth - 8 : 8,
    y: rowY + ROW_HEIGHT / 2,
    'text-anchor': after ? 'end' : 'start',
    class: 'pm-gantt-out-of-range',
    cursor: 'pointer'
  })
  note.textContent = text
  note.addEventListener('click', () => {
    openTaskModal(ctx.plugin, ctx.project, { task, onSave: () => ctx.onRefresh() })
  })
  g.appendChild(note)

  // The note may sit far from the scrolled view, so the whole row explains itself on hover.
  const tt = svgEl('title', {})
  tt.textContent = text
  hover.appendChild(tt)
}

// ─── Milestone diamond ────────────────────────────────────────────────────

function renderMilestoneDiamond(
  g: SVGGElement,
  task: Task,
  row: number,
  color: string,
  ctx: RendererContext,
  cx: number
): void {
  const cy = HEADER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT / 2
  const size = MILESTONE_SIZE

  const pts = `${cx},${cy - size} ${cx + size},${cy} ${cx},${cy + size} ${cx - size},${cy}`
  const diamond = svgEl('polygon', {
    points: pts,
    fill: color,
    opacity: 0.8,
    class: 'pm-gantt-milestone',
    cursor: 'pointer'
  })
  g.appendChild(diamond)

  const tt = svgEl('title', {})
  tt.textContent = `${task.title} (milestone)\nDate: ${task.due || task.start || '\u2014'}`
  diamond.appendChild(tt)

  diamond.addEventListener('click', () => {
    openTaskModal(ctx.plugin, ctx.project, { task, onSave: () => ctx.onRefresh() })
  })
}

// ─── Milestone labels ─────────────────────────────────────────────────────

export function renderMilestoneLabels(ctx: RendererContext): void {
  const milestones = ctx.flatTasks.filter((f) => f.task.type === 'milestone' && (f.task.due || f.task.start))
  if (!milestones.length) return

  const linesG = svgEl('g', { class: 'pm-gantt-milestone-labels' })

  for (const { task } of milestones) {
    // Centred on the diamond; nothing for a date outside the range.
    const span = spanX(task, ctx.cfg)
    if (!span) continue
    const x = (span.left + span.right) / 2
    const statusConfig = getStatusConfig(ctx.statuses, task.status)
    const color = statusConfig?.color ?? getComputedStyle(ctx.svgEl).getPropertyValue('--interactive-accent').trim()

    const totalH = HEADER_HEIGHT + ctx.flatTasks.filter((f) => f.visible || f.depth === 0).length * ROW_HEIGHT
    linesG.appendChild(
      svgEl('line', {
        x1: x,
        y1: HEADER_HEIGHT,
        x2: x,
        y2: totalH,
        stroke: color,
        'stroke-width': 1,
        'stroke-dasharray': '4 4',
        opacity: 0.4
      })
    )

    // Label rides the sticky header so it stays visible while rows scroll.
    const label = svgEl('text', {
      x,
      y: 14,
      'text-anchor': 'middle',
      class: 'pm-gantt-milestone-label',
      fill: color
    })
    label.textContent = task.title.length > 16 ? task.title.slice(0, 14) + '\u2026' : task.title
    ctx.headerSvgEl.appendChild(label)
  }

  ctx.svgEl.appendChild(linesG)
}

// ─── Dependency arrows ─────────────────────────────────────────────────────

export function renderDependencyArrows(ctx: RendererContext): void {
  const indexMap = new Map<string, number>()
  ctx.flatTasks.forEach((f, i) => indexMap.set(f.task.id, i))

  const arrowGroup = svgEl('g', { class: 'pm-gantt-arrows' })

  for (const { task } of ctx.flatTasks) {
    if (!task.dependencies?.length) continue
    const toRow = indexMap.get(task.id)
    if (toRow === undefined) continue
    const toY = HEADER_HEIGHT + toRow * ROW_HEIGHT + ROW_HEIGHT / 2
    // Arrows run from the predecessor's right edge to the successor's left edge,
    // as drawn (spanX), so due-only tasks and milestones connect where they show.
    const to = spanX(task, ctx.cfg)
    if (!to) continue
    const toX = to.left

    for (const depId of task.dependencies) {
      const fromRow = indexMap.get(depId)
      if (fromRow === undefined) continue
      const from = spanX(ctx.flatTasks[fromRow].task, ctx.cfg)
      if (!from) continue
      const fromX = from.right
      const fromY = HEADER_HEIGHT + fromRow * ROW_HEIGHT + ROW_HEIGHT / 2

      const midX = (fromX + toX) / 2
      arrowGroup.appendChild(
        svgEl('path', {
          d: `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`,
          class: 'pm-gantt-arrow',
          'marker-end': 'url(#pm-arrowhead)'
        })
      )
    }
  }

  // Arrowhead marker
  const defs = getOrCreateDefs(ctx.svgEl)
  const marker = svgEl('marker', {
    id: 'pm-arrowhead',
    markerWidth: 8,
    markerHeight: 8,
    refX: 6,
    refY: 3,
    orient: 'auto'
  })
  marker.appendChild(
    svgEl('path', {
      d: 'M0,0 L0,6 L8,3 z',
      class: 'pm-gantt-arrowhead'
    })
  )
  defs.appendChild(marker)

  ctx.svgEl.appendChild(arrowGroup)
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getOrCreateDefs(el: SVGSVGElement): SVGDefsElement {
  return (
    (el.querySelector('defs') as SVGDefsElement) ??
    (() => {
      const d = svgEl('defs', {})
      el.insertBefore(d, el.firstChild)
      return d
    })()
  )
}
