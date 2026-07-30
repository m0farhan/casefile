import { today } from './dates'
import type { TaskIndex } from './store/TaskIndex'

export type TaskStatus = string
export type TaskPriority = string
export type GanttGranularity = 'day' | 'week' | 'month' | 'quarter'
export type GanttWeekLabel = 'weekNumber' | 'dateRange' | 'both'
export type ViewMode = 'table' | 'gantt' | 'kanban' | 'backlog' | 'reports'
export type DueDateFilter = 'any' | 'overdue' | 'this-week' | 'this-month' | 'no-date'
export type TaskType = 'task' | 'milestone' | 'subtask'
/** Lightweight planning buckets — the useful part of sprints without ceremony. */
export type IssueBucket = 'none' | 'this-week' | 'next' | 'later' | 'someday'

export const BUCKETS: { id: IssueBucket; label: string }[] = [
  { id: 'this-week', label: 'This week' },
  { id: 'next', label: 'Next' },
  { id: 'later', label: 'Later' },
  { id: 'someday', label: 'Someday' },
  { id: 'none', label: 'No bucket' }
]

export type IocType = 'ip' | 'domain' | 'hash' | 'url' | 'email'

export interface Ioc {
  type: IocType
  value: string
  /** Omitted (never undefined) when absent — the YAML emitter writes literal `undefined` otherwise. */
  note?: string
}

/** One audit-log entry. Appended by the store on tracked field changes; never edited. */
export interface ActivityEntry {
  at: string // ISO datetime
  field: string
  from: string
  to: string
}

/** Parsed from the task note's `## Comments` body section. Runtime-only — never serialized to frontmatter. */
export interface Comment {
  at: string // 'YYYY-MM-DD HH:mm'
  text: string
}

export interface Recurrence {
  interval: 'daily' | 'weekly' | 'monthly' | 'yearly'
  every: number // e.g. every 2 weeks
  endDate?: string // YYYY-MM-DD
}

export interface TimeLog {
  date: string // YYYY-MM-DD
  hours: number
  note: string
}

export interface CustomFieldDef {
  id: string
  name: string
  type: 'text' | 'number' | 'date' | 'select' | 'multiselect' | 'person' | 'checkbox' | 'url'
  options?: string[] // for select / multiselect
  icon?: string // emoji or lucide icon name
}

export interface Task {
  id: string
  /** Immutable human-facing issue key ("ARGUS-12"). '' until assigned by the store on save. */
  key: string
  title: string
  description: string
  type: TaskType // 'task' or 'milestone' (zero-duration)
  /** Semantic issue type (epic/story/task/bug/incident/...), orthogonal to the structural `type`. */
  issueType: string
  status: TaskStatus
  priority: TaskPriority
  /** Incident impact (drives SLA). '' = none. Distinct from priority (the analyst's work order). */
  severity: string
  /** Incident resolution: '' | true-positive | false-positive | benign-true-positive | duplicate | pending. */
  verdict: string
  bucket: IssueBucket
  start: string // YYYY-MM-DD, empty string = unset
  due: string // YYYY-MM-DD, empty string = unset
  /** Incident lifecycle timestamps (ISO datetime, '' = unset). SLA clock anchors at detectedAt||createdAt. */
  detectedAt: string
  respondedAt: string
  containedAt: string
  resolvedAt: string
  progress: number // 0–100
  completed: string // YYYY-MM-DD, empty string = not completed; stamped when status becomes complete
  assignees: string[]
  tags: string[]
  iocs: Ioc[]
  /** MITRE ATT&CK technique IDs, e.g. "T1566.001". */
  attack: string[]
  /** Append-only audit log, stamped by the store on tracked field changes. */
  activity: ActivityEntry[]
  /** Runtime-only, parsed from the note body's `## Comments` section by loadTaskBody. */
  comments?: Comment[]
  subtasks: Task[]
  dependencies: string[] // task IDs
  recurrence?: Recurrence
  timeEstimate?: number // hours
  timeLogs?: TimeLog[]
  customFields: Record<string, unknown>
  /** UI state, persisted per project in plugin settings (data.json), not in frontmatter. */
  collapsed: boolean
  createdAt: string
  updatedAt: string
  filePath?: string // vault path to this task's .md file
  archived?: boolean // runtime only — derived from file location in Archive/ subfolder
}

export interface Project {
  id: string
  title: string
  description: string
  color: string // hex
  icon: string // emoji
  tasks: Task[]
  customFields: CustomFieldDef[]
  teamMembers: string[]
  /** Issue-key prefix ("ARGUS"). '' = keys disabled for this project. */
  keyPrefix: string
  /** Next sequence number for key assignment. Persisted so keys are never reused. */
  nextKeySeq: number
  createdAt: string
  updatedAt: string
  filePath: string // resolved vault path
  savedViews: SavedView[]
  /** Per-project overrides for the global settings. Absent fields inherit. */
  config?: ProjectConfig
  /** Transient id → {task, parentId} index. Rebuilt on load, maintained by store mutators. Not serialized. */
  taskIndex: TaskIndex
}

export interface FilterState {
  text: string
  statuses: TaskStatus[]
  priorities: TaskPriority[]
  severities: string[]
  verdicts: string[]
  assignees: string[]
  tags: string[]
  dueDateFilter: DueDateFilter
  showArchived: boolean
}

export interface SavedView {
  id: string
  name: string
  filter: FilterState
  sortKey: string
  sortDir: 'asc' | 'desc'
  viewMode?: ViewMode
}

export interface PerProjectFilter {
  filter: FilterState
  activeSavedViewId: string | null
  /** Kanban swimlane grouping for this project. Absent = 'none'. */
  kanbanLane?: string
}

export interface StatusConfig {
  id: string
  label: string
  color: string
  icon: string
  complete: boolean
  /** Soft WIP limit for the kanban column; count turns amber when exceeded. Absent = no limit. */
  wipLimit?: number
}

/**
 * The settings a project may override in its own file. Every field is
 * optional; an absent field falls back to the global plugin settings.
 */
export interface ProjectConfig {
  statuses?: StatusConfig[]
  priorities?: PriorityConfig[]
  issueTypes?: IssueTypeConfig[]
  defaultView?: ViewMode
  autoSchedule?: boolean
  kanbanShowSubtasks?: boolean
  kanbanShowDescriptionPreview?: boolean
}

/**
 * A project's configuration with every fallback applied, as returned by
 * `TaskSource.configFor`. Views and modals read this instead of the global
 * settings so alternative task sources can supply their own catalogs.
 */
export interface ResolvedProjectConfig {
  statuses: StatusConfig[]
  priorities: PriorityConfig[]
  issueTypes: IssueTypeConfig[]
  /** Global-only in v1 (no per-project override) but resolved here so views read one config object. */
  severities: SeverityConfig[]
  verdicts: VerdictConfig[]
  defaultView: ViewMode
  autoSchedule: boolean
  kanbanShowSubtasks: boolean
  kanbanShowDescriptionPreview: boolean
}

export interface PriorityConfig {
  id: TaskPriority
  label: string
  color: string
  icon: string
}

export interface IssueTypeConfig {
  id: string
  label: string
  color: string
  icon: string
}

export interface SeverityConfig {
  id: string
  label: string
  color: string
  icon: string
}

export interface VerdictConfig {
  id: string
  label: string
  color: string
  icon: string
}

export interface SlaPolicy {
  /** Minutes from detectedAt||createdAt to first response (respondedAt). */
  responseMins: number
  /** Minutes from detectedAt||createdAt to resolution (resolvedAt). */
  resolutionMins: number
}

export interface IncidentTemplate {
  id: string
  name: string
  taskDefaults: {
    issueType?: string
    severity?: string
    priority?: string
    tags?: string[]
    attack?: string[]
  }
  bodyMarkdown: string
}

export interface PMSettings {
  projectsFolder: string
  defaultView: ViewMode
  ganttGranularity: GanttGranularity
  ganttWeekLabel: GanttWeekLabel
  statuses: StatusConfig[]
  priorities: PriorityConfig[]
  issueTypes: IssueTypeConfig[]
  severities: SeverityConfig[]
  verdicts: VerdictConfig[]
  /** SLA policy per severity id. Absent severity = no SLA clock. */
  slaPolicies: Record<string, SlaPolicy>
  incidentTemplates: IncidentTemplate[]
  /** Vault path of the generated shift-handover note. */
  handoverPath: string
  handoverWindowHours: number
  globalTeamMembers: string[]
  /** Matches `assignee:me` in the query bar. */
  currentUser: string
  /** Where row/card clicks open the task: the modal or the right-leaf detail panel. */
  openTaskIn: 'modal' | 'panel'
  notificationsEnabled: boolean
  notificationLeadDays: number
  autoSchedule: boolean
  kanbanShowSubtasks: boolean
  kanbanShowDescriptionPreview: boolean
  showTagColors: boolean
  saveTaskOnClose: boolean
  projectFilters: Record<string, PerProjectFilter>
  /** Collapsed task ids per project file path. UI state — lives here so toggles don't rewrite task files. */
  collapsedTasks: Record<string, string[]>
  /** Collapsed kanban column status-ids per project file path. */
  collapsedKanbanColumns: Record<string, string[]>
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_STATUSES: StatusConfig[] = [
  { id: 'todo', label: 'To Do', color: '#8a94a0', icon: '', complete: false },
  { id: 'in-progress', label: 'In Progress', color: '#8b72be', icon: '', complete: false },
  { id: 'blocked', label: 'Blocked', color: '#c47070', icon: '', complete: false },
  { id: 'review', label: 'In Review', color: '#b8a06b', icon: '', complete: false },
  { id: 'done', label: 'Done', color: '#79b58d', icon: '', complete: true },
  { id: 'cancelled', label: 'Cancelled', color: '#767491', icon: '', complete: true }
]

export const DEFAULT_PRIORITIES: PriorityConfig[] = [
  { id: 'critical', label: 'Critical', color: '#c47070', icon: '' },
  { id: 'high', label: 'High', color: '#b8a06b', icon: '' },
  { id: 'medium', label: 'Medium', color: '#8a94a0', icon: '' },
  { id: 'low', label: 'Low', color: '#79b58d', icon: '' }
]

/* Colors follow the GreySurface semantic palette (variables.css --gs-issue-*). */
export const DEFAULT_ISSUE_TYPES: IssueTypeConfig[] = [
  { id: 'epic', label: 'Epic', color: '#b59aff', icon: 'zap' },
  { id: 'story', label: 'Story', color: '#4cb782', icon: 'bookmark' },
  { id: 'task', label: 'Task', color: '#4ea7fc', icon: 'square-check-big' },
  { id: 'bug', label: 'Bug', color: '#eb5757', icon: 'bug' },
  { id: 'incident', label: 'Incident', color: '#f2994a', icon: 'siren' }
]

export const DEFAULT_SEVERITIES: SeverityConfig[] = [
  { id: 'sev1', label: 'SEV1', color: '#eb5757', icon: '' },
  { id: 'sev2', label: 'SEV2', color: '#f2994a', icon: '' },
  { id: 'sev3', label: 'SEV3', color: '#f2c94c', icon: '' },
  { id: 'sev4', label: 'SEV4', color: '#4ea7fc', icon: '' }
]

export const DEFAULT_VERDICTS: VerdictConfig[] = [
  { id: 'true-positive', label: 'True Positive', color: '#eb5757', icon: '' },
  { id: 'false-positive', label: 'False Positive', color: '#4cb782', icon: '' },
  { id: 'benign-true-positive', label: 'Benign True Positive', color: '#2fbfa4', icon: '' },
  { id: 'duplicate', label: 'Duplicate', color: '#8a8f98', icon: '' },
  { id: 'pending', label: 'Pending', color: '#f2994a', icon: '' }
]

export const DEFAULT_SLA_POLICIES: Record<string, SlaPolicy> = {
  sev1: { responseMins: 60, resolutionMins: 240 },
  sev2: { responseMins: 240, resolutionMins: 1440 },
  sev3: { responseMins: 1440, resolutionMins: 4320 },
  sev4: { responseMins: 2880, resolutionMins: 10080 }
}

export const DEFAULT_INCIDENT_TEMPLATES: IncidentTemplate[] = [
  {
    id: 'phishing',
    name: 'Phishing',
    taskDefaults: { issueType: 'incident', severity: 'sev3', priority: 'high', tags: ['phishing'], attack: ['T1566'] },
    bodyMarkdown: [
      '## Summary',
      '',
      '',
      '## Checklist',
      '- [ ] Preserve the original email (headers included)',
      '- [ ] Extract and record IOCs (sender, URLs, attachments)',
      '- [ ] Check who else received it / clicked',
      '- [ ] Block sender / URLs where confirmed malicious',
      '- [ ] Reset credentials for anyone who submitted them',
      '- [ ] Record verdict and close'
    ].join('\n')
  },
  {
    id: 'malware',
    name: 'Malware',
    taskDefaults: { issueType: 'incident', severity: 'sev2', priority: 'high', tags: ['malware'] },
    bodyMarkdown: [
      '## Summary',
      '',
      '',
      '## Checklist',
      '- [ ] Isolate the affected host',
      '- [ ] Capture hashes and record IOCs',
      '- [ ] Identify the malware family and delivery vector',
      '- [ ] Scope lateral movement / other detections',
      '- [ ] Remediate and restore',
      '- [ ] Record verdict and close'
    ].join('\n')
  },
  {
    id: 'credential-compromise',
    name: 'Credential compromise',
    taskDefaults: {
      issueType: 'incident',
      severity: 'sev2',
      priority: 'critical',
      tags: ['credentials'],
      attack: ['T1078']
    },
    bodyMarkdown: [
      '## Summary',
      '',
      '',
      '## Checklist',
      '- [ ] Disable / reset the affected account(s)',
      '- [ ] Revoke active sessions and tokens',
      '- [ ] Review sign-in and audit logs for misuse',
      '- [ ] Identify the exposure vector',
      '- [ ] Check for persistence (forwarding rules, MFA changes)',
      '- [ ] Record verdict and close'
    ].join('\n')
  }
]

export const DEFAULT_SETTINGS: PMSettings = {
  projectsFolder: 'Projects',
  defaultView: 'table',
  ganttGranularity: 'week',
  ganttWeekLabel: 'weekNumber',
  statuses: DEFAULT_STATUSES,
  priorities: DEFAULT_PRIORITIES,
  issueTypes: DEFAULT_ISSUE_TYPES,
  severities: DEFAULT_SEVERITIES,
  verdicts: DEFAULT_VERDICTS,
  slaPolicies: DEFAULT_SLA_POLICIES,
  incidentTemplates: DEFAULT_INCIDENT_TEMPLATES,
  handoverPath: 'SOC/Handover.md',
  handoverWindowHours: 12,
  globalTeamMembers: [],
  currentUser: '',
  openTaskIn: 'modal',
  kanbanShowSubtasks: false,
  kanbanShowDescriptionPreview: false,
  showTagColors: true,
  notificationsEnabled: true,
  notificationLeadDays: 2,
  autoSchedule: true,
  saveTaskOnClose: true,
  projectFilters: {},
  collapsedTasks: {},
  collapsedKanbanColumns: {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function makeId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString()
  return {
    id: makeId(),
    key: '',
    title: 'New Task',
    description: '',
    type: 'task',
    issueType: 'task',
    status: 'todo',
    priority: 'medium',
    severity: '',
    verdict: '',
    bucket: 'none',
    start: today().toString(),
    due: '',
    detectedAt: '',
    respondedAt: '',
    containedAt: '',
    resolvedAt: '',
    progress: 0,
    completed: '',
    assignees: [],
    tags: [],
    iocs: [],
    attack: [],
    activity: [],
    subtasks: [],
    dependencies: [],
    customFields: {},
    collapsed: false,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

export function makeProject(title: string, filePath: string): Project {
  const now = new Date().toISOString()
  return {
    id: makeId(),
    title,
    description: '',
    color: '#8b72be',
    icon: '📋',
    tasks: [],
    customFields: [],
    teamMembers: [],
    keyPrefix: '',
    nextKeySeq: 1,
    createdAt: now,
    updatedAt: now,
    filePath,
    savedViews: [],
    taskIndex: new Map()
  }
}

export function makeDefaultFilter(): FilterState {
  return {
    text: '',
    statuses: [],
    priorities: [],
    severities: [],
    verdicts: [],
    assignees: [],
    tags: [],
    dueDateFilter: 'any',
    showArchived: false
  }
}
