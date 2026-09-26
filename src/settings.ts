import { App, PluginSettingTab, Setting, Notice } from 'obsidian'
import type PMPlugin from './main'
import { type PMSettings, type Project, type SlaPolicy, type StatusConfig, DEFAULT_SETTINGS, makeId } from './types'
import { flattenTasks } from './store/TaskTreeOps'
import { getTaskNotesApi, importTaskNotesPalettes, isTaskNotesInstalled } from './integrations/tasknotes'
import { renderPriorityListEditor, renderStatusListEditor, statusFallback } from './ui/PaletteListEditor'
import { confirmDialog } from './ui/ModalFactory'
import { IconButton } from './ui/primitives/IconButton'
import { unmatchableAssetRules } from './soc/ioc'

export type { PMSettings }
export { DEFAULT_SETTINGS }

/** A palette whose deleted entries leave cases to move. */
type PaletteField = 'status' | 'issueType' | 'severity' | 'verdict'
type PaletteItem = { id: string; label: string }

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
      .setName('Default folder for new boards')
      .setDesc(
        'Where a new board is created when you do not pick a folder yourself. Leave empty for the vault root. Boards are found by their frontmatter wherever they sit, so this is a starting point, not a fence — move a board folder in the file explorer and it keeps working.'
      )
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
      .setDesc('Which view opens when you open a board.')
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

    new Setting(containerEl)
      .setName('Gantt granularity')
      .setDesc('The zoom the gantt view opens at. Changing the zoom inside the gantt view also changes this setting.')
      .addDropdown((dd) =>
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
      .setDesc(
        'Save an existing case automatically when you close its dialog. When off, only the save button keeps ' +
          'changes. A new case is created only by its create button, and closing over a typed draft asks first.'
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.saveTaskOnClose).onChange(async (v) => {
          this.plugin.settings.saveTaskOnClose = v
          await this.plugin.saveSettings()
        })
      )

    // ── Notifications ─────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Notifications').setHeading()

    new Setting(containerEl)
      .setName('Enable notifications')
      .setDesc(
        'Show a banner when a task approaches its due date or an incident misses its response or resolution ' +
          'target. ' +
          "A missed target is recorded in the case's activity log either way."
      )
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
      text: 'Global list of people available as assignees across all boards.'
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
      text: 'Customize status labels, colors, and icons. Drag or use the arrows to reorder.'
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
      text: 'Customize issue type labels, colors, and icons. Drag or use the arrows to reorder.'
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
      text: 'Customize severity labels, colors, and icons. Drag or use the arrows to reorder, from most to least severe.'
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
      text: 'Customize verdict labels, colors, and icons. Drag or use the arrows to reorder.'
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
      text:
        'Severity drives the response clock on incidents. Times are calendar minutes, counted from the ' +
        'detection time, or from case creation when none is recorded. The clock never pauses: a case ' +
        'waiting in any open status, such as User Response, keeps counting and can breach. Set both ' +
        'targets for a severity, or leave both empty to run no clock for it.'
    })

    this.slaContainer = containerEl.createDiv('pm-settings-sla')
    this.renderSlaRows()

    // ── Asset boundary ────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Asset boundary').setHeading()
    containerEl.createEl('p', {
      cls: 'pm-settings-desc',
      text:
        'Your own domains and IPv4 ranges, one per line — corp.example, *.corp.example, 10.0.0.0/8, ' +
        '198.51.100.7, 2001:db8::5. Lines starting with # are comments. Indicators that match are still ' +
        'recorded on the case and marked ASSET, and are never sent to VirusTotal, AbuseIPDB or abuse.ch, ' +
        'or searched across cases. Nothing is guessed: only what you list here, plus the private, loopback ' +
        'and link-local ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, IPv6 ::1, fc00::/7, ' +
        'fe80::/10, and IPv4-mapped forms like ::ffff:10.0.0.5), which are internal by definition. ' +
        'A domain covers its subdomains: corp.example matches mail.corp.example, not evilcorp.example.'
    })
    const assetWarnEl = containerEl.createEl('p', { cls: 'pm-settings-desc' })
    const renderAssetWarning = () => {
      const bad = unmatchableAssetRules(this.plugin.settings.ownedAssets)
      assetWarnEl.setText(
        bad.length
          ? `Not matched, these entries are ignored: ${bad.join(', ')} — use a domain, an IPv4 address ` +
              `or CIDR, or a single IPv6 address. IPv6 ranges are not supported.`
          : ''
      )
    }
    new Setting(containerEl).setName('Owned domains and ranges').addTextArea((text) => {
      text.inputEl.rows = 4
      // No placeholder: the examples are in the description above, and the
      // UI-copy lint reads any placeholder as a sentence — 'corp.example' is
      // not one, and capitalising it would make it a wrong example.
      text.setValue(this.plugin.settings.ownedAssets.join('\n')).onChange(async (v) => {
        // One entry per LINE, as the description promises. Splitting on all
        // whitespace would turn "# datacentre range" into three live rules,
        // one of which ("datacentre") would match a bare hostname.
        this.plugin.settings.ownedAssets = v
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'))
        renderAssetWarning()
        await this.plugin.saveSettings()
      })
    })
    renderAssetWarning()

    // ── Phishing analyser ─────────────────────────────────────────────────────
    new Setting(containerEl).setName('Phishing analyser').setHeading()
    containerEl.createEl('p', {
      cls: 'pm-settings-desc',
      text:
        'Names worth impersonating, one per line — the brands your users would believe. The analyser folds ' +
        'look-alike characters and reports a link host that reads as one of these once folded, or that sits ' +
        'one character away from it. Nothing ships in this list on purpose: which brands matter is your ' +
        'call, not the plugin’s, and a guessed list would cry wolf on every mail from a real sender.'
    })
    new Setting(containerEl).setName('Brands to watch for').addTextArea((text) => {
      text.inputEl.rows = 4
      text.setValue(this.plugin.settings.phishBrands.join('\n')).onChange(async (v) => {
        this.plugin.settings.phishBrands = v
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'))
        await this.plugin.saveSettings()
      })
    })

    // ── Live reputation checks ────────────────────────────────────────────────
    new Setting(containerEl).setName('Live reputation checks').setHeading()

    const repDesc = new Setting(containerEl)
      .setName('VirusTotal key')
      .setDesc(
        'Enables the reputation button on indicator rows (IP, domain, hash, URL; ' +
          'for an email its domain is checked). The key is stored on this device ' +
          'only (not synced, not in the vault); the indicator value is sent to ' +
          'VirusTotal only when you click the button.'
      )
    repDesc.addText((text) => {
      text.inputEl.type = 'password'
      text
        .setPlaceholder('None — checks disabled')
        .setValue(this.plugin.getSecret('virustotal'))
        .onChange((v) => {
          this.plugin.setSecret('virustotal', v)
        })
    })

    const abDesc = new Setting(containerEl)
      .setName('AbuseIPDB key')
      .setDesc(
        'Adds a second opinion for IP indicators (AbuseIPDB checks IP addresses ' +
          'only). Same rules: device-local key, sent only on click.'
      )
    abDesc.addText((text) => {
      text.inputEl.type = 'password'
      text
        .setPlaceholder('None — checks disabled')
        .setValue(this.plugin.getSecret('abuseipdb'))
        .onChange((v) => {
          this.plugin.setSecret('abuseipdb', v)
        })
    })

    const acDesc = new Setting(containerEl)
      .setName('abuse.ch auth key')
      .setDesc(
        'Adds MalwareBazaar (hashes), URLhaus (URLs and domains) and ThreatFox ' +
          '(IPs) — one free key from auth.abuse.ch covers all three. Same rules: ' +
          'device-local key, sent only on click.'
      )
    acDesc.addText((text) => {
      text.inputEl.type = 'password'
      text
        .setPlaceholder('None — checks disabled')
        .setValue(this.plugin.getSecret('abusech'))
        .onChange((v) => {
          this.plugin.setSecret('abusech', v)
        })
    })

    // ── Note layout ───────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Note layout').setHeading()

    new Setting(containerEl)
      .setName('Link each task note back to its board')
      .setDesc(
        'Writes a "Project: [[Board]]" line at the foot of every task note. It is only an Obsidian ' +
          "backlink — the plugin finds a task's board from its folder — so turning it off costs the graph " +
          'edge and nothing else. Notes that already have the line keep it until the next time each one is saved.'
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.linkTasksToBoard).onChange(async (v) => {
          this.plugin.settings.linkTasksToBoard = v
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Show the incident timeline panel')
      .setDesc(
        'The five lifecycle stamps — occurred, detected, responded, contained, resolved — as editable ' +
          'fields on a case. Off by default: intake no longer invents a detection time, so on most cases ' +
          'all five are empty. The stamps still drive the response clock and still print in the case ' +
          'timeline and the case report; turn this on to set one by hand.'
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showIncidentTimeline).onChange(async (v) => {
          this.plugin.settings.showIncidentTimeline = v
          await this.plugin.saveSettings()
        })
      )

    // ── Auto-archive ──────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Auto-archive').setHeading()

    new Setting(containerEl)
      .setName('Archive closed cases after (days)')
      .setDesc(
        "Move a closed case into its board's Archive folder this many days after it last moved into a " +
          'closing status. Moving it between two closing statuses restarts the count, and a case whose ' +
          'timeline never recorded that move counts from its completion date. Whole days, 0–365; 0 turns ' +
          'it off. The case note is moved, not deleted, and the move is written into the case timeline. ' +
          'A case you unarchive is never taken again — archive it by hand after that. ' +
          'A case with no completion date is never moved.'
      )
      .addText((text) => {
        text.setValue(String(this.plugin.settings.autoArchiveDays))
        // Read on commit (blur or Enter), not per keystroke: typing "400" used
        // to save 4 and then 40 on the way, and the sweep moved files on 40.
        text.inputEl.addEventListener('change', () => {
          const n = Number(text.getValue().trim())
          // Refuse a value rather than quietly clamping it: an analyst who typed
          // "30" and got 7 would not know their files were about to move early.
          // The box goes back to the saved value, so it shows what applies.
          if (!Number.isFinite(n) || n < 0 || n > 365 || !Number.isInteger(n)) {
            const kept = this.plugin.settings.autoArchiveDays
            text.setValue(String(kept))
            new Notice(`Archive window must be whole days, 0–365. Kept ${kept}.`)
            return
          }
          this.plugin.settings.autoArchiveDays = n
          void this.plugin.saveSettings()
        })
      })

    // ── Shift handover ────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Shift handover').setHeading()

    new Setting(containerEl)
      .setName('Handover note path')
      .setDesc(
        'Vault path of the shift-handover note. Choosing Write in the handover preview replaces the whole ' +
          'note at this path each time, so use a path that holds nothing else.'
      )
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

      // Not pm-input: the settings tab sits outside the plugin's variable scope,
      // and that class's rules would outrank Obsidian's native textarea border,
      // background and focus ring with values that are empty here.
      const bodyArea = row.createEl('textarea', { cls: 'pm-settings-template-body' })
      bodyArea.rows = 5
      bodyArea.value = tpl.bodyMarkdown
      bodyArea.placeholder = 'Checklist body (Markdown)'
      bodyArea.addEventListener('change', () => {
        tpl.bodyMarkdown = bodyArea.value
        void this.plugin.saveSettings()
      })
    })
  }

  /**
   * Where a deleted palette entry's cases go. A status goes to the first other
   * status of the same kind, closing to closing and open to open, so a remap
   * never reopens or closes a case; with none of its kind there is nowhere
   * true to put them, and null refuses the delete. An issue type goes to
   * 'task', else the first. A severity or verdict is cleared: '' is their "none".
   */
  private orphanTarget(field: PaletteField, deleted: PaletteItem): { id: string; label: string } | null {
    if (field === 'severity' || field === 'verdict') return { id: '', label: 'none' }
    if (field === 'status') return statusFallback(this.plugin.settings.statuses, deleted as StatusConfig) ?? null
    const rest = this.plugin.settings.issueTypes.filter((t) => t.id !== deleted.id)
    return rest.find((t) => t.id === 'task') ?? rest[0] ?? null
  }

  /** The cases, per board, whose `field` is `id` on a board that follows the global list. */
  private async casesUsing(field: PaletteField, id: string): Promise<{ project: Project; ids: string[] }[]> {
    const projects = await this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder)
    const hits: { project: Project; ids: string[] }[] = []
    for (const project of projects) {
      // A board with its own list does not use the global one, so a global
      // delete leaves its cases alone. Severities/verdicts are global-only.
      const own =
        field === 'status' ? project.config?.statuses : field === 'issueType' ? project.config?.issueTypes : undefined
      if (own?.length) continue
      const ids = flattenTasks(project.tasks)
        .filter(({ task }) => task[field] === id)
        .map(({ task }) => task.id)
      if (ids.length) hits.push({ project, ids })
    }
    return hits
  }

  /**
   * Asked before a palette entry is removed: says how many cases it changes
   * and where they go, and refuses a status with no other of its kind. A
   * delete used to rewrite every matching case on one unconfirmed click.
   */
  private async confirmPaletteDelete(field: PaletteField, deleted: PaletteItem): Promise<boolean> {
    const target = this.orphanTarget(field, deleted)
    if (!target) {
      const kind = (deleted as StatusConfig).complete ? 'closing' : 'open'
      new Notice(
        `"${deleted.label}" is the only ${kind} status, so its cases would have nowhere of the same kind to go. Add another ${kind} status first.`
      )
      return false
    }
    const n = (await this.casesUsing(field, deleted.id)).reduce((sum, hit) => sum + hit.ids.length, 0)
    if (!n) return true
    const them = n === 1 ? 'that case' : 'them'
    const change = target.id ? `moves ${them} to "${target.label}"` : `clears it from ${them}`
    return confirmDialog(
      this.app,
      `${n} ${n === 1 ? 'case uses' : 'cases use'} "${deleted.label}". Deleting it ${change}, and the change is written to each case's activity log.`
    )
  }

  /**
   * Move the cases of a deleted entry to its target. Administrative: each
   * change is logged, but no completion date or lifecycle stamp is set or
   * cleared, since the case did not really close, reopen or get a response.
   */
  private async remapOrphanTasks(field: PaletteField, deleted: PaletteItem): Promise<void> {
    const target = this.orphanTarget(field, deleted)
    if (!target) return
    let remapped = 0
    for (const { project, ids } of await this.casesUsing(field, deleted.id)) {
      await this.plugin.store.updateTasks(project, ids, { [field]: target.id }, { administrative: true })
      remapped += ids.length
    }
    if (remapped > 0) {
      const cases = `${remapped} case${remapped === 1 ? '' : 's'}`
      new Notice(
        target.id
          ? `Moved ${cases} from "${deleted.label}" to "${target.label}".`
          : `Cleared "${deleted.label}" from ${cases}.`
      )
    }
  }

  private renderStatusList(container: HTMLElement): void {
    renderStatusListEditor(container, {
      app: this.app,
      statuses: this.plugin.settings.statuses,
      onChanged: () => void this.plugin.saveSettings(),
      confirmDelete: (item) => this.confirmPaletteDelete('status', item),
      onDeleted: (deleted) => void this.remapOrphanTasks('status', deleted)
    })
  }

  private renderIssueTypeList(container: HTMLElement): void {
    // ponytail: IssueTypeConfig is structurally a PriorityConfig, so the priority palette editor
    // is reused as-is (its min-one Notice copy is generic).
    renderPriorityListEditor(container, {
      app: this.app,
      priorities: this.plugin.settings.issueTypes,
      onChanged: () => void this.plugin.saveSettings(),
      confirmDelete: (item) => this.confirmPaletteDelete('issueType', item),
      onDeleted: (deleted) => void this.remapOrphanTasks('issueType', deleted)
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
      confirmDelete: (item) => this.confirmPaletteDelete('severity', item),
      onDeleted: (deleted) => {
        Reflect.deleteProperty(this.plugin.settings.slaPolicies, deleted.id)
        void this.plugin.saveSettings()
        void this.remapOrphanTasks('severity', deleted)
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
      confirmDelete: (item) => this.confirmPaletteDelete('verdict', item),
      onDeleted: (deleted) => void this.remapOrphanTasks('verdict', deleted)
    })
  }

  /**
   * One row per severity: response/resolution targets in minutes. Empty pair
   * = no clock. A row with one side blank, or a target of 0, is not saved:
   * it used to save the blank side as 0 minutes, breaching every incident of
   * that severity the moment it was created, into the append-only log.
   */
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
        input.min = '1'
        input.placeholder = '—'
        if (value !== undefined) input.value = String(value)
        return input
      }
      const response = makeField('Response', policy?.responseMins)
      const resolution = makeField('Resolution', policy?.resolutionMins)
      const hint = row.createSpan({ cls: 'pm-settings-sla-field-label' })

      const save = (): void => {
        // null = blank; NaN = typed but not a whole number of minutes above 0.
        const parse = (el: HTMLInputElement): number | null => {
          if (el.value.trim() === '') return null
          const n = Math.round(Number(el.value))
          return Number.isFinite(n) && n > 0 ? n : NaN
        }
        const responseMins = parse(response)
        const resolutionMins = parse(resolution)
        if (responseMins === null && resolutionMins === null) {
          Reflect.deleteProperty(this.plugin.settings.slaPolicies, sev.id)
        } else if (
          responseMins === null ||
          resolutionMins === null ||
          Number.isNaN(responseMins) ||
          Number.isNaN(resolutionMins)
        ) {
          hint.setText('Not saved: set both targets above 0 minutes, or clear both for no clock.')
          return
        } else {
          this.plugin.settings.slaPolicies[sev.id] = { responseMins, resolutionMins }
        }
        hint.setText('')
        void this.plugin.saveSettings()
      }
      response.addEventListener('change', save)
      resolution.addEventListener('change', save)
    }
  }
}
