import type PMPlugin from '../main'
import type { IssueBucket, IssueTypeConfig, Project, Task, Recurrence, StatusConfig } from '../types'
import { BUCKETS } from '../types'
import { flattenTasks } from '../store/TaskTreeOps'
import { wouldCreateCycle } from '../store/Scheduler'
import { renderPropRow } from '../ui/FormField'
import { isTerminalStatus, stringToColor } from '../utils'
import { completionOutcome, relativeDue } from '../dates'
import { renderCustomFieldInput } from './CustomFieldInputs'
import { setKindTag } from '../soc/alertCategory'
import { shownAlertKind } from '../ui/composites/issueMeta'
import {
  renderSelectControl,
  renderDateControl,
  renderMultiSelect,
  renderAddProperty,
  type SelectItem,
  type HiddenProperty
} from '../ui/composites/properties'

export interface TaskFormFieldsContext {
  task: Task
  project: Project
  plugin: PMPlugin
  parentId: string | null
  setParentId: (id: string | null) => void
  rerender: () => void
  shownExtras: Set<string>
  /** Hosts without a working parent picker (their setParentId is a no-op) pass
   * false to drop 'Subtask of…' from the merged Type dropdown. Default true. */
  parentPickerEnabled?: boolean
  /** Called after an edit that does not rerender: the multi-selects, whose
   * pickers sit outside the host's DOM, so no input or change event of theirs
   * reaches it. The side panel schedules its autosave here; the modal saves
   * the whole clone and passes nothing. */
  onChange?: () => void
}

/* The structural kinds fold into the ONE type dropdown alongside the issue
 * types (Jira has a single type control; showing "Type" and "Issue type" as
 * two near-identical rows read as duplication). Sentinel ids so a custom
 * issue type can never collide. */
const MILESTONE_OPTION_ID = '__milestone__'
const SUBTASK_OPTION_ID = '__subtask__'

/** The merged Type dropdown: the project's issue types plus the structural
 * kinds. 'Subtask of…' only offers itself where the host can actually pick a
 * parent — otherwise it would mint parentless 'subtask' rows. */
export function typeOptions(issueTypes: IssueTypeConfig[], parentPickerEnabled: boolean): SelectItem[] {
  const options: SelectItem[] = [
    ...issueTypes.map((t) => ({ id: t.id, label: t.label, color: t.color, icon: t.icon || undefined })),
    { id: MILESTONE_OPTION_ID, label: 'Milestone', icon: 'diamond' }
  ]
  if (parentPickerEnabled) options.push({ id: SUBTASK_OPTION_ID, label: 'Subtask of…', icon: 'git-branch' })
  return options
}

/** The task's own id plus every descendant's. None of these may become the
 * task's parent — re-parenting under a descendant creates an index cycle and
 * an infinite ancestor walk. */
export function subtreeIds(task: Task): Set<string> {
  const ids = new Set<string>()
  const walk = (t: Task) => {
    ids.add(t.id)
    for (const s of t.subtasks) walk(s)
  }
  walk(task)
  return ids
}

/**
 * Done is all of it (the store fills the same 100 on save, stampCompletion): a
 * status pick that closes a case saved open fills its progress, so the slider
 * shows it at once and the save carries it. `savedStatus` is the status on
 * disk, not the last pick, so Done → In progress → Done on a case saved Done
 * fills nothing. Returns the progress the fill replaced, for the host to hold
 * until the save goes out: a pick that reopens the case before then puts it
 * back, unless the slider moved since. Milestones have no progress.
 */
export function fillProgressOnDone(
  task: Task,
  savedStatus: string,
  statuses: StatusConfig[],
  filledFrom?: number
): number | undefined {
  if (isTerminalStatus(task.status, statuses) && !isTerminalStatus(savedStatus, statuses)) {
    if (filledFrom !== undefined || task.type === 'milestone' || (task.progress ?? 0) >= 100) return filledFrom
    const from = task.progress ?? 0
    task.progress = 100
    return from
  }
  if (filledFrom !== undefined && task.progress === 100) task.progress = filledFrom
  return undefined
}

const REPEAT_OPTIONS: SelectItem[] = [
  { id: 'none', label: 'Does not repeat', icon: 'repeat' },
  { id: 'daily', label: 'Daily', icon: 'repeat' },
  { id: 'weekly', label: 'Weekly', icon: 'repeat' },
  { id: 'monthly', label: 'Monthly', icon: 'repeat' },
  { id: 'yearly', label: 'Yearly', icon: 'repeat' }
]

/**
 * Renders the compact property grid: core properties (type, status, severity, due, assignees,
 * tags) always show; rarely-used ones (start, repeat, depends on) hide when empty behind
 * "Add property". Single-selects and dates re-render the form on change; multi-selects mutate
 * the task in place and refresh their own chips.
 */
export function renderTaskFormFields(container: HTMLElement, ctx: TaskFormFieldsContext): void {
  const { task, project, plugin, rerender, shownExtras } = ctx
  const changed = () => ctx.onChange?.()
  const { statuses, issueTypes, severities, verdicts, boardType } = plugin.store.configFor(project)
  // A plain board records no verdict and runs no clocks; a verdict stays on any
  // note that already has one and returns if the board is switched back.
  // Severity shows on every board: it is the one urgency dial, and a goals or
  // project board needs a way to say which card matters most.
  const socBoard = boardType !== 'plain'
  // Two columns, filled in order: every property takes the next free cell, so a
  // property that does not apply (no parent, no severity, no verdict) leaves no
  // hole behind — its neighbours close up instead. Which pairs share a row
  // therefore depends on what this task shows, and that is the point.
  const grid = container.createDiv('pm-prop-grid')

  // Type — one merged control: the issue types plus the structural kinds.
  // The file format is untouched; type and issueType still serialize apart.
  renderPropRow(
    grid,
    'Type',
    () => {
      const cell = createDiv('pm-prop-value')
      renderSelectControl({
        container: cell,
        value: task.type === 'milestone' ? MILESTONE_OPTION_ID : task.issueType,
        options: typeOptions(issueTypes, ctx.parentPickerEnabled ?? true),
        onChange: (id) => {
          if (id === MILESTONE_OPTION_ID) {
            task.type = 'milestone'
            task.start = ''
            task.progress = 0
            ctx.setParentId(null)
          } else if (id === SUBTASK_OPTION_ID) {
            task.type = 'subtask'
          } else {
            task.issueType = id
            // Leaving milestone mode restores a plain task; a subtask keeps
            // its nesting — its issue type changes freely.
            if (task.type === 'milestone') task.type = 'task'
          }
          rerender()
        }
      })
      return cell
    },
    'shapes'
  )

  // Parent task — subtasks only; it follows Type straight into the next cell.
  if (task.type === 'subtask') {
    renderPropRow(
      grid,
      'Parent task',
      () => {
        const cell = createDiv('pm-prop-value')
        // Excluding the whole subtree (not just self): picking a descendant as
        // parent cycles the index and hangs the ancestor walk.
        const excluded = subtreeIds(task)
        const parents = flattenTasks(project.tasks)
          .map((f) => f.task)
          .filter((t) => !excluded.has(t.id))
        renderSelectControl({
          container: cell,
          value: ctx.parentId,
          options: [{ id: '', label: 'No parent' }, ...parents.map((t) => ({ id: t.id, label: t.title }))],
          placeholder: 'Select parent',
          search: true,
          searchPlaceholder: 'Search tasks…',
          width: 230,
          onChange: (id) => {
            ctx.setParentId(id || null)
            // "No parent" is the way back to a plain task now that the merged
            // type control no longer offers Task/Subtask as separate kinds.
            if (!id) task.type = 'task'
            rerender()
          }
        })
        return cell
      },
      'corner-up-right'
    )
  }

  // Status | Severity — severity is the single urgency dial, optional on every task type.
  // Only incidents run an SLA clock off it (slaState gates on issueType).
  renderPropRow(
    grid,
    'Status',
    () => {
      const cell = createDiv('pm-prop-value')
      renderSelectControl({
        container: cell,
        value: task.status,
        options: statuses.map((s) => ({ id: s.id, label: s.label, color: s.color, icon: s.icon || undefined })),
        onChange: (id) => {
          task.status = id
          rerender()
        }
      })
      return cell
    },
    'circle-dot'
  )
  renderPropRow(
    grid,
    'Severity',
    () => {
      const cell = createDiv('pm-prop-value')
      renderSelectControl({
        container: cell,
        value: task.severity,
        options: [
          { id: '', label: 'None' },
          ...severities.map((s) => ({ id: s.id, label: s.label, color: s.color, icon: s.icon || undefined }))
        ],
        // Shown only when no option matches: a recorded id missing from the
        // severity list reads as itself, never as unset.
        placeholder: task.severity,
        onChange: (id) => {
          task.severity = id
          rerender()
        }
      })
      return cell
    },
    'shield-alert'
  )

  // Verdict — incidents only, and only on a case board; the spacer keeps the
  // two-column grid aligned
  if (socBoard && task.issueType === 'incident') {
    renderPropRow(
      grid,
      'Verdict',
      () => {
        const cell = createDiv('pm-prop-value')
        renderSelectControl({
          container: cell,
          value: task.verdict,
          options: [
            { id: '', label: 'None' },
            ...verdicts.map((v) => ({ id: v.id, label: v.label, color: v.color, icon: v.icon || undefined }))
          ],
          onChange: (id) => {
            task.verdict = id
            rerender()
          }
        })
        return cell
      },
      'scale'
    )
  }

  // Alert kind — incidents on a case board, like the verdict. The kind is a tag
  // on the case, so picking one is a tag edit that goes out with the save like
  // any other. A kind only derived from the title matches no option: it shows
  // as the muted placeholder, saying so, until the analyst picks.
  if (socBoard && task.issueType === 'incident') {
    const categories = plugin.settings.alertCategories
    const kind = shownAlertKind({ tags: task.tags, title: task.title, categories })
    const derived = kind?.derivedFrom !== undefined ? `${kind.category.label} (derived from title)` : undefined
    renderPropRow(
      grid,
      'Alert kind',
      () => {
        const cell = createDiv('pm-prop-value')
        renderSelectControl({
          container: cell,
          value: derived ? null : (kind?.category.id ?? ''),
          options: [
            { id: '', label: 'None' },
            ...categories.map((c) => ({ id: c.id, label: c.label, color: c.color, icon: c.icon || undefined }))
          ],
          placeholder: derived,
          onChange: (id) => {
            task.tags = setKindTag(task.tags, categories, id)
            rerender()
          }
        })
        return cell
      },
      'radar'
    )
  }

  // Progress — milestones have none
  if (task.type !== 'milestone') {
    renderPropRow(
      grid,
      'Progress',
      () => {
        const cell = createDiv('pm-prop-value pm-prop-progress')
        const slider = cell.createEl('input', { type: 'range', cls: 'slider' })
        slider.min = '0'
        slider.max = '100'
        // Notches of 25, except for a value off them (a migrated board's 5s, a
        // hand edit): the browser snaps the value to the step, which would draw
        // 40 at 50, beside a label saying 40%.
        slider.step = (task.progress ?? 0) % 25 ? '1' : '25'
        slider.value = String(task.progress ?? 0)
        const label = cell.createSpan({ cls: 'pm-prop-progress-label', text: `${Math.round(task.progress ?? 0)}%` })
        // Obsidian 1.13 paints a `.slider`'s fill from --slider-fill-ratio, which
        // only its own SliderComponent sets; a bare input left it at 0, so a
        // sliver of fill sat at the left whatever the value. Set it ourselves.
        const paint = () => slider.setCssProps({ '--slider-fill-ratio': String(Number(slider.value) / 100) })
        paint()
        slider.setAttribute('aria-label', 'Progress')
        slider.addEventListener('input', () => {
          label.setText(`${slider.value}%`)
          paint()
        })
        slider.addEventListener('change', () => {
          task.progress = Number(slider.value)
          rerender()
        })
        return cell
      },
      'gauge'
    )
  }
  renderPropRow(
    grid,
    'Bucket',
    () => {
      const cell = createDiv('pm-prop-value')
      renderSelectControl({
        container: cell,
        value: task.bucket,
        options: BUCKETS.map((b) => ({ id: b.id, label: b.label })),
        onChange: (id) => {
          task.bucket = id as IssueBucket
          rerender()
        }
      })
      return cell
    },
    'inbox'
  )

  // Due (Date for milestones)
  renderPropRow(
    grid,
    task.type === 'milestone' ? 'Date' : 'Due',
    () => {
      const cell = createDiv('pm-prop-value')
      renderDateControl({
        container: cell,
        value: task.due,
        emptyLabel: 'Set due date',
        hint: isTerminalStatus(task.status, statuses) ? null : relativeDue(task.due),
        onChange: (v) => {
          task.due = v
          rerender()
        }
      })
      return cell
    },
    'calendar-clock'
  )

  // Start — milestones have none
  if (task.type !== 'milestone') {
    renderPropRow(
      grid,
      'Start',
      () => {
        const cell = createDiv('pm-prop-value')
        renderDateControl({
          container: cell,
          value: task.start,
          emptyLabel: 'Set start',
          onChange: (v) => {
            task.start = v
            rerender()
          }
        })
        return cell
      },
      'play'
    )
  }

  // Assignees
  renderPropRow(
    grid,
    'Assignees',
    () => {
      const cell = createDiv('pm-prop-value')
      // A member row added in Settings and never named is no one to assign.
      const allMembers = () =>
        [...new Set([...project.teamMembers, ...plugin.settings.globalTeamMembers])].filter((m) => m.trim())
      renderMultiSelect({
        container: cell,
        avatarStack: true,
        search: true,
        addLabel: 'Assign',
        placeholder: 'Search people…',
        selected: () => task.assignees,
        options: () => allMembers().map((m) => ({ id: m, label: m })),
        add: (id) => {
          if (!task.assignees.includes(id)) task.assignees.push(id)
          changed()
        },
        remove: (id) => {
          task.assignees = task.assignees.filter((a) => a !== id)
          changed()
        },
        create: (label) => {
          if (!task.assignees.includes(label)) task.assignees.push(label)
          changed()
        }
      })
      return cell
    },
    'users'
  )

  // Completed (when complete or in a terminal status)
  if (task.completed || isTerminalStatus(task.status, statuses)) {
    renderPropRow(
      grid,
      'Completed',
      () => {
        const cell = createDiv('pm-prop-value')
        renderDateControl({
          container: cell,
          value: task.completed,
          emptyLabel: 'Set date',
          hint: completionOutcome(task.due, task.completed),
          onChange: (v) => {
            task.completed = v
            rerender()
          }
        })
        return cell
      },
      'circle-check-big'
    )
  }

  // Repeat (extra)
  if (task.recurrence || shownExtras.has('repeat')) {
    renderPropRow(
      grid,
      'Repeat',
      () => {
        const cell = createDiv('pm-prop-value')
        renderSelectControl({
          container: cell,
          value: task.recurrence?.interval ?? 'none',
          options: REPEAT_OPTIONS,
          onChange: (id) => {
            if (id === 'none') {
              task.recurrence = undefined
            } else {
              task.recurrence = {
                interval: id as Recurrence['interval'],
                every: task.recurrence?.every ?? 1,
                endDate: task.recurrence?.endDate
              }
            }
            rerender()
          }
        })
        return cell
      },
      'repeat'
    )
  }

  // Tags
  const tagsRow = renderPropRow(
    grid,
    'Tags',
    () => {
      const cell = createDiv('pm-prop-value')
      const projectTags = [...new Set(flattenTasks(project.tasks).flatMap((f) => f.task.tags))]
      renderMultiSelect({
        container: cell,
        search: true,
        addLabel: 'Add tags',
        placeholder: 'Find or create…',
        tag: true,
        colorFor: plugin.settings.showTagColors ? (t) => stringToColor(t) : undefined,
        selected: () => task.tags,
        options: () => projectTags.map((t) => ({ id: t, label: t })),
        add: (id) => {
          if (!task.tags.includes(id)) task.tags.push(id)
          changed()
        },
        remove: (id) => {
          task.tags = task.tags.filter((t) => t !== id)
          changed()
        },
        create: (label) => {
          if (!task.tags.includes(label)) task.tags.push(label)
          changed()
        }
      })
      return cell
    },
    'tag'
  )
  tagsRow.addClass('pm-prop-row--wide')

  // Depends on (extra)
  if (task.dependencies.length > 0 || shownExtras.has('depends')) {
    const allTasks = flattenTasks(project.tasks)
      .map((f) => f.task)
      .filter((t) => t.id !== task.id)
    const titleOf = (id: string) => allTasks.find((t) => t.id === id)?.title ?? id
    const depRow = renderPropRow(
      grid,
      'Depends on',
      () => {
        const cell = createDiv('pm-prop-value')
        renderMultiSelect({
          container: cell,
          search: true,
          addLabel: 'Add dependency',
          addLabelMore: 'Add another',
          placeholder: 'Search tasks…',
          depsList: true,
          labelFor: titleOf,
          selected: () => task.dependencies.filter((id) => allTasks.some((t) => t.id === id)),
          options: () =>
            allTasks
              .filter((t) => task.dependencies.includes(t.id) || !wouldCreateCycle(project.tasks, task.id, t.id))
              .map((t) => ({ id: t.id, label: t.title })),
          add: (id) => {
            if (!task.dependencies.includes(id)) task.dependencies.push(id)
            changed()
          },
          remove: (id) => {
            task.dependencies = task.dependencies.filter((d) => d !== id)
            changed()
          }
        })
        return cell
      },
      'link-2'
    )
    depRow.addClass('pm-prop-row--wide')
  }

  // Progressive disclosure for the remaining empty extras
  const hidden: HiddenProperty[] = []
  if (!task.recurrence && !shownExtras.has('repeat')) {
    hidden.push({ id: 'repeat', label: 'Repeat', icon: 'repeat' })
  }
  if (task.dependencies.length === 0 && !shownExtras.has('depends')) {
    hidden.push({ id: 'depends', label: 'Depends on', icon: 'link-2' })
  }
  if (hidden.length > 0) {
    const addCell = grid.createDiv('pm-prop-add-cell')
    renderAddProperty(addCell, hidden, (id) => {
      shownExtras.add(id)
      rerender()
    })
  }

  // Custom fields
  if (project.customFields.length > 0) {
    const cfSection = container.createDiv('pm-modal-section')
    cfSection.createEl('h4', { text: 'Custom fields', cls: 'pm-modal-section-title' })
    const cfGrid = cfSection.createDiv('pm-prop-grid')
    for (const cf of project.customFields) {
      renderPropRow(cfGrid, cf.name, () => renderCustomFieldInput(cf, task, project, plugin, ctx.onChange))
    }
  }
}
