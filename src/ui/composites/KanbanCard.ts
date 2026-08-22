import { setIcon, setTooltip } from 'obsidian'
import {
  DEFAULT_ISSUE_TYPES,
  DEFAULT_SEVERITIES,
  DEFAULT_SLA_POLICIES,
  type IssueTypeConfig,
  type SeverityConfig,
  type SlaPolicy,
  type Task
} from '../../types'
import { renderSeverityBadge, renderSlaChip } from '../../soc/slaTicker'
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

export class KanbanCard {
  el: HTMLElement

  constructor(parentEl: HTMLElement, props: KanbanCardProps) {
    const { task } = props
    const card = parentEl.createDiv('pm-kanban-card')
    card.draggable = true
    card.dataset.taskId = task.id
    this.el = card

    const body = card.createDiv('pm-kanban-card-body')

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

    // Jira card anatomy: title first; type icon, key and severity live in the
    // footer. The M/Sub/R letter chips are gone — the type icon and nesting
    // already encode them.
    body.createDiv({ text: task.title, cls: 'pm-kanban-card-title' })

    if (props.epic) {
      const label = props.epic.label.length > 18 ? props.epic.label.slice(0, 18) + '…' : props.epic.label
      const chip = body.createSpan({ cls: 'pm-epic-chip', text: label })
      setTooltip(chip, props.epic.label)
      if (props.epic.color) {
        chip.setCssStyles({
          color: props.epic.color,
          background: `color-mix(in srgb, ${props.epic.color} 15%, transparent)`
        })
      }
    }

    const soc = body.createDiv('pm-kanban-card-soc')
    // SLA chip stays incident-only (slaState also gates on issueType, so this
    // is belt and braces). Severity renders in the footer.
    if (task.issueType === 'incident') {
      renderSlaChip(soc, task, socConfig?.slaPolicies ?? DEFAULT_SLA_POLICIES)
    }
    if (task.iocs.length) {
      const iocChip = soc.createSpan({ cls: 'pm-ioc-count' })
      setIcon(iocChip.createSpan({ cls: 'pm-ioc-count-icon' }), 'crosshair')
      iocChip.createSpan({ text: String(task.iocs.length) })
      setTooltip(iocChip, `${task.iocs.length} indicator${task.iocs.length === 1 ? '' : 's'}`)
    }
    if (!soc.hasChildNodes()) soc.remove()

    if (props.descriptionPreview) {
      body.createDiv({ cls: 'pm-kanban-card-description', text: props.descriptionPreview })
    }

    renderTimeChip(body, props.loggedHours, task.timeEstimate ?? 0, 'sm')

    if (task.tags.length) {
      const tagsEl = body.createDiv('pm-kanban-card-tags')
      for (const tag of task.tags.slice(0, 3)) {
        renderTagChip(tagsEl, tag, props.showTagColors)
      }
    }

    if (props.onProgressChange) {
      // Minimal in-card progress: the same thin track, but adjustable. The
      // slider must never start a card drag or bubble into click-to-open.
      const onProgressChange = props.onProgressChange
      const slider = body.createEl('input', { type: 'range', cls: 'pm-kanban-progress' })
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
      new ProgressBar(body).setSize('sm').setValue(task.progress)
    }

    if (props.subtaskProgress) {
      const { done, total } = props.subtaskProgress
      body.createSpan({
        text: `${done}/${total} subtasks`,
        cls: 'pm-kanban-card-subtasks'
      })
    }

    const footer = body.createDiv('pm-kanban-card-footer')
    const footLeft = footer.createDiv('pm-kanban-card-footer-left')
    renderIssueTypeIcon(
      footLeft,
      (props.issueTypes ?? DEFAULT_ISSUE_TYPES).find((t) => t.id === task.issueType)
    )
    if (task.key) renderKeyChip(footLeft, task.key, { plain: true })
    renderSeverityBadge(
      footLeft,
      (socConfig?.severities ?? DEFAULT_SEVERITIES).find((s) => s.id === task.severity)
    )

    const footRight = footer.createDiv('pm-kanban-card-footer-right')
    new AvatarStack(footRight).setNames(task.assignees).setMax(3).setSize('sm')

    if (task.due) {
      renderDueChip(footRight, formatDateShort(task.due), props.overdue ? 'overdue' : 'normal', 'sm')
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
