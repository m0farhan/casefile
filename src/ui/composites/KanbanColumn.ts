import { setIcon } from 'obsidian'
import type { IssueTypeConfig, Task } from '../../types'
import { formatBadgeText, isIconName, safeAsync } from '../../utils'
import { IconButton } from '../primitives/IconButton'
import { KanbanCard } from './KanbanCard'

export interface KanbanColumnStatus {
  id: string
  label: string
  color: string
  icon: string
  /** Soft WIP limit; count renders 'n / limit' in amber when exceeded. */
  wipLimit?: number
}

export interface KanbanCardData {
  task: Task
  descriptionPreview?: string
  parentTitle?: string
  issueTypes?: IssueTypeConfig[]
  epic?: { label: string; color?: string }
  subtaskProgress?: { done: number; total: number }
  loggedHours: number
  overdue: boolean
  showTagColors: boolean
}

/** The card the dragged task landed next to, for persisting the drop order. */
export interface DropNeighbor {
  targetId: string
  position: 'before' | 'after'
}

export interface KanbanColumnProps {
  status: KanbanColumnStatus
  cards: KanbanCardData[]
  collapsed: boolean
  onToggleCollapse: () => void
  onCardClick: (task: Task) => void
  onCardContextMenu: (task: Task, e: MouseEvent) => void
  onCardDragStart: (task: Task) => void
  onCardDragEnd: () => void
  onDrop: (taskId: string, newStatus: string, before: DropNeighbor | null) => Promise<void>
}

export class KanbanColumn {
  el: HTMLElement

  constructor(parentEl: HTMLElement, props: KanbanColumnProps) {
    const col = parentEl.createDiv('pm-kanban-col')
    col.dataset.status = props.status.id
    this.el = col

    if (props.collapsed) {
      this.renderCollapsed(col, props)
      return
    }

    const header = col.createDiv('pm-kanban-col-header')
    header.style.setProperty('--col-color', props.status.color)

    const topBar = header.createDiv('pm-kanban-col-topbar')
    topBar.setCssStyles({ background: props.status.color })

    const titleRow = header.createDiv('pm-kanban-col-title-row')
    const badge = titleRow.createSpan({ cls: 'pm-kanban-col-badge' })
    if (props.status.icon && isIconName(props.status.icon)) {
      setIcon(badge.createSpan({ cls: 'pm-kanban-col-badge-icon' }), props.status.icon)
      badge.appendText(props.status.label)
    } else {
      badge.setText(formatBadgeText(props.status.icon, props.status.label))
    }
    badge.style.color = props.status.color

    const headerRight = titleRow.createDiv('pm-kanban-col-header-right')
    renderCount(headerRight, props.cards.length, props.status.wipLimit)
    new IconButton(headerRight)
      .setIcon('chevron-left')
      .setTooltip('Collapse column')
      .onClick(() => props.onToggleCollapse())

    const cardsEl = col.createDiv('pm-kanban-cards')
    cardsEl.dataset.status = props.status.id

    for (const card of props.cards) {
      new KanbanCard(cardsEl, {
        task: card.task,
        descriptionPreview: card.descriptionPreview,
        parentTitle: card.parentTitle,
        issueTypes: card.issueTypes,
        epic: card.epic,
        subtaskProgress: card.subtaskProgress,
        loggedHours: card.loggedHours,
        overdue: card.overdue,
        showTagColors: card.showTagColors,
        onClick: () => props.onCardClick(card.task),
        onContextMenu: (e) => props.onCardContextMenu(card.task, e),
        onDragStart: () => props.onCardDragStart(card.task),
        onDragEnd: () => props.onCardDragEnd()
      })
    }

    cardsEl.addEventListener('dragover', (e) => {
      e.preventDefault()
      cardsEl.addClass('pm-kanban-drop-target')
      const afterEl = getDragAfterElement(cardsEl, e.clientY)
      const dragging = cardsEl.querySelector('.pm-kanban-card--dragging')
      if (dragging) {
        if (afterEl) {
          cardsEl.insertBefore(dragging, afterEl)
        } else {
          cardsEl.appendChild(dragging)
        }
      }
    })

    cardsEl.addEventListener('dragleave', () => {
      cardsEl.removeClass('pm-kanban-drop-target')
    })

    cardsEl.addEventListener(
      'drop',
      safeAsync(async (e: DragEvent) => {
        e.preventDefault()
        cardsEl.removeClass('pm-kanban-drop-target')
        const taskId = e.dataTransfer?.getData('text/plain') ?? ''
        if (!taskId) return
        await props.onDrop(taskId, props.status.id, getDropNeighbor(cardsEl))
      })
    )
  }

  /** Narrow vertical strip: rotated label + count; clicking anywhere expands. */
  private renderCollapsed(col: HTMLElement, props: KanbanColumnProps): void {
    col.addClass('pm-kanban-col--collapsed')
    col.setAttribute('role', 'button')
    col.setAttribute('tabindex', '0')
    col.setAttribute('aria-label', `Expand ${props.status.label} column`)

    const topBar = col.createDiv('pm-kanban-col-topbar')
    topBar.setCssStyles({ background: props.status.color })

    const label = col.createSpan({ text: props.status.label, cls: 'pm-kanban-col-collapsed-label' })
    label.setCssStyles({ color: props.status.color })
    renderCount(col, props.cards.length, props.status.wipLimit)

    col.addEventListener('click', () => props.onToggleCollapse())
    col.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        props.onToggleCollapse()
      }
    })

    // Dropping on the collapsed strip appends to the column (no visible cards to order against)
    col.addEventListener('dragover', (e) => {
      e.preventDefault()
      col.addClass('pm-kanban-drop-target')
    })
    col.addEventListener('dragleave', () => {
      col.removeClass('pm-kanban-drop-target')
    })
    col.addEventListener(
      'drop',
      safeAsync(async (e: DragEvent) => {
        e.preventDefault()
        col.removeClass('pm-kanban-drop-target')
        const taskId = e.dataTransfer?.getData('text/plain') ?? ''
        if (!taskId) return
        await props.onDrop(taskId, props.status.id, null)
      })
    )
  }
}

function renderCount(parent: HTMLElement, count: number, wipLimit: number | undefined): void {
  const over = wipLimit !== undefined && count > wipLimit
  const el = parent.createSpan({
    text: over ? `${count} / ${wipLimit}` : String(count),
    cls: 'pm-kanban-col-count'
  })
  if (over) el.addClass('pm-kanban-col-count--over')
}

/**
 * Where did the drag land? The dragover handler live-moves the dragged card,
 * so at drop time its DOM position IS the drop position: report the card after
 * it ('before' that card), else the card before it ('after'), else null.
 */
function getDropNeighbor(cardsEl: HTMLElement): DropNeighbor | null {
  const dragging = cardsEl.querySelector('.pm-kanban-card--dragging')
  if (!dragging) return null
  const next = siblingCard(dragging, 'next')
  if (next?.dataset.taskId) return { targetId: next.dataset.taskId, position: 'before' }
  const prev = siblingCard(dragging, 'previous')
  if (prev?.dataset.taskId) return { targetId: prev.dataset.taskId, position: 'after' }
  return null
}

function siblingCard(from: Element, dir: 'next' | 'previous'): HTMLElement | null {
  let el = dir === 'next' ? from.nextElementSibling : from.previousElementSibling
  while (el) {
    if (el.instanceOf(HTMLElement) && el.classList.contains('pm-kanban-card')) return el
    el = dir === 'next' ? el.nextElementSibling : el.previousElementSibling
  }
  return null
}

function getDragAfterElement(container: HTMLElement, y: number): Element | null {
  const cards = Array.from(container.querySelectorAll('.pm-kanban-card:not(.pm-kanban-card--dragging)'))
  let closest: Element | null = null
  let closestOffset = Number.NEGATIVE_INFINITY
  for (const card of cards) {
    const box = card.getBoundingClientRect()
    const offset = y - box.top - box.height / 2
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset
      closest = card
    }
  }
  return closest
}
