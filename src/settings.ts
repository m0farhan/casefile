import { App, PluginSettingTab, Setting, Notice } from 'obsidian'
import type PMPlugin from './main'
import { type PMSettings, type SlaPolicy, DEFAULT_SETTINGS, makeId } from './types'
import { flattenTasks } from './store/TaskTreeOps'
import { getTaskNotesApi, importTaskNotesPalettes, isTaskNotesInstalled } from './integrations/tasknotes'
import { renderPriorityListEditor, renderStatusListEditor } from './ui/PaletteListEditor'
import { IconButton } from './ui/primitives/IconButton'

export type { PMSettings }
export { DEFAULT_SETTINGS }

export class PMSettingTab extends PluginSettingTab {
  plugin: PMPlugin
  /** Response-target rows container; re-rendered when the severity palette changes. */
  private slaContainer: HTMLElement | null = null

  constructor(app: App, plugin: PMPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    containerEl.addClass('pm-settings')

    // ── General ──────────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName('Projects folder')
      .setDesc('Vault folder that holds each project folder. Leave empty to use the vault root.')
      .addText((text) =>
        text
          .setPlaceholder('Vault root')
          .setValue(this.plugin.settings.projectsFolder)
          .onChange(async (v) => {
            this.plugin.settings.projectsFolder = v.trim()
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Default view')
      .setDesc('Which view opens when you open a project.')
      .addDropdown((dd) =>
        dd
          .addOption('table', 'Table')
          .addOption('gantt', 'Gantt')
          .addOption('kanban', 'Board')
          .setValue(this.plugin.settings.defaultView)
          .onChange(async (v) => {
            this.plugin.settings.defaultView = v as PMSettings['defaultView']
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Open tasks in')
      .setDesc(
        'Where clicking a task opens it. The side panel autosaves and suits triage runs; new tasks always use the dialog.'
      )
      .addDropdown((dd) =>
        dd
          .addOption('modal', 'Dialog')
          .addOption('panel', 'Side panel')
          .setValue(this.plugin.settings.openTaskIn)
          .onChange(async (v) => {
            this.plugin.settings.openTaskIn = v as PMSettings['openTaskIn']
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Current user')
      .setDesc('Your assignee name — makes assignee:me work in the search bar.')
      .addText((text) =>
        text
          .setPlaceholder('Farhan')
          .setValue(this.plugin.settings.currentUser)
          .onChange(async (v) => {
            this.plugin.settings.currentUser = v.trim()
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl).setName('Default gantt granularity').addDropdown((dd) =>
      dd
        .addOption('day', 'Day')
        .addOption('week', 'Week')
        .addOption('month', 'Month')
        .addOption('quarter', 'Quarter')
        .setValue(this.plugin.settings.ganttGranularity)
        .onChange(async (v) => {
          this.plugin.settings.ganttGranularity = v as PMSettings['ganttGranularity']
          await this.plugin.saveSettings()
        })
    )

    new Setting(containerEl)
      .setName('Gantt week label')
      .setDesc('What to display in weekly gantt header cells.')
      .addDropdown((dd) =>
        dd
          .addOption('weekNumber', 'Week number (w15)')
          .addOption('dateRange', 'Date range (apr 7\u201313)')
          .addOption('both', 'Both (w15: apr 7\u201313)')
          .setValue(this.plugin.settings.ganttWeekLabel)
          .onChange(async (v) => {
            this.plugin.settings.ganttWeekLabel = v as PMSettings['ganttWeekLabel']
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Show subtasks on board')
      .setDesc('Display subtasks as individual cards on the kanban board.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.kanbanShowSubtasks).onChange(async (v) => {
          this.plugin.settings.kanbanShowSubtasks = v
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Show description preview on board')
      .setDesc('Display the first few lines of each task description on kanban cards.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.kanbanShowDescriptionPreview).onChange(async (v) => {
          this.plugin.settings.kanbanShowDescriptionPreview = v
          await this.plugin.saveSettings()
          this.plugin.refreshProjectViews()
        })
      )

    new Setting(containerEl)
      .setName('Show tag colors')
      .setDesc('Show a colored dot on each tag, derived from its name. Turn off for plain tags.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showTagColors).onChange(async (v) => {
          this.plugin.settings.showTagColors = v
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Reduce animations')
      .setDesc('Disable movement effects (card glides, entrances, pulses). Color transitions remain.')
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.reduceAnimations).onChange(async (v) => {
          this.plugin.settings.reduceAnimations = v
          await this.plugin.saveSettings()
          this.plugin.applyMotionPreference()
        })
      )

    new Setting(containerEl)
      .setName('Save tasks on close')
      .setDesc('Automatically save tasks when you close the task modal. When off, only clicking save persists changes.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.saveTaskOnClose).onChange(async (v) => {
          this.plugin.settings.saveTaskOnClose = v
          await this.plugin.saveSettings()
        })
      )

    // ── Notifications ─────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Due date notifications').setHeading()

    new Setting(containerEl)
      .setName('Enable notifications')
      .setDesc('Show a banner when tasks are approaching their due date.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.notificationsEnabled).onChange(async (v) => {
          this.plugin.settings.notificationsEnabled = v
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Lead time (days)')
      .setDesc('How many days before the due date to show the notification.')
      .addSlider((sl) =>
        sl
          .setLimits(1, 14, 1)
          .setValue(this.plugin.settings.notificationLeadDays)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.notificationLeadDays = v
            await this.plugin.saveSettings()
          })
      )

    // ── Scheduling ───────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Scheduling').setHeading()

    new Setting(containerEl)
      .setName('Auto-schedule')
      .setDesc('Automatically adjust dependent task dates when a task changes.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSchedule).onChange(async (v) => {
          this.plugin.settings.autoSchedule = v
          await this.plugin.saveSettings()
        })
      )

    // ── Team Members ──────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Team members').setHeading()

    containerEl.createEl('p', {
      cls: 'pm-settings-desc',
      text: 'Global list of people available as assignees across all projects.'
    })
    // margin handled by .pm-settings-desc CSS class

    const membersContainer = containerEl.createDiv('pm-settings-members')
    this.renderMembersList(membersContainer)

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText('+ add member')
        .setCta()
        .onClick(() => {
          this.plugin.settings.globalTeamMembers.push('')
          void this.plugin.saveSettings()
          this.renderMembersList(membersContainer)
        })
    )

    // ── Statuses ──────────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Statuses').setHeading()
    containerEl.createEl('p', {
      cls: 'pm-settings-desc',
      text: 'Customize status labels, colors, and icons. Drag to reorder.'
    })

    const statusContainer = containerEl.createDiv('pm-settings-statuses')
    this.renderStatusList(statusContainer)

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText('+ add status')
        .setCta()
        .onClick(() => {
          const id = 'status-' + makeId().slice(0, 6)
          this.plugin.settings.statuses.push({
            id,
            label: 'New status',
            color: '#8a94a0',
            icon: '',
            complete: false
          })
          void this.plugin.saveSettings()
          this.renderStatusList(statusContainer)
        })
    )

    // No Priorities section: priority is UI-retired (severity is the urgency dial).
    // settings.priorities stays in data.json so existing task files keep round-tripping.

    // ── Issue types ───────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Issue types').setHeading()
    containerEl.createEl('p', {
      cls: 'pm-settings-desc',
      text: 'Customize issue type labels, colors, and icons. Drag to reorder.'
    })

    const issueTypeContainer = containerEl.createDiv('pm-settings-statuses')
    this.renderIssueTypeList(issueTypeContainer)

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText('+ add issue type')
        .setCta()
        .onClick(() => {
          const id = 'issuetype-' + makeId().slice(0, 6)
          this.plugin.settings.issueTypes.push({
            id,
            label: 'New issue type',
            color: '#8a94a0',
            icon: ''
          })
          void this.plugin.saveSettings()
          this.renderIssueTypeList(issueTypeContainer)
        })
    )

    // ── Severities ────────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Severities').setHeading()
    containerEl.createEl('p', {
      cls: 'pm-settings-desc',
      text: 'Customize severity labels, colors, and icons. Drag to reorder from most to least severe.'
    })

    const severityContainer = containerEl.createDiv('pm-settings-statuses')
    this.renderSeverityList(severityContainer)

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText('+ add severity')
        .setCta()
        .onClick(() => {
          const id = 'severity-' + makeId().slice(0, 6)
          this.plugin.settings.severities.push({
            id,
            label: 'New severity',
            color: '#8a94a0',
            icon: ''
          })
          void this.plugin.saveSettings()
          this.renderSeverityList(severityContainer)
          this.renderSlaRows()
        })
    )

    // ── Verdicts ──────────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Verdicts').setHeading()
    containerEl.createEl('p', {
      cls: 'pm-settings-desc',
      text: 'Customize verdict labels, colors, and icons. Drag to reorder.'
    })

    const verdictContainer = containerEl.createDiv('pm-settings-statuses')
    this.renderVerdictList(verdictContainer)

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText('+ add verdict')
        .setCta()
        .onClick(() => {
          const id = 'verdict-' + makeId().slice(0, 6)
          this.plugin.settings.verdicts.push({
            id,
            label: 'New verdict',
            color: '#8a94a0',
            icon: ''
          })
          void this.plugin.saveSettings()
          this.renderVerdictList(verdictContainer)
        })
    )

    // ── Incident response targets (SLA policies) ──────────────────────────────
    new Setting(containerEl).setName('Incident response targets').setHeading()
    containerEl.createEl('p', {
      cls: 'pm-settings-desc',
      text: 'Severity drives the response clock on incidents. Times are minutes; leave both fields empty to run no clock for a severity.'
    })

    this.slaContainer = containerEl.createDiv('pm-settings-sla')
    this.renderSlaRows()

    // ── Shift handover ────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Shift handover').setHeading()

    new Setting(containerEl)
      .setName('Handover note path')
      .setDesc('Vault path of the generated shift-handover note.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.handoverPath)
          .setValue(this.plugin.settings.handoverPath)
          .onChange(async (v) => {
            this.plugin.settings.handoverPath = v.trim() || DEFAULT_SETTINGS.handoverPath
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Handover window (hours)')
      .setDesc('How far back the handover note looks for activity.')
      .addSlider((sl) =>
        sl
          .setLimits(1, 48, 1)
          .setValue(this.plugin.settings.handoverWindowHours)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.handoverWindowHours = v
            await this.plugin.saveSettings()
          })
      )

    // ── Incident templates ────────────────────────────────────────────────────
    new Setting(containerEl).setName('Incident templates').setHeading()
    containerEl.createEl('p', {
      cls: 'pm-settings-desc',
      text: 'Playbook presets for the new-incident command: issue type, severity, tags and a checklist body.'
    })
    const templatesContainer = containerEl.createDiv('pm-settings-templates')
    this.renderTemplatesList(templatesContainer)
    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText('+ add template').onClick(async () => {
        this.plugin.settings.incidentTemplates.push({
          id: makeId(),
          name: 'New template',
          taskDefaults: { issueType: 'incident', severity: '', priority: 'high', tags: [] },
          bodyMarkdown: '## Summary\n\n\n## Checklist\n- [ ] Record verdict and close'
        })
        await this.plugin.saveSettings()
        this.renderTemplatesList(templatesContainer)
      })
    )

    if (isTaskNotesInstalled(this.app)) {
      new Setting(containerEl).setName('TaskNotes').setHeading()

      new Setting(containerEl)
        .setName('Import statuses')
        .setDesc(
          'Add or update statuses to match TaskNotes; its priorities are recorded too so imported tasks round-trip. Entries TaskNotes does not know are kept.'
        )
        .addButton((btn) =>
          btn.setButtonText('Import from TaskNotes').onClick(() => {
            const api = getTaskNotesApi(this.app)
            if (!api) {
              new Notice('TaskNotes 4.10 or newer is required.')
              return
            }
            const { added, updated } = importTaskNotesPalettes(api, this.plugin.settings)
            void this.plugin.saveSettings()
            this.display()
            new Notice(
              added || updated
                ? `Imported from TaskNotes: ${added} added, ${updated} updated.`
                : 'Statuses and priorities already match TaskNotes.'
            )
          })
        )
    }
  }

  private renderMembersList(container: HTMLElement): void {
    container.empty()
    const members = this.plugin.settings.globalTeamMembers
    members.forEach((m, i) => {
      const row = container.createDiv('pm-settings-member-row')
      const input = row.createEl('input', { type: 'text', value: m })
      input.placeholder = 'Name'
      input.addEventListener('change', () => {
        this.plugin.settings.globalTeamMembers[i] = input.value
        void this.plugin.saveSettings()
      })
      new IconButton(row)
        .setIcon('x')
        .setTooltip('Remove member')
        .onClick(() => {
          this.plugin.settings.globalTeamMembers.splice(i, 1)
          void this.plugin.saveSettings()
          this.renderMembersList(container)
        })
    })
  }

  private renderTemplatesList(container: HTMLElement): void {
    container.empty()
    const templates = this.plugin.settings.incidentTemplates
    templates.forEach((tpl, i) => {
      const row = container.createDiv('pm-settings-template')
      const head = row.createDiv('pm-settings-template-head')
      const nameInput = head.createEl('input', { type: 'text', value: tpl.name, cls: 'pm-input' })
      nameInput.placeholder = 'Template name'
      nameInput.addEventListener('change', () => {
        tpl.name = nameInput.value.trim() || tpl.name
        void this.plugin.saveSettings()
      })
      new IconButton(head)
        .setIcon('x')
        .setTooltip('Remove template')
        .onClick(() => {
          this.plugin.settings.incidentTemplates.splice(i, 1)
          void this.plugin.saveSettings()
          this.renderTemplatesList(container)
        })

      const defaults = row.createDiv('pm-settings-template-defaults')
      const sevSelect = defaults.createEl('select', { cls: 'dropdown' })
      sevSelect.createEl('option', { text: 'No severity', value: '' })
      for (const s of this.plugin.settings.severities) {
        sevSelect.createEl('option', { text: s.label, value: s.id })
      }
      sevSelect.value = tpl.taskDefaults.severity ?? ''
      sevSelect.addEventListener('change', () => {
        tpl.taskDefaults.severity = sevSelect.value
        void this.plugin.saveSettings()
      })
      const tagsInput = defaults.createEl('input', { type: 'text', cls: 'pm-input' })
      tagsInput.placeholder = 'Tags, comma-separated'
      tagsInput.value = (tpl.taskDefaults.tags ?? []).join(', ')
      tagsInput.addEventListener('change', () => {
        tpl.taskDefaults.tags = tagsInput.value
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
        void this.plugin.saveSettings()
      })

      const bodyArea = row.createEl('textarea', { cls: 'pm-input pm-settings-template-body' })
      bodyArea.rows = 5
      bodyArea.value = tpl.bodyMarkdown
      bodyArea.placeholder = 'Checklist body (Markdown)'
      bodyArea.addEventListener('change', () => {
        tpl.bodyMarkdown = bodyArea.value
        void this.plugin.saveSettings()
      })
    })
  }

  private async remapOrphanTasks(
    field: 'status' | 'issueType' | 'severity' | 'verdict',
    deletedId: string,
    deletedLabel: string
  ): Promise<void> {
    const configs =
      field === 'status'
        ? this.plugin.settings.statuses
        : field === 'issueType'
          ? this.plugin.settings.issueTypes
          : null
    // Severity/verdict '' is the valid "none" state, so their orphans clear rather than remap.
    let fallbackId = ''
    let fallbackLabel = 'none'
    if (configs) {
      if (configs.length === 0) return
      // Orphaned issue types remap to 'task' (the neutral default); statuses to the first entry.
      const fallback = (field === 'issueType' && configs.find((c) => c.id === 'task')) || configs[0]
      fallbackId = fallback.id
      fallbackLabel = fallback.label
    }
    const folder = this.plugin.settings.projectsFolder
    const projects = await this.plugin.store.loadAllProjects(folder)
    let remapped = 0
    for (const project of projects) {
      // A project that defines this entry itself is unaffected by the global delete.
      // Severities/verdicts are global-only in v1 — no per-project override to check.
      const own =
        field === 'status' ? project.config?.statuses : field === 'issueType' ? project.config?.issueTypes : undefined
      if (own?.some((entry) => entry.id === deletedId)) continue
      const ids = flattenTasks(project.tasks)
        .filter(({ task }) => task[field] === deletedId)
        .map(({ task }) => task.id)
      if (ids.length) {
        await this.plugin.store.updateTasks(project, ids, { [field]: fallbackId })
        remapped += ids.length
      }
    }
    if (remapped > 0) {
      new Notice(`Remapped ${remapped} task${remapped === 1 ? '' : 's'} from '${deletedLabel}' to '${fallbackLabel}'.`)
    }
  }

  private renderStatusList(container: HTMLElement): void {
    renderStatusListEditor(container, {
      app: this.app,
      statuses: this.plugin.settings.statuses,
      onChanged: () => void this.plugin.saveSettings(),
      onDeleted: (deleted) => void this.remapOrphanTasks('status', deleted.id, deleted.label)
    })
  }

  private renderIssueTypeList(container: HTMLElement): void {
    // ponytail: IssueTypeConfig is structurally a PriorityConfig, so the priority palette editor
    // is reused as-is (its min-one Notice copy is generic).
    renderPriorityListEditor(container, {
      app: this.app,
      priorities: this.plugin.settings.issueTypes,
      onChanged: () => void this.plugin.saveSettings(),
      onDeleted: (deleted) => void this.remapOrphanTasks('issueType', deleted.id, deleted.label)
    })
  }

  private renderSeverityList(container: HTMLElement): void {
    // ponytail: SeverityConfig is structurally a PriorityConfig — same editor reuse as issue types.
    renderPriorityListEditor(container, {
      app: this.app,
      priorities: this.plugin.settings.severities,
      onChanged: () => {
        void this.plugin.saveSettings()
        this.renderSlaRows() // severity labels/colors also show in the response-target rows
      },
      onDeleted: (deleted) => {
        Reflect.deleteProperty(this.plugin.settings.slaPolicies, deleted.id)
        void this.plugin.saveSettings()
        void this.remapOrphanTasks('severity', deleted.id, deleted.label)
        this.renderSlaRows()
      }
    })
  }

  private renderVerdictList(container: HTMLElement): void {
    // ponytail: VerdictConfig is structurally a PriorityConfig — same editor reuse as issue types.
    renderPriorityListEditor(container, {
      app: this.app,
      priorities: this.plugin.settings.verdicts,
      onChanged: () => void this.plugin.saveSettings(),
      onDeleted: (deleted) => void this.remapOrphanTasks('verdict', deleted.id, deleted.label)
    })
  }

  /** One row per severity: response/resolution targets in minutes. Empty pair = no clock. */
  private renderSlaRows(): void {
    const container = this.slaContainer
    if (!container) return
    container.empty()
    for (const sev of this.plugin.settings.severities) {
      const row = container.createDiv('pm-settings-sla-row')
      row.createSpan({ cls: 'pm-settings-sla-dot' }).setCssStyles({ background: sev.color })
      row.createSpan({ text: sev.label, cls: 'pm-settings-sla-label' })

      const policy: SlaPolicy | undefined = this.plugin.settings.slaPolicies[sev.id]
      const makeField = (label: string, value: number | undefined): HTMLInputElement => {
        row.createSpan({ text: label, cls: 'pm-settings-sla-field-label' })
        const input = row.createEl('input', { type: 'number', cls: 'pm-settings-sla-input' })
        input.min = '0'
        input.placeholder = '—'
        if (value !== undefined) input.value = String(value)
        return input
      }
      const response = makeField('Response', policy?.responseMins)
      const resolution = makeField('Resolution', policy?.resolutionMins)

      const save = (): void => {
        const parse = (el: HTMLInputElement): number | null => {
          if (el.value.trim() === '') return null
          const n = Number(el.value)
          return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null
        }
        const responseMins = parse(response)
        const resolutionMins = parse(resolution)
        if (responseMins === null && resolutionMins === null) {
          Reflect.deleteProperty(this.plugin.settings.slaPolicies, sev.id)
        } else {
          this.plugin.settings.slaPolicies[sev.id] = {
            responseMins: responseMins ?? 0,
            resolutionMins: resolutionMins ?? 0
          }
        }
        void this.plugin.saveSettings()
      }
      response.addEventListener('change', save)
      resolution.addEventListener('change', save)
    }
  }
}
