import { setIcon, setTooltip } from 'obsidian'
import {
  DEFAULT_ISSUE_TYPES,
  DEFAULT_ALERT_CATEGORIES,
  DEFAULT_SEVERITIES,
  DEFAULT_SLA_POLICIES,
  type AlertCategoryConfig,
  type IssueTypeConfig,
  type Recurrence,
  type SeverityConfig,
  type SlaPolicy,
  type Task
} from '../../types'
import { renderSeverityBadge, renderSlaChip } from '../../soc/slaTicker'
import { checklistProgress } from '../../modals/checkboxToggle'
import { formatDateShort } from '../../utils'
import { AvatarStack } from '../primitives/AvatarStack'
import { ProgressBar } from '../primitives/ProgressBar'
import { renderDueChip } from './dueChip'
import { renderIssueTypeIcon, renderKeyChip } from './issueMeta'
import { renderTagChip } from './tagChip'
import { renderTimeChip } from './timeChip'

export interface KanbanCardProps {
  task: Task
  descriptionPreview?: string
  parentTitle?: string
  parentKey?: string
  nested?: boolean
  /** Resolved issue-type catalog (configFor(project).issueTypes). Defaults apply when absent. */
  issueTypes?: IssueTypeConfig[]
  /** Epic ancestor context. TODO(board agent): the card has no project access — fill from
   *  findEpicAncestor(project, task.id) in KanbanView (label = epic.key || epic.title). */
  epic?: { label: string; color?: string }
  subtaskProgress?: { done: number; total: number }
  loggedHours: number
  overdue: boolean
  showTagColors: boolean
  onClick: () => void
  /** Present = the card shows an adjustable progress slider (absent = read-only bar). */
  onProgressChange?: (value: number) => void
  onContextMenu: (e: MouseEvent) => void
  onDragStart: () => void
  onDragEnd: () => void
}

interface KanbanSocConfig {
  severities: SeverityConfig[]
  slaPolicies: Record<string, SlaPolicy>
  alertCategories: AlertCategoryConfig[]
}

/**
 * ponytail: module-level config bridge. KanbanColumn forwards card fields
 * explicitly and is outside this change's file set, so per-card props can't
 * reach here through it. Severities/SLA policies are global-only in v1, so a
 * board-scoped setter (KanbanView calls it before building columns) is exact.
 * Promote to real KanbanCardData props when KanbanColumn is open for edit.
 */
let socConfig: KanbanSocConfig | null = null

export function setKanbanSocConfig(cfg: KanbanSocConfig): void {
  socConfig = cfg
}

/** Tooltip text for the card's repeat marker: 'Repeats weekly' / 'Repeats every 2 weeks'. */
export function recurrenceLabel(rec: Recurrence): string {
  const adverb = { daily: 'daily', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly' }[rec.interval]
  if (rec.every <= 1) return `Repeats ${adverb}`
  const unit = { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' }[rec.interval]
  return `Repeats every ${rec.every} ${unit}`
}

export class KanbanCard {
  el: HTMLElement

  constructor(parentEl: HTMLElement, props: KanbanCardProps) {
    const { task } = props
    const card = parentEl.createDiv('pm-kanban-card')
    card.draggable = true
    card.dataset.taskId = task.id
    this.el = card

    const body = card.createDiv('pm-kanban-card-body')

    // Two rows, not six. Casefile's card carried the same facts down a stack of
    // one-item rows — parent, title, soc chips, time, tags, progress, subtasks,
    // footer — and a routine incident card ran ~130px tall, so a column held
    // three of them. Farhan's one complaint about the old board. Nothing is
    // dropped: the title shares its row with whoever owns the card and when it
    // is due, every counter became a chip in one wrapping row, and progress
    // became a hairline on the card's own bottom edge instead of a row.

    // Jira-style parent context for subtasks: directly under the parent (or a
    // same-parent sibling) the card indents with an elbow connector; stranded
    // in another column it carries a "↳ parent" breadcrumb instead.
    if (props.nested) {
      card.addClass('pm-kanban-card--nested')
    } else if (props.parentTitle || props.parentKey) {
      const bc = body.createDiv('pm-kanban-card-parent')
      setIcon(bc.createSpan({ cls: 'pm-kanban-card-parent-icon' }), 'corner-down-right')
      bc.createSpan({ text: props.parentKey || props.parentTitle || '', cls: 'pm-kanban-card-parent-label' })
      if (props.parentKey && props.parentTitle) setTooltip(bc, props.parentTitle)
    }

    // ── Row 1: what it is, and whose it is ───────────────────────────────────
    const head = body.createDiv('pm-kanban-card-head')
    head.createDiv({ text: task.title, cls: 'pm-kanban-card-title' })
    const owner = head.createDiv('pm-kanban-card-owner')
    new AvatarStack(owner).setNames(task.assignees).setMax(3).setSize('sm')
    if (task.due) {
      renderDueChip(owner, formatDateShort(task.due), props.overdue ? 'overdue' : 'normal', 'sm')
    }
    if (!owner.hasChildNodes()) owner.remove()

    if (props.descriptionPreview) {
      body.createDiv({ cls: 'pm-kanban-card-description', text: props.descriptionPreview })
    }

    // ── Row 2: every mark the card carries, one wrapping row ─────────────────
    const chips = body.createDiv('pm-kanban-card-chips')
    renderIssueTypeIcon(
      chips,
      (props.issueTypes ?? DEFAULT_ISSUE_TYPES).find((t) => t.id === task.issueType),
      { alert: { tags: task.tags, categories: socConfig?.alertCategories ?? DEFAULT_ALERT_CATEGORIES } }
    )
    if (task.key) renderKeyChip(chips, task.key, { plain: true })
    renderSeverityBadge(
      chips,
      (socConfig?.severities ?? DEFAULT_SEVERITIES).find((s) => s.id === task.severity)
    )
    // SLA chip stays incident-only (slaState also gates on issueType, so this
    // is belt and braces).
    if (task.issueType === 'incident') {
      renderSlaChip(chips, task, socConfig?.slaPolicies ?? DEFAULT_SLA_POLICIES)
    }
    if (task.iocs.length) {
      const iocChip = chips.createSpan({ cls: 'pm-ioc-count' })
      setIcon(iocChip.createSpan({ cls: 'pm-ioc-count-icon' }), 'crosshair')
      iocChip.createSpan({ text: String(task.iocs.length) })
      setTooltip(iocChip, `${task.iocs.length} indicator${task.iocs.length === 1 ? '' : 's'}`)
    }
    // Playbook progress: the description's rendered checkbox set (the same
    // set the editor's clickable checkboxes flip).
    const checklist = checklistProgress(task.description)
    if (checklist) {
      const chip = chips.createSpan({ cls: 'pm-checklist-count' })
      setIcon(chip.createSpan({ cls: 'pm-checklist-count-icon' }), 'list-checks')
      chip.createSpan({ text: `${checklist.done}/${checklist.total}` })
      setTooltip(chip, `Checklist: ${checklist.done} of ${checklist.total} done`)
    }
    // Subtasks were a sentence on their own line; same count, same words in the
    // tooltip, now the width of a chip.
    if (props.subtaskProgress) {
      const { done, total } = props.subtaskProgress
      const chip = chips.createSpan({ cls: 'pm-checklist-count' })
      setIcon(chip.createSpan({ cls: 'pm-checklist-count-icon' }), 'git-branch')
      chip.createSpan({ text: `${done}/${total}` })
      setTooltip(chip, `${done}/${total} subtasks`)
    }
    renderTimeChip(chips, props.loggedHours, task.timeEstimate ?? 0, 'sm')
    if (props.epic) {
      const label = props.epic.label.length > 18 ? props.epic.label.slice(0, 18) + '…' : props.epic.label
      const chip = chips.createSpan({ cls: 'pm-epic-chip', text: label })
      setTooltip(chip, props.epic.label)
      if (props.epic.color) {
        chip.setCssStyles({
          color: props.epic.color,
          background: `color-mix(in srgb, ${props.epic.color} 15%, transparent)`
        })
      }
    }
    if (task.tags.length) {
      for (const tag of task.tags.slice(0, 3)) {
        renderTagChip(chips, tag, props.showTagColors)
      }
    }
    if (task.flagged) {
      const flagEl = chips.createSpan({ cls: 'pm-flag-icon' })
      setIcon(flagEl, 'flag')
      setTooltip(flagEl, 'Flagged')
    }
    if (task.recurrence) {
      const recurEl = chips.createSpan({ cls: 'pm-recur-icon' })
      setIcon(recurEl, 'repeat')
      setTooltip(recurEl, recurrenceLabel(task.recurrence))
    }
    if (!chips.hasChildNodes()) chips.remove()

    // ── The card's own bottom edge, not a row ────────────────────────────────
    if (props.onProgressChange) {
      // Minimal in-card progress: the same thin track, but adjustable. The
      // slider must never start a card drag or bubble into click-to-open.
      const onProgressChange = props.onProgressChange
      const slider = card.createEl('input', { type: 'range', cls: 'pm-kanban-progress' })
      slider.min = '0'
      slider.max = '100'
      slider.step = '25'
      slider.value = String(task.progress)
      const paint = () => slider.setCssProps({ '--pm-progress-pct': `${slider.value}%` })
      paint()
      slider.setAttribute('aria-label', 'Progress')
      slider.addEventListener('pointerdown', (e) => {
        e.stopPropagation()
        card.draggable = false
      })
      const restoreDrag = () => {
        card.draggable = true
      }
      slider.addEventListener('pointerup', restoreDrag)
      slider.addEventListener('pointercancel', restoreDrag)
      slider.addEventListener('click', (e) => e.stopPropagation())
      slider.addEventListener('input', paint)
      slider.addEventListener('change', () => onProgressChange(Number(slider.value)))
    } else if (task.progress > 0) {
      new ProgressBar(card.createDiv('pm-kanban-card-progress')).setSize('sm').setValue(task.progress)
    }

    card.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', task.id)
      card.addClass('pm-kanban-card--dragging')
      window.setTimeout(() => card.addClass('pm-dragging'), 0)
      props.onDragStart()
    })

    card.addEventListener('dragend', () => {
      card.removeClass('pm-kanban-card--dragging')
      card.removeClass('pm-dragging')
      props.onDragEnd()
    })

    card.addEventListener('click', () => props.onClick())
    // Keyboard access: the card is a focusable button (same pattern as the
    // collapsed-column strip). Target check keeps the progress slider's keys.
    card.setAttribute('role', 'button')
    card.setAttribute('tabindex', '0')
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        props.onClick()
      }
    })
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      props.onContextMenu(e)
    })
  }
}
