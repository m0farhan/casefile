import { setIcon } from 'obsidian'
import type { IssueTypeConfig, Task } from '../../types'
import { safeAsync } from '../../utils'
import { IconButton } from '../primitives/IconButton'
import { KanbanCard } from './KanbanCard'

export interface KanbanColumnStatus {
  id: string
  label: string
  color: string
  icon: string
  /** Soft WIP limit; count renders 'n / limit' in amber when exceeded. */
  wipLimit?: number
  /** Terminal status (Done) — the column gets the settled/crossed-off card look. */
  complete?: boolean
}

export interface KanbanCardData {
  task: Task
  descriptionPreview?: string
  parentTitle?: string
  parentKey?: string
  /** Subtask rendering directly under its parent (or a same-parent sibling run) in this column. */
  nested?: boolean
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
  /** Present = cards render an adjustable progress slider. */
  onCardProgressChange?: (task: Task, value: number) => void
  onDrop: (taskId: string, newStatus: string, before: DropNeighbor | null) => Promise<void>
  /** Present = the column foot shows the inline '+ Create' affordance (absent on Archive). */
  onInlineCreate?: (title: string) => Promise<void>
}

export class KanbanColumn {
  el: HTMLElement

  constructor(parentEl: HTMLElement, props: KanbanColumnProps) {
    const col = parentEl.createDiv('pm-kanban-col')
    col.dataset.status = props.status.id
    // Terminal-status columns (Done) share the Archive column's settled look.
    if (props.status.complete) col.addClass('pm-kanban-col--complete')
    this.el = col

    if (props.collapsed) {
      this.renderCollapsed(col, props)
      return
    }

    const header = col.createDiv('pm-kanban-col-header')

    // Flat Jira-style header: quiet uppercase label, the status color reduced
    // to a small dot. The collapsed strip keeps its colored bar + label.
    const titleRow = header.createDiv('pm-kanban-col-title-row')
    const badge = titleRow.createSpan({ cls: 'pm-kanban-col-badge' })
    badge.createSpan({ cls: 'pm-kanban-col-dot' }).setCssStyles({ background: props.status.color })
    badge.appendText(props.status.label)

    const headerRight = titleRow.createDiv('pm-kanban-col-header-right')
    renderCount(headerRight, props.cards.length, props.status.wipLimit)
    new IconButton(headerRight)
      .setIcon('chevron-left')
      .setTooltip('Collapse column')
      .onClick(() => props.onToggleCollapse())

    const cardsEl = col.createDiv('pm-kanban-cards')
    cardsEl.dataset.status = props.status.id

    if (!props.cards.length) {
      cardsEl.createDiv({ cls: 'pm-kanban-empty', text: 'No items' })
    }

    for (const card of props.cards) {
      new KanbanCard(cardsEl, {
        task: card.task,
        descriptionPreview: card.descriptionPreview,
        parentTitle: card.parentTitle,
        parentKey: card.parentKey,
        nested: card.nested,
        issueTypes: card.issueTypes,
        epic: card.epic,
        subtaskProgress: card.subtaskProgress,
        loggedHours: card.loggedHours,
        overdue: card.overdue,
        showTagColors: card.showTagColors,
        onClick: () => props.onCardClick(card.task),
        onProgressChange: props.onCardProgressChange
          ? (value) => props.onCardProgressChange?.(card.task, value)
          : undefined,
        onContextMenu: (e) => props.onCardContextMenu(card.task, e),
        onDragStart: () => props.onCardDragStart(card.task),
        onDragEnd: () => props.onCardDragEnd()
      })
    }

    cardsEl.addEventListener('dragover', (e) => {
      e.preventDefault()
      cardsEl.addClass('pm-kanban-drop-target')
      const afterEl = getDragAfterElement(cardsEl, e.clientY)
      // Document-wide lookup: pulls the dragged card in from its origin column,
      // so the ghost slot previews placement across columns, not just within
      // the one the drag started in. Same-view check keeps a drag over another
      // pane's board (whose drop handler would refuse it) from stealing the card.
      const dragging = cardsEl.ownerDocument.querySelector('.pm-kanban-card--dragging')
      if (dragging && dragging.closest('.pm-kanban-view') === cardsEl.closest('.pm-kanban-view')) {
        if (afterEl) {
          cardsEl.insertBefore(dragging, afterEl)
        } else {
          cardsEl.appendChild(dragging)
        }
      }
    })

    cardsEl.addEventListener('dragleave', (e) => {
      // Entering a child card fires dragleave on the container; only clear the
      // target tint when the pointer actually left the card area (no flicker).
      if (cardsEl.contains(e.relatedTarget as Node | null)) return
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

    if (props.onInlineCreate) this.renderInlineCreate(col, props.onInlineCreate)
  }

  /** Quiet '+ Create' at the column foot; click swaps it for a borderless input (Jira rapid entry). */
  private renderInlineCreate(col: HTMLElement, onCreate: (title: string) => Promise<void>): void {
    const wrap = col.createDiv('pm-kanban-col-create')
    const showButton = (): void => {
      wrap.empty()
      const btn = wrap.createEl('button', { cls: 'pm-kanban-create-btn' })
      setIcon(btn.createSpan({ cls: 'pm-kanban-create-icon' }), 'plus')
      btn.appendText('Create')
      btn.addEventListener('click', () => showInput())
    }
    const showInput = (): void => {
      wrap.empty()
      const input = wrap.createEl('input', {
        type: 'text',
        cls: 'pm-kanban-create-input',
        attr: { placeholder: 'What needs doing?', 'aria-label': 'New task title' }
      })
      input.addEventListener(
        'keydown',
        safeAsync(async (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            showButton()
          } else if (e.key === 'Enter') {
            const title = input.value.trim()
            if (!title) return
            // The create refreshes the board; KanbanView reopens a fresh input
            // in this column afterwards, keeping the rapid-entry loop going.
            await onCreate(title)
          }
        })
      )
      input.addEventListener('blur', () => {
        if (!input.value.trim()) showButton()
      })
      input.focus()
    }
    showButton()
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
    col.addEventListener('dragleave', (e) => {
      if (col.contains(e.relatedTarget as Node | null)) return
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
